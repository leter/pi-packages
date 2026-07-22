#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
destination=${HERDR_AGENT_ACTIVITY_HOME:-"${XDG_DATA_HOME:-$HOME/.local/share}/herdr-agent-icons"}

install -d "$destination/config" "$destination/scripts" "$destination/tests"
install -m 0644 "$root/README.md" "$destination/README.md"
install -m 0644 "$root/config/sidebar.toml" "$destination/config/sidebar.toml"
install -m 0644 "$root/default-icons.json" "$destination/default-icons.json"
install -m 0644 "$root/herdr-plugin.toml" "$destination/herdr-plugin.toml"
install -m 0755 "$root/scripts/refresh.py" "$destination/scripts/refresh.py"
install -m 0755 "$root/scripts/setup.sh" "$destination/scripts/setup.sh"
install -m 0755 "$root/tests/test_refresh.py" "$destination/tests/test_refresh.py"

python3 "$destination/tests/test_refresh.py"
python3 "$destination/scripts/refresh.py"

printf 'Installed Agent activity plugin to %s\n' "$destination"
printf 'Merge %s into ~/.config/herdr/config.toml when the sidebar layout changes.\n' "$root/config/sidebar.toml"
