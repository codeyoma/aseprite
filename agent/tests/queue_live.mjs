// Live test of the prompt queue: a message sent while the agent works waits
// and goes when the turn ends; Send now stops the turn and sends it next;
// Stop pauses the queue.
// Run with Aseprite open:  node agent/tests/queue_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, waitIdle, check, done } = await live({ provider });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const submit = (text) => lua(`AsepriteAgent.chat(${JSON.stringify(text)}, ${JSON.stringify(provider)}, "ask") return true`);
const count = (x) => (Array.isArray(x) ? x.length : Object.keys(x ?? {}).length);
const queued = async () => { const q = await lua("return AsepriteAgent.queued()"); return { n: count(q.items), items: q.items, paused: q.paused }; };
const bubbles = async () => (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "user").map((e) => e.text);
const busy = () => lua("return AsepriteAgent.isBusy and AsepriteAgent.isBusy() or false");
const whenBusy = async () => { for (let i = 0; i < 40 && !(await busy()); i++) await sleep(250); };

await lua("Sprite(16, 16) AsepriteAgent.newChat() return true");

// 1) Queued while busy, sent at the end of the turn.
await submit("Count slowly from 1 to 30, one number per line.");
await whenBusy();
await submit("Now say only the word QUEUED.");
const q1 = await queued();
check("the second message waits in the queue", q1.n === 1 && !q1.paused, q1);
check("only the first message is in the log", (await bubbles()).length === 1);
await waitIdle();
await sleep(1500);
await waitIdle();
const b1 = await bubbles();
check("the queued message was sent after the turn", b1.length === 2 && /QUEUED/.test(b1[1]), b1);
check("the queue is empty", (await queued()).n === 0);

// 2) Send now stops the running turn and sends the queued one next.
await submit("Write a 40-line poem about pixels, slowly.");
await whenBusy();
await submit("Stop that and say only NOW.");
await lua("AsepriteAgent.sendNow(1) return true");
await sleep(1500);
await waitIdle();
await sleep(1500);
await waitIdle();
const entries = await lua("return AsepriteAgent.entries()");
check("the poem turn was stopped", entries.some((e) => e.kind === "worked" && /Stopped/i.test(e.text ?? "") || e.status === "stopped" || /Stopped/.test(e.text ?? "")), entries.map((e) => `${e.kind}:${(e.text ?? "").slice(0, 30)}`));
check("then NOW was sent", (await bubbles()).at(-1)?.includes("NOW"));

// 3) Stop pauses the queue.
await submit("Count slowly from 1 to 30, one number per line.");
await whenBusy();
await submit("Say only PAUSED.");
await lua("AsepriteAgent.stop() return true");
await sleep(1500);
await waitIdle();
await sleep(1000);
const q3 = await queued();
check("after Stop the message stays, paused", q3.n === 1 && q3.paused === true, q3);
check("and was not sent", !(await bubbles()).some((t) => t.includes("PAUSED")));
await lua("AsepriteAgent.sendNow(1) return true");
await sleep(1000);
await waitIdle();
check("Send now sends the paused one", (await bubbles()).at(-1)?.includes("PAUSED"));
done("QUEUE");
