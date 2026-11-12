// The default tool set (#88): MCP clients list the core tools plus find_tools
// and call_tool; every other tool stays callable through call_tool (checked
// against its schema, within the endpoint's filters) and stays in the Tool
// table for the CLI. Skills, the basics guide and the chat prompt give the
// inputs of the deferred tools they name. Also prints the tool-list size.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS, toolContext } from "../dist/tools.js";
import { startHttpEndpoint } from "../dist/http.js";
import { availableTools, serverTools } from "../dist/server.js";
import { CORE_TOOL_NAMES, skillToolsNote, toolSetMode, toolSignature, toolsNamedIn } from "../dist/tool_sets.js";
import { allSkills, readGuide } from "../dist/guide.js";
import { skillPromptText } from "../dist/skill_mcp.js";
import { systemPrompt, unwrapCallTool } from "../dist/chat.js";

const NO_USER_SKILLS = mkdtempSync(join(tmpdir(), "no-skills-"));
process.env.ASEPRITE_AGENT_SKILLS = NO_USER_SKILLS;
process.on("exit", () => rmSync(NO_USER_SKILLS, { recursive: true, force: true }));
const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const names = (tools) => tools.map((t) => t.name);
const metaOf = (opts = {}) => Object.fromEntries(serverTools({ tools: "core", ...opts }).filter((t) => t.name === "find_tools" || t.name === "call_tool").map((t) => [t.name, t]));

test("the core set is explicit, about 15 tools, and every core name is a real tool", () => {
  const all = new Set(names(TOOLS));
  for (const n of CORE_TOOL_NAMES) assert.ok(all.has(n), `${n} is a tool`);
  const listed = names(serverTools({ tools: "core" }));
  assert.deepEqual(listed, [...CORE_TOOL_NAMES, "find_tools", "call_tool"]);
  assert.ok(listed.length >= 12 && listed.length <= 18, `${listed.length} listed`);
  assert.equal(serverTools({ tools: "all" }).length, TOOLS.length + 2, "all: every tool plus the meta tools");
  assert.equal(toolSetMode({ ASEPRITE_AGENT_TOOLS: "all" }), "all");
  assert.equal(toolSetMode({}), "core");
});

test("read-only, sub-agent and critic servers keep their filters, call_tool included", async () => {
  const ro = serverTools({ tools: "core", readOnly: true });
  assert.ok(ro.every((t) => t.kind === "read"), names(ro.filter((t) => t.kind !== "read")).join(","));
  const calls = [];
  const ctx = toolContext({ request: async (m, p) => { calls.push(m); return { result: {} }; } });
  const refused = await metaOf({ readOnly: true }).call_tool.run({ name: "make_ramp", input: { base: "#ff0000" } }, ctx);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /not available here/);
  const sub = await metaOf({ subAgent: true }).call_tool.run({ name: "spawn_agents", input: { tasks: [{ prompt: "x", frames: 1 }] } }, ctx);
  assert.match(textOf(sub), /not available here/);
  assert.ok(!names(availableTools({ critic: true, readOnly: true })).includes("critique"));
  assert.deepEqual(calls, []);
});

test("call_tool checks the input against the tool's schema, then runs it", async () => {
  const calls = [];
  const ctx = toolContext({ request: async (m, p) => { calls.push({ m, p }); return { result: { text: "frames 1" } }; } });
  const { call_tool } = metaOf();
  const bad = await call_tool.run({ name: "apply_timeline_text", input: { text: 3 } }, ctx);
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Invalid input for apply_timeline_text:\n- input\.text/);
  assert.match(textOf(bad), /Its inputs: apply_timeline_text \{text: string, plan\?: boolean\}/);
  const ok = await call_tool.run({ name: "get_timeline_text" }, ctx);
  assert.equal(textOf(ok), "frames 1");
  assert.deepEqual(calls.map((c) => c.m), ["get_timeline_text"]);
  assert.match(textOf(await call_tool.run({ name: "no_such" }, ctx)), /No tool named "no_such"/);
  assert.match(textOf(await call_tool.run({ name: "find_tools" }, ctx)), /directly/);
  assert.equal(call_tool.label({ name: "run_command", input: { name: "Flip" } }), "Run Flip");
  assert.deepEqual(unwrapCallTool("call_tool", { name: "make_ramp", input: { base: "#f00" } }), { tool: "make_ramp", input: { base: "#f00" } });
  assert.deepEqual(unwrapCallTool("snapshot", { frame: 2 }), { tool: "snapshot", input: { frame: 2 } });
});

test("find_tools searches the deferred tools and gives full schemas by name", async () => {
  const { find_tools } = metaOf();
  const found = textOf(await find_tools.run({ query: "outline" }));
  assert.match(found, /^Matching tools/);
  assert.match(found, /- outline_sprite \{/);
  const exact = textOf(await find_tools.run({ names: ["make_ramp", "nope"] }));
  assert.match(exact, /make_ramp \(read|edit\)/);
  assert.match(exact, /Input schema: \{"type":"object"/);
  assert.match(exact, /nope: no such tool here/);
  assert.equal(toolSignature(TOOLS.find((t) => t.name === "undo")), "undo {steps?: integer 1-100}");
});

test("skills, the basics guide and the chat prompt name only tools they also tell how to call", () => {
  const prompt = systemPrompt();
  // Every deferred tool the prompt or basics name has its signature in the prompt's <more-tools> block. The skills
  // index (#113) only describes skills; its words are not instructions to call a tool.
  for (const n of toolsNamedIn(prompt.split("<more-tools>")[0].replace(/<skills-index>[\s\S]*?<\/skills-index>/, ""))) {
    if (CORE_TOOL_NAMES.includes(n)) continue;
    assert.ok(prompt.includes(`- ${n} {`), `${n} is named in the chat prompt but its inputs are not`);
  }
  assert.match(readGuide("basics"), /call_tool/);
  // Every built-in skill: its deferred frontmatter tools come with their signatures, in the MCP prompt too.
  for (const s of allSkills().values()) {
    if (s.source !== "built-in") continue;
    const deferred = s.tools.filter((n) => !CORE_TOOL_NAMES.includes(n));
    const note = skillToolsNote(s.tools);
    for (const n of deferred) assert.ok(note.includes(`- ${n} {`), `${s.name}: ${n}`);
    if (deferred.length) assert.ok(skillPromptText(s).includes("<skill-tools>"), `${s.name} prompt`);
  }
});

test("over MCP: the default list is the core set, call_tool reaches the rest; the list is much smaller", async () => {
  const ep = await startHttpEndpoint({ request: async () => ({ result: { text: "frames 2" } }) }, "t0k");
  try {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ep.url), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [...CORE_TOOL_NAMES, "find_tools", "call_tool"]);
    const res = await client.callTool({ name: "call_tool", arguments: { name: "get_timeline_text", input: {} } });
    assert.equal(res.content[0].text, "frames 2");
    await client.close();

    // ASEPRITE_AGENT_TOOLS=all lists every tool, as before #88.
    process.env.ASEPRITE_AGENT_TOOLS = "all";
    const full = new Client({ name: "test", version: "1" });
    await full.connect(new StreamableHTTPClientTransport(new URL(ep.url), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const everything = (await full.listTools()).tools;
    await full.close();
    delete process.env.ASEPRITE_AGENT_TOOLS;
    assert.equal(everything.length, TOOLS.length + 2);

    // Size of the tools/list result a model gets, before #88 (every tool but apply) and now (the core set).
    const before = everything.filter((t) => !["apply", "find_tools", "call_tool"].includes(t.name));
    const all = JSON.stringify(before).length, core = JSON.stringify(tools).length;
    console.log(`tool list: before ${before.length} tools, ${all} chars (~${Math.round(all / 4)} tokens); ` +
      `after ${tools.length} tools, ${core} chars (~${Math.round(core / 4)} tokens)`);
    assert.ok(core < all / 3, `${core} vs ${all}`);
  } finally {
    delete process.env.ASEPRITE_AGENT_TOOLS;
    ep.server.close();
  }
});
