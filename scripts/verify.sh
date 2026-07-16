#!/usr/bin/env bash
# Verification gate. Modes:
#   verify.sh                 type-check + full test suite for every workspace
#   verify.sh <package-dir>   one workspace (e.g. verify.sh pi-herdr-dispatch)
#   verify.sh live            Herdr live contract tests (requires a Herdr pane)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

self_check() {
  # AGENTS.md's phrase table and scripts/ must reference each other both ways.
  local script name
  for script in scripts/*.sh; do
    name="$(basename "$script")"
    if ! grep -q "$name" AGENTS.md; then
      echo "verify: scripts/$name is not documented in AGENTS.md's phrase table" >&2
      exit 1
    fi
  done
  for name in $(grep -o 'scripts/[a-z-]*\.sh' AGENTS.md | sort -u); do
    if [[ ! -f "$name" ]]; then
      echo "verify: AGENTS.md references $name, which does not exist" >&2
      exit 1
    fi
  done
}

mode="${1:-all}"
case "$mode" in
  all)
    self_check
    npm run check
    npm test
    ;;
  live)
    for var in HERDR_SOCKET_PATH HERDR_TEST_WORKSPACE_ID; do
      if [[ -z "${!var:-}" ]]; then
        echo "verify live: $var is not set. Run inside a Herdr pane and export HERDR_TEST_WORKSPACE_ID (a workspace with at least one pane)." >&2
        exit 1
      fi
    done
    (cd packages/pi-herdr-dispatch && HERDR_LIVE_CONTRACT=1 npx vitest run test/live)
    ;;
  *)
    if [[ ! -d "packages/$mode" ]]; then
      echo "verify: unknown mode or package '$mode' (expected: all, live, or a directory under packages/)" >&2
      exit 1
    fi
    npm run check --workspace "packages/$mode"
    npm test --workspace "packages/$mode"
    ;;
esac
echo "verify: OK ($mode)"
