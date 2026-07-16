#!/usr/bin/env bash
# Environment diagnosis. Hard requirements fail the script; live/runtime
# prerequisites (Herdr, Pi) are reported but only warn, because they are
# needed for live testing and /reload loops, not for check/test.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf '  warn  %s\n' "$1"; }

echo "Hard requirements"

node_version="$(node --version 2>/dev/null || true)"
if [[ "${node_version#v}" =~ ^([0-9]+) ]] && (( BASH_REMATCH[1] >= 24 )); then
  pass "node $node_version (>= 24)"
else
  fail "node >= 24 required, found '${node_version:-not installed}'"
fi

if node --input-type=module -e "await import('node:sqlite')" 2>/dev/null; then
  pass "node:sqlite available"
else
  fail "node:sqlite unavailable (Registry cannot open)"
fi

if [[ -f node_modules/.package-lock.json ]]; then
  pass "dependencies installed (run 'npm ci' after lockfile changes)"
else
  fail "node_modules missing — run 'npm ci'"
fi

echo "Live/runtime prerequisites (needed for 'verify.sh live' and /reload loops)"

if command -v pi >/dev/null 2>&1; then
  pass "pi on PATH"
else
  warn "pi not on PATH — extension cannot be loaded interactively"
fi

if command -v herdr >/dev/null 2>&1; then
  pass "herdr on PATH"
else
  warn "herdr not on PATH"
fi

for var in HERDR_SOCKET_PATH HERDR_WORKSPACE_ID HERDR_PANE_ID; do
  if [[ -n "${!var:-}" ]]; then
    pass "$var set"
  else
    warn "$var not set — not inside a Herdr pane"
  fi
done

if [[ -n "${HERDR_SOCKET_PATH:-}" ]]; then
  if [[ -S "$HERDR_SOCKET_PATH" ]]; then
    pass "Herdr socket exists"
  else
    warn "HERDR_SOCKET_PATH does not point to a socket"
  fi
fi

if [[ -n "${HERDR_TEST_WORKSPACE_ID:-}" ]]; then
  pass "HERDR_TEST_WORKSPACE_ID set (live contract tests runnable)"
else
  warn "HERDR_TEST_WORKSPACE_ID not set — 'verify.sh live' will refuse to run"
fi

if (( failures > 0 )); then
  echo "doctor: $failures hard failure(s)"
  exit 1
fi
echo "doctor: OK"
