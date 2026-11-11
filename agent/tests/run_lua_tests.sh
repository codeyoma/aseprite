#!/usr/bin/env bash
# Kept for habit: the Lua test runner is tests/run_lua_tests.mjs (macOS, Linux, Windows).
exec node "$(dirname "$0")/run_lua_tests.mjs" "$@"
