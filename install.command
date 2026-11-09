#!/bin/bash
# Duplo clique no Finder para instalar o comando docker-dash.
cd "$(dirname "$0")"
./install.sh
echo
read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
