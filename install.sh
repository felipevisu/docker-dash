#!/usr/bin/env bash
# Instala o comando `docker-dash`.
#   1. instala o Bun se ele não existir (só para compilar)
#   2. compila um binário único (não depende de Bun/Node para rodar)
#   3. copia para ~/.local/bin (ou PREFIX/bin) e garante que a pasta está no PATH
#
# Uso:  ./install.sh                 (instala em ~/.local/bin)
#       PREFIX=/usr/local ./install.sh
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
  bold "Instalando o Bun (necessário só para compilar)…"
  curl -fsSL https://bun.sh/install | bash
fi
ok "bun $(bun --version)"

# 2) dependências + compilação
bold "Instalando dependências…"
bun install --frozen-lockfile 2>/dev/null || bun install
bold "Compilando o binário…"
mkdir -p build
bun build --compile --minify src/cli.tsx --outfile "build/$NAME"
ok "build/$NAME ($(du -h "build/$NAME" | cut -f1))"

# 3) instalação
mkdir -p "$BIN_DIR"
cp "build/$NAME" "$BIN_DIR/$NAME"
chmod +x "$BIN_DIR/$NAME"
ok "instalado em $BIN_DIR/$NAME"

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
      ok "adicionei $BIN_DIR ao PATH em $RC"
    fi
    warn "abra um novo terminal (ou rode: source $RC) para o comando funcionar"
    ;;
esac

# 5) avisos sobre dependências em tempo de execução
command -v colima >/dev/null 2>&1 || [ -x /opt/homebrew/bin/colima ] || warn "colima não encontrado (brew install colima)"
command -v docker >/dev/null 2>&1 || [ -x /opt/homebrew/bin/docker ] || warn "docker CLI não encontrado (brew install docker)"

echo
bold "Pronto! Digite: $NAME"
