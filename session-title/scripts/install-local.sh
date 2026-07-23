#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
destination=${PI_AGENT_HOME:-"$HOME/.pi/agent"}/extensions

install -d "$destination"
install -m 0644 "$root/herdr-session-title.ts" "$destination/herdr-session-title.ts"

printf 'Installed Session Title extension to %s\n' "$destination/herdr-session-title.ts"
printf 'Run /reload in Pi to load the updated extension.\n'
