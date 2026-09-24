#!/usr/bin/env python3
"""
vigosk-agent — lightweight metrics agent for vigosk multi-node.

Runs on every machine you want on the dashboard (a second Proxmox node,
a NAS, a VPS …) and pushes a small JSON sample to the vigosk hub every
few seconds.

Design goals, in priority order:

  1. Safe to run on important machines. The agent never listens on a
     port — it only makes outbound HTTPS connections to the one hub it
     was paired with. The hub's TLS certificate is pinned by SHA-256
     fingerprint (delivered inside the join code), so nothing on the
     network can impersonate the hub or read the stream. Process
     *command lines* are never collected (they can contain secrets);
     only the short kernel process name.
  2. Cheap. Standard library only (no psutil, no pip), reads /proc and
     /sys directly, forks nothing in the steady state, reuses one
     keep-alive TLS connection. Typical cost is well under 1% of one
     core and ~25 MB RSS (mostly the Python runtime itself).
  3. Auditable. One file. Read it top to bottom before you run it.

Usage:
  vigosk-agent join <join-code>     pair with a hub (code comes from `vigosk node add`)
  vigosk-agent run                  push samples forever (what the systemd unit runs)
  vigosk-agent sample               print one sample as JSON — exactly what gets sent
  vigosk-agent status               show the saved pairing (never prints the secret)

Linux only (it reads /proc). Python 3.8+.
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
import random
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

VERSION = "0.2.1"
SCHEMA = 1                      # payload schema version understood by the hub

DEFAULT_INTERVAL = 2.0          # seconds between pushes (hub may override)
MIN_INTERVAL, MAX_INTERVAL = 1.0, 60.0
PROC_EVERY = 5                  # process scan every Nth sample (~10 s at 2 s)
DISK_EVERY_S = 30.0             # re-enumerate mounts this often
THIN_EVERY_S = 60.0             # LVM thin-pool poll (root only; forks `lvs`)
IFACE_EVERY_S = 60.0            # re-resolve NIC / block-device lists
SYS_EVERY_S = 300.0             # resend static system info this often
TOP_N = 8                       # processes sent per scan
MAX_DISKS = 10
HTTP_TIMEOUT = 10.0
MAX_RESPONSE = 16 * 1024

DISK_FSTYPES = ("ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "f2fs", "vfat", "ntfs", "ntfs3")
# Mounts that are never interesting on a dashboard (tiny, or duplicates
# of storage that is already shown).
SKIP_MOUNT_PREFIXES = ("/boot", "/snap/", "/run/", "/var/lib/docker/", "/var/lib/containers/")
VIRTUAL_IFACE_PREFIXES = (
    "lo", "docker", "br-", "veth", "fwbr", "fwpr", "fwln", "tap", "tun", "wg",
    "tailscale", "zt", "virbr", "vbox", "lxcbr", "kube", "cni", "cilium", "flannel",
)


def _log(msg):
    print(f"[vigosk-agent] {msg}", file=sys.stderr, flush=True)


def _read(path, limit=1 << 20):
    with open(path, "rb") as f:
        return f.read(limit).decode("utf-8", "replace")


def _read_int(path):
    try:
        return int(_read(path, 64).strip())
    except (OSError, ValueError):
        return None


# ══════════════════════════════════════════════════════════════════
# Collector — turns /proc + /sys into one compact sample.
# Also imported by the hub (metrics.py) so the hub's own row on the
# fleet dashboard is measured with exactly the same semantics.
# ══════════════════════════════════════════════════════════════════
class Collector:
    def __init__(self, procs=True, proc_every=PROC_EVERY):
        self.procs_enabled = procs
        self.proc_every = max(1, int(proc_every))
        self.clk_tck = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
        self.page = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
        self.is_root = hasattr(os, "geteuid") and os.geteuid() == 0
        self.is_pve = os.path.isdir("/etc/pve") or os.path.exists("/usr/bin/pveversion")
        self._n = 0
        self._cpu_prev = None
        self._net_prev = None
        self._dio_prev = None
        self._t_prev = None
        self._proc_prev = {}            # pid -> cpu ticks
        self._proc_t_prev = None
        self._nics, self._blockdevs, self._iface_t = [], [], 0.0
        self._disks, self._disk_t = [], 0.0
        self._thin, self._thin_t = [], 0.0
        self._temp_path = self._find_temp_sensor()
        self._mhz = None
        self._top, self._nprocs, self._guests = [], 0, None
        self._sysinfo = None

    # ── static info ──────────────────────────────────────────────
    def sysinfo(self):
        if self._sysinfo is None:
            self._sysinfo = self._build_sysinfo()
        return self._sysinfo

    def _build_sysinfo(self):
        u = os.uname()
        os_name = ""
        try:
            for line in _read("/etc/os-release").splitlines():
                if line.startswith("PRETTY_NAME="):
                    os_name = line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
        model, cores = "CPU", os.cpu_count() or 1
        try:
            for line in _read("/proc/cpuinfo").splitlines():
                if line.startswith(("model name", "Hardware", "Model")):
                    model = _clean_cpu_name(line.split(":", 1)[1].strip()) or model
                    break
        except OSError:
            pass
        pve = None
        if self.is_pve and shutil.which("pveversion"):
            # One fork at startup, never again.
            try:
                r = subprocess.run(["pveversion"], capture_output=True, text=True, timeout=10)
                m = re.search(r"pve-manager/([\d.]+)", r.stdout)
                pve = m.group(1) if m else None
            except Exception:
                pass
        return {
            "host": u.nodename[:64], "os": os_name[:64], "kernel": u.release[:64],
            "arch": u.machine[:16], "cpu_model": model, "cores": cores,
            "pve": pve, "agent": VERSION,
        }

    # ── helpers: device discovery ───────────────────────────────
    def _refresh_devices(self, now):
        if now - self._iface_t < IFACE_EVERY_S and self._iface_t:
            return
        self._iface_t = now
        # NICs: physical interfaces (have a /device link) carry the real
        # wire traffic, including guests behind a bridge. Inside a
        # container/VM there may be none, so fall back to the
        # default-route interface.
        nics = []
        try:
            for name in sorted(os.listdir("/sys/class/net")):
                if name.startswith(VIRTUAL_IFACE_PREFIXES):
                    continue
                if os.path.exists(f"/sys/class/net/{name}/device"):
                    nics.append(name)
        except OSError:
            pass
        if not nics:
            gw = _default_route_iface()
            if gw:
                nics = [gw]
        self._nics = nics[:8]
        # Block devices: whole physical disks only (sda, nvme0n1 …) so
        # partitions / device-mapper layers aren't double counted.
        devs = []
        try:
            for name in os.listdir("/sys/block"):
                if name.startswith(("loop", "ram", "zram", "dm-", "md", "sr", "fd")):
                    continue
                if os.path.exists(f"/sys/block/{name}/device"):
                    devs.append(name)
        except OSError:
            pass
        self._blockdevs = devs

    def _find_temp_sensor(self):
        """Pick the best CPU temperature input once; reading it is one small file."""
        base = "/sys/class/hwmon"
        prefer = ("coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal", "acpitz")
        found = {}
        try:
            for hw in os.listdir(base):
                p = os.path.join(base, hw)
                try:
                    name = _read(os.path.join(p, "name"), 64).strip()
                except OSError:
                    continue
                if name not in prefer or name in found:
                    continue
                inp = os.path.join(p, "temp1_input")
                # coretemp: prefer the "Package id 0" sensor when labelled.
                try:
                    for fn in sorted(os.listdir(p)):
                        if fn.endswith("_label"):
                            lbl = _read(os.path.join(p, fn), 64).strip().lower()
                            if lbl.startswith(("package", "tctl", "tdie")):
                                inp = os.path.join(p, fn.replace("_label", "_input"))
                                break
                except OSError:
                    pass
                if os.path.exists(inp):
                    found[name] = inp
        except OSError:
            return None
        for name in prefer:
            if name in found:
                return found[name]
        return None

    # ── individual readers ──────────────────────────────────────
    @staticmethod
    def _cpu_times():
        out = []
        for line in _read("/proc/stat", 256 * 1024).splitlines():
            if not line.startswith("cpu"):
                break
            f = line.split()
            vals = [int(x) for x in f[1:9]]          # user..steal (guest already in user)
            while len(vals) < 8:
                vals.append(0)
            total = sum(vals)
            idle = vals[3] + vals[4]                 # idle + iowait
            out.append((total, idle, vals[4]))
        return out                                   # [aggregate, cpu0, cpu1, …]

    @staticmethod
    def _meminfo():
        m = {}
        for line in _read("/proc/meminfo").splitlines():
            k, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                try:
                    m[k] = int(parts[0]) * 1024
                except ValueError:
                    pass
        return m

    def _net_counters(self):
        rx = tx = 0
        want = set(self._nics)
        for line in _read("/proc/net/dev").splitlines()[2:]:
            name, _, rest = line.partition(":")
            if name.strip() in want:
                f = rest.split()
                rx += int(f[0]); tx += int(f[8])
        return rx, tx

    def _disk_counters(self):
        r = w = 0
        want = set(self._blockdevs)
        for line in _read("/proc/diskstats").splitlines():
            f = line.split()
            if len(f) > 9 and f[2] in want:
                r += int(f[5]); w += int(f[9])
        return r * 512, w * 512

    def _refresh_disks(self, now):
        if self._disk_t and now - self._disk_t < DISK_EVERY_S:
            return
        self._disk_t = now
        seen_dev, out = set(), []
        try:
            mounts = _read("/proc/self/mounts").splitlines()
        except OSError:
            mounts = []
        for line in mounts:
            f = line.split()
            if len(f) < 3:
                continue
            dev, mnt, fstype = f[0], f[1].replace("\\040", " "), f[2]
            if fstype not in DISK_FSTYPES or dev in seen_dev:
                continue
            if mnt != "/" and mnt.startswith(SKIP_MOUNT_PREFIXES):
                continue
            try:
                st = os.statvfs(mnt)
            except OSError:
                continue
            total = st.f_blocks * st.f_frsize
            if total < 256 * 1024 * 1024:            # skip tiny helper filesystems
                continue
            used = (st.f_blocks - st.f_bfree) * st.f_frsize
            avail = st.f_bavail * st.f_frsize
            denom = used + avail
            seen_dev.add(dev)
            out.append({
                "label": _disk_label(dev, mnt), "mount": mnt[:64],
                "total": total, "used": used,
                "pct": round(100.0 * used / denom, 1) if denom else 0.0,
                "kind": "fs",
            })
        out.sort(key=lambda d: (d["mount"] != "/", -d["total"]))
        self._disks = out[:MAX_DISKS]

    def _refresh_thin(self, now):
        # LVM thin pools (Proxmox "local-lvm") need root to query. The
        # hardened systemd unit runs unprivileged, so this is opt-in.
        if not self.is_root or (self._thin_t and now - self._thin_t < THIN_EVERY_S):
            return
        self._thin_t = now
        if not shutil.which("lvs"):
            return
        try:
            r = subprocess.run(
                ["lvs", "--reportformat", "json", "--units", "b", "--nosuffix",
                 "-o", "vg_name,lv_name,lv_size,data_percent,lv_attr"],
                capture_output=True, text=True, timeout=5)
            pools = []
            for lv in (json.loads(r.stdout).get("report") or [{}])[0].get("lv", []):
                if not lv.get("lv_attr", "").startswith("t") or not lv.get("data_percent"):
                    continue
                size = int(float(lv["lv_size"]))
                pct = float(lv["data_percent"])
                pools.append({"label": f"{lv['vg_name']}/{lv['lv_name']}", "mount": "",
                              "total": size, "used": int(size * pct / 100), "pct": round(pct, 1),
                              "kind": "thin"})
            self._thin = pools[:4]
        except Exception:
            pass

    def _scan_procs(self, now, mem_total):
        """Top processes by CPU since the last scan + running-guest counts."""
        cur, rows, n = {}, [], 0
        lxc = kvm = 0
        run_ct, run_vm = set(), set()
        dt = (now - self._proc_t_prev) if self._proc_t_prev else None
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                raw = _read(f"/proc/{pid}/stat", 4096)
            except OSError:
                continue
            n += 1
            # comm may contain spaces/parens — split around the LAST ')'.
            lp, rp = raw.find("("), raw.rfind(")")
            if lp < 0 or rp < 0:
                continue
            name = raw[lp + 1:rp]
            f = raw[rp + 2:].split()
            try:
                ticks = int(f[11]) + int(f[12])     # utime + stime
                rss = int(f[21]) * self.page
            except (IndexError, ValueError):
                continue
            ipid = int(pid)
            cur[ipid] = ticks
            if name == "lxc-start":
                lxc += 1
                if self.is_pve:
                    gid = _guest_id_from_cmdline(pid, "-n")
                    if gid is not None:
                        run_ct.add(gid)
            elif name == "kvm" or name.startswith("qemu-system"):
                kvm += 1
                if self.is_pve:
                    gid = _guest_id_from_cmdline(pid, "-id")
                    if gid is not None:
                        run_vm.add(gid)
            prev = self._proc_prev.get(ipid)
            if dt and prev is not None:
                cpu = 100.0 * (ticks - prev) / self.clk_tck / dt
                rows.append((cpu, rss, ipid, name))
        self._proc_prev, self._proc_t_prev = cur, now
        rows.sort(reverse=True)
        self._top = [{"pid": p, "name": nm[:24], "cpu": round(c, 1),
                      "mem": round(100.0 * r / mem_total, 1) if mem_total else 0.0}
                     for c, r, p, nm in rows[:TOP_N]]
        self._nprocs = n
        self._guests = None
        if self.is_pve:
            self._guests = {"ct": lxc, "vm": kvm}
            inv = pve_guest_inventory(run_ct, run_vm)
            if inv is not None:
                self._guests["list"] = inv

    # ── public: one sample ──────────────────────────────────────
    def sample(self):
        now = time.monotonic()
        self._refresh_devices(now)
        dt = (now - self._t_prev) if self._t_prev else None
        self._t_prev = now

        # CPU
        times = self._cpu_times()
        cpu_pct, per, iow = 0.0, [], 0.0
        if self._cpu_prev and len(self._cpu_prev) == len(times):
            def pct(a, b):
                dtot = b[0] - a[0]
                return max(0.0, min(100.0, 100.0 * (dtot - (b[1] - a[1])) / dtot)) if dtot > 0 else 0.0
            cpu_pct = pct(self._cpu_prev[0], times[0])
            per = [round(pct(a, b)) for a, b in zip(self._cpu_prev[1:], times[1:])]
            dtot = times[0][0] - self._cpu_prev[0][0]
            iow = 100.0 * (times[0][2] - self._cpu_prev[0][2]) / dtot if dtot > 0 else 0.0
        self._cpu_prev = times
        if self._n % 5 == 0:
            self._mhz = _avg_cpu_mhz()
        temp = None
        if self._temp_path:
            v = _read_int(self._temp_path)
            temp = round(v / 1000.0, 1) if v else None

        # Memory
        m = self._meminfo()
        total = m.get("MemTotal", 0)
        avail = m.get("MemAvailable", m.get("MemFree", 0))
        used = max(0, total - avail)
        swap_total = m.get("SwapTotal", 0)
        swap_used = max(0, swap_total - m.get("SwapFree", 0))

        # Rates
        rx_tx = self._net_counters()
        rw = self._disk_counters()
        net = {"rx": 0.0, "tx": 0.0}
        dio = {"r": 0.0, "w": 0.0}
        if dt and self._net_prev:
            net["rx"] = max(0.0, (rx_tx[0] - self._net_prev[0]) / dt)
            net["tx"] = max(0.0, (rx_tx[1] - self._net_prev[1]) / dt)
        if dt and self._dio_prev:
            dio["r"] = max(0.0, (rw[0] - self._dio_prev[0]) / dt)
            dio["w"] = max(0.0, (rw[1] - self._dio_prev[1]) / dt)
        self._net_prev, self._dio_prev = rx_tx, rw
        net["ifaces"] = list(self._nics)

        self._refresh_disks(now)
        self._refresh_thin(now)

        out = {
            "v": SCHEMA,
            "ts": time.time(),
            "up": _uptime(),
            "cpu": {"pct": round(cpu_pct, 1), "per": per, "load": [round(x, 2) for x in os.getloadavg()],
                    "mhz": self._mhz, "temp": temp, "iow": round(iow, 1)},
            "mem": {"total": total, "used": used, "avail": avail,
                    "pct": round(100.0 * used / total, 1) if total else 0.0,
                    "swap_total": swap_total, "swap_used": swap_used},
            "disks": self._disks + self._thin,
            "dio": {k: round(v) for k, v in dio.items()},
            "net": {"rx": round(net["rx"]), "tx": round(net["tx"]), "ifaces": net["ifaces"]},
        }
        if self.procs_enabled and self._n % self.proc_every == 0:
            self._scan_procs(now, total)
            out["procs"] = {"n": self._nprocs, "top": self._top}
            if self._guests is not None:
                out["guests"] = self._guests
        self._n += 1
        return out


# ── Proxmox guest inventory ─────────────────────────────────────────
# Which containers / VMs live on this node and whether they're running.
# Running state comes from the process table (`lxc-start … -n <id>`,
# `kvm -id <id>`); the guest list and names come from this node's
# folder in the Proxmox cluster filesystem. Listing guest IDs works for
# any user; reading names needs root (the privileged agent, or the hub
# machine for its cluster peers), otherwise names are left blank.
PVE_NODES_DIR = "/etc/pve/nodes"
MAX_GUESTS = 256


def _guest_id_from_cmdline(pid, flag):
    try:
        args = _read(f"/proc/{pid}/cmdline", 8192).split("\0")
    except OSError:
        return None
    for k, a in enumerate(args[:-1]):
        if a == flag and args[k + 1].isdigit():
            return int(args[k + 1])
    return None


def pve_node_name():
    return os.uname().nodename.split(".")[0]


def pve_guest_inventory(running_ct, running_vm, node=None):
    """[{id, t: ct|vm, n: name, s: running|stopped, tpl?}] for this node, or None off-Proxmox."""
    base = os.path.join(PVE_NODES_DIR, node or pve_node_name())
    if not os.path.isdir(base):
        return None
    out = []
    for sub, kind, key in (("lxc", "ct", "hostname"), ("qemu-server", "vm", "name")):
        folder = os.path.join(base, sub)
        try:
            files = os.listdir(folder)
        except OSError:
            continue
        for fn in files:
            if not fn.endswith(".conf") or not fn[:-5].isdigit():
                continue
            gid, name, tpl = int(fn[:-5]), "", False
            try:
                for line in _read(os.path.join(folder, fn), 64 * 1024).splitlines():
                    if line.startswith("["):          # snapshot sections follow
                        break
                    if line.startswith(key + ":"):
                        name = line.split(":", 1)[1].strip()
                    elif line.startswith("template:"):
                        tpl = line.split(":", 1)[1].strip() == "1"
            except OSError:
                pass                                   # unprivileged: IDs only
            g = {"id": gid, "t": kind, "n": name[:64],
                 "s": "running" if gid in (running_ct if kind == "ct" else running_vm) else "stopped"}
            if tpl:
                g["tpl"] = True
            out.append(g)
    out.sort(key=lambda g: g["id"])
    return out[:MAX_GUESTS]


def pve_guests():
    """Stand-alone inventory (scans only guest processes) — used by the dashboard."""
    if not os.path.isdir(PVE_NODES_DIR):
        return None
    ct, vm = set(), set()
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            comm = _read(f"/proc/{pid}/comm", 64).strip()
        except OSError:
            continue
        if comm == "lxc-start":
            gid = _guest_id_from_cmdline(pid, "-n")
            if gid is not None:
                ct.add(gid)
        elif comm == "kvm" or comm.startswith("qemu-system"):
            gid = _guest_id_from_cmdline(pid, "-id")
            if gid is not None:
                vm.add(gid)
    return pve_guest_inventory(ct, vm)


def _clean_cpu_name(raw):
    s = raw.split("@")[0]
    for noise in ("(R)", "(TM)", "(r)", "(tm)"):
        s = s.replace(noise, "")
    s = re.sub(r"\b(CPU|Processor|with Radeon Graphics|\d+-Core)\b", "", s, flags=re.IGNORECASE)
    return " ".join(s.split())[:32]


def _disk_label(device, mount):
    name = ""
    if device.startswith("/dev/mapper/"):
        token = device[len("/dev/mapper/"):].replace("--", "\x00")
        vg, sep, lv = token.partition("-")
        name = f"{vg}/{lv}".replace("\x00", "-") if sep else token.replace("\x00", "-")
    elif device.startswith("/dev/"):
        name = device[len("/dev/"):]
    elif "/" in device and not device.startswith("/"):
        name = device                                  # zfs dataset, e.g. rpool/data
    if not name:
        return mount[:40]
    if mount and mount not in ("/" + name, name):
        return f"{name} {mount}"[:40]
    return name[:40]


def _avg_cpu_mhz():
    vals = []
    base = "/sys/devices/system/cpu"
    try:
        for d in os.listdir(base):
            if d.startswith("cpu") and d[3:].isdigit():
                v = _read_int(f"{base}/{d}/cpufreq/scaling_cur_freq")
                if v:
                    vals.append(v / 1000.0)
    except OSError:
        pass
    return round(sum(vals) / len(vals)) if vals else None


def _uptime():
    try:
        return round(float(_read("/proc/uptime", 64).split()[0]))
    except (OSError, ValueError, IndexError):
        return None


def _default_route_iface():
    try:
        for line in _read("/proc/net/route").splitlines()[1:]:
            f = line.split()
            if len(f) > 3 and f[1] == "00000000" and int(f[3], 16) & 0x2:
                return f[0]
    except (OSError, ValueError):
        pass
    return None


# ══════════════════════════════════════════════════════════════════
# Pairing + transport
# ══════════════════════════════════════════════════════════════════
JOIN_PREFIX = "vgk1."
_FP_RE = re.compile(r"^[0-9a-f]{64}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
_NODE_RE = re.compile(r"^n[0-9a-f]{10}$")


class PinError(Exception):
    """The hub presented a certificate that doesn't match the pinned fingerprint."""


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection that trusts exactly one certificate: the hub's.

    The hub uses a self-signed certificate, so ordinary CA validation
    can't work; instead the join code carries the SHA-256 fingerprint of
    the hub certificate and every (re)connect is checked against it
    *before* any request bytes — and therefore the node secret — are
    written. http.client transparently reconnects by calling connect(),
    so overriding it here covers every connection, not just the first.
    """

    def __init__(self, host, port, fingerprint, timeout=HTTP_TIMEOUT):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE      # trust comes from the pin below
        super().__init__(host, port, timeout=timeout, context=ctx)
        self._fp = fingerprint

    def connect(self):
        super().connect()
        der = self.sock.getpeercert(binary_form=True)
        got = hashlib.sha256(der or b"").hexdigest()
        if not hmac.compare_digest(got, self._fp):
            self.close()
            raise PinError(f"hub certificate fingerprint mismatch (got {got[:16]}…)")


def _split_hub_url(url):
    u = urlsplit(url)
    if u.scheme != "https" or not u.hostname or u.path not in ("", "/") or u.query or u.fragment:
        raise ValueError("hub URL must look like https://HOST:PORT")
    return u.hostname, u.port or 443


def decode_join_code(code):
    code = (code or "").strip()
    if not code.startswith(JOIN_PREFIX):
        raise ValueError("not a vigosk join code (should start with 'vgk1.')")
    raw = code[len(JOIN_PREFIX):]
    try:
        obj = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except Exception:
        raise ValueError("join code is corrupted — copy it again")
    if not isinstance(obj, dict):
        raise ValueError("join code is corrupted — copy it again")
    url, fp, tok = str(obj.get("u", "")), str(obj.get("f", "")).lower(), str(obj.get("t", ""))
    _split_hub_url(url)
    if not _FP_RE.match(fp) or not _TOKEN_RE.match(tok):
        raise ValueError("join code is corrupted — copy it again")
    return url, fp, tok


def default_config_path():
    env = os.environ.get("VIGOSK_AGENT_CONFIG", "").strip()
    if env:
        return env
    creds = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()   # systemd LoadCredential=
    if creds and os.path.exists(os.path.join(creds, "agent.json")):
        return os.path.join(creds, "agent.json")
    if os.geteuid() == 0:
        return "/etc/vigosk-agent/agent.json"
    base = os.environ.get("XDG_CONFIG_HOME", "").strip() or os.path.expanduser("~/.config")
    return os.path.join(base, "vigosk-agent", "agent.json")


def load_config(path):
    with open(path) as f:
        cfg = json.load(f)
    _split_hub_url(cfg["hub"])
    if not _FP_RE.match(cfg.get("fp", "")) or not _NODE_RE.match(cfg.get("node", "")):
        raise ValueError(f"{path}: invalid pairing — run `vigosk-agent join` again")
    if not _TOKEN_RE.match(cfg.get("secret", "")):
        raise ValueError(f"{path}: invalid pairing — run `vigosk-agent join` again")
    return cfg


def save_config(path, cfg):
    d = os.path.dirname(path) or "."
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _post(conn, path, body, token=None):
    headers = {"Content-Type": "application/json", "User-Agent": f"vigosk-agent/{VERSION}"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body, separators=(",", ":")).encode()
    conn.request("POST", path, body=data, headers=headers)
    r = conn.getresponse()
    raw = r.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError("hub response too large")
    try:
        obj = json.loads(raw or b"{}")
    except ValueError:
        obj = {}
    return r.status, obj if isinstance(obj, dict) else {}


def cmd_join(args):
    try:
        url, fp, token = decode_join_code(args.code)
    except ValueError as e:
        _log(str(e)); return 2
    path = args.config or default_config_path()
    if os.path.exists(path) and not args.force:
        _log(f"{path} already exists — this machine is already paired. Use --force to re-pair.")
        return 2
    host, port = _split_hub_url(url)
    conn = PinnedHTTPSConnection(host, port, fp)
    info = Collector(procs=False).sysinfo()
    try:
        status, resp = _post(conn, "/v1/enroll", {"token": token, "host": info["host"],
                                                   "agent": VERSION, "schema": SCHEMA})
    except PinError as e:
        _log(f"REFUSED: {e}. The hub at {url} is not the one that issued this code.")
        return 3
    except (OSError, http.client.HTTPException) as e:
        _log(f"cannot reach hub at {url}: {e}")
        _log("check the hub is running and its port is open in the hub's firewall.")
        return 4
    finally:
        conn.close()
    if status != 200:
        _log(f"hub rejected the join code ({status}): {resp.get('error', 'unknown error')}")
        return 5
    node, secret = str(resp.get("node", "")), str(resp.get("secret", ""))
    if not _NODE_RE.match(node) or not _TOKEN_RE.match(secret):
        _log("hub sent an invalid response"); return 5
    save_config(path, {"v": 1, "hub": url, "fp": fp, "node": node, "secret": secret,
                       "name": str(resp.get("name", ""))[:32]})
    print(f"✓ paired with {url} as \"{resp.get('name', node)}\"")
    print(f"  credentials saved to {path} (mode 600)")
    if not os.environ.get("VIGOSK_INSTALLER"):          # install.sh starts the service itself
        print("  next: systemctl enable --now vigosk-agent   (or run: vigosk-agent run)")
    return 0


def cmd_status(args):
    path = args.config or default_config_path()
    try:
        cfg = load_config(path)
    except FileNotFoundError:
        print(f"not paired ({path} not found)"); return 1
    except (ValueError, KeyError, OSError) as e:
        print(f"invalid config: {e}"); return 1
    print(f"hub:         {cfg['hub']}")
    print(f"node:        {cfg.get('name') or '?'} ({cfg['node']})")
    print(f"fingerprint: {cfg['fp'][:16]}…")
    print(f"config:      {path}")
    return 0


def cmd_sample(args):
    c = Collector(procs=not args.no_procs, proc_every=1)
    c.sample()
    time.sleep(1.0)
    out = c.sample()
    out["sys"] = c.sysinfo()
    print(json.dumps(out, indent=2))
    return 0


def cmd_run(args):
    path = args.config or default_config_path()
    try:
        cfg = load_config(path)
    except FileNotFoundError:
        _log(f"not paired: {path} not found. Run `vigosk-agent join <code>` first.")
        return 2
    except (ValueError, KeyError, OSError) as e:
        _log(str(e)); return 2
    host, port = _split_hub_url(cfg["hub"])
    token = f"{cfg['node']}.{cfg['secret']}"
    interval = DEFAULT_INTERVAL
    col = Collector(procs=not args.no_procs)
    col.sample()                                  # prime the delta counters
    conn = None
    backoff = 0.0
    sys_sent_t = 0.0
    need_sys = True
    _log(f"v{VERSION} pushing to {cfg['hub']} as {cfg.get('name') or cfg['node']}")
    while True:
        t0 = time.monotonic()
        try:
            payload = col.sample()
            if need_sys or t0 - sys_sent_t > SYS_EVERY_S:
                payload["sys"] = col.sysinfo()
                sys_sent_t, need_sys = t0, False
            if conn is None:
                conn = PinnedHTTPSConnection(host, port, cfg["fp"])
            status, resp = _post(conn, "/v1/push", payload, token)
            if status == 200:
                if backoff:
                    _log("connected")
                backoff = 0.0
                try:
                    interval = min(MAX_INTERVAL, max(MIN_INTERVAL, float(resp.get("interval", interval))))
                except (TypeError, ValueError):
                    pass
                need_sys = bool(resp.get("need_sys"))
            elif status == 401:
                _log("hub rejected our credentials (node removed or re-keyed). "
                     "Re-pair with `vigosk-agent join`. Retrying in 5 min.")
                conn.close(); conn = None
                time.sleep(300); continue
            elif status == 429:
                time.sleep(interval)
            else:
                _log(f"hub error {status}: {resp.get('error', '')}")
                backoff = min(60.0, max(2.0, backoff * 2))
        except PinError as e:
            _log(f"REFUSING to send: {e}. Retrying in 60 s.")
            conn = None
            time.sleep(60); continue
        except (OSError, http.client.HTTPException, ValueError) as e:
            if conn is not None:
                conn.close(); conn = None
            backoff = min(60.0, max(2.0, backoff * 2))
            _log(f"hub unreachable ({e.__class__.__name__}: {e}); retry in {backoff:.0f}s")
        sleep = backoff + random.uniform(0, backoff / 4) if backoff else interval - (time.monotonic() - t0)
        time.sleep(max(0.05, sleep))


def main(argv=None):
    p = argparse.ArgumentParser(prog="vigosk-agent", description="vigosk multi-node metrics agent")
    p.add_argument("--version", action="version", version=f"vigosk-agent {VERSION}")
    p.add_argument("--config", help="pairing file (default: /etc/vigosk-agent/agent.json as root)")
    sub = p.add_subparsers(dest="cmd")
    j = sub.add_parser("join", help="pair this machine with a hub")
    j.add_argument("code", help="join code printed by `vigosk node add` on the hub")
    j.add_argument("--force", action="store_true", help="overwrite an existing pairing")
    r = sub.add_parser("run", help="push samples to the hub forever")
    r.add_argument("--no-procs", action="store_true", help="don't send the top-process list")
    s = sub.add_parser("sample", help="print one sample (exactly what would be sent)")
    s.add_argument("--no-procs", action="store_true")
    sub.add_parser("status", help="show the saved pairing")
    args = p.parse_args(argv)
    if not sys.platform.startswith("linux"):
        _log("vigosk-agent currently supports Linux only"); return 2
    if args.cmd == "join":
        return cmd_join(args)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "sample":
        return cmd_sample(args)
    if args.cmd == "status":
        return cmd_status(args)
    p.print_help()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
