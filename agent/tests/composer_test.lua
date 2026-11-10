-- Composer (the chat panel's draft): / picker matching and keys, the skill
-- chip, skill needs, Saved Command precedence, mentions and attachments.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/composer_test.lua
local extDir = app.params.ext
local Composer = dofile(app.fs.joinPath(extDir, "composer.lua"))
local Conversation = dofile(app.fs.joinPath(extDir, "conversation.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local CATALOG = {
  { kind = "skill", name = "outline", title = "Outline", source = "builtin", category = "Drawing",
    description = "Adds an outline around the sprite", needs = {} },
  { kind = "skill", name = "recreate", title = "Recreate", source = "builtin", category = "Reference",
    description = "Recreates art from an image", needs = { "image" } },
  { kind = "skill", name = "cutout", title = "Cutout", source = "builtin", category = "Drawing",
    description = "Cuts the selection out", needs = { "selection" } },
  { kind = "skill", name = "anim-basics", title = "Animation basics", source = "guide", category = "Animation",
    description = "Guide topic", needs = {} },
  { kind = "skill", name = "shade", title = "Shading", source = "user", category = "Color",
    description = "Shades with an outline of light", needs = {} },
}

local function new(opts)
  opts = opts or {}
  local c = Composer.new{
    commands = function() return opts.commands or {} end,
    selectionEmpty = function() return opts.selectionEmpty ~= false end,
    stateBlock = function() return "<aseprite-state>S</aseprite-state>" end,
    changes = function() return opts.changes end,
    expandMentions = Conversation.expandMentions,
  }
  c:setCatalog(CATALOG)
  return c
end
local function titles(list)
  local t = {}
  for _, it in ipairs(list) do t[#t + 1] = it.name end
  return table.concat(t, ",")
end

-- Matching
do
  local c = new{ commands = {
    { name = "add-outline", title = "Add Outline", description = "Saved", enabled = true },
    { name = "hidden", title = "Hidden", enabled = false },
  } }
  local all = c:matches("")
  -- Bare "/": grouped by category (Color, Drawing, Reference), commands last; no guide topics or disabled commands.
  check("bare / groups by category, commands last", titles(all) == "shade,cutout,outline,recreate,add-outline", titles(all))
  local m = c:matches("outline")
  -- "outline" starts outline's head (3) and is inside add-outline's head (2), shade's description (1).
  check("ranks name/title prefix over contains over description", titles(m) == "outline,add-outline,shade", titles(m))
  check("every word must match", titles(c:matches("cut sel")) == "cutout", titles(c:matches("cut sel")))
  check("no match", #c:matches("zzz") == 0)
end

-- Typing "/" opens the picker; arrows wrap; Escape closes; "@" asks for the mention picker
do
  local c = new()
  local r = c:onTextChange("/")
  check("bare / shows matches", #c:suggestions() == 4 and c:suggestionIndex() == 1 and r.suggestChanged)
  check("ArrowUp wraps to the last", c:onKey("ArrowUp").index == 4)
  check("ArrowDown wraps to the first", c:onKey("ArrowDown").index == 1)
  check("ArrowDown moves", c:onKey("ArrowDown").index == 2)
  check("other keys pass through", c:onKey("KeyA") == nil)
  check("Escape closes", c:onKey("Escape").kind == "close" and #c:suggestions() == 0)
  c:onTextChange("/out-l")
  check("- and _ split words", titles(c:suggestions()) == "outline,cutout,shade", titles(c:suggestions()))
  c:onTextChange("/outline please")
  check("a space closes the picker", #c:suggestions() == 0)
  c:onTextChange("/skill:outline")
  check("/skill: doesn't open the picker", #c:suggestions() == 0)
  c:setText("draw ")
  check("typing @ asks for the mention picker", c:onTextChange("draw @").mentionPicker)
  check("pasting text ending in @ doesn't", not c:onTextChange("draw @ and x@").mentionPicker)
  local empty = Composer.new{}
  check("no catalog yet asks for it", empty:onTextChange("/").needCatalog)
end

-- Enter / Tab pick; the chip; Backspace removes it
do
  local c = new()
  c:onTextChange("/outl")
  local r = c:onKey("Enter")
  check("Enter picks the highlighted skill", r.kind == "pick" and r.text == "" and c:pickedSkill().name == "outline")
  check("picking closes the picker", #c:suggestions() == 0)
  check("Backspace with text keeps the chip", c:onKey("Backspace", "x") == nil and c:pickedSkill() ~= nil)
  check("Backspace in an empty prompt removes the chip", c:onKey("Backspace", "").kind == "chip_removed" and c:pickedSkill() == nil)
  c:onTextChange("/outl")
  check("Tab picks too", c:onKey("Tab").kind == "pick" and c:pickedSkill().name == "outline")
  check("empty prompt with a chip asks for a request",
    c:decide{ text = "  ", mode = "agent" }.message == "Write what you want Outline to do")
  local s = c:decide{ text = "thicker please", provider = "claude", mode = "agent" }
  check("the chip becomes /skill:name", s.kind == "send" and s.payload.prompt == "/skill:outline thicker please", s.payload and s.payload.prompt)
  check("the bubble shows only the request", s.shown == "thicker please" and s.skillTitle == "Outline")
  check("the chip goes with the message", c:pickedSkill() == nil)
  check("state, provider and mode in the payload", s.payload.state == "<aseprite-state>S</aseprite-state>"
    and s.payload.provider == "claude" and s.payload.mode == "agent" and s.payload.changes == nil
    and s.payload.attachments == nil)
  check("empty prompt without a chip does nothing", c:decide{ text = "" }.kind == "none")
  -- A typed /skill:name is not prefixed again, and an unknown skill keeps its id as the title.
  c:onTextChange("/outl"); c:onKey("Enter")
  local t = c:decide{ text = "/skill:other go", mode = "agent" }
  check("typed /skill: wins over the chip", t.payload.prompt == "/skill:other go" and t.skillTitle == "other")
end

-- Picking a saved command puts "/name " in the prompt; picking skills warns about needs
do
  local c = new{ commands = { { name = "add-layers", title = "Add Layers", enabled = true } } }
  local r = c:pick(c:matches("add")[1])
  check("command pick fills the prompt", r.text == "/add-layers " and c:pickedSkill() == nil)
  r = c:pick(CATALOG[2])
  check("image skill pick warns without an attachment", r.tips[1] == "This skill needs an image: attach one with +")
  r = c:pick(CATALOG[3])
  check("selection skill pick warns without a selection", r.tips[1] == "This skill works on a selection: select an area first")
end

-- Skill needs at send time
do
  local c = new()
  local r = c:decide{ text = "/skill:recreate this", mode = "agent" }
  check("image skill waits for an attachment", r.kind == "tip" and r.message == "Recreate needs an image: attach one with + first")
  c:addAttachment{ label = "ref.png", path = "/tmp/ref.png" }
  r = c:decide{ text = "/skill:recreate this", mode = "agent" }
  check("image skill sends with an attachment", r.kind == "send")
  r = c:decide{ text = "/skill:recreate again", mode = "agent" }
  check("a follow-up after the image was sent is fine", r.kind == "send")
  c:newConversation()
  r = c:decide{ text = "/skill:recreate again", mode = "agent" }
  check("a new chat needs the image again", r.kind == "tip")
  r = c:decide{ text = "/skill:cutout it", mode = "agent" }
  check("selection skill waits for a selection", r.kind == "tip" and r.message == "Cutout works on a selection: select an area first")
  local withSel = new{ selectionEmpty = false }
  check("selection skill sends with a selection", withSel:decide{ text = "/skill:cutout it", mode = "agent" }.kind == "send")
end

-- Saved Command precedence over the picker
do
  local c = new{ commands = { { name = "outline", title = "Outline cmd", enabled = true } } }
  c:onTextChange("/outline")
  check("picker shows matches for /outline", #c:suggestions() == 3)
  local r = c:decide{ text = "/outline", mode = "agent" }
  check("a saved command's exact name runs it", r.kind == "command" and r.name == "outline" and r.args == "")
  check("running closes the picker and clears the draft", #c:suggestions() == 0 and c.text == "")
  r = c:decide{ text = "/outline n=2 color=red", mode = "agent" }
  check("command args", r.kind == "command" and r.args == "n=2 color=red" and r.text == "/outline n=2 color=red")
  c:onTextChange("/sha")
  r = c:decide{ text = "/sha", mode = "agent" }
  check("other bare /query picks the best match", r.kind == "pick" and c:pickedSkill().name == "shade")
  c:clearPickedSkill()
  r = c:decide{ text = "/nothing here", mode = "agent" }
  check("an unknown /name is sent", r.kind == "send" and r.payload.prompt == "/nothing here")
end

-- Developer confirm
do
  local c = new()
  check("developer mode asks first", c:decide{ text = "fix it", mode = "developer" }.kind == "confirm_developer")
  check("the draft is kept while asking", c:decide{ text = "fix it", mode = "developer", developerConfirmed = true }.kind == "send")
end

-- Mentions, changes and attachment lines
do
  local c = new{ changes = "<changes-since-your-last-reply>x</changes-since-your-last-reply>" }
  c:setText("shade ")
  local text = c:insertMention({ name = "Body", uri = "aseprite://layer/L12" }, "shade @")
  check("mention replaces a typed @", text == "shade @[Body] ", text)
  text = c:insertMention({ name = "Frame 2", uri = "aseprite://frame/2" }, text .. "and")
  check("mention adds a space", text == "shade @[Body] and @[Frame 2] ", text)
  check("attach", c:addAttachment{ label = "selection", path = "/tmp/a.png", uri = "aseprite://selection" })
  c:addAttachment{ label = "ref.png", path = "/tmp/b.png" }
  check("attachment labels", table.concat(c:attachmentLabels(), ",") == "selection,ref.png")
  local r = c:decide{ text = text .. "please", provider = "codex", mode = "ask" }
  check("mentions expanded for the agent",
    r.payload.prompt == "shade Body (aseprite://layer/L12) and Frame 2 (aseprite://frame/2) please", r.payload.prompt)
  check("the bubble keeps the tokens and lists attachments",
    r.shown == "shade @[Body] and @[Frame 2] please\nAttached: selection\nAttached: ref.png", r.shown)
  check("attachments in the payload", #r.payload.attachments == 2 and r.payload.attachments[1].uri == "aseprite://selection")
  check("changes in the payload", r.payload.changes:find("changes%-since") ~= nil)
  check("sending clears mentions and attachments", next(c.mentions) == nil and #c:pendingAttachments() == 0)
  local again = c:decide{ text = "@[Body] again", mode = "agent" }
  check("old mentions don't expand later", again.payload.prompt == "@[Body] again")
  for i = 1, 8 do c:addAttachment{ label = "a" .. i } end
  local ok, why = c:addAttachment{ label = "a9" }
  check("at most 8 attachments", not ok and why == "At most 8 attachments per message")
  c:clearAttachments()
  check("clear attachments", #c:pendingAttachments() == 0)
end

print(failures == 0 and "ALL PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " checks failed") end
