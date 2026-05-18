#!/usr/bin/env python3
"""
vigosk — minimal HTTP server for the kiosk dashboard.
Serves index.html at / and a JSON snapshot at /api/stats.
Listens on 127.0.0.1:8765 by default; override with VIGOSK_HOST / VIGOSK_PORT.

Architecture: two daemon sampler threads write into a lock-guarded dict.
HTTP handlers just serialize the latest dict — no psutil work happens on
the request path, so /api/stats responses are always sub-millisecond and
the kiosk doesn't see freezes when something heavy (proc enumeration)
happens to coincide with a poll.
"""
import collections
import json
import os
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
STATIC_DIR = ROOT / "static"

# Allowlist for /static/<name> — keeps the handler from doing any path
# resolution against arbitrary user input.
STATIC_FILES: dict[str, tuple[Path, str]] = {
    "/static/style.css":   (STATIC_DIR / "style.css",   "text/css; charset=utf-8"),
    "/static/themes.css":  (STATIC_DIR / "themes.css",  "text/css; charset=utf-8"),
    "/static/layouts.css": (STATIC_DIR / "layouts.css", "text/css; charset=utf-8"),
    "/static/app.js":      (STATIC_DIR / "app.js",      "application/javascript; charset=utf-8"),
    "/static/layouts.js":  (STATIC_DIR / "layouts.js",  "application/javascript; charset=utf-8"),
}

# ── Sampler cadence ──────────────────────────────────────────────────
FAST_PERIOD = 0.10        # 10 Hz fast metrics
PROC_PERIOD = 1.5         # ~0.67 Hz process enumeration
CPU_WINDOW  = 10          # 10 × 100ms = 1s rolling window for smoothed CPU
SENSOR_EVERY = 10         # refresh freq/temp every Nth fast sample
IFACE_REFRESH = 600       # re-resolve WAN/LAN interfaces every Nth tick (~60s)

# ── Ping sampler ─────────────────────────────────────────────────────
PING_PERIOD     = 1.0     # seconds between full ping rounds (per target)
PING_HISTORY    = 60      # ring length per target → ~60 s of samples
PING_TIMEOUT_S  = 1       # per-ping timeout (-W argument)
PING_FAIL_VALUE = 100.0   # value pushed into the ring on timeout/error
PING_SCALE_MS   = 100.0   # spark max — covers normal RTT plus a failure spike
PING_EXT_TARGET = os.environ.get("PING_EXT", "1.1.1.1").strip() or "1.1.1.1"

# ── GPU sampler ──────────────────────────────────────────────────────
GPU_SAMPLE_MS = 1000      # intel_gpu_top sample interval
GPU_HISTORY   = 60        # ring length for the busy-% sparkline

# ── Disk listing ─────────────────────────────────────────────────────
DISK_FSTYPES  = ("ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "vfat", "ntfs")
DISK_REFRESH  = 50        # re-enumerate disks every Nth fast tick (~5 s)

# ── WAN/LAN classification ───────────────────────────────────────────
# Interfaces we never count as LAN even when up. Loopback, container /
# bridge backplane, tunnels, VPNs, and common virtual-network kernel ifs.
_VIRTUAL_IFACE_PREFIXES = (
    "lo", "docker", "br-", "veth", "fwbr", "fwpr", "fwln",
    "tap", "tun", "wg", "tailscale", "zt", "virbr", "vbox",
    "lxcbr", "kube", "cni", "cilium", "flannel",
)


def _is_virtual_iface(name: str) -> bool:
    return any(name == p or name.startswith(p) for p in _VIRTUAL_IFACE_PREFIXES)


def _is_bridge_member(name: str) -> bool:
    """True if `name` is a port of a bridge (its counters duplicate the bridge's)."""
    return Path(f"/sys/class/net/{name}/brport").exists()


def _detect_wan_iface() -> str | None:
    """Iface holding the IPv4 default route, or None."""
    try:
        with open("/proc/net/route") as f:
            next(f)  # header
            for line in f:
                fields = line.split()
                if len(fields) < 4:
                    continue
                iface, dest, _gw, flags = fields[0], fields[1], fields[2], fields[3]
                if dest == "00000000" and (int(flags, 16) & 0x2):
                    return iface
    except Exception:
        pass
    return None


def _detect_lan_ifaces(wan: str | None) -> list[str]:
    """Up, non-virtual interfaces other than WAN.

    Skips bridge slaves so we don't double-count packets already
    accounted for at the bridge level.
    """
    out: list[str] = []
    try:
        for name, st in psutil.net_if_stats().items():
            if not st.isup or name == wan or _is_virtual_iface(name):
                continue
            if _is_bridge_member(name):
                continue
            out.append(name)
    except Exception:
        pass
    return out


def _resolve_net_ifaces() -> tuple[str | None, list[str]]:
    """Resolve (WAN, [LAN]) honoring env overrides."""
    wan_env = os.environ.get("WAN_IFACE", "").strip()
    wan = wan_env or _detect_wan_iface()
    lan_env = os.environ.get("LAN_IFACES", "").strip()
    if lan_env:
        lan = [x.strip() for x in lan_env.split(",") if x.strip()]
    else:
        lan = _detect_lan_ifaces(wan)
    return wan, lan


def _gateway_ipv4() -> str | None:
    """IPv4 of the default gateway, parsed from /proc/net/route."""
    try:
        with open("/proc/net/route") as f:
            next(f)  # header
            for line in f:
                fields = line.split()
                if len(fields) < 4:
                    continue
                dest, gw_hex, flags = fields[1], fields[2], fields[3]
                if dest == "00000000" and (int(flags, 16) & 0x2):
                    raw = bytes.fromhex(gw_hex)
                    if len(raw) == 4:
                        return ".".join(str(b) for b in raw[::-1])
    except Exception:
        pass
    return None


_PING_TIME_RE = re.compile(r"time=([\d.]+)\s*ms")


def _ping_once(ip: str) -> float | None:
    """Single ICMP ping via the system `ping` binary; returns RTT ms or None."""
    try:
        r = subprocess.run(
            ["ping", "-c", "1", "-W", str(int(PING_TIMEOUT_S)), "-n", ip],
            capture_output=True, text=True, timeout=PING_TIMEOUT_S + 1.0,
        )
        if r.returncode != 0:
            return None
        m = _PING_TIME_RE.search(r.stdout)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def _ping_loop() -> None:
    """Probe gateway + external target every PING_PERIOD; push into the rings."""
    while True:
        try:
            gw_ip = _gateway_ipv4()
            for slot, ip in (("gw", gw_ip), ("ext", PING_EXT_TARGET)):
                ms = _ping_once(ip) if ip else None
                spark_v = min(ms if ms is not None else PING_FAIL_VALUE, PING_SCALE_MS)
                with _LOCK:
                    _PING_STATE[slot]["target"] = ip
                    _PING_STATE[slot]["ms"] = ms
                    _PING_STATE[slot]["hist"].append(spark_v)
        except Exception as e:
            print(f"[ping_loop] {e}", flush=True)
        time.sleep(PING_PERIOD)


def _gpu_model() -> str | None:
    """Best-effort GPU model name from `lspci`. None if not detectable."""
    try:
        r = subprocess.run(["lspci"], capture_output=True, text=True, timeout=2)
        for line in r.stdout.splitlines():
            low = line.lower()
            if "vga compatible controller" in low or "3d controller" in low or "display controller" in low:
                # Trim "00:02.0 VGA compatible controller: " prefix.
                _, _, rest = line.partition(":")
                _, _, name = rest.partition(":")
                name = name.strip()
                # Strip vendor prefix and trailing "(rev ..)" silicon revision.
                for prefix in ("Intel Corporation ", "Advanced Micro Devices, Inc. ", "NVIDIA Corporation "):
                    if name.startswith(prefix):
                        name = name[len(prefix):]
                        break
                name = re.sub(r"\s*\(rev [0-9a-f]+\)\s*$", "", name, flags=re.IGNORECASE)
                return name[:40] or None
    except Exception:
        pass
    return None


def _gpu_dedicated_temp() -> float | None:
    """GPU die temp from a *dedicated* sensor — None for integrated GPUs.

    Returning None is the contract the client uses to fall back to displaying
    GPU power instead of duplicating the CPU package temperature.
    """
    # AMD/discrete GPUs and some discrete Intel parts expose a hwmon node
    # under the drm card; the i915 integrated driver does not.
    try:
        import glob as _glob
        for path in _glob.glob("/sys/class/drm/card*/device/hwmon/hwmon*/temp1_input"):
            try:
                with open(path) as f:
                    raw = int(f.read().strip())
                if raw > 0:
                    return raw / 1000.0
            except Exception:
                continue
    except Exception:
        pass
    # NVIDIA: nvidia-smi reports per-GPU temp directly.
    if subprocess.run(["which", "nvidia-smi"], capture_output=True).returncode == 0:
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=2,
            )
            if r.returncode == 0 and r.stdout.strip():
                return float(r.stdout.strip().splitlines()[0])
        except Exception:
            pass
    return None


def _gpu_loop() -> None:
    """Stream `intel_gpu_top -J` and update _GPU_STATE."""
    if subprocess.run(["which", "intel_gpu_top"], capture_output=True).returncode != 0:
        return  # No tool, no panel.
    model = _gpu_model() or "GPU"
    decoder = json.JSONDecoder()
    while True:
        proc = None
        try:
            proc = subprocess.Popen(
                ["intel_gpu_top", "-J", "-s", str(GPU_SAMPLE_MS)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, bufsize=1,
            )
            buf = ""
            for line in proc.stdout:
                buf += line
                # intel_gpu_top wraps frames in [ {...}, {...}, ... ] — strip
                # array and separator chrome before each parse attempt.
                buf = buf.lstrip(" \t\n[,")
                while buf:
                    try:
                        obj, idx = decoder.raw_decode(buf)
                    except json.JSONDecodeError:
                        break
                    _ingest_gpu_sample(model, obj)
                    buf = buf[idx:].lstrip(" \t\n[,")
        except Exception as e:
            print(f"[gpu_loop] {e}", flush=True)
        finally:
            if proc is not None:
                try: proc.terminate()
                except Exception: pass
        time.sleep(2)  # back off before respawn


def _ingest_gpu_sample(model: str, obj: dict) -> None:
    """Translate one intel_gpu_top frame into the shared GPU state."""
    try:
        engines = {}
        for name, e in (obj.get("engines") or {}).items():
            if isinstance(e, dict) and "busy" in e:
                engines[name] = float(e["busy"])
        busy = max(engines.values()) if engines else 0.0
        freq = float((obj.get("frequency") or {}).get("actual") or 0.0)
        power = obj.get("power") or {}
        temp_c = _gpu_dedicated_temp()
        with _LOCK:
            _GPU_STATE["available"] = True
            _GPU_STATE["model"] = model
            _GPU_STATE["freq_mhz"] = freq
            _GPU_STATE["engines"] = engines
            _GPU_STATE["busy"] = busy
            _GPU_STATE["power_w"] = float(power["GPU"]) if "GPU" in power else None
            _GPU_STATE["temp_c"] = temp_c
    except Exception as e:
        print(f"[gpu_ingest] {e}", flush=True)


def _parse_lvs_size(s: str) -> int:
    """`lvs` size strings like '<931.28g' or '8.00g' → bytes."""
    s = (s or "").lstrip("<")
    units = {"k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}
    if not s:
        return 0
    suffix = s[-1].lower()
    if suffix in units:
        try:
            return int(float(s[:-1]) * units[suffix])
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def _lvm_thin_pools() -> list[dict]:
    """LVM thin-pool usage as pseudo-disk entries; empty if `lvs` not available."""
    if subprocess.run(["which", "lvs"], capture_output=True).returncode != 0:
        return []
    try:
        r = subprocess.run(
            ["lvs", "--reportformat", "json", "-o",
             "vg_name,lv_name,lv_size,data_percent,lv_attr"],
            capture_output=True, text=True, timeout=2,
        )
        if r.returncode != 0:
            return []
        report = json.loads(r.stdout).get("report", [])
        if not report:
            return []
        out = []
        for lv in report[0].get("lv", []):
            attr = lv.get("lv_attr", "")
            # lv_attr[0] == 't' marks a thin pool. Skip per-volume thin LVs.
            if not attr or attr[0] != "t":
                continue
            pct_raw = lv.get("data_percent", "")
            if not pct_raw:
                continue
            pct = float(pct_raw)
            size = _parse_lvs_size(lv.get("lv_size", "0"))
            out.append({
                "label": f"{lv['vg_name']}/{lv['lv_name']}",
                "total": size,
                "used": int(size * pct / 100.0),
                "percent": pct,
                "kind": "thin",
            })
        return out
    except Exception:
        return []


def _disk_label(device: str, mount: str) -> str:
    """Friendly name for a mounted block device.

    `/dev/mapper/<vg-lv>` → `vg/lv` (matching the thin-pool labels), with the
    standard dm `--` escaping handled. Plain block devices fall back to their
    basename. The mountpoint is appended only when the derived name doesn't
    already convey it (so rootfs reads `pve/root /` instead of just `/`).
    """
    name = ""
    if device.startswith("/dev/mapper/"):
        # In dm names, '--' escapes a literal '-'; a single '-' separates VG
        # from LV. Swap '--' for a sentinel before splitting, then restore.
        token = device[len("/dev/mapper/"):].replace("--", "\x00")
        vg, sep, lv = token.partition("-")
        if sep:
            name = f"{vg.replace(chr(0), '-')}/{lv.replace(chr(0), '-')}"
        else:
            name = token.replace("\x00", "-")
    elif device.startswith("/dev/"):
        name = device[len("/dev/"):]
    if not name:
        return mount or device
    if mount and mount != "/" + name and mount != name:
        return f"{name} {mount}"
    return name


def _enumerate_disks() -> list[dict]:
    """Mounted real filesystems plus optional LVM thin-pool stats."""
    out: list[dict] = []
    seen: set[str] = set()
    try:
        for p in psutil.disk_partitions(all=False):
            if p.fstype not in DISK_FSTYPES or p.mountpoint in seen:
                continue
            try:
                u = psutil.disk_usage(p.mountpoint)
            except Exception:
                continue
            seen.add(p.mountpoint)
            out.append({
                "label": _disk_label(p.device, p.mountpoint),
                "total": u.total,
                "used": u.used,
                "percent": u.percent,
                "kind": "fs",
            })
    except Exception:
        pass
    out.extend(_lvm_thin_pools())
    return out


def _iface_ipv4(name: str | None) -> str | None:
    if not name:
        return None
    try:
        for addr in psutil.net_if_addrs().get(name, []):
            if addr.family == socket.AF_INET:
                return addr.address
    except Exception:
        pass
    return None

# ── Shared state ─────────────────────────────────────────────────────
_LOCK = threading.Lock()
_LATEST_FAST: dict | None = None
_LATEST_PROCS: list = []
_PING_STATE: dict[str, dict] = {
    "gw":  {"target": None, "ms": None,
            "hist": collections.deque([0.0] * PING_HISTORY, maxlen=PING_HISTORY)},
    "ext": {"target": PING_EXT_TARGET, "ms": None,
            "hist": collections.deque([0.0] * PING_HISTORY, maxlen=PING_HISTORY)},
}
_GPU_STATE: dict = {
    "available": False,
    "model": None,
    "freq_mhz": 0.0,
    "engines": {},          # {name: busy_pct}
    "busy": 0.0,            # max engine busy
    "power_w": None,
    "temp_c": None,         # only set when a *dedicated* sensor exists; the
                            # client uses None as the signal to display watts
                            # instead of duplicating the CPU package temp.
}
_DISK_LIST: list[dict] = []  # populated by fast loop, list of {label, total, used, percent, kind}


def _clean_cpu_name(raw: str) -> str:
    """Sanitize a /proc/cpuinfo model string for compact display.

    Works for x86 ("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz"), AMD
    ("AMD Ryzen 5 5600X 6-Core Processor"), and ARM ("ARMv8 Processor")
    by stripping vendor noise rather than pattern-matching specific families.
    """
    s = raw
    s = s.split("@")[0]                              # drop frequency suffix
    for noise in ("(R)", "(TM)", "(r)", "(tm)"):
        s = s.replace(noise, "")
    # Drop common trailing words.
    s = re.sub(r"\b(CPU|Processor|with Radeon Graphics|\d+-Core)\b", "", s, flags=re.IGNORECASE)
    s = " ".join(s.split())                          # collapse whitespace
    return s[:32] or "CPU"


def _detect_cpu_model() -> str:
    try:
        with open("/proc/cpuinfo") as f:
            txt = f.read()
        # x86 uses "model name"; ARM uses "Hardware"/"Model"/"Processor".
        for key in ("model name", "Hardware", "Model", "Processor"):
            for line in txt.splitlines():
                if line.startswith(key + "\t") or line.startswith(key + " "):
                    raw = line.split(":", 1)[1].strip()
                    if raw:
                        return _clean_cpu_name(raw)
    except Exception:
        pass
    return "CPU"


CPU_MODEL = _detect_cpu_model()


# ── Process sampler (slow path) ──────────────────────────────────────
_PROC_CACHE: dict[int, psutil.Process] = {}


def _compute_top_procs(limit: int = 20) -> list:
    seen: set[int] = set()
    rows: list[dict] = []
    for p in psutil.process_iter(["pid", "name", "username"]):
        pid = p.info["pid"]
        seen.add(pid)
        cached = _PROC_CACHE.get(pid)
        try:
            if cached is None:
                cached = psutil.Process(pid)
                cached.cpu_percent(interval=None)  # prime; first read is 0
                _PROC_CACHE[pid] = cached
                continue
            cpu = cached.cpu_percent(interval=None)
            mem = cached.memory_percent()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            _PROC_CACHE.pop(pid, None)
            continue
        rows.append({
            "pid": pid,
            "name": (p.info["name"] or "")[:24],
            "user": (p.info["username"] or "")[:10],
            "cpu": cpu,
            "mem": mem,
        })
    for pid in list(_PROC_CACHE.keys()):
        if pid not in seen:
            _PROC_CACHE.pop(pid, None)
    rows.sort(key=lambda r: (r["cpu"], r["mem"]), reverse=True)
    return rows[:limit]


def _proc_loop() -> None:
    global _LATEST_PROCS
    while True:
        try:
            top = _compute_top_procs()
            with _LOCK:
                _LATEST_PROCS = top
        except Exception as e:
            print(f"[proc_loop] {e}", flush=True)
        time.sleep(PROC_PERIOD)


# ── Fast sampler (CPU/mem/disk/net every 100ms) ──────────────────────
def _fast_loop() -> None:
    global _LATEST_FAST

    psutil.cpu_percent(interval=None, percpu=True)  # prime
    cpu_count = psutil.cpu_count(logical=True) or 1

    cpu_avg_win = collections.deque(maxlen=CPU_WINDOW)
    cpu_per_win = [collections.deque(maxlen=CPU_WINDOW) for _ in range(cpu_count)]

    last_t = time.monotonic()
    last_io = psutil.net_io_counters(pernic=False)
    try:
        last_io_per = psutil.net_io_counters(pernic=True)
    except Exception:
        last_io_per = {}
    try:
        last_dio = psutil.disk_io_counters(perdisk=False)
    except Exception:
        last_dio = None

    freq_mhz = 0.0
    cpu_temp: float | None = None
    tick = 0

    nodename = os.uname().nodename
    boot_t = psutil.boot_time()
    wan_iface, lan_ifaces = _resolve_net_ifaces()
    global _DISK_LIST
    _DISK_LIST = _enumerate_disks()

    while True:
        try:
            now = time.monotonic()

            cpu_per_raw = psutil.cpu_percent(interval=None, percpu=True)
            cpu_avg_raw = sum(cpu_per_raw) / len(cpu_per_raw) if cpu_per_raw else 0.0
            cpu_avg_win.append(cpu_avg_raw)
            for i, v in enumerate(cpu_per_raw):
                if i < len(cpu_per_win):
                    cpu_per_win[i].append(v)
            cpu_avg_smooth = sum(cpu_avg_win) / len(cpu_avg_win)
            cpu_per_smooth = [
                (sum(w) / len(w)) if w else 0.0 for w in cpu_per_win
            ]

            mem = psutil.virtual_memory()
            swap = psutil.swap_memory()
            disk = psutil.disk_usage("/")
            load1, load5, load15 = os.getloadavg()

            io = psutil.net_io_counters(pernic=False)
            try:
                io_per = psutil.net_io_counters(pernic=True)
            except Exception:
                io_per = {}
            dt = max(now - last_t, 1e-3)
            rx_rate = (io.bytes_recv - last_io.bytes_recv) / dt
            tx_rate = (io.bytes_sent - last_io.bytes_sent) / dt
            if rx_rate < 0 or rx_rate > 10 * 1024**3: rx_rate = 0
            if tx_rate < 0 or tx_rate > 10 * 1024**3: tx_rate = 0

            # Per-iface deltas for WAN/LAN split.
            def _iface_rate(name: str) -> tuple[float, float]:
                cur = io_per.get(name) if io_per else None
                prev = last_io_per.get(name) if last_io_per else None
                if cur is None or prev is None:
                    return (0.0, 0.0)
                rx = (cur.bytes_recv - prev.bytes_recv) / dt
                tx = (cur.bytes_sent - prev.bytes_sent) / dt
                if rx < 0 or rx > 10 * 1024**3: rx = 0.0
                if tx < 0 or tx > 10 * 1024**3: tx = 0.0
                return (rx, tx)

            wan_rx = wan_tx = 0.0
            if wan_iface:
                wan_rx, wan_tx = _iface_rate(wan_iface)
            lan_rx = lan_tx = 0.0
            for nm in lan_ifaces:
                rxv, txv = _iface_rate(nm)
                lan_rx += rxv
                lan_tx += txv

            # Aggregate disk I/O across physical disks.
            disk_read_rate = 0.0
            disk_write_rate = 0.0
            try:
                dio = psutil.disk_io_counters(perdisk=False)
                if last_dio is not None and dio is not None:
                    disk_read_rate = (dio.read_bytes - last_dio.read_bytes) / dt
                    disk_write_rate = (dio.write_bytes - last_dio.write_bytes) / dt
                    if disk_read_rate < 0 or disk_read_rate > 10 * 1024**3:
                        disk_read_rate = 0
                    if disk_write_rate < 0 or disk_write_rate > 10 * 1024**3:
                        disk_write_rate = 0
                last_dio = dio
            except Exception:
                pass

            last_t = now
            last_io = io
            last_io_per = io_per

            # Periodically re-resolve interfaces so a new NIC plugged in
            # (or `WAN_IFACE` override after a config change + restart) is
            # picked up without stopping the service.
            if tick % IFACE_REFRESH == 0 and tick > 0:
                wan_iface, lan_ifaces = _resolve_net_ifaces()

            # Re-poll disk usage (cheap) every DISK_REFRESH ticks.
            if tick % DISK_REFRESH == 0:
                _DISK_LIST = _enumerate_disks()

            # Sensors: refresh every Nth tick — they're a touch slow.
            if tick % SENSOR_EVERY == 0:
                try:
                    freq_mhz = psutil.cpu_freq().current or 0.0
                except Exception:
                    freq_mhz = 0.0
                try:
                    temps = psutil.sensors_temperatures()
                    cpu_temp = None
                    for label in ("coretemp", "k10temp", "cpu_thermal", "acpitz"):
                        if label in temps and temps[label]:
                            cpu_temp = temps[label][0].current
                            break
                except Exception:
                    cpu_temp = None
            tick += 1

            snap = {
                "ts": time.time(),
                "host": nodename,
                "uptime": time.time() - boot_t,
                "cpu": {
                    "avg": cpu_avg_smooth,
                    "per": cpu_per_smooth,
                    "raw": cpu_avg_raw,
                    "per_raw": list(cpu_per_raw),
                    "freq_mhz": freq_mhz,
                    "temp_c": cpu_temp,
                    "count": cpu_count,
                    "model": CPU_MODEL,
                },
                "load": [load1, load5, load15],
                "mem": {
                    "total": mem.total,
                    "used": mem.used,
                    "available": mem.available,
                    "buffers": getattr(mem, "buffers", 0),
                    "cached": getattr(mem, "cached", 0),
                    "percent": mem.percent,
                },
                "swap": {
                    "total": swap.total,
                    "used": swap.used,
                    "percent": swap.percent,
                },
                "disk": {
                    "total": disk.total,
                    "used": disk.used,
                    "free": disk.free,
                    "percent": disk.percent,
                    "read_rate":  disk_read_rate,
                    "write_rate": disk_write_rate,
                },
                "net": {
                    "rx": rx_rate,
                    "tx": tx_rate,
                    "wan": {
                        "iface": wan_iface,
                        "ip": _iface_ipv4(wan_iface),
                        "rx": wan_rx, "tx": wan_tx,
                    },
                    "lan": {
                        "ifaces": lan_ifaces,
                        "ips": [_iface_ipv4(nm) for nm in lan_ifaces],
                        "rx": lan_rx, "tx": lan_tx,
                    },
                },
                "procs": len(psutil.pids()),
            }
            with _LOCK:
                _LATEST_FAST = snap
        except Exception as e:
            print(f"[fast_loop] {e}", flush=True)

        # Stable cadence: sleep the remainder of the period.
        elapsed = time.monotonic() - now
        time.sleep(max(0.0, FAST_PERIOD - elapsed))


def snapshot() -> dict:
    with _LOCK:
        fast = _LATEST_FAST
        procs = _LATEST_PROCS
        ping = {
            slot: {
                "target": st["target"],
                "ms": st["ms"],
                "hist": list(st["hist"]),
                "scale_ms": PING_SCALE_MS,
            }
            for slot, st in _PING_STATE.items()
        }
        gpu = {
            "available": _GPU_STATE["available"],
            "model": _GPU_STATE["model"],
            "freq_mhz": _GPU_STATE["freq_mhz"],
            "engines": dict(_GPU_STATE["engines"]),
            "busy": _GPU_STATE["busy"],
            "power_w": _GPU_STATE["power_w"],
            "temp_c": _GPU_STATE["temp_c"],   # None ⇒ no dedicated sensor
        }
        disks = list(_DISK_LIST)
    if fast is None:
        return {"loading": True}
    out = dict(fast)
    out["procs_top"] = procs
    out["net"] = {**out["net"], "ping": ping}
    out["gpu"] = gpu
    out["disks"] = disks
    return out


# ── HTTP ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            try:
                body = INDEX.read_bytes()
            except FileNotFoundError:
                self.send_error(404, "index.html missing")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/stats":
            body = json.dumps(snapshot()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        static = STATIC_FILES.get(self.path)
        if static is not None:
            fs_path, ctype = static
            try:
                body = fs_path.read_bytes()
            except FileNotFoundError:
                self.send_error(404, f"{self.path} missing")
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


def main():
    threading.Thread(target=_fast_loop, name="fast-sampler", daemon=True).start()
    threading.Thread(target=_proc_loop, name="proc-sampler", daemon=True).start()
    threading.Thread(target=_ping_loop, name="ping-sampler", daemon=True).start()
    threading.Thread(target=_gpu_loop,  name="gpu-sampler",  daemon=True).start()
    host = os.environ.get("VIGOSK_HOST", "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(os.environ.get("VIGOSK_PORT", "8765"))
    except ValueError:
        port = 8765
    addr = (host, port)
    srv = ThreadingHTTPServer(addr, Handler)
    print(f"vigosk metrics server listening on http://{addr[0]}:{addr[1]}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
