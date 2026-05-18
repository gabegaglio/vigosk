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

if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  printf '\033[33m!\033[0m chromium not found — vigosk will only run in --server-only mode\n'
fi

if [ "$VERSION" = "latest" ]; then
  printf 'resolving latest release of %s...\n' "$REPO"
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' \
    | head -n1)
  if [ -z "${VERSION:-}" ]; then
    printf '\033[31m✗\033[0m failed to resolve latest release. Is the repo public? Are there any releases yet?\n' >&2
    printf '  fallback: install from main with VIGOSK_VERSION=main\n' >&2
    exit 1
  fi
fi

TARBALL="vigosk-$VERSION.tar.gz"
URL="https://github.com/$REPO/releases/download/v$VERSION/$TARBALL"

printf 'installing vigosk %s → %s\n' "$VERSION" "$PREFIX"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'downloading %s...\n' "$URL"
if ! curl -fsSL "$URL" -o "$TMP/$TARBALL"; then
  printf '\033[31m✗\033[0m download failed. Check that release v%s exists at https://github.com/%s/releases\n' "$VERSION" "$REPO" >&2
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
