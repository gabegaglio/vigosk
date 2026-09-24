# Multi-node: one dashboard, all your machines

vigosk can show several machines side by side (a second Proxmox node, a NAS,
a Raspberry Pi, a VPS) on the same screen. Press `8` for the **FLEET** layout:

![fleet layout — two Proxmox nodes](screenshots/fleet.png)

- **Top strip:** the whole fleet combined: how many machines are online, CPU
  weighted by core count, total memory, total network traffic, running
  Proxmox guests, and the one thing most worth a look (an offline machine, a
  nearly full disk, a hot CPU).
- **One column per machine:** CPU and memory as big numbers with history
  graphs, the two fullest disks, network, disk I/O and load. Every graph uses
  the same 0–100 % scale and time window, so you compare machines by reading
  straight across.
- **Five or more machines** switch to a compact list (one row per machine).
  Press `V` or tap the `AUTO` chip to pick columns or list yourself. The list
  shrinks its rows as machines are added and then flows into two, three or
  four side-by-side columns, so even dozens of machines fit without scrolling.
- **Tap a machine** for details: every core, every disk, top processes,
  interfaces, uptime and running guests.

![fleet list view — five or more machines](screenshots/fleet-list.png)

Prefer the clock? Press **`9`** for **HUB · FLEET**: the hub clock on the
left, one card per machine on the right, and weather · quote of the day ·
services along the bottom. Adding a machine re-tiles the cards to fit, and
each card sheds detail as it shrinks, so 2 machines get big cards with
graphs while 40 get compact `CPU · MEM` tiles.

![hub · fleet — clock and machine cards](screenshots/hub-fleet.png)

---

## How it works (30-second version)

```
   the machine with the screen                   every other machine
 ┌────────────────────────────────┐          ┌──────────────────────────┐
 │  vigosk dashboard  (kiosk)     │          │  vigosk-agent            │
 │        ▲                       │  HTTPS   │  reads CPU / RAM / disk  │
 │        │ local only            │◄─────────│  / net every 2 s and     │
 │  vigosk-hub  :8767 (TLS)       │  (push)  │  sends it to the hub     │
 └────────────────────────────────┘          └──────────────────────────┘
```

- The machine with the screen is the **hub**. Every other machine runs a small
  **agent** that sends its stats to the hub every 2 seconds.
- Agents never open a port. They only connect **out** to the hub, so there is
  nothing new listening on your other machines.
- You pair a machine by pasting **one command** that the hub prints for you.
  That command works once, expires after 15 minutes, and also tells the agent
  exactly which hub to trust. See [Security](#security) for the details.
- It's light. Measured on Proxmox nodes, the agent uses about **0.07 % of one
  CPU core** and ~25 MB of RAM, and the hub about 0.1 % with several machines.

---

## Before you start

| You need | Notes |
| --- | --- |
| **A hub**: the Linux machine running the vigosk dashboard | needs `systemd`, `python3` 3.8+, `openssl` (all standard on Debian, Ubuntu, Proxmox VE, Raspberry Pi OS) |
| **Each other machine**: Linux with `systemd` and `python3` 3.8+ | no pip packages and no Docker needed. Proxmox VE, Debian 11+, Ubuntu 20.04+, Fedora and Raspberry Pi OS all work |
| **Network**: the other machines can reach the hub on **TCP 8767** | same LAN, VLANs with a routing rule, or Tailscale / WireGuard |
| **Root** (sudo) on every machine | only for installing; the services themselves run sandboxed |

> **Your machine names.** Examples below call the hub `pve1` at `192.168.1.10`
> and add a machine called `nas`. Use your own names and addresses.

---

## Step 1: Install vigosk on the hub (system-wide)

If vigosk already runs on your hub as a service, skip to step 2. It must be
**v0.2.0 or newer** (`vigosk --version`).

```sh
curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/install.sh | sudo VIGOSK_VERSION=main sh
```

> `VIGOSK_VERSION=main` installs the newest code. Once a 0.2.0 release is
> published you can drop it; the installer then picks the latest release.

Use `sudo`: the hub service needs vigosk installed system-wide (under
`/usr/local/share/vigosk`) so its sandboxed user can read it. Then start the
dashboard as a service so it survives reboots:

```sh
sudo tee /etc/systemd/system/vigosk-metrics.service >/dev/null <<'EOF'
[Unit]
Description=vigosk metrics server
After=network.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/share/vigosk/metrics.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now vigosk-metrics
```

Open `http://127.0.0.1:8765` on the hub (or run `vigosk --kiosk`) to check
that the dashboard shows up.

---

## Step 2: Turn on the hub

```sh
sudo vigosk hub enable
```

You should see:

```
✓ vigosk hub is running

  version      0.2.0
  listen       0.0.0.0:8767
  url          https://192.168.1.10:8767
  fingerprint  3f9c…
  nodes        0
```

That's it. The hub created its own certificate and is waiting for machines.
Check on it any time with `vigosk hub status`.

<details>
<summary>Options (Tailscale, a different port, a hostname)</summary>

| Want | Command |
| --- | --- |
| a different port | `sudo vigosk hub enable --port 9443` |
| accept agents **only over Tailscale** | `sudo vigosk hub enable --listen 100.101.102.103:8767` (the hub's Tailscale IP) |
| agents should dial a name instead of an IP | `sudo vigosk hub enable --advertise https://pve1.lan:8767` |

Re-running `hub enable` with new options is safe and paired machines are kept. If you change
the port or address, re-pair each machine with `sudo vigosk node rekey <name>`.
</details>

---

## Step 3: Open port 8767 on the hub's firewall

Only the other machines need to reach this port. **Never port-forward it
from the internet.** Pick the recipe that matches your hub:

**No firewall on the hub** (typical Debian/Ubuntu desktop or Pi): nothing to do.

**Proxmox VE with the firewall enabled** (check *Datacenter → Firewall*):
the host drops unknown ports, so add a rule. In the web UI go to *your node →
Firewall → Add*:
*Direction* `in`, *Action* `ACCEPT`, *Protocol* `tcp`, *Dest. port* `8767`,
*Source* the other machine's IP (or your LAN, e.g. `192.168.1.0/24`). Or from
the shell (replace `pve1` with your node's name):

```sh
cat >> /etc/pve/nodes/pve1/host.fw <<'EOF'

[RULES]
IN ACCEPT -source 192.168.1.0/24 -p tcp -dport 8767 -log nolog # vigosk-hub
EOF
```

> If `host.fw` already has a `[RULES]` section, add only the `IN ACCEPT …`
> line under it. The rule is live within about 10 seconds.

**ufw:** `sudo ufw allow from 192.168.1.0/24 to any port 8767 proto tcp`

**firewalld:**
```sh
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="8767" protocol="tcp" accept'
sudo firewall-cmd --reload
```

**Tailscale only:** if you used `--listen <tailscale-ip>`, traffic arrives
over the tailnet and usually needs no LAN rule. Your Tailscale ACLs decide
who can connect.

---

## Step 4: Add a machine

On the **hub**:

```sh
sudo vigosk node add nas
```

It prints a ready-to-paste command:

```
✓ node "nas" is ready to pair — the code below works once, for 15 minutes.

  On nas, as root, run ONE of these:

  • Fresh machine (installs the agent, pairs it, starts it):

      curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/agent/install.sh | sh -s -- vgk1.eyJ1Ijoi…

  • Agent already installed:

      vigosk-agent join vgk1.eyJ1Ijoi… && systemctl enable --now vigosk-agent
```

On the **other machine** (`nas`), as root, paste the "fresh machine" line.
You should see:

```
✓ installed /usr/local/bin/vigosk-agent (…)
✓ paired with https://192.168.1.10:8767 as "nas"
✓ vigosk-agent is running — this machine should now appear on the hub's FLEET layout (key 8)
```

> **Proxmox VE nodes:** add `--privileged` at the end
> (`… | sh -s -- vgk1.… --privileged`) to also show **LVM-thin pool usage**
> (`local-lvm` / `pve/data`, where your guests' disks live). Reading it needs
> root. With this flag the agent runs as root but still sandboxed, keeping
> only the one capability that query needs. Without it, everything else still
> works.

> **Want to read the code before running it?** The agent is one file,
> [`agent/vigosk_agent.py`](../agent/vigosk_agent.py), standard-library
> Python only. Download the `agent/` folder, read it, then run
> `sudo sh install.sh --from-dir . vgk1.…` to install from your local copy.

---

## Step 5: Look at it

On the hub's screen press **`8`** for FLEET or **`9`** for HUB · FLEET (or
`Esc` → OPTIONS → LAYOUT). The new machine appears within a few seconds, and
the layout re-fits itself to make room.

| Key / action | Does |
| --- | --- |
| `8` | FLEET layout (columns / list) |
| `9` | HUB · FLEET layout (clock + machine cards) |
| `V` (or tap `AUTO`) | cycle view: auto → columns → list |
| tap a machine | details: cores, disks, top processes, network |
| `Esc` | close details |

A green dot means online. Amber means the machine hasn't reported for a few
seconds (**stale**). Red means **offline**, and its column stays in place,
faded, so you notice.

**More machines:** repeat step 4 for each one. Names are lowercase letters,
digits, `.`, `_`, `-` (up to 32 characters). Up to 64 machines per hub.

---

## Everyday commands

Run these on the **hub**:

| Task | Command |
| --- | --- |
| see every machine and when it last reported | `sudo vigosk node list` |
| hub address, certificate fingerprint, status | `vigosk hub status` |
| remove a machine (it's cut off immediately) | `sudo vigosk node remove nas` |
| re-pair a machine (reinstalled, moved, lost its pairing) | `sudo vigosk node rekey nas`, then paste the new command on it |
| pair using a different hub address (e.g. Tailscale) | `sudo vigosk node add nas --url https://100.101.102.103:8767` |
| stop the hub (pairings are kept) | `sudo vigosk hub disable` |
| hub logs | `journalctl -u vigosk-hub -f` |

Run these on **an agent machine**:

| Task | Command |
| --- | --- |
| is it running? | `systemctl status vigosk-agent` |
| logs | `journalctl -u vigosk-agent -f` |
| which hub is it paired with? | `sudo vigosk-agent status` |
| see **exactly** what it sends | `vigosk-agent sample` |
| update the agent | re-run the installer **without** a code: `curl -fsSL …/agent/install.sh \| sh` (add `-s -- --privileged` if you used it). It keeps the pairing and restarts |
| uninstall | `curl -fsSL …/agent/install.sh \| sh -s -- --uninstall`, then `sudo vigosk node remove <name>` on the hub |

Uninstall the hub: `sudo vigosk hub disable && sudo rm /etc/systemd/system/vigosk-hub.service && sudo rm -rf /var/lib/private/vigosk-hub /var/lib/vigosk-hub`.

---

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| `cannot reach hub at https://…:8767` while pairing | firewall or wrong address | Do step 3. Test from the machine: `curl -vk https://HUB-IP:8767/` should say `404`, not time out. If the IP is wrong, `sudo vigosk node rekey <name> --url https://RIGHT-IP:8767` |
| `REFUSED: hub certificate fingerprint mismatch` | the agent reached something that isn't your hub (wrong IP, or the hub's certificate was re-created) | Check the address. If you reset the hub, re-pair with `node rekey` |
| `join code is invalid, expired or already used` | codes work once, for 15 minutes | `sudo vigosk node rekey <name>` for a fresh one |
| `…already exists — this machine is already paired` | re-running `join` | use the installer (it re-pairs automatically), or `vigosk-agent join --force <code>` |
| machine shows **offline** | agent stopped, network down, or machine off | on that machine: `systemctl status vigosk-agent` and `journalctl -u vigosk-agent -n 30` |
| agent log says `hub rejected our credentials` | the node was removed or re-keyed on the hub | `sudo vigosk node rekey <name>` on the hub, paste on the machine |
| `too many failed attempts` | 10 failed logins from one IP in 5 minutes | wait 10 minutes; fix the code/credentials first |
| Proxmox `local-lvm` / `pve/data` missing from a node | the agent isn't in privileged mode | re-run the installer with `sh -s -- --privileged` (no code needed); it restarts the agent |
| FLEET shows "the hub service isn't running yet" | hub not enabled | step 2, or `journalctl -u vigosk-hub -n 30` |
| red banner: `this hostname is not allowed` | you opened the dashboard through a hostname, e.g. behind nginx | add the name to `VIGOSK_ALLOWED_HOSTS`, see [OPTIONAL.md](../OPTIONAL.md) |
| `vigosk: command not found` on the hub | vigosk isn't on PATH | reinstall with `sudo` (step 1) or `sudo ln -s /usr/local/share/vigosk/bin/vigosk /usr/local/bin/vigosk` |
| `node management requires root` | ran `vigosk node …` without sudo | add `sudo` |

---

## Security

vigosk is meant for home labs, and running it should never make a machine
easier to attack. In plain terms:

1. **Nothing new listens on your other machines.** Agents only make one
   outbound HTTPS connection, to the hub they were paired with.
2. **Agents only trust *your* hub.** The pairing command contains the
   fingerprint of the hub's certificate. If anything else answers (a
   different machine, a man-in-the-middle), the agent refuses **before**
   sending anything. There's no "trust on first use" gap.
3. **Pairing commands are single-use and expire in 15 minutes.** Pasting one
   trades it for a long random secret you never see. A leaked command from
   your shell history or a screenshot is useless once used.
4. **The hub stores no passwords.** It keeps only SHA-256 hashes of pairing
   codes and secrets. Removing or re-keying a machine cuts it off instantly.
5. **Everything is sandboxed.** The hub and the agent run as throwaway
   system users with no Linux capabilities, a read-only view of the system and
   hard CPU/RAM limits (`systemd-analyze security` rates the hub 1.2 and the
   agent 2.6 even in privileged mode, both "OK"). The privileged agent keeps exactly one capability for the LVM query.
6. **The hub doesn't trust agents either.** Every value an agent sends is
   checked and rebuilt field by field (types, ranges, lengths; control and
   text-direction characters stripped). The dashboard only ever inserts
   remote text as plain text, never as HTML, so a compromised machine can't
   inject anything into your screen.
7. **Brute force is throttled.** 10 failed attempts from one IP in 5
   minutes → that IP is blocked for 10 minutes. Connection counts are capped
   per IP and in total, and slow or stalled clients are timed out.

**What each agent sends:** hostname, OS / kernel / CPU model / core count,
Proxmox version, CPU % (total + per core), load, CPU temperature and clock,
memory and swap, mounted filesystem usage (+ LVM-thin pools in privileged
mode), disk and network throughput, network interface names, uptime, the
number of processes and the **top 8 processes by CPU (PID, short name, CPU %,
memory %)**, and running container/VM counts on Proxmox. It **never** sends
process command lines (they can contain passwords), environment variables,
file contents, or users. Run `vigosk-agent sample` to see the exact payload.
Add `--no-procs` to the `ExecStart` line to stop sending the process list.

**The dashboard itself** (port 8765) has no login. It's meant to be viewed on
the kiosk, listens on `127.0.0.1` only, and refuses API requests arriving under
unknown hostnames (defeats DNS-rebinding attacks from websites you visit) and
cross-site settings changes. If you expose it on your network through a
reverse proxy, put authentication in front of it (see
[OPTIONAL.md](../OPTIONAL.md)).

**Good practice:** keep port 8767 on your LAN or tailnet only, give each
machine its own name, and remove machines you retire. Found a vulnerability?
See [SECURITY.md](../SECURITY.md).

---

## Reference

**Ports**

| Port | Where | What |
| --- | --- | --- |
| `8767/tcp` | hub, network-facing | agents → hub (TLS). The only port multi-node adds |
| `8765/tcp` | hub, `127.0.0.1` | the dashboard (unchanged) |

**Files**

| Path | Machine | Contents |
| --- | --- | --- |
| `/etc/systemd/system/vigosk-hub.service` | hub | hub service (written by `vigosk hub enable`) |
| `/var/lib/private/vigosk-hub/` (`/var/lib/vigosk-hub` inside the sandbox) | hub | `hub.crt`, `hub.key`, `nodes.json` (hashes only), mode 700 |
| `/run/vigosk-hub/hub.sock` | hub | local control socket (root + hub only) |
| `/usr/local/bin/vigosk-agent` | agent | the agent (single Python file) |
| `/etc/systemd/system/vigosk-agent.service` (+ `.d/privileged.conf`) | agent | agent service |
| `/etc/vigosk-agent/agent.json` | agent | pairing: hub URL, certificate fingerprint, node secret. Root-only, mode 600 |

**Environment variables**

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `VIGOSK_HUB_LISTEN` | hub | `0.0.0.0:8767` | agent listen address (set by `hub enable --listen/--port`) |
| `VIGOSK_HUB_ADVERTISE` | hub | auto (`https://<LAN IP>:8767`) | address put into pairing commands |
| `VIGOSK_HUB_SOCKET` | hub, dashboard, CLI | `/run/vigosk-hub/hub.sock` | control socket path |
| `VIGOSK_HUB_STATE` | hub | `/var/lib/vigosk-hub` | state directory |
| `VIGOSK_ALLOWED_HOSTS` | dashboard | *(empty)* | extra hostnames allowed to use `/api/*` (IPs and `localhost` always are) |
| `VIGOSK_AGENT_CONFIG` | agent | `/etc/vigosk-agent/agent.json` | pairing file |
| `VIGOSK_VERSION` | installers | latest release | version to install (`main` for the newest code) |

---

## Under the hood

For contributors and the curious.

**Data flow.** Each agent samples `/proc` and `/sys` every 2 s (CPU deltas from
`/proc/stat`, memory from `/proc/meminfo`, throughput from `/proc/net/dev` and
`/proc/diskstats`, filesystems via `statvfs`, temperature from `hwmon`), and
scans processes every 10 s. It POSTs a ~1.5 KB JSON sample (schema `v: 1`)
to `https://hub:8767/v1/push` over one keep-alive TLS connection. The hub keeps
the latest sample and 6 minutes of history per machine in memory. The dashboard
(`metrics.py`) serves `GET /api/fleet`: this machine, measured by the **same**
collector code the agents run (so every row means the same thing), merged with
the hub's nodes, read over the hub's Unix socket. The browser polls it once a
second, and only while the FLEET layout is on screen. The other layouts pay
nothing, and the local collector parks itself after 60 s without a viewer.

**Design choices**

- *Push, not pull.* Pull (the hub polls agents) would mean a listening port on
  every machine. With push, the hub is the only listener, so there's one
  thing to firewall, and agents work from behind NAT.
- *Pinned self-signed certificate.* No CA to run, no expiry to babysit
  (10-year ECDSA P-256), and pinning is stricter than CA validation: only this
  one certificate is accepted, not anything a CA would sign.
- *Standard library only.* No `psutil` or pip on the machines you monitor.
  One auditable file, nothing to keep patched.
- *Privilege separation.* The network-facing hub is its own unprivileged,
  sandboxed process, separate from the dashboard server.

**Wire protocol** (`/v1`): `POST /v1/enroll {token, host, agent, schema}` →
`{node, name, secret, interval}`. `POST /v1/push` with
`Authorization: Bearer <node>.<secret>` and the sample → `{ok, interval,
need_sys}`. The hub can change the push interval and ask for the static
system info again (e.g. after it restarts). Unknown schema versions get a
clear `400` telling you which side to upgrade.

**Roadmap ideas**

- Open any existing layout (gauges, heatmap, …) *focused* on a remote machine.
- An agent-less Proxmox source that reads cluster members through a read-only
  API token.
- Alerts (machine offline, disk above a threshold) via ntfy / email.
- Optional mutual TLS and certificate rotation without re-pairing.
- Lowering the dashboard's own cost while FLEET is showing (its local sampler
  runs at 10 Hz for the single-machine layouts).
