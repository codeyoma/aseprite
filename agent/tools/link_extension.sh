#!/usr/bin/env bash
# Installs agent/extension for development: a real folder in Aseprite's
# extensions (Aseprite skips a symlinked extension folder) with a symlink
# per file, so edits apply on the next Aseprite restart. Links every
# .lua and .json in agent/extension (new modules included) and removes links
# to files that no longer exist. Run it again after adding a module.
# EXTENSIONS=<dir> overrides Aseprite's extensions folder.
set -euo pipefail
src="$(cd "$(dirname "$0")/../extension" && pwd)"
case "$(uname)" in
  Darwin) base="$HOME/Library/Application Support/Aseprite/extensions" ;;
  *) base="${XDG_CONFIG_HOME:-$HOME/.config}/aseprite/extensions" ;;
esac
dest="${EXTENSIONS:-$base}/aseprite-agent"
mkdir -p "$dest"
n=0
for f in "$src"/*.lua "$src"/*.json; do
  name="$(basename "$f")"
  [ "$name" = "__pref.lua" ] && continue
  ln -sfn "$f" "$dest/$name"
  n=$((n + 1))
done
# Links whose file is gone (a module was renamed or removed).
for l in "$dest"/*; do
  if [ -L "$l" ] && [ ! -e "$l" ]; then rm "$l"; echo "removed stale link $(basename "$l")"; fi
done
echo "linked $n files into $dest"
