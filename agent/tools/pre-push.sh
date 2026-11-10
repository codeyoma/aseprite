#!/usr/bin/env bash
# Optional git pre-push hook: the bridge tests, with the Lua-tests stamp
# required (CI cannot run the Lua tests, so it only warns there).
# Install (from the repository root):
#   ln -s "$PWD/agent/tools/pre-push.sh" "$(git rev-parse --git-common-dir)/hooks/pre-push"
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root/agent/bridge"
ASEPRITE_AGENT_REQUIRE_LUA=1 npm test
