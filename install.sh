#!/usr/bin/env bash
# Installs the `docker-dash` command.
#   1. installs Bun if it's missing (only needed to compile)
#   2. compiles a single binary (doesn't need Bun/Node to run)
#   3. copies it to ~/.local/bin (or PREFIX/bin) and makes sure that folder is in PATH
#
# Usage: ./install.sh                (installs to ~/.local/bin)
#        PREFIX=/usr/local ./install.sh
set -euo pipefail

cd "$(dirname "$0")"
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
NAME="docker-dash"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }

# 1) Bun
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  bold "Installing Bun (only needed to compile)…"
  curl -fsSL https://bun.sh/install | bash
fi
ok "bun $(bun --version)"

# 2) dependencies + compile
bold "Installing dependencies…"
bun install --frozen-lockfile 2>/dev/null || bun install
bold "Compiling the binary…"
mkdir -p build
bun build --compile --minify src/cli.tsx --outfile "build/$NAME"
ok "build/$NAME ($(du -h "build/$NAME" | cut -f1))"

# 3) install
mkdir -p "$BIN_DIR"
cp "build/$NAME" "$BIN_DIR/$NAME"
chmod +x "$BIN_DIR/$NAME"
ok "installed to $BIN_DIR/$NAME"

# 4) PATH
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-zsh}")"
    case "$SHELL_NAME" in
      zsh)  RC="$HOME/.zshrc" ;;
      bash) RC="$HOME/.bash_profile" ;;
      *)    RC="$HOME/.profile" ;;
    esac
    LINE="export PATH=\"$BIN_DIR:\$PATH\""
    if ! grep -qsF "$LINE" "$RC"; then
      printf '\n# docker-dash\n%s\n' "$LINE" >> "$RC"
      ok "added $BIN_DIR to PATH in $RC"
    fi
    warn "open a new terminal (or run: source $RC) for the command to work"
    ;;
esac

# 5) warnings about runtime dependencies
command -v colima >/dev/null 2>&1 || [ -x /opt/homebrew/bin/colima ] || warn "colima not found (brew install colima)"
command -v docker >/dev/null 2>&1 || [ -x /opt/homebrew/bin/docker ] || warn "docker CLI not found (brew install docker)"

echo
bold "Done! Type: $NAME"
