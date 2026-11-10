// Skills as MCP prompts and skill:// resources (#84): an MCP client lists the
// skills as prompts, gets one with the request appended, reads skill://animate,
// and sees a user skill's text where it replaces a built-in. Over the HTTP
// endpoint (all three paths) and the stdio server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHttpEndpoint } from "../dist/http.js";
import { allSkills } from "../dist/guide.js";
import { servedSkills, SKILL_PREAMBLE } from "../dist/skill_mcp.js";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
// No user skills unless a test adds them (the real ~/.aseprite-agent/skills would override built-ins).
const NO_USER_SKILLS = mkdtempSync(join(tmpdir(), "no-skills-"));
process.env.ASEPRITE_AGENT_SKILLS = NO_USER_SKILLS;
process.on("exit", () => rmSync(NO_USER_SKILLS, { recursive: true, force: true }));
const textOf = (r) => r.messages.map((m) => m.content.text).join("\n");

/** A user skills folder with one override (animate) and one new skill. */
function userSkills() {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  writeFileSync(join(dir, "animate.md"), "---\ndescription: My own animation steps\n---\n# Animate my way\nUSER ANIMATE TEXT\n");
  mkdirSync(join(dir, "glow-up"));
  writeFileSync(join(dir, "glow-up", "SKILL.md"), "---\nname: glow-up\ndescription: Add a soft glow\n---\nGLOW STEPS\n");
  return dir;
}

async function httpClient(ep, path = "/mcp") {
  const client = new Client({ name: "test", version: "1" });
  const url = new URL(ep.url);
  url.pathname = path;
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
  return client;
}

async function checkBuiltIns(client) {
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name);
  for (const s of servedSkills()) assert.ok(names.includes(s.name), `prompt ${s.name}`);
  assert.ok(!names.includes("basics"), "guide topics are not prompts");
  const animate = prompts.find((p) => p.name === "animate");
  assert.equal(animate.description, allSkills().get("animate").description);
  assert.deepEqual(animate.arguments.map((a) => [a.name, !!a.required]), [["request", false]]);

  const got = await client.getPrompt({ name: "animate", arguments: { request: "make a 6-frame walk" } });
  const text = textOf(got);
  assert.ok(text.startsWith(SKILL_PREAMBLE));
  assert.match(text, /read_guide\("basics"\)/);
  assert.ok(text.includes(allSkills().get("animate").body.trim()), "the skill's text");
  assert.ok(text.trimEnd().endsWith("The user's request: make a 6-frame walk"));
  assert.ok(!/The user's request/.test(textOf(await client.getPrompt({ name: "animate", arguments: {} }))));

  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("skill://animate") && uris.includes("rules://animation"), uris.join());
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ["skill://{name}"]);
  const r = await client.readResource({ uri: "skill://animate" });
  assert.equal(r.contents[0].mimeType, "text/markdown");
  assert.equal(r.contents[0].text, allSkills().get("animate").body);
  await assert.rejects(client.readResource({ uri: "skill://nope" }), /No skill named "nope"/);
  await assert.rejects(client.readResource({ uri: "skill://basics" }), /No skill named/);
}

test("HTTP /mcp: skills as prompts and skill:// resources", async () => {
  const ep = await startHttpEndpoint({ request: async () => ({ result: {} }) }, "t0k");
  try {
    const client = await httpClient(ep);
    await checkBuiltIns(client);
    await client.close();
  } finally {
    ep.server.close();
  }
});

test("HTTP /mcp/ask: skill resources but no prompts", async () => {
  const ep = await startHttpEndpoint({ request: async () => ({ result: {} }) }, "t0k");
  try {
    const ask = await httpClient(ep, "/mcp/ask");
    assert.equal(ask.getServerCapabilities().prompts, undefined);
    assert.match((await ask.readResource({ uri: "skill://animate" })).contents[0].text, /\S/);
    await ask.close();
  } finally {
    ep.server.close();
  }
});

test("a user skill replaces the built-in's prompt and resource, and adds its own", async () => {
  const dir = userSkills();
  process.env.ASEPRITE_AGENT_SKILLS = dir;
  const ep = await startHttpEndpoint({ request: async () => ({ result: {} }) }, "t0k");
  try {
    const client = await httpClient(ep);
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.find((p) => p.name === "animate").description, "My own animation steps");
    assert.equal(prompts.find((p) => p.name === "glow-up").description, "Add a soft glow");
    const text = textOf(await client.getPrompt({ name: "animate", arguments: { request: "walk" } }));
    assert.match(text, /USER ANIMATE TEXT/);
    assert.ok(!text.includes('read_guide("rules/animation")'), "the built-in's text is gone");
    assert.match((await client.readResource({ uri: "skill://animate" })).contents[0].text, /USER ANIMATE TEXT/);
    assert.match((await client.readResource({ uri: "skill://glow-up" })).contents[0].text, /GLOW STEPS/);
    await client.close();
  } finally {
    ep.server.close();
    process.env.ASEPRITE_AGENT_SKILLS = NO_USER_SKILLS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio server: the same prompts and resources", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-")); // the bridge records itself under ~/.aseprite-agent
  const client = new Client({ name: "test", version: "1" });
  try {
    const env = { ...process.env, HOME: home, ASEPRITE_AGENT_PORT: "0" };
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env, stderr: "ignore" }));
    await checkBuiltIns(client);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
