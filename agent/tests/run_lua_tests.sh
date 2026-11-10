#!/usr/bin/env bash
# Runs the extension's batch-mode Lua tests (agent/tests/*_test.lua) and the
# syntax check in a headless Aseprite, each with every parameter the tests
# use (ext, fixtures, guide, tmp), and prints one line per test.
# Usage: agent/tests/run_lua_tests.sh [name ...]   (default: all; names without _test.lua)
# ASEPRITE=<binary> picks the Aseprite build (default: build/bin/aseprite).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bin="${ASEPRITE:-$root/build/bin/aseprite}"
[ -x "$bin" ] || { echo "No Aseprite at $bin (set ASEPRITE)"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ $# -gt 0 ]; then names=("$@"); else
  names=(syntax_check); for f in "$here"/*_test.lua; do n="$(basename "$f" .lua)"; names+=("${n%_test}"); done
fi

failed=0
for n in "${names[@]}"; do
  script="$here/${n}_test.lua"; [ "$n" = syntax_check ] && script="$here/syntax_check.lua"
  out="$("$bin" -b --script-param ext="$root/agent/extension" --script-param fixtures="$here/fixtures" \
    --script-param guide="$root/agent/guide" --script-param tmp="$tmp" --script "$script" 2>&1)"
  if grep -qE '^FAIL|stack traceback|^[^ ]*\.lua:[0-9]+:' <<<"$out" || ! grep -qE '^ALL .*PASS' <<<"$out"; then
    failed=$((failed + 1)); echo "FAIL $n"; grep -E '^FAIL|\.lua:[0-9]+:' <<<"$out" | head -5 | sed 's/^/  /'
  else
    echo "ok   $n"
  fi
done
[ $failed -eq 0 ] && echo "LUA TESTS PASSED" || { echo "LUA TESTS FAILED ($failed)"; exit 1; }
