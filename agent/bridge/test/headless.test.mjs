// Headless runner (#85): the JSON-lines framing, the refusal of files the
// live window has open (stub bridges), and, when ASEPRITE is set (CI has no
// Aseprite), the real runner: requests, an error and shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AsepriteLink } from "../dist/aseprite.js";
import { parseArgs, runHeadlessMode, snapshotTarget } from "../dist/cli.js";
import { encodeRequest, HeadlessLink, headlessRequested, LineDecoder, liveOpenFiles, LiveFileError, MARK } from "../dist/headless.js";
import { PROTOCOL } from "../dist/protocol.js";

const ASEPRITE = process.env.ASEPRITE;
const extensionDir = fileURLToPath(new URL("../../extension", import.meta.url));

test("JSON-lines framing: marked replies, split chunks, stray lines", () => {
  const replies = [];
  const other = [];
  const d = new LineDecoder((r) => replies.push(r), (l) => other.push(l));
  const line = (o) => MARK + JSON.stringify(o) + "\n";
  const both = line({ id: 1, result: { ok: true } }) + "Aseprite warning\n" + line({ id: 2, error: { message: "boom" } });
  d.push(both.slice(0, 9));
  assert.equal(replies.length, 0, "half a line waits");
  d.push(Buffer.from(both.slice(9)));
  d.push(MARK + "{not json\n" + '{"id":3,"result":1}\n\n');
  assert.deepEqual(replies, [{ id: 1, result: { ok: true } }, { id: 2, error: { message: "boom" } }]);
  assert.deepEqual(other, ["Aseprite warning", MARK + "{not json", '{"id":3,"result":1}'], "unmarked JSON is never a reply");
  assert.equal(encodeRequest({ id: 7, method: "ping", params: {} }), '{"id":7,"method":"ping","params":{}}\n');
});

test("headless mode is explicit: --headless or ASEPRITE_AGENT_MODE=headless", () => {
  assert.equal(parseArgs(["--headless", "snapshot", "a.aseprite", "-o", "x/"]).flags.headless, true);
  assert.equal(parseArgs(["snapshot", "a.aseprite", "--headless"]).command, "snapshot");
  assert.equal(headlessRequested(undefined, {}), false);
  assert.equal(headlessRequested(true, {}), true);
  assert.equal(headlessRequested(undefined, { ASEPRITE_AGENT_MODE: "headless" }), true);
  assert.equal(snapshotTarget("one.png", "/a/hero.aseprite", 1), "one.png");
  assert.equal(snapshotTarget("out/", "/a/hero.aseprite", 1), join("out", "hero.png"));
  assert.equal(snapshotTarget("out", "/a/hero.aseprite", 2), join("out", "hero.png"));
});

/** A stub live bridge: answers GET paths from routes, records the auth header. */
async function stubBridge(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const r = routes[req.url] ?? [426, "Upgrade Required"];
    res.writeHead(r[0]).end(typeof r[1] === "string" ? r[1] : JSON.stringify(r[1]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "ase-session-"));
  const session = join(dir, "session.json");
  writeFileSync(session, JSON.stringify({ port: server.address().port, token: "t0k", pid: 1 }));
  return { session, seen, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("liveOpenFiles asks the live bridge with its token; no bridge means nothing is open", async () => {
  const s = await stubBridge({ "/files": [200, { connected: true, files: ["/art/hero.aseprite", ""] }] });
  try {
    assert.deepEqual(await liveOpenFiles({ session: s.session }), ["/art/hero.aseprite"]);
    assert.deepEqual(s.seen, [{ url: "/files", auth: "Bearer t0k" }]);
  } finally {
    s.close();
  }
  assert.deepEqual(await liveOpenFiles({ session: "/nonexistent/session.json" }), []);
  // A stale session file whose port is closed.
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const dir = mkdtempSync(join(tmpdir(), "ase-session-"));
  try {
    writeFileSync(join(dir, "session.json"), JSON.stringify({ port, token: "x", pid: 1 }));
    assert.deepEqual(await liveOpenFiles({ session: join(dir, "session.json") }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older bridge (426): nothing open when no window is attached, refused otherwise", async () => {
  const idle = await stubBridge({ "/status": [200, { connected: false }] });
  try {
    assert.deepEqual(await liveOpenFiles({ session: idle.session }), []);
  } finally {
    idle.close();
  }
  const busy = await stubBridge({ "/status": [200, { connected: true }] });
  try {
    await assert.rejects(liveOpenFiles({ session: busy.session }), /too old/);
  } finally {
    busy.close();
  }
  const broken = await stubBridge({ "/files": [503, { error: "no answer" }] });
  try {
    await assert.rejects(liveOpenFiles({ session: broken.session }), /503/);
  } finally {
    broken.close();
  }
});

test("HeadlessLink.open refuses a file the live window has open, before asking the runner", async () => {
  const link = new HeadlessLink({ bin: "/nonexistent", extensionDir, liveFiles: async () => ["/art/hero.aseprite"] });
  await assert.rejects(link.open("/art/hero.aseprite"), (e) => e instanceof LiveFileError && /open in the live Aseprite window/.test(e.message));
  await assert.rejects(link.open("/art/other.aseprite"), /not running/, "a free file goes on to the runner");
});

test("the bridge answers GET /files with the token: open sprites of the attached window", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const url = `http://127.0.0.1:${port}/files`;
  const auth = { headers: { authorization: `Bearer ${link.token}` } };
  let ws;
  try {
    assert.equal((await fetch(url)).status, 401, "no token");
    assert.deepEqual(await (await fetch(url, auth)).json(), { connected: false, files: [] });
    // A fake extension answering get_state (protocol.json State).
    const sprite = (filename) => ({ id: "S1", filename, width: 8, height: 8, colorMode: "rgb", frameCount: 1, layerCount: 1, modified: false });
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once("open", r));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === "get_state") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { asepriteVersion: "test", apiVersion: 1, fgColor: "#000000", bgColor: "#ffffff", openSprites: [sprite("/art/hero.aseprite"), sprite("")] } }));
      }
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol: PROTOCOL.version, asepriteVersion: "test" } }));
    assert.ok(await link.waitForConnection(2_000));
    assert.deepEqual(await (await fetch(url, auth)).json(), { connected: true, files: ["/art/hero.aseprite"] });
  } finally {
    ws?.close();
    link.stop();
  }
});

test("the headless runner: requests, binary, an error, open/close and shutdown", { skip: !ASEPRITE && "set ASEPRITE to run" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ase-headless-"));
  const link = new HeadlessLink({ bin: ASEPRITE, extensionDir, liveFiles: async () => [join(dir, "busy.aseprite")] });
  try {
    await link.start();
    assert.ok(link.asepriteVersion);
    assert.deepEqual((await link.request("ping", {})).result !== undefined, true);
    // Make two files on disk, in the runner itself.
    const made = await link.request("execute_lua", {
      code: `for _, name in ipairs(args.names) do
        local s = Sprite(4, 3); s:newCel(s.layers[1], 1, Image(4, 3), Point(0, 0))
        app.useTool{ tool = "pencil", color = Color(255, 0, 0), points = { Point(1, 1) } }
        s:saveAs(args.dir .. "/" .. name); s:close() end
        return #app.sprites`,
      args: { dir, names: ["a.aseprite", "b.aseprite"] },
    });
    assert.equal(made.result.ok, true, made.result.error);
    const opened = await link.open(join(dir, "a.aseprite"));
    assert.deepEqual([opened.width, opened.height], [4, 3]);
    const state = (await link.request("get_state", {})).result;
    assert.equal(state.activeSprite.width, 4);
    const snap = await link.request("snapshot", { frame: 1 });
    assert.equal(snap.result.binary, true);
    assert.equal(snap.binary.length, 4 * 3 * 4);
    assert.deepEqual([...snap.binary.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)], [255, 0, 0, 255]);
    // Documents stay in memory between requests: the second file opens next to the first.
    await link.open(join(dir, "b.aseprite"));
    assert.equal((await link.request("get_state", {})).result.openSprites.length, 2);
    // Errors come back as rejections; the runner keeps going.
    await assert.rejects(link.request("snapshot", { layer: "Nope" }), /Nope/);
    await assert.rejects(link.close(join(dir, "missing.aseprite")), /Not open/);
    await assert.rejects(link.open(join(dir, "busy.aseprite")), LiveFileError);
    await link.close();
    assert.equal((await link.request("get_state", {})).result.openSprites.length, 1);
    await link.stop();
    await assert.rejects(link.request("ping", {}), /exited/);

    // ase --headless snapshot over both files in one runner.
    process.env.ASEPRITE_BIN = ASEPRITE;
    const out = join(dir, "out");
    const r = await runHeadlessMode(parseArgs(["--headless", "snapshot", join(dir, "a.aseprite"), join(dir, "b.aseprite"), "-o", out]), { liveFiles: async () => [] });
    assert.equal(r.json.files.length, 2);
    assert.deepEqual(readdirSync(out).sort(), ["a.png", "b.png"]);
    assert.equal(readFileSync(join(out, "a.png")).subarray(1, 4).toString(), "PNG");
    await assert.rejects(
      runHeadlessMode(parseArgs(["--headless", "check", join(dir, "a.aseprite")]), { liveFiles: async () => [join(dir, "a.aseprite")] }),
      /open in the live Aseprite window/,
    );
  } finally {
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
