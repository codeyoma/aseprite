#!/usr/bin/env bash
# Builds dist/aseprite-agent-<version>.aseprite-extension from agent/extension.
# An .aseprite-extension file is a zip with package.json at its root.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/package.json').version")
out="dist/aseprite-agent-${version}.aseprite-extension"
mkdir -p dist
rm -f "$out"
(cd extension && zip -q -X "../$out" package.json protocol.json agent.lua document_handlers.lua bridge_connection.lua chat_panel.lua conversation.lua turn_history.lua)
echo "$out"
