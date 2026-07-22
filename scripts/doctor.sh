#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

node_version="$(node --version 2>/dev/null || true)"
if [[ "${node_version#v}" =~ ^([0-9]+) ]] && (( BASH_REMATCH[1] >= 24 )); then
  pass "node $node_version (>= 24)"
else
  fail "node >= 24 required, found '${node_version:-not installed}'"
fi

if [[ -f node_modules/.package-lock.json ]]; then
  pass "dependencies installed"
else
  fail "node_modules missing — run 'npm ci'"
fi

if (( failures > 0 )); then
  echo "doctor: $failures hard failure(s)"
  exit 1
fi
echo "doctor: OK"
