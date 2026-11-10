// Live test of saved commands (#26): the agent saves a command, it shows
// in the menu and runs without the agent, /name runs it from the chat.
// Run with Aseprite open (uses a scratch folder):
//   ASEPRITE_AGENT_COMMANDS=/tmp/x node agent/tests/commands_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
if (!process.env.ASEPRITE_AGENT_COMMANDS) throw new Error("Set ASEPRITE_AGENT_COMMANDS to a scratch folder");
const { lua, chat, sleep, check, done } = await live({ provider });
const layerCount = () => lua("return #app.sprite.layers");

await lua("Sprite(16, 16) return true");
await chat(
  "Write Lua that adds a new layer named 'Grid' and draws a 1px gray dot every 4 pixels on it, run it once, " +
  "then save it as a command called grid-dots titled 'Grid Dots'. Skip the check and snapshot.",
);
const cmds = await lua("return AsepriteAgent.savedCommands()");
check("the agent saved grid-dots", cmds?.some((x) => x.name === "grid-dots"), cmds);
const menu = await lua(`return app.command.AgentCmd_grid_dots ~= nil`);
check("it is a menu command", menu === true);

let n = await layerCount();
await lua("app.command.AgentCmd_grid_dots() return true");
check("the menu command runs without the agent", (await layerCount()) === n + 1);

n = await layerCount();
await chat("/grid-dots", { mode: null, wait: false });
await sleep(1000);
const entries = await lua("return AsepriteAgent.entries()");
check("/grid-dots runs from the chat", (await layerCount()) === n + 1 && entries.at(-1).text?.startsWith("Ran /grid-dots"), entries.at(-1));
check("no agent turn for /name", !(await lua("return AsepriteAgent.isBusy()")));

done("COMMANDS");
