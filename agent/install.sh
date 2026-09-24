#!/bin/sh
# vigosk-agent installer — run as root on each machine you want on the dashboard.
#
#   curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/agent/install.sh | sh -s -- <JOIN_CODE>
#
# With a join code it installs, pairs and starts the agent in one go.
# Without one it just installs; pair later with `vigosk-agent join <code>`.
#
# Options (after `sh -s --`):
#   --privileged     also report LVM thin-pool usage (Proxmox local-lvm);
#                    runs the agent as root with only CAP_SYS_ADMIN
#   --from-dir DIR   install from a local copy of the repo's agent/ folder
#                    instead of downloading (air-gapped / audited installs)
#   --uninstall      stop and remove the agent and its pairing
#
# Environment:
#   VIGOSK_VERSION   release to install (e.g. 0.2.0; default: latest release,
#                    falling back to the main branch)
set -eu

REPO="gabegaglio/vigosk"
BIN=/usr/local/bin/vigosk-agent
UNIT=/etc/systemd/system/vigosk-agent.service
DROPIN_DIR=/etc/systemd/system/vigosk-agent.service.d
CONF_DIR=/etc/vigosk-agent

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
die() { red "✗ $*"; exit 1; }

CODE=""; PRIV=0; FROM=""; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --privileged) PRIV=1 ;;
    --from-dir) FROM="${2:?--from-dir needs a directory}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    vgk1.*) CODE="$1" ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run as root (sudo sh -s -- …)"
[ "$(uname -s)" = "Linux" ] || die "vigosk-agent supports Linux only"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now vigosk-agent 2>/dev/null || true
  rm -rf "$BIN" "$UNIT" "$DROPIN_DIR" "$CONF_DIR"
  systemctl daemon-reload 2>/dev/null || true
  ok "vigosk-agent removed. Also run \`vigosk node remove <name>\` on the hub."
  exit 0
fi

command -v python3 >/dev/null 2>&1 || die "python3 is required (apt install python3)"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "python3 3.8+ is required"
command -v systemctl >/dev/null 2>&1 || die "systemd is required for the service (you can still run: python3 vigosk_agent.py run)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {  # fetch <repo-path> <dest>
  if [ -n "$FROM" ]; then
    cp "$FROM/$(basename "$1")" "$2" || die "missing $FROM/$(basename "$1")"
  else
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/$1" -o "$2" || die "download failed: $1 ($REF)"
  fi
}

if [ -z "$FROM" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  VERSION="${VIGOSK_VERSION:-latest}"
  if [ "$VERSION" = "latest" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1 || true)
  fi
  REF="main"
  if [ -n "$VERSION" ] && [ "$VERSION" != "main" ]; then
    # Releases publish the agent with a checksum — verify it.
    base="https://github.com/$REPO/releases/download/v$VERSION"
    if curl -fsSL "$base/vigosk-agent-$VERSION.py" -o "$TMP/vigosk_agent.py" 2>/dev/null \
       && curl -fsSL "$base/vigosk-agent-$VERSION.py.sha256" -o "$TMP/sum" 2>/dev/null; then
      want=$(cut -d' ' -f1 "$TMP/sum"); got=$(sha256sum "$TMP/vigosk_agent.py" | cut -d' ' -f1)
      [ "$want" = "$got" ] || die "checksum mismatch for vigosk-agent $VERSION — refusing to install"
      ok "downloaded vigosk-agent $VERSION (sha256 verified)"
      REF="v$VERSION"
    else
      rm -f "$TMP/vigosk_agent.py"   # never keep a half-verified download
      REF="main"
    fi
  fi
  [ -s "$TMP/vigosk_agent.py" ] || { fetch agent/vigosk_agent.py "$TMP/vigosk_agent.py"; ok "downloaded vigosk-agent from $REF"; }
else
  fetch agent/vigosk_agent.py "$TMP/vigosk_agent.py"
fi
fetch agent/vigosk-agent.service "$TMP/vigosk-agent.service"
[ "$PRIV" -eq 1 ] && fetch agent/vigosk-agent-privileged.conf "$TMP/privileged.conf"

python3 -m py_compile "$TMP/vigosk_agent.py" || die "downloaded agent doesn't compile — aborting"

install -m 0755 "$TMP/vigosk_agent.py" "$BIN"
install -m 0644 "$TMP/vigosk-agent.service" "$UNIT"
if [ "$PRIV" -eq 1 ]; then
  install -d -m 0755 "$DROPIN_DIR"
  install -m 0644 "$TMP/privileged.conf" "$DROPIN_DIR/privileged.conf"
  ok "privileged mode on (LVM thin pools will be reported)"
fi
install -d -m 0700 "$CONF_DIR"
systemctl daemon-reload
ok "installed $BIN ($(sha256sum "$BIN" | cut -c1-16)…)"

if [ "$PRIV" -eq 0 ] && command -v lvs >/dev/null 2>&1 && lvs --noheadings -o lv_attr 2>/dev/null | grep -q '^ *t'; then
  printf '  note: this machine has LVM thin pools. To show their usage, re-run with --privileged.\n'
fi

if [ -z "$CODE" ]; then
  if [ -f "$CONF_DIR/agent.json" ]; then
    # Already paired: this was an update — restart onto the new version.
    systemctl restart vigosk-agent
    sleep 3
    systemctl is-active --quiet vigosk-agent && ok "vigosk-agent updated and restarted" \
      || { red "vigosk-agent failed to restart:"; journalctl -u vigosk-agent -n 20 --no-pager >&2; exit 1; }
    exit 0
  fi
  printf '\nnext: vigosk-agent join <code> && systemctl enable --now vigosk-agent\n'
  printf '      (get a code on the hub with: sudo vigosk node add <name>)\n'
  exit 0
fi

if [ -f "$CONF_DIR/agent.json" ]; then
  VIGOSK_INSTALLER=1 "$BIN" join --force "$CODE"
else
  VIGOSK_INSTALLER=1 "$BIN" join "$CODE"
fi
systemctl enable vigosk-agent >/dev/null 2>&1
systemctl restart vigosk-agent
sleep 4
if systemctl is-active --quiet vigosk-agent; then
  ok "vigosk-agent is running — this machine should now appear on the hub's FLEET layouts (keys 8 and 9)"
else
  red "vigosk-agent failed to start. Recent log:"
  journalctl -u vigosk-agent -n 20 --no-pager >&2 || true
  exit 1
fi
