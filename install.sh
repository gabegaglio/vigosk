#!/usr/bin/env sh
# vigosk installer — downloads the latest release tarball and installs it to
# /usr/local (if run as root) or ~/.local (otherwise). Drops a `vigosk`
# launcher onto your PATH.
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/gabegaglio/vigosk/main/install.sh | sh
#
# Pin a version:
#   VIGOSK_VERSION=0.1.0 curl -fsSL .../install.sh | sh
#
# Override the install location:
#   VIGOSK_PREFIX=$HOME/apps curl -fsSL .../install.sh | sh

set -eu

REPO="gabegaglio/vigosk"
VERSION="${VIGOSK_VERSION:-latest}"

if [ "$(id -u)" -eq 0 ]; then
  PREFIX="${VIGOSK_PREFIX:-/usr/local}"
else
  PREFIX="${VIGOSK_PREFIX:-$HOME/.local}"
fi

SHARE="$PREFIX/share/vigosk"
BIN="$PREFIX/bin"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '\033[31m✗\033[0m missing required dependency: %s\n' "$1" >&2
    exit 1
  }
}

need curl
need tar
need python3

# psutil is required by metrics.py — try to install via the distro package
# first (cleanest, no pip), fall back to pip --user, otherwise instruct.
if ! python3 -c "import psutil" >/dev/null 2>&1; then
  printf 'installing psutil (required by metrics.py)...\n'
  installed=0
  if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    apt-get install -y python3-psutil >/dev/null 2>&1 && installed=1
  elif [ "$(id -u)" -eq 0 ] && command -v dnf >/dev/null 2>&1; then
    dnf install -y python3-psutil >/dev/null 2>&1 && installed=1
  elif [ "$(id -u)" -eq 0 ] && command -v pacman >/dev/null 2>&1; then
    pacman -S --noconfirm python-psutil >/dev/null 2>&1 && installed=1
  fi
  if [ "$installed" -eq 0 ] && command -v pip3 >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      pip3 install --break-system-packages psutil >/dev/null 2>&1 && installed=1 \
        || pip3 install psutil >/dev/null 2>&1 && installed=1
    else
      pip3 install --user psutil >/dev/null 2>&1 && installed=1
    fi
  fi
  if [ "$installed" -eq 0 ] || ! python3 -c "import psutil" >/dev/null 2>&1; then
    printf '\033[31m✗\033[0m could not install psutil. Install it manually:\n' >&2
    printf '    debian/ubuntu:  apt install python3-psutil\n' >&2
    printf '    fedora/rhel:    dnf install python3-psutil\n' >&2
    printf '    arch:           pacman -S python-psutil\n' >&2
    printf '    via pip:        pip3 install --user psutil\n' >&2
    exit 1
  fi
fi

if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  printf '\033[33m!\033[0m chromium not found — vigosk will only run in --server-only mode\n'
fi

if [ "$VERSION" = "latest" ]; then
  printf 'resolving latest release of %s...\n' "$REPO"
  resolved=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' \
    | head -n1)
  if [ -n "${resolved:-}" ]; then
    VERSION="$resolved"
  else
    printf '\033[33m!\033[0m no published releases yet — falling back to the main branch.\n' >&2
    VERSION=main
  fi
fi

# Pick the right URL based on whether VERSION names a release or a branch.
# Anything that looks like X.Y.Z is treated as a release tag (e.g. 0.1.0);
# everything else (main, master, a feature branch, a commit ref) is fetched
# from the GitHub archive endpoint.
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*|v[0-9]*.[0-9]*.[0-9]*)
    TAG="${VERSION#v}"
    TARBALL="vigosk-$TAG.tar.gz"
    URL="https://github.com/$REPO/releases/download/v$TAG/$TARBALL"
    SOURCE_LABEL="release v$TAG"
    ;;
  *)
    TARBALL="vigosk-$VERSION.tar.gz"
    URL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz"
    SOURCE_LABEL="branch $VERSION"
    ;;
esac

printf 'installing vigosk (%s) → %s\n' "$SOURCE_LABEL" "$PREFIX"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'downloading %s...\n' "$URL"
if ! curl -fsSL "$URL" -o "$TMP/$TARBALL"; then
  printf '\033[31m✗\033[0m download failed: %s\n' "$URL" >&2
  printf '  for branch installs, try: VIGOSK_VERSION=main curl ... | sh\n' >&2
  exit 1
fi

tar -xzf "$TMP/$TARBALL" -C "$TMP"
SRC_DIR=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)
[ -n "$SRC_DIR" ] || { printf '\033[31m✗\033[0m tarball has no top-level directory\n' >&2; exit 1; }

mkdir -p "$SHARE" "$BIN"
cp -r "$SRC_DIR"/. "$SHARE"/
[ -f "$SHARE/bin/vigosk" ] && cp "$SHARE/bin/vigosk" "$BIN/vigosk" || {
  printf '\033[31m✗\033[0m wrapper script bin/vigosk missing from tarball\n' >&2
  exit 1
}
chmod +x "$BIN/vigosk"

printf '\n\033[32m✓\033[0m vigosk %s installed\n' "$VERSION"
printf '  source:   %s\n' "$SHARE"
printf '  launcher: %s\n' "$BIN/vigosk"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    printf '\n\033[33m!\033[0m %s is not on your PATH.\n' "$BIN"
    printf '  add this line to your ~/.bashrc or ~/.zshrc and re-open your shell:\n'
    printf '    export PATH="%s:$PATH"\n' "$BIN"
    ;;
esac

printf '\nrun: \033[1mvigosk --help\033[0m\n'
