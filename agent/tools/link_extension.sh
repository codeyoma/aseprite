#!/usr/bin/env bash
# Links agent/extension into the agent's dev instance of Aseprite (its own
# user folder, not the user's): see tools/dev.mjs and docs/INSTANCES.md.
exec node "$(dirname "$0")/dev.mjs" install
