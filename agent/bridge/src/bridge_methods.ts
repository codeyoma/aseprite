// Every method the extension may call on the bridge (protocol.json
// bridgeMethods), assembled from the features that own them.
import { chatMethods, type ChatRunner } from "./chat.js";
import { developerMethods, type DeveloperDeps } from "./developer_methods.js";
import { catalog } from "./guide.js";
import { commandMethods, type SavedCommands } from "./saved_commands.js";
import { updateMethods } from "./update_methods.js";
import type { AsepriteRequester } from "./tool.js";
import { toolContext } from "./tool.js";
import { findTool, runTool } from "./tools.js";

export function bridgeMethods(
  chat: ChatRunner,
  version: string,
  opts: { link?: DeveloperDeps["link"] & AsepriteRequester; commands?: SavedCommands } = {},
): Record<string, (params: any) => unknown> {
  return {
    ...chatMethods(chat, version),
    ...commandMethods(opts.commands),
    ...developerMethods({ notify: (ev) => chat.notify(ev), link: opts.link }),
    ...updateMethods(),
    // The Skill Catalog for the panel's / picker (#35).
    "skills.list": () => ({ skills: catalog() }),
    // The panel's "Import animation as frames": import_animation with no agent turn.
    "import.animation": async (p: { path: string; into?: "new" | "layer"; frame?: number }) => {
      if (!opts.link) throw new Error("No Aseprite connection");
      const r = await runTool(findTool("import_animation")!, { path: p.path, into: p.into, frame: p.frame }, toolContext(opts.link));
      const message = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(" ");
      if (r.isError) throw new Error(message);
      return { text: message };
    },
  };
}
