<!--
  Rendered logo lives in assets/logo.txt — this fenced block is the same
  rendering, kept here so GitHub shows it without a separate image.
-->

```
██╗   ██╗ ██╗  ██████╗   ██████╗  ███████╗ ██╗  ██╗
██║   ██║ ██║ ██╔════╝  ██╔═══██╗ ██╔════╝ ██║ ██╔╝
██║   ██║ ██║ ██║  ███╗ ██║   ██║ ███████╗ █████╔╝
╚██╗ ██╔╝ ██║ ██║   ██║ ██║   ██║ ╚════██║ ██╔═██╗
 ╚████╔╝  ██║ ╚██████╔╝ ╚██████╔╝ ███████║ ██║  ██╗
  ╚═══╝   ╚═╝  ╚═════╝   ╚═════╝  ╚══════╝ ╚═╝  ╚═╝
```

# vigosk

A terminal-styled system metrics dashboard for Linux. Renders CPU, memory, GPU, disk, network and ping in a fullscreen Chromium kiosk with a `btop`-meets-`htop` aesthetic — but built on the web stack, so it's easy to theme, lay out, and remote-view.

> Was previously called `vterm`. Same dashboard, new name. The braille V-TERM logo lives on as `--braille-logo`.

---

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/install.sh | sh
```

Installs to `~/.local/share/vigosk` and drops a launcher at `~/.local/bin/vigosk`. Run with sudo to install system-wide under `/usr/local`.

Then:

```sh
vigosk
```

The terminal switches to the alternate screen buffer (like `btop`), the metrics server starts on `127.0.0.1:8765`, and Chromium opens in `--kiosk` mode. Exit with `Esc` → `QUIT` (or kill the terminal) — the alt-screen restores cleanly.

### Requirements

- Linux (X session for kiosk mode; headless works in `--server-only` mode)
- `python3` (3.8+)
- `chromium` or `chromium-browser` or `google-chrome` (optional — only needed for kiosk mode)
- `curl`, `tar` (only for installation)

---

## Usage

```
vigosk [OPTIONS]

  -h, --help           show help and exit
  -v, --version        print version and exit
  -p, --port PORT      bind port for the metrics server   [default: 8765]
      --host HOST      bind address                       [default: 127.0.0.1]
      --server-only    start the server but don't launch chromium
      --no-clear       don't use the terminal alt-screen buffer
      --braille-logo   print the braille V-TERM easter-egg logo and exit
```

### Environment

| Variable          | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `VIGOSK_HOME`     | Override install location (where `metrics.py` lives) |
| `VIGOSK_BROWSER`  | Browser binary to launch (default: chromium)         |
| `VIGOSK_HOST`     | Bind address — same as `--host`                      |
| `VIGOSK_PORT`     | Bind port — same as `--port`                         |
| `PING_EXT`        | External ping target (default: `1.1.1.1`)            |
| `WAN_IFACE`       | WAN interface for net stats (auto-detected if unset) |
| `LAN_IFACES`      | LAN interfaces for net stats (auto-detected if unset)|

---

## Keyboard

| Key       | Action                                                          |
| --------- | --------------------------------------------------------------- |
| `Esc`     | open / close the VIGOSK menu                                    |
| `S`       | settings                                                        |
| `W`       | widgets                                                         |
| `L`       | layouts                                                         |
| `G`       | toggle line / braille graph mode                                |
| `T`       | theme picker                                                    |
| `A` · `D` | previous / next theme                                           |
| `1` – `4` | default · gauges · heatmap · flowstrip layout                   |
| `↑ ↓ ← →` | navigate menu actions                                           |
| `Enter`   | activate focused action                                         |
| `?`       | show in-app help overlay                                        |

---

## Layouts

Four built-in layouts, cycle with `1`–`4`:

1. **default** — classic six-row strip: CPU, MEM, GPU, DISK, NET, PING.
2. **gauges** — dial-based; foreground metric large, supporting metrics small.
3. **heatmap** — temporal density view; useful when watching for spikes.
4. **flowstrip** — six-column dense row, uniformly accented; designed for at-a-glance scans.

## Themes

Multiple terminal-friendly themes (cyber, amber, nord-ish, etc.). Cycle with `A`/`D`; pick directly via `T`.

## Graph modes

`G` toggles between two rendering styles:

- **line** — anti-aliased SVG line graphs.
- **braille** — text-cell-aligned braille-character graphs, like `btop`'s default.

---

## Architecture

```
  ┌─ python3 metrics.py ──┐         ┌─ chromium --kiosk ──┐
  │  HTTP on 127.0.0.1    │ ◄──────►│  http://127.0.0.1   │
  │  • /                  │         │       :8765         │
  │  • /api/stats         │         │                     │
  │  • /static/...        │         │  → index.html       │
  └───────────────────────┘         │  → app.js sampler   │
           ▲                        │  → layouts.js       │
           │  daemon samplers:      │  → themes.css       │
           │  fast / proc /         └─────────────────────┘
           │  ping / gpu
           │  (lock-guarded dict, sub-ms read on the request path)
```

`metrics.py` is a stdlib `ThreadingHTTPServer`. Sampler threads write into a shared dict under a lock; the HTTP handlers just serialize the latest dict, so `/api/stats` is always sub-millisecond and the kiosk never freezes when something heavy (process enumeration) is in flight.

The kiosk page polls `/api/stats` and re-renders client-side; nothing on the page reloads, only the data.

---

## Running as a real kiosk (panel boot)

`vigosk` works fine as a CLI from your normal session, but the original use case is a dedicated panel that boots straight into the dashboard. The included `kiosk.sh` is designed to be launched from `~/.xinitrc` on `tty1`:

```sh
# ~/.xinitrc
exec /usr/local/share/vigosk/kiosk.sh
```

And `screen-metrics.service` keeps the server up across reboots:

```ini
[Unit]
Description=vigosk metrics server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/share/vigosk/metrics.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

See [`OPTIONAL.md`](./OPTIONAL.md) for remote-viewing via nginx and an on-demand screenshot endpoint.

---

## Development

The repo is the working tree — there is no build step. Edit `metrics.py`, `static/*.js`, `static/*.css` or `index.html`; refresh the kiosk (`Ctrl+R` if you have a keyboard plugged in, or `systemctl restart screen-metrics` then re-open).

```
.
├── bin/vigosk                # the CLI launcher
├── install.sh                # curl-to-shell installer
├── metrics.py                # HTTP server + samplers
├── kiosk.sh                  # X / chromium boot wrapper
├── index.html                # main page
├── static/
│   ├── app.js                # sampler, draw loop
│   ├── layouts.js            # menu, layouts, theme picker
│   ├── style.css             # base styles
│   ├── themes.css            # theme palette tokens
│   └── layouts.css           # per-layout styles
├── assets/
│   ├── logo.txt              # legible VIGOSK block-letter logo
│   └── logo-braille.txt      # the braille V-TERM easter egg
├── OPTIONAL.md               # remote view + screenshot add-ons
└── .github/workflows/release.yml
```

### Release flow

Tags matching `v*` trigger `.github/workflows/release.yml`, which builds `vigosk-<version>.tar.gz`, generates release notes, and attaches the tarball + SHA256 to a new GitHub Release. `install.sh` pulls from there.

```sh
git tag v0.1.0
git push origin v0.1.0
```

---

## License

TBD — add a `LICENSE` file before tagging a public release.
