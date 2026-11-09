#!/bin/bash
# Double-click in Finder to install the docker-dash command.
cd "$(dirname "$0")"
./install.sh
echo
read -n 1 -s -r -p "Press any key to close..."
