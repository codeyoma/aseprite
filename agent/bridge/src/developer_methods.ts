// Developer mode (#28) bridge methods: what changed, apply, rebuild, discard,
// relaunch. The side effects (git root, ninja, launching Aseprite, timers)
// are injected so build-progress throttling and relaunch can be tested.
import type { ChatEvent } from "./chat.js";
import { applyDev, asepriteBinary, build, devStatus, discard, launch, repoRoot } from "./developer.js";

/** Build progress goes to the panel at most this often. */
export const BUILD_PROGRESS_MS = 400;
/** Pause between Aseprite quitting and starting it again. */
export const RELAUNCH_DELAY_MS = 1500;

export interface DeveloperDeps {
  /** Sends a chat event to the panel (build progress and result). */
  notify(event: ChatEvent): void;
  /** Aseprite's connection: relaunch waits for it to drop. */
  link?: { readonly connected: boolean; once(event: "disconnected", listener: () => void): unknown };
  /** The fork's checkout; default: the clone the bridge runs from. */
  root?: () => string | undefined;
  build?: typeof build;
  binary?: (root: string) => string | undefined;
  launch?: (bin: string) => void;
  now?: () => number;
  delay?: (fn: () => void, ms: number) => void;
}

export function developerMethods(deps: DeveloperDeps): Record<string, (params: any) => unknown> {
  const {
    notify, link, build: runBuild = build, binary = asepriteBinary, launch: start = launch,
    now = Date.now, delay = (fn, ms) => void setTimeout(fn, ms),
  } = deps;
  const root = () => {
    const r = (deps.root ?? repoRoot)();
    if (!r) throw new Error("The bridge is not running from a clone of the Aseprite fork");
    return r;
  };
  return {
    "dev.status": () => devStatus(root()),
    // Fast-forwards the user's branch to the agent's work (before a rebuild or relaunch).
    "dev.apply": () => applyDev(root()),
    // Answers at once; progress and the result arrive as chat events ("status", then "build").
    "dev.build": () => {
      const r = root();
      let last = -Infinity;
      void runBuild(r, (line) => {
        const t = now();
        if (t - last > BUILD_PROGRESS_MS) {
          last = t;
          notify({ type: "status", text: `Building: ${line.slice(0, 120)}` });
        }
      }).then(({ ok, tail }) => notify({ type: "build", ok, text: tail }));
      return { started: true };
    },
    "dev.discard": () => discard(root()),
    // Waits for Aseprite to quit, then starts the fork's build again.
    "dev.relaunch": () => {
      const bin = binary(root());
      if (!bin) throw new Error("No build of the fork at build/bin/aseprite");
      const relaunch = () => delay(() => start(bin), RELAUNCH_DELAY_MS);
      if (link?.connected) link.once("disconnected", relaunch);
      else relaunch();
      return { relaunching: true, bin };
    },
  };
}
