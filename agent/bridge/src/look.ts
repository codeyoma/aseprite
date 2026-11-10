// The "look before you are done" reminder (#81), in one place: the chat's
// system prompt (chat.ts) ends with it, and `npm run gen` copies it into the
// Claude Code plugin's PostToolUse hook (claude-plugin/hooks/edit-tools.json).
// An agent that only reads tool results ("412 pixels changed") reports art it
// has never seen; the idea comes from aseprite-ai-artist's look nudge (MIT).

export const LOOK_NUDGE =
  "A tool result that says pixels changed is no proof the art is right: before you decide you are done, " +
  'look at it with snapshot (view: "filmstrip" for an animation).';
