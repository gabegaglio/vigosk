# Optional Add-Ons

Extras that aren't required for the kiosk panel itself but extend what you can do with it (remote viewing, screenshots, etc.). Each section is self-contained — pick what you want.

---

## 1. Remote Live View

Mirrors the kiosk page over your network so any device can open the dashboard in a browser. Useful for checking host stats from a phone, laptop, or another room without touching the panel.

**Architecture**

```
browser  ──►  nginx (:80)  ──►  metrics.py (127.0.0.1:8765)
                /kiosk/live/
```

Nginx terminates the public request and forwards to the local metrics server. Nothing on `:8765` is ever exposed directly.

### Prerequisites

- `metrics.py` already running under `vigosk-metrics.service` on `127.0.0.1:8765`.
- Nginx installed (`apt install nginx`).
- A way for clients to reach the host: LAN IP, Tailscale, ZeroTier, etc.

### Steps

1. **Add a location block to your nginx site** (e.g. `/etc/nginx/sites-available/default`, inside the `server { ... }` block):

   ```nginx
   # Live mirror of the kiosk page (served by vigosk-metrics on :8765).
   # Trailing slash on proxy_pass strips the /kiosk/live/ prefix upstream.
   location /kiosk/live/ {
       proxy_pass http://127.0.0.1:8765/;
       proxy_http_version 1.1;
       proxy_buffering off;
       proxy_set_header Host $host;
   }
   ```

   The trailing slashes on both the `location` and `proxy_pass` are load-bearing — they tell nginx to strip `/kiosk/live/` before forwarding so the metrics server sees `/`, `/api/stats`, `/static/...` as it expects.

   `proxy_buffering off` keeps the JS sampler responsive; without it, polling responses can stack up in nginx's buffer.

2. **Reload nginx:**

   ```bash
   nginx -t && systemctl reload nginx
   ```

3. **Verify** from another device:

   ```
   http://<host-ip-or-tailscale-ip>/kiosk/live/
   ```

   You should see the same dashboard the kiosk panel is showing.

### Notes

- Read-only by design — the metrics server has no write endpoints.
- If you want HTTPS, add a TLS-terminating block at the nginx layer (Let's Encrypt or self-signed); the upstream stays plain HTTP on loopback.
- If you front this with Tailscale, no port forwarding is needed — clients reach nginx over the tailnet.

---

## 2. On-Demand Screenshot Endpoint

Returns a fresh PNG of the actual kiosk panel (not just a re-render — captured via Chromium DevTools against the running kiosk session). Useful for slides, status reports, or remote sanity checks when the monitor is parked.

**Architecture**

```
browser  ──►  nginx (:80)  ──►  screenshot-server.py (127.0.0.1:8766)
                /kiosk/capture                │
                                              ▼
                                  Chromium DevTools (127.0.0.1:9222)
                                              │
                                              ▼
                                       /var/www/html/kiosk/*.png
```

A small Python service on `:8766` calls Chromium's CDP, grabs a screenshot of the live tab, and serves the PNG.

### Prerequisites

- The kiosk Chromium is launched with `--remote-debugging-port=9222` (already the case in `kiosk.sh`).
- `screenshot-server.py` installed somewhere (e.g. `/opt/local-screen/screenshot-server.py`).
- A systemd unit to keep it running.
- Nginx as above.

### Steps

1. **Install the systemd unit** at `/etc/systemd/system/screen-screenshot.service`:

   ```ini
   [Unit]
   Description=Kiosk screenshot capture server (DevTools)
   After=network.target

   [Service]
   Type=simple
   ExecStart=/usr/bin/python3 /opt/local-screen/screenshot-server.py
   Restart=on-failure
   RestartSec=3
   User=root

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   systemctl daemon-reload
   systemctl enable --now screen-screenshot.service
   ```

2. **Add the nginx location block:**

   ```nginx
   # On-demand screenshot capture via Chromium DevTools.
   location = /kiosk/capture {
       proxy_pass http://127.0.0.1:8766/capture;
       proxy_read_timeout 10s;
   }
   ```

   `=` makes this an exact match (won't intercept `/kiosk/capture-something-else`). The `10s` timeout gives DevTools room to respond on a busy host.

3. **Reload nginx:**

   ```bash
   nginx -t && systemctl reload nginx
   ```

4. **Verify:**

   ```bash
   curl -o /tmp/kiosk.png http://<host>/kiosk/capture
   ```

### Notes

- Captures whatever Chromium is currently rendering, including theme swaps and touchscreen interactions — it's a real screenshot, not a re-render.
- If `vbetool dpms` doesn't work on your kernel, this is also a way to grab a frame while the physical monitor is parked.
- Combine with `cron` or a systemd timer to write periodic snapshots to disk for time-lapse footage.

---

## Adding More Add-Ons

Pattern for future extensions:

1. Run the new component on a fresh loopback port (`127.0.0.1:87xx`) under its own systemd service.
2. Add a single nginx `location` block under `/kiosk/<name>/` proxying to that port.
3. Document it here with the same structure: architecture diagram, prerequisites, steps, verify, notes.

Keeping everything behind `/kiosk/...` means one nginx site, one auth boundary, and a clean URL namespace.
