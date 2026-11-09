#!/usr/bin/env bash
# Removes the `docker-dash` command installed by install.sh.
set -euo pipefail
PREFIX="${PREFIX:-$HOME/.local}"
TARGET="$PREFIX/bin/docker-dash"

if [ -f "$TARGET" ]; then
  rm "$TARGET"
  echo "✓ removed $TARGET"
else
  echo "nothing to remove at $TARGET"
fi
echo "(the PATH line in ~/.zshrc was kept, since ~/.local/bin is also used by other tools)"
