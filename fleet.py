#!/usr/bin/env python3
"""
vigosk hub — collects samples pushed by vigosk-agents on other machines.

Runs as its own small, unprivileged service next to the vigosk
dashboard (metrics.py). Two listeners:

  • Agent port (TLS, default 0.0.0.0:8767) — the ONLY thing exposed to
    the network. Accepts exactly two requests: POST /v1/enroll (trade a
    one-time join code for a node credential) and POST /v1/push (a
    metrics sample, authenticated with that credential). Everything an
    agent sends is re-validated and re-built field by field before it
    is stored, so a compromised agent can't inject markup, oversized
    data or unexpected keys into the dashboard.

  • Control socket (Unix, default /run/vigosk-hub/hub.sock) — local
    only. metrics.py reads the fleet from it, and the `vigosk node …`
    CLI manages nodes through it. Node management additionally requires
    the caller to be root or the hub's own user (checked with
    SO_PEERCRED), so file permissions aren't the only guard.

Trust model
  • The hub generates a self-signed ECDSA P-256 certificate on first
    start. Its SHA-256 fingerprint travels inside every join code, and
    agents refuse to talk to any hub that presents a different cert —
    so there is no trust-on-first-use window and no CA to manage.
  • A join code works once and expires after 15 minutes. It is traded
    for a random 256-bit node secret the user never sees. The hub only
    stores SHA-256 hashes of join tokens and node secrets.
  • Removing a node (or re-keying it) revokes its secret instantly.

Standard library only. Python 3.8+. Linux (SO_PEERCRED, Unix sockets).
"""
import argparse
import base64
import collections
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HUB_VERSION = "0.2.1"
SCHEMA = 1

DEFAULT_STATE = os.environ.get("VIGOSK_HUB_STATE", "") or os.environ.get("STATE_DIRECTORY", "") or "/var/lib/vigosk-hub"
DEFAULT_LISTEN = os.environ.get("VIGOSK_HUB_LISTEN", "") or "0.0.0.0:8767"
DEFAULT_SOCKET = os.environ.get("VIGOSK_HUB_SOCKET", "") or "/run/vigosk-hub/hub.sock"
DEFAULT_ADVERTISE = os.environ.get("VIGOSK_HUB_ADVERTISE", "")

PUSH_INTERVAL = 2.0          # seconds; sent to agents in every push response
MIN_PUSH_SPACING = 0.5       # reject pushes from one node faster than this
MAX_NODES = 64
HIST_LEN = 180               # samples of history kept per node (6 min @ 2 s)
ENROLL_TTL = 15 * 60         # join codes expire after 15 minutes
MAX_PUSH_BYTES = 64 * 1024
MAX_ENROLL_BYTES = 4 * 1024
MAX_CONTROL_BYTES = 8 * 1024
HANDSHAKE_TIMEOUT = 10.0
IDLE_TIMEOUT = 60.0          # keep-alive idle / per-read timeout
MAX_CONN = MAX_NODES * 2 + 16
MAX_CONN_PER_IP = 8
AUTH_FAIL_LIMIT = 10         # failed auth attempts per window …
AUTH_FAIL_WINDOW = 300.0     # … per IP …
AUTH_BLOCK = 600.0           # … blocks that IP for this long
ONLINE_GRACE = 3 * PUSH_INTERVAL + 2
STALE_AFTER = 30.0

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")
NODE_ID_RE = re.compile(r"^n[0-9a-f]{10}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
# Control chars, zero-width and bidi-override characters are stripped
# from every agent-supplied string so names can't spoof or reorder text.
_BAD_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁯﻿]")


def log(msg):
    print(f"[vigosk-hub] {msg}", file=sys.stderr, flush=True)


def _sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _atomic_write(path, text, mode=0o600):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# ══════════════════════════════════════════════════════════════════
# Validation of agent payloads — rebuild, never pass through.
# ══════════════════════════════════════════════════════════════════
def _num(v, lo=0.0, hi=1e15):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return min(hi, max(lo, f))


def _int(v, lo=0, hi=10**9):
    f = _num(v, lo, hi)
    return int(f) if f is not None else None


def _str(v, n):
    if not isinstance(v, str):
        return ""
    return _BAD_CHARS.sub("", v).strip()[:n]


def _dict(v):
    return v if isinstance(v, dict) else {}


def _list(v, n):
    return v[:n] if isinstance(v, list) else []


def sanitize_sample(o):
    """Return a clean copy of an agent sample, or raise ValueError."""
    if not isinstance(o, dict):
        raise ValueError("sample must be a JSON object")
    if o.get("v") != SCHEMA:
        raise ValueError(f"unsupported sample schema {o.get('v')!r}; this hub speaks {SCHEMA} — upgrade the older side")
    cpu, mem, net, dio = _dict(o.get("cpu")), _dict(o.get("mem")), _dict(o.get("net")), _dict(o.get("dio"))
    out = {
        "up": _num(o.get("up"), 0, 1e10),
        "cpu": {
            "pct": _num(cpu.get("pct"), 0, 100) or 0.0,
            "per": [_int(x, 0, 100) or 0 for x in _list(cpu.get("per"), 512)],
            "load": [_num(x, 0, 1e6) for x in _list(cpu.get("load"), 3)],
            "mhz": _num(cpu.get("mhz"), 0, 1e5),
            "temp": _num(cpu.get("temp"), -50, 200),
            "iow": _num(cpu.get("iow"), 0, 100),
        },
        "mem": {
            "total": _num(mem.get("total"), 0, 2**52) or 0,
            "used": _num(mem.get("used"), 0, 2**52) or 0,
            "avail": _num(mem.get("avail"), 0, 2**52),
            "pct": _num(mem.get("pct"), 0, 100) or 0.0,
            "swap_total": _num(mem.get("swap_total"), 0, 2**52) or 0,
            "swap_used": _num(mem.get("swap_used"), 0, 2**52) or 0,
        },
        "disks": [],
        "dio": {"r": _num(dio.get("r"), 0, 1e13) or 0, "w": _num(dio.get("w"), 0, 1e13) or 0},
        "net": {
            "rx": _num(net.get("rx"), 0, 1e13) or 0,
            "tx": _num(net.get("tx"), 0, 1e13) or 0,
            "ifaces": [s for s in (_str(x, 16) for x in _list(net.get("ifaces"), 8)) if s],
        },
    }
    for d in _list(o.get("disks"), 16):
        d = _dict(d)
        label = _str(d.get("label"), 40)
        if not label:
            continue
        out["disks"].append({
            "label": label, "mount": _str(d.get("mount"), 64),
            "total": _num(d.get("total"), 0, 2**60) or 0, "used": _num(d.get("used"), 0, 2**60) or 0,
            "pct": _num(d.get("pct"), 0, 100) or 0.0,
            "kind": "thin" if d.get("kind") == "thin" else "fs",
        })
    if "procs" in o:
        p = _dict(o.get("procs"))
        top = []
        for t in _list(p.get("top"), 12):
            t = _dict(t)
            top.append({"pid": _int(t.get("pid"), 0, 2**31) or 0, "name": _str(t.get("name"), 24),
                        "cpu": _num(t.get("cpu"), 0, 1e5) or 0.0, "mem": _num(t.get("mem"), 0, 100) or 0.0})
        out["procs"] = {"n": _int(p.get("n"), 0, 10**7) or 0, "top": top}
    if "guests" in o:
        g = _dict(o.get("guests"))
        out["guests"] = {"ct": _int(g.get("ct"), 0, 10**5) or 0, "vm": _int(g.get("vm"), 0, 10**5) or 0}
        if "list" in g:                              # Proxmox guest inventory (agent ≥ 0.2.1)
            inv = []
            for x in _list(g.get("list"), 256):
                x = _dict(x)
                gid = _int(x.get("id"), 1, 999999999)
                if not gid:
                    continue
                item = {"id": gid, "t": "vm" if x.get("t") == "vm" else "ct",
                        "n": _str(x.get("n"), 64), "s": "running" if x.get("s") == "running" else "stopped"}
                if x.get("tpl") is True:
                    item["tpl"] = True
                inv.append(item)
            out["guests"]["list"] = inv
    if "sys" in o:
        s = _dict(o.get("sys"))
        out["sys"] = {
            "host": _str(s.get("host"), 64), "os": _str(s.get("os"), 64),
            "kernel": _str(s.get("kernel"), 64), "arch": _str(s.get("arch"), 16),
            "cpu_model": _str(s.get("cpu_model"), 32), "cores": _int(s.get("cores"), 1, 4096) or 1,
            "pve": _str(s.get("pve"), 16) or None, "agent": _str(s.get("agent"), 16),
        }
    return out


# ══════════════════════════════════════════════════════════════════
# Node registry (persistent) — names, credential hashes, join tokens.
# ══════════════════════════════════════════════════════════════════
class RegistryError(Exception):
    pass


class Registry:
    def __init__(self, state_dir):
        self.path = Path(state_dir) / "nodes.json"
        self.lock = threading.Lock()
        self.nodes = {}                      # id -> record (insertion order = display order)
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                self.nodes = {k: v for k, v in data.get("nodes", {}).items() if NODE_ID_RE.match(k)}
            except (ValueError, OSError) as e:
                # Refuse to start rather than silently forgetting every node.
                raise SystemExit(f"[vigosk-hub] cannot read {self.path}: {e}")

    def _save(self):
        _atomic_write(self.path, json.dumps({"v": 1, "nodes": self.nodes}, indent=2))

    def _by_name(self, name):
        for nid, rec in self.nodes.items():
            if rec["name"] == name:
                return nid, rec
        return None, None

    @staticmethod
    def check_name(name):
        name = (name or "").strip().lower()
        if not NAME_RE.match(name):
            raise RegistryError("name must be 1–32 chars: a-z 0-9 . _ - (start with a letter or digit)")
        if name in ("local", "hub"):
            raise RegistryError(f"'{name}' is reserved")
        return name

    def add(self, name):
        name = self.check_name(name)
        with self.lock:
            if self._by_name(name)[0]:
                raise RegistryError(f"node '{name}' already exists (use `vigosk node rekey {name}` for a new join code)")
            if len(self.nodes) >= MAX_NODES:
                raise RegistryError(f"node limit reached ({MAX_NODES})")
            nid = "n" + secrets.token_hex(5)
            token = secrets.token_urlsafe(24)
            self.nodes[nid] = {"name": name, "created": time.time(), "enrolled": None, "host": "",
                               "secret_sha256": None, "enroll_sha256": _sha(token),
                               "enroll_exp": time.time() + ENROLL_TTL}
            self._save()
            return nid, token

    def rekey(self, name):
        name = self.check_name(name)
        with self.lock:
            nid, rec = self._by_name(name)
            if not nid:
                raise RegistryError(f"no node named '{name}'")
            token = secrets.token_urlsafe(24)
            rec.update(secret_sha256=None, enroll_sha256=_sha(token), enroll_exp=time.time() + ENROLL_TTL)
            self._save()
            return nid, token

    def remove(self, name):
        name = self.check_name(name)
        with self.lock:
            nid, _ = self._by_name(name)
            if not nid:
                raise RegistryError(f"no node named '{name}'")
            del self.nodes[nid]
            self._save()
            return nid

    def enroll(self, token, host):
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            return None
        h = _sha(token)
        now = time.time()
        with self.lock:
            match = None
            for nid, rec in self.nodes.items():      # compare against every candidate
                eh = rec.get("enroll_sha256")
                if eh and hmac.compare_digest(eh, h) and (rec.get("enroll_exp") or 0) > now:
                    match = nid
            if not match:
                return None
            rec = self.nodes[match]
            secret = secrets.token_urlsafe(32)
            rec.update(secret_sha256=_sha(secret), enroll_sha256=None, enroll_exp=None,
                       enrolled=now, host=_str(host, 64))
            self._save()
            return match, rec["name"], secret

    def verify(self, nid, secret):
        rec = self.nodes.get(nid)
        if not rec or not rec.get("secret_sha256") or not isinstance(secret, str):
            return None
        return rec["name"] if hmac.compare_digest(rec["secret_sha256"], _sha(secret)) else None

    def public(self):
        with self.lock:
            now = time.time()
            return [{"id": nid, "name": r["name"], "host": r.get("host", ""), "created": r.get("created"),
                     "enrolled": r.get("enrolled"),
                     "pending": bool(r.get("enroll_sha256")) and (r.get("enroll_exp") or 0) > now,
                     "paired": bool(r.get("secret_sha256"))}
                    for nid, r in self.nodes.items()]


# ══════════════════════════════════════════════════════════════════
# Live fleet state (memory only).
# ══════════════════════════════════════════════════════════════════
class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.nodes = {}

    def _slot(self, nid):
        st = self.nodes.get(nid)
        if st is None:
            st = self.nodes[nid] = {
                "m": None, "sys": None, "procs": None, "guests": None, "seq": 0,
                "seen": None, "seen_mono": 0.0, "addr": "",
                # "t" = receive time of each sample, so the dashboard can place
                # points on a real time axis (gaps stay gaps, graphs scroll
                # at a constant speed however irregularly samples arrive).
                "hist": {k: collections.deque(maxlen=HIST_LEN) for k in ("t", "cpu", "mem", "rx", "tx")},
            }
        return st

    def too_fast(self, nid):
        with self.lock:
            st = self.nodes.get(nid)
            return bool(st and time.monotonic() - st["seen_mono"] < MIN_PUSH_SPACING)

    def update(self, nid, sample, addr):
        with self.lock:
            st = self._slot(nid)
            if "sys" in sample:
                st["sys"] = sample.pop("sys")
            if "procs" in sample:
                st["procs"] = sample.pop("procs")
            if "guests" in sample:
                st["guests"] = sample.pop("guests")
            st["m"] = sample
            st["seq"] += 1
            st["seen"], st["seen_mono"], st["addr"] = time.time(), time.monotonic(), addr
            h = st["hist"]
            h["t"].append(round(st["seen"], 2))
            h["cpu"].append(round(sample["cpu"]["pct"], 1))
            h["mem"].append(round(sample["mem"]["pct"], 1))
            h["rx"].append(round(sample["net"]["rx"]))
            h["tx"].append(round(sample["net"]["tx"]))
            return st["sys"] is None

    def forget(self, nid):
        with self.lock:
            self.nodes.pop(nid, None)

    def view(self, nid, with_hist):
        with self.lock:
            st = self.nodes.get(nid)
            if st is None:
                return None
            age = time.monotonic() - st["seen_mono"]
            v = {"m": st["m"], "sys": st["sys"], "procs": st["procs"], "guests": st["guests"],
                 "seq": st["seq"], "seen": st["seen"], "age": round(age, 1), "addr": st["addr"],
                 "status": "online" if age <= ONLINE_GRACE else ("stale" if age <= STALE_AFTER else "offline")}
            if with_hist:
                v["hist"] = {k: list(d) for k, d in st["hist"].items()}
            return v


# ══════════════════════════════════════════════════════════════════
# Brute-force / abuse limiter (per source IP).
# ══════════════════════════════════════════════════════════════════
class Limiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.fails = {}                  # ip -> [count, window_start, blocked_until]
        self.conns = collections.Counter()

    def blocked(self, ip):
        with self.lock:
            f = self.fails.get(ip)
            return bool(f and f[2] > time.monotonic())

    def fail(self, ip):
        now = time.monotonic()
        with self.lock:
            if len(self.fails) > 4096:       # bound memory under a spray
                self.fails = {k: v for k, v in self.fails.items() if v[2] > now}
            f = self.fails.setdefault(ip, [0, now, 0.0])
            if now - f[1] > AUTH_FAIL_WINDOW:
                f[0], f[1] = 0, now
            f[0] += 1
            if f[0] >= AUTH_FAIL_LIMIT and f[2] <= now:
                f[2] = now + AUTH_BLOCK
                log(f"blocking {ip} for {int(AUTH_BLOCK)}s after {f[0]} failed attempts")

    def conn_open(self, ip):
        with self.lock:
            if self.conns[ip] >= MAX_CONN_PER_IP:
                return False
            self.conns[ip] += 1
            return True

    def conn_close(self, ip):
        with self.lock:
            self.conns[ip] -= 1
            if self.conns[ip] <= 0:
                del self.conns[ip]


# ══════════════════════════════════════════════════════════════════
# TLS certificate
# ══════════════════════════════════════════════════════════════════
def ensure_cert(state_dir):
    crt, key = Path(state_dir) / "hub.crt", Path(state_dir) / "hub.key"
    if not (crt.exists() and key.exists()):
        openssl = shutil.which("openssl")
        if not openssl:
            raise SystemExit("[vigosk-hub] `openssl` is needed once to create the hub certificate "
                             "(apt install openssl)")
        tmp_c, tmp_k = crt.with_suffix(".crt.tmp"), key.with_suffix(".key.tmp")
        old = os.umask(0o077)
        try:
            subprocess.run([openssl, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                            "-nodes", "-days", "3650", "-subj", "/CN=vigosk-hub",
                            "-keyout", str(tmp_k), "-out", str(tmp_c)],
                           check=True, capture_output=True, timeout=60)
        finally:
            os.umask(old)
        os.replace(tmp_k, key)
        os.replace(tmp_c, crt)
        log(f"created hub certificate {crt}")
    der = ssl.PEM_cert_to_DER_cert(crt.read_text())
    return crt, key, hashlib.sha256(der).hexdigest()


def _primary_ipv4():
    """IPv4 the host would use to reach the LAN (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))          # TEST-NET-1; UDP connect only picks a route
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _parse_listen(s):
    s = s.strip()
    if s.startswith("["):
        host, _, port = s[1:].partition("]:")
    else:
        host, _, port = s.rpartition(":")
    return host or "0.0.0.0", int(port)


def make_join_code(url, fp, token):
    raw = json.dumps({"u": url, "f": fp, "t": token}, separators=(",", ":")).encode()
    return "vgk1." + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _valid_hub_url(url):
    u = urlsplit(url or "")
    return u.scheme == "https" and bool(u.hostname) and u.path in ("", "/") and not u.query and not u.fragment


# ══════════════════════════════════════════════════════════════════
# The hub
# ══════════════════════════════════════════════════════════════════
class Hub:
    def __init__(self, state_dir, fp, listen, advertise):
        self.registry = Registry(state_dir)
        self.store = Store()
        self.limiter = Limiter()
        self.fp = fp
        self.listen = listen
        self.advertise = advertise

    def default_url(self):
        if self.advertise:
            return self.advertise
        host, port = _parse_listen(self.listen)
        if host in ("0.0.0.0", "::", ""):
            host = _primary_ipv4() or "127.0.0.1"
        if ":" in host:
            host = f"[{host}]"
        return f"https://{host}:{port}"

    def fleet(self, with_hist):
        out = []
        for rec in self.registry.public():
            v = self.store.view(rec["id"], with_hist) or {"status": "pending" if not rec["paired"] else "offline",
                                                          "m": None, "sys": None, "seq": 0, "seen": None}
            v.update(id=rec["id"], name=rec["name"], role="agent")
            out.append(v)
        return {"hub": {"version": HUB_VERSION, "interval": PUSH_INTERVAL, "fp": self.fp[:16],
                        "url": self.default_url()}, "nodes": out}


# ── Agent-facing TLS server ───────────────────────────────────────
class _IngestServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64

    def __init__(self, addr, hub, ctx):
        self.hub, self.ctx = hub, ctx
        self.slots = threading.BoundedSemaphore(MAX_CONN)
        if ":" in addr[0]:
            self.address_family = socket.AF_INET6
        super().__init__(addr, _IngestHandler)

    def process_request(self, request, client_address):
        ip = client_address[0]
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        if not self.hub.limiter.conn_open(ip):
            self.slots.release()
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.hub.limiter.conn_close(ip)
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.hub.limiter.conn_close(client_address[0])
            self.slots.release()

    def finish_request(self, request, client_address):
        # TLS handshake happens here, in the worker thread and under a
        # timeout, so a stalled client can never block accept().
        request.settimeout(HANDSHAKE_TIMEOUT)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass

    def handle_error(self, request, client_address):
        pass                                  # never dump tracebacks for client noise


class _IngestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = IDLE_TIMEOUT

    def version_string(self):
        return "vigosk-hub"

    def log_message(self, *_):
        pass

    def _json(self, code, obj, close=False):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(404, {"error": "not found"}, close=True)

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_GET

    def _read_json(self, limit):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self._json(411, {"error": "content-length required"}, close=True); return None
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            self._json(415, {"error": "content-type must be application/json"}, close=True); return None
        try:
            n = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            self._json(413, {"error": "body missing or too large"}, close=True); return None
        try:
            obj = json.loads(self.rfile.read(n) or b"null")
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "invalid JSON"}); return None
        if not isinstance(obj, dict):
            self._json(400, {"error": "expected a JSON object"}); return None
        return obj

    def do_POST(self):
        hub = self.server.hub
        ip = self.client_address[0]
        if hub.limiter.blocked(ip):
            self._json(429, {"error": "too many failed attempts; try again later"}, close=True)
            return
        if self.path == "/v1/push":
            self._push(hub, ip)
        elif self.path == "/v1/enroll":
            self._enroll(hub, ip)
        else:
            self._json(404, {"error": "not found"}, close=True)

    def _push(self, hub, ip):
        auth = self.headers.get("Authorization") or ""
        nid, _, secret = auth[7:].partition(".") if auth.startswith("Bearer ") else ("", "", "")
        name = hub.registry.verify(nid, secret) if NODE_ID_RE.match(nid) else None
        if not name:
            hub.limiter.fail(ip)
            self._json(401, {"error": "unknown or revoked node credential"}, close=True)
            return
        obj = self._read_json(MAX_PUSH_BYTES)
        if obj is None:
            return
        if hub.store.too_fast(nid):
            self._json(429, {"error": "slow down", "interval": PUSH_INTERVAL})
            return
        try:
            clean = sanitize_sample(obj)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return
        first = hub.store.view(nid, False) is None
        need_sys = hub.store.update(nid, clean, ip)
        if first:
            log(f"node '{name}' connected from {ip}")
        self._json(200, {"ok": True, "interval": PUSH_INTERVAL, "need_sys": need_sys})

    def _enroll(self, hub, ip):
        obj = self._read_json(MAX_ENROLL_BYTES)
        if obj is None:
            return
        res = hub.registry.enroll(obj.get("token"), obj.get("host"))
        if not res:
            hub.limiter.fail(ip)
            self._json(401, {"error": "join code is invalid, expired or already used — "
                                      "run `vigosk node rekey <name>` on the hub for a new one"}, close=True)
            return
        nid, name, secret = res
        hub.store.forget(nid)
        log(f"node '{name}' paired from {ip} (host {_str(obj.get('host'), 64) or '?'})")
        self._json(200, {"node": nid, "name": name, "secret": secret, "interval": PUSH_INTERVAL})


# ── Local control socket ──────────────────────────────────────────
class _ControlServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path, hub):
        self.hub = hub
        super().__init__(path, _ControlHandler)

    def handle_error(self, request, client_address):
        pass


class _ControlHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    timeout = 5.0

    def address_string(self):
        return "unix"

    def version_string(self):
        return "vigosk-hub"

    def log_message(self, *_):
        pass

    def _peer_uid(self):
        try:
            raw = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            return struct.unpack("3i", raw)[1]
        except OSError:
            return -1

    def _json(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _admin_ok(self):
        uid = self._peer_uid()
        if uid in (0, os.geteuid()):
            return True
        self._json(403, {"error": "node management requires root"})
        return False

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        if n > MAX_CONTROL_BYTES:
            return None
        try:
            obj = json.loads(self.rfile.read(n))
            return obj if isinstance(obj, dict) else None
        except ValueError:
            return None

    def do_GET(self):
        hub = self.server.hub
        u = urlsplit(self.path)
        if u.path == "/v1/fleet":
            hist = parse_qs(u.query).get("hist", ["0"])[0] == "1"
            self._json(200, hub.fleet(hist))
        elif u.path == "/v1/nodes":
            self._json(200, {"nodes": hub.registry.public(), "url": hub.default_url()})
        elif u.path == "/v1/info":
            self._json(200, {"version": HUB_VERSION, "listen": hub.listen, "url": hub.default_url(),
                             "fingerprint": hub.fp, "nodes": len(hub.registry.nodes)})
        else:
            self._json(404, {"error": "not found"})

    def _join_reply(self, hub, nid, name, token, body):
        url = (body or {}).get("url") or hub.default_url()
        if not _valid_hub_url(url):
            self._json(400, {"error": "url must look like https://HOST:PORT"})
            return
        self._json(200, {"id": nid, "name": name, "url": url, "expires_in": ENROLL_TTL,
                         "join": make_join_code(url, hub.fp, token)})

    def do_POST(self):
        hub = self.server.hub
        if not self._admin_ok():
            return
        body = self._body()
        if body is None:
            self._json(400, {"error": "invalid body"})
            return
        parts = [p for p in urlsplit(self.path).path.split("/") if p]
        try:
            if parts == ["v1", "nodes"]:
                nid, token = hub.registry.add(body.get("name", ""))
                log(f"node '{hub.registry.nodes[nid]['name']}' created (awaiting join)")
                self._join_reply(hub, nid, hub.registry.nodes[nid]["name"], token, body)
            elif len(parts) == 4 and parts[:2] == ["v1", "nodes"] and parts[3] == "rekey":
                nid, token = hub.registry.rekey(parts[2])
                hub.store.forget(nid)
                log(f"node '{parts[2]}' re-keyed (old credential revoked)")
                self._join_reply(hub, nid, parts[2], token, body)
            else:
                self._json(404, {"error": "not found"})
        except RegistryError as e:
            self._json(400, {"error": str(e)})

    def do_DELETE(self):
        hub = self.server.hub
        if not self._admin_ok():
            return
        parts = [p for p in urlsplit(self.path).path.split("/") if p]
        if len(parts) != 3 or parts[:2] != ["v1", "nodes"]:
            self._json(404, {"error": "not found"})
            return
        try:
            nid = hub.registry.remove(parts[2])
            hub.store.forget(nid)
            log(f"node '{parts[2]}' removed (credential revoked)")
            self._json(200, {"ok": True})
        except RegistryError as e:
            self._json(400, {"error": str(e)})


# ══════════════════════════════════════════════════════════════════
# Control-socket client — used by the CLI below and by metrics.py.
# ══════════════════════════════════════════════════════════════════
class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=2.0):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        try:
            s.connect(self._path)
        except OSError:
            s.close()
            raise
        self.sock = s


def control(method, path, body=None, sock=DEFAULT_SOCKET, timeout=2.0, limit=4 * 1024 * 1024):
    conn = UnixHTTPConnection(sock, timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        return r.status, json.loads(r.read(limit) or b"{}")
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════
def cmd_serve(args):
    state = Path(args.state)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    crt, key, fp = ensure_cert(state)
    hub = Hub(state, fp, args.listen, args.advertise)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(crt), str(key))
    ingest = _IngestServer(_parse_listen(args.listen), hub, ctx)
    threading.Thread(target=ingest.serve_forever, name="ingest", daemon=True).start()

    sock = Path(args.socket)
    sock.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if sock.exists() or sock.is_symlink():
        sock.unlink()                        # stale socket from a previous run
    old = os.umask(0o117)                    # socket is born 0660, no chmod race
    try:
        ctl = _ControlServer(str(sock), hub)
    finally:
        os.umask(old)
    log(f"v{HUB_VERSION} agents → {args.listen} (TLS, fp {fp[:16]}…) · control → {sock} · "
        f"{len(hub.registry.nodes)} node(s)")
    try:
        ctl.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def _ctl(args, method, path, body=None):
    try:
        return control(method, path, body, sock=args.socket)
    except FileNotFoundError:
        print(f"✗ the vigosk hub isn't running (no socket at {args.socket}).\n"
              f"  start it: systemctl enable --now vigosk-hub", file=sys.stderr)
    except PermissionError:
        print("✗ permission denied talking to the hub — run this as root (sudo).", file=sys.stderr)
    except (OSError, http.client.HTTPException, ValueError) as e:
        print(f"✗ hub not responding: {e}", file=sys.stderr)
    sys.exit(1)


def _print_join(res, installer_url):
    name, code = res["name"], res["join"]
    mins = res["expires_in"] // 60
    print(f"\n✓ node \"{name}\" is ready to pair — the code below works once, for {mins} minutes.\n")
    print(f"  On {name}, as root, run ONE of these:\n")
    print("  • Fresh machine (installs the agent, pairs it, starts it):\n")
    print(f"      curl -fsSL {installer_url} | sh -s -- {code}\n")
    print("  • Agent already installed:\n")
    print(f"      vigosk-agent join {code} && systemctl enable --now vigosk-agent\n")
    print(f"  {name} must be able to reach the hub at {res['url']}")
    print("  (open that TCP port in the hub's firewall for your LAN / tailnet only).\n")


INSTALLER_URL = os.environ.get(
    "VIGOSK_AGENT_INSTALLER",
    "https://raw.githubusercontent.com/gabegaglio/vigosk/main/agent/install.sh")


def cmd_node(args):
    if args.action == "add":
        st, res = _ctl(args, "POST", "/v1/nodes", {"name": args.name, **({"url": args.url} if args.url else {})})
    elif args.action == "rekey":
        st, res = _ctl(args, "POST", f"/v1/nodes/{args.name}/rekey", {"url": args.url} if args.url else {})
    elif args.action == "remove":
        st, res = _ctl(args, "DELETE", f"/v1/nodes/{args.name}")
        if st == 200:
            print(f"✓ removed '{args.name}' — its agent can no longer push. "
                  f"On that machine: systemctl disable --now vigosk-agent")
            return 0
    else:
        st, res = _ctl(args, "GET", "/v1/fleet")
        if st == 200:
            rows = res.get("nodes", [])
            if not rows:
                print("no nodes yet — add one: vigosk node add <name>")
                return 0
            print(f"{'NAME':<16} {'STATUS':<9} {'HOST':<18} {'ADDRESS':<16} {'LAST SEEN':<10} AGENT")
            for n in rows:
                seen = f"{int(n['age'])}s ago" if n.get("age") is not None and n.get("seen") else "never"
                sysi = n.get("sys") or {}
                print(f"{n['name']:<16} {n['status']:<9} {(sysi.get('host') or '—'):<18} "
                      f"{(n.get('addr') or '—'):<16} {seen:<10} {sysi.get('agent') or '—'}")
            return 0
    if st != 200:
        print(f"✗ {res.get('error', 'failed')}", file=sys.stderr)
        return 1
    _print_join(res, INSTALLER_URL)
    return 0


def cmd_info(args):
    st, res = _ctl(args, "GET", "/v1/info")
    for k in ("version", "listen", "url", "fingerprint", "nodes"):
        print(f"{k:<12} {res.get(k)}")
    return 0 if st == 200 else 1


def main(argv=None):
    p = argparse.ArgumentParser(prog="vigosk-hub", description="vigosk multi-node hub")
    p.add_argument("--socket", default=DEFAULT_SOCKET, help=f"control socket [{DEFAULT_SOCKET}]")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the hub (what the systemd unit runs)")
    s.add_argument("--state", default=DEFAULT_STATE, help=f"state directory [{DEFAULT_STATE}]")
    s.add_argument("--listen", default=DEFAULT_LISTEN, help=f"agent TLS listen address [{DEFAULT_LISTEN}]")
    s.add_argument("--advertise", default=DEFAULT_ADVERTISE,
                   help="URL agents use to reach this hub (default: https://<primary IPv4>:<port>)")
    n = sub.add_parser("node", help="add / list / remove / rekey nodes")
    n.add_argument("action", choices=["add", "list", "remove", "rekey"])
    n.add_argument("name", nargs="?")
    n.add_argument("--url", help="hub URL to embed in the join code, e.g. https://100.64.0.1:8767")
    sub.add_parser("info", help="show hub address + certificate fingerprint")
    args = p.parse_args(argv)
    if args.cmd == "serve":
        return cmd_serve(args)
    if args.cmd == "node":
        if args.action != "list" and not args.name:
            p.error(f"node {args.action} needs a NAME")
        if args.url and not _valid_hub_url(args.url):
            p.error("--url must look like https://HOST:PORT")
        return cmd_node(args)
    if args.cmd == "info":
        return cmd_info(args)
    p.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
