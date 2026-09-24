# vigosk-agent

The agent that runs on every machine you add to a vigosk hub
(see **[docs/MULTINODE.md](../docs/MULTINODE.md)** for the full guide).

| File | What it is |
| --- | --- |
| `vigosk_agent.py` | the whole agent: one file, Python standard library only (installed as `/usr/local/bin/vigosk-agent`) |
| `install.sh` | installer: `curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/agent/install.sh \| sh -s -- <join-code> [--privileged]` |
| `vigosk-agent.service` | hardened systemd unit (throwaway user, no capabilities, read-only system, CPU/RAM caps) |
| `vigosk-agent-privileged.conf` | optional drop-in so Proxmox LVM-thin usage can be read (root, but only `CAP_SYS_ADMIN`) |

```sh
vigosk-agent join <code>    # pair with a hub (the hub prints the code: sudo vigosk node add <name>)
vigosk-agent run            # push samples forever (what the service runs)
vigosk-agent sample         # print one sample: exactly what is sent to the hub
vigosk-agent status         # which hub it's paired with (never prints the secret)
```

It never listens on a port, never sends process command lines, and refuses to
talk to any hub whose certificate doesn't match the fingerprint in the join
code. It's short enough to read before you run it, and we'd like you to.

To install from a local, reviewed copy instead of downloading:

```sh
sudo sh install.sh --from-dir . <join-code>
```
