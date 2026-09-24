# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's
private reporting instead: **Security → Report a vulnerability** on
<https://github.com/gabegaglio/vigosk>. Include what you found, how to
reproduce it and which version (`vigosk --version`, `vigosk-agent --version`).
You'll get a reply within a week; fixes are released as soon as they're ready
and credited unless you prefer otherwise.

## Supported versions

Only the latest release (and `main`) receives security fixes.

## Scope and design

- The dashboard (`metrics.py`, port 8765) binds `127.0.0.1` and has no
  authentication by design. Exposing it to a network is the operator's
  choice. See [OPTIONAL.md](OPTIONAL.md).
- Multi-node (`fleet.py` hub on TCP 8767 and `agent/vigosk_agent.py`) is
  designed for LAN / tailnet use. Its threat model, pairing protocol and
  sandboxing are documented in [docs/MULTINODE.md](docs/MULTINODE.md#security).
  Reports that break those guarantees (impersonating a hub or node, reading
  another node's data, reaching the hub's control socket, code execution via
  a crafted payload, escaping the systemd sandbox) are especially welcome.
