#!/usr/bin/env bash
# Remove o comando `docker-dash` instalado pelo install.sh.
set -euo pipefail
PREFIX="${PREFIX:-$HOME/.local}"
TARGET="$PREFIX/bin/docker-dash"

if [ -f "$TARGET" ]; then
  rm "$TARGET"
  echo "✓ removido $TARGET"
else
  echo "nada para remover em $TARGET"
fi
echo "(a linha de PATH em ~/.zshrc foi mantida, pois ~/.local/bin também é usado por outras ferramentas)"
