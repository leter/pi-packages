#!/usr/bin/env bash
set -euo pipefail

root=${HERDR_PLUGIN_ROOT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}
config_dir=${HERDR_PLUGIN_CONFIG_DIR:-"${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/local.agent-icons"}

mkdir -p "$config_dir"
# Always refresh the shipped defaults into config when the file is missing.
# Existing user edits in icons.json are preserved.
if [[ ! -f "$config_dir/icons.json" ]]; then
  cp "$root/default-icons.json" "$config_dir/icons.json"
fi
python3 "$root/scripts/refresh.py"
printf 'Agent activity labels refreshed.\n'
