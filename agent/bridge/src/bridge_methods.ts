// Every method the extension may call on the bridge (protocol.json
// bridgeMethods), assembled from the features that own them.
import { chatMethods, type ChatRunner } from "./chat.js";
import { developerMethods, type DeveloperDeps } from "./developer_methods.js";
import { catalog } from "./guide.js";
import { commandMethods, type SavedCommands } from "./saved_commands.js";

export function bridgeMethods(
  chat: ChatRunner,
  version: string,
  opts: { link?: DeveloperDeps["link"]; commands?: SavedCommands } = {},
): Record<string, (params: any) => unknown> {
  return {
    ...chatMethods(chat, version),
    ...commandMethods(opts.commands),
    ...developerMethods({ notify: (ev) => chat.notify(ev), link: opts.link }),
    // The Skill Catalog for the panel's / picker (#35).
    "skills.list": () => ({ skills: catalog() }),
  };
}
