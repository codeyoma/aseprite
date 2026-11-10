#!/usr/bin/env python3
"""Generate agent/bridge/src/commands.json from this fork's C++ sources.

For each built-in command it records the menu title (from
data/strings/en.ini) and the parameters it reads, found from
`Param<T> name{ this, default, "key" }` declarations and
`params.get("key")` calls in the command's source file.

Run from the repository root: python3 agent/tools/gen_commands.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CMD_DIR = ROOT / "src/app/commands"
OUT = ROOT / "agent/bridge/src/commands.json"

ids = re.findall(r"FOR_EACH_COMMAND\((\w+)\)", (CMD_DIR / "commands_list.h").read_text())

titles = {}
section = None
for line in (ROOT / "data/strings/en.ini").read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\[(\w+)\]", line)
    if m:
        section = m.group(1)
        continue
    if section == "commands":
        m = re.match(r"^(\w+)\s*=\s*(.*)$", line)
        if m:
            titles[m.group(1)] = m.group(2).strip()

# Param<T> name{ this, default, "key" } or { "key", "alias" }, possibly
# spread over several lines.
PARAM_RE = re.compile(
    r'Param<\s*([^>;]+?)\s*>\s+\w+\s*\{\s*this\s*,\s*([^;]*?)\s*,\s*(\{[^{};]*\}|"\w+")\s*\}\s*;')
GET_RE = re.compile(r'params\.(?:get|has_param)\("(\w+)"\)')
CMD_RE = re.compile(r"CommandId::(\w+)\(\)")

TYPE_MAP = {
    "bool": "boolean", "int": "integer", "double": "number", "float": "number",
    "std::string": "string", "app::Color": "color", "gfx::Rect": "rectangle",
    "gfx::Size": "size", "gfx::Point": "point", "doc::frame_t": "integer",
}

# String values accepted by enum-typed params, from Param<T>::fromString
# specializations in new_params.cpp.
enum_values = {}
np_src = (CMD_DIR / "new_params.cpp").read_text(encoding="utf-8")
for m in re.finditer(r"void Param<([\w:]+)>::fromString\(const std::string& value\)\s*\{(.*?)\n\}", np_src, re.S):
    vals = [v for v in re.findall(r'"([\w-]+)"', m.group(2)) if v not in ("1", "true")]
    if vals:
        enum_values[m.group(1).split("::")[-1]] = list(dict.fromkeys(vals))

params_by_cmd = {}
for path in sorted(CMD_DIR.rglob("*.cpp")):
    src = path.read_text(encoding="utf-8", errors="replace")
    header = path.with_suffix(".h")
    if header.exists():
        src += "\n" + header.read_text(encoding="utf-8", errors="replace")
    # Commands constructed in this file: Command(CommandId::X(), ...),
    # CommandWithNewParams<...>(CommandId::X()), or a constructor whose
    # default id argument is CommandId::X().
    defined = set(re.findall(r"(?:Command|CommandWithNewParams(?:<\w+>)?)\(\s*CommandId::(\w+)\(\)", src))
    defined |= set(re.findall(r"const char\*\s*\w+\s*=\s*CommandId::(\w+)\(\)", src))
    if not defined:
        continue
    found = {}
    for typ, default, keys in PARAM_RE.findall(src):
        names = re.findall(r'"(\w+)"', keys)
        entry = {"name": names[0], "type": TYPE_MAP.get(typ, typ), "default": " ".join(default.split())}
        values = enum_values.get(typ.split("::")[-1])
        if values:
            entry["values"] = values
        if len(names) > 1:
            entry["aliases"] = names[1:]
        found[names[0]] = entry
    for key in GET_RE.findall(src):
        found.setdefault(key, {"name": key, "type": "string"})
    for cid in defined:
        params_by_cmd.setdefault(cid, {}).update(found)

commands = []
for cid in ids:
    params = sorted(params_by_cmd.get(cid, {}).values(), key=lambda p: p["name"])
    title = titles.get(cid, "")
    commands.append({"name": cid, "title": re.sub(r"\{\d\}", "…", title), "params": params})

OUT.write_text(json.dumps(commands, indent=1) + "\n")
with_params = sum(1 for c in commands if c["params"])
print(f"{len(commands)} commands, {with_params} with known params -> {OUT.relative_to(ROOT)}")
