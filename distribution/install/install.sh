#!/bin/sh
# Constellate: one command for the contributor app and x0x.
#   curl -fsSL <release URL>/install.sh | sh            (once published)
#   sh install.sh --dry-run                              (show what it would do)
# It asks before installing anything, never starts a daemon without asking,
# and verifies x0x with x0x's own GPG-checking installer.
# Prepared, not published: it goes out only with an approved release.
set -eu

DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi; }
ask() { # ask "question" -> 0 for yes
  if [ "$YES" = 1 ] || [ "$DRY" = 1 ]; then return 0; fi
  printf '%s [y/N] ' "$1"; read -r reply </dev/tty || return 1
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
have() { command -v "$1" >/dev/null 2>&1; }

HOME_DIR="${CONSTELLATE_HOME:-$HOME/.constellate}"
SRC="${CONSTELLATE_SOURCE:-https://github.com/nkoteskey/constellate}"
X0X_INSTALLER="https://raw.githubusercontent.com/saorsa-labs/x0x/main/scripts/install.py"

say "Constellate installer"
say "  where: $HOME_DIR"
[ "$DRY" = 1 ] && say "  (dry run: nothing will change)"

# 1. Node.js 20 or newer
if have node; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt 20 ]; then say "Node.js $major is too old: Constellate needs 20 or newer (https://nodejs.org)."; exit 1; fi
  say "✓ Node.js $(node -v)"
else
  say "Constellate needs Node.js 20 or newer: https://nodejs.org (or: brew install node)."; exit 1
fi

# 2. x0x, via its own installer, which checks pinned GPG signatures and does not start a daemon
if have x0x; then
  say "✓ x0x $(x0x --version 2>/dev/null || echo installed)"
elif ask "Install x0x (the network Constellate runs on) using x0x's signature-checking installer?"; then
  have python3 || { say "x0x's installer needs python3."; exit 1; }
  tmp=$(mktemp -d)
  run curl -fsSL "$X0X_INSTALLER" -o "$tmp/install.py"
  run python3 "$tmp/install.py"
  say "  x0x installed. Start it when you're ready with: x0x start"
else
  say "  Skipped x0x. Constellate runs offline until you install it."
fi

# 3. Constellate itself: from npm once published, from source until then
if npm view constellate-mcp version >/dev/null 2>&1; then
  ask "Install Constellate from npm?" && run npm install -g constellate-mcp
  BIN="constellate"
else
  say "  Constellate isn't on npm yet: installing from source."
  have git || { say "Installing from source needs git."; exit 1; }
  if [ -d "$HOME_DIR/app/.git" ]; then run git -C "$HOME_DIR/app" pull --ff-only
  else run mkdir -p "$HOME_DIR"; run git clone --depth 1 "$SRC" "$HOME_DIR/app"; fi
  run sh -c "cd '$HOME_DIR/app' && npm install --no-audit --no-fund"
  BIN="npx --prefix $HOME_DIR/app tsx $HOME_DIR/app/src/cli.ts"
fi
say "✓ Constellate"

# 4. A free, open model that fits this machine
if have ollama; then say "✓ Ollama"; else say "  For free local models, install Ollama: https://ollama.com (Constellate suggests which models fit)."; fi

say ""
say "Done. Next:"
say "  $BIN models        see which free models fit this machine"
say "  $BIN contribute    lend idle compute (status and controls at http://127.0.0.1:4748)"
say "  $BIN setup         connect Claude, Cursor or any MCP agent"
