#!/usr/bin/env bash
# Verification gate. Modes:
#   verify.sh                 type-check + test every workspace
#   verify.sh <package-dir>   verify one workspace under packages/
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

self_check() {
  local script name
  for script in scripts/*.sh; do
    name="$(basename "$script")"
    if ! grep -q "$name" AGENTS.md; then
      echo "verify: scripts/$name is not documented in AGENTS.md" >&2
      exit 1
    fi
  done
}

mode="${1:-all}"
case "$mode" in
  all)
    self_check
    npm run check:tools
    npm run test:tools
    if compgen -G "packages/*/package.json" >/dev/null; then
      npm run check
      npm test
    fi
    ;;
  *)
    if [[ ! -d "packages/$mode" ]]; then
      echo "verify: unknown package '$mode'" >&2
      exit 1
    fi
    npm run check --workspace "packages/$mode"
    npm test --workspace "packages/$mode"
    ;;
esac
echo "verify: OK ($mode)"
