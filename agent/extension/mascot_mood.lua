-- Mascot Mood: which of the mascot's moods (mascot.lua) a chat shows, from
-- what happens in it. Chat events, sends and waits go in; the mood and how
-- long it has been showing come out. Pure: the panel passes the time.
--
--   local Mood = dofile("mascot_mood.lua")
--   local m = Mood.new()
--   m:greet(now)                          -- the panel opened or a chat started
--   m:send(now, { attachments = true })   -- the user sent a message
--   m:event(ev, now)                      -- a chat event (thinking, tool, done, ...)
--   m:hold(true, now)                     -- tool requests wait for the sprite's tab
--   m:queued(true, now)                   -- a message waits for another chat's turn
--   local name, t = m:current(now)        -- the mood, and seconds since it began
--
-- A mood is either steady (until the next event) or a short reaction that
-- falls back to the steady one. Without a turn the mascot idles: it looks
-- around and wanders, and falls asleep after a while.

local Mood = {}
Mood.__index = Mood

Mood.SLEEP_AFTER = 90        -- seconds idle before it gets sleepy
Mood.DEEP_AFTER = 8          -- seconds of thinking before deep thinking
Mood.LOADING_AFTER = 3       -- seconds a tool runs before loading shows
Mood.IMPATIENT_AFTER = 15    -- seconds waiting before impatience

-- Tool names to moods, first match wins (tool names as the MCP tools have them).
Mood.TOOL_MOODS = {
  { "spawn_agents", "handoff" }, { "critique", "reviewing" }, { "ab_compare", "reviewing" }, { "diff_visual", "reviewing" },
  { "check_expect", "testing" }, { "check", "checking" },
  { "export", "saving" }, { "save", "saving" },
  { "lospec", "downloading" }, { "import", "downloading" },
  { "TodoWrite", "noting" }, { "todo", "noting" },
  { "read_guide", "searching" }, { "list_skills", "rummaging" }, { "list_fx", "rummaging" }, { "list_", "browsing" },
  { "find_", "searching" }, { "search", "searching" },
  { "read_pixels", "digging" }, { "colors", "digging" },
  { "snapshot", "scanning" }, { "get_state", "scanning" }, { "state", "scanning" }, { "look", "scanning" }, { "apply_timeline", "organizing" }, { "timeline", "reading" },
  { "palette", "computing" }, { "ramp", "computing" }, { "quantize", "computing" }, { "style", "computing" },
  { "delete", "deleting" }, { "remove", "deleting" }, { "clear", "deleting" },
  { "frames", "organizing" }, { "tag", "organizing" }, { "reorder", "organizing" }, { "mirror", "organizing" },
  { "text", "writing" }, { "fix", "fixing" },
  { "execute_lua", "building" }, { "lua", "building" },
}

function Mood.new()
  return setmetatable({
    steady = "idle", steadySince = 0,
    react = nil, reactUntil = 0, reactSince = 0,
    turn = false, idleSince = 0,
    edits = 0, failures = 0, tools = 0, toolSince = nil, thinkSince = nil, lastKind = nil,
    lastText = "", held = false, waiting = false, waitSince = nil,
  }, Mood)
end

-- Classifies a tool by its name (and label), and whether it changes the sprite.
function Mood.toolMood(name, label, kind)
  local n = (name or ""):lower()
  for _, m in ipairs(Mood.TOOL_MOODS) do
    if n:find(m[1]:lower(), 1, true) then return m[2] end
  end
  local l = (label or ""):lower()
  if l:find("fix", 1, true) then return "fixing" end
  if l:find("delete", 1, true) or l:find("remove", 1, true) then return "deleting" end
  if kind == "edit" then return "drawing" end
  return "searching"
end

function Mood:setSteady(name, now)
  if self.steady ~= name then self.steady, self.steadySince = name, now end
end

-- A short reaction, then back to the steady mood.
function Mood:flash(name, now, seconds)
  self.react, self.reactSince, self.reactUntil = name, now, now + (seconds or 1)
end

function Mood:greet(now) self:flash("greet", now, 1.8); self.idleSince = now end

function Mood:send(now, opts)
  opts = opts or {}
  local wasSleepy = not self.turn and (now - self.idleSince) >= Mood.SLEEP_AFTER
  self.turn, self.edits, self.failures, self.tools = true, 0, 0, 0
  self.toolSince, self.thinkSince, self.lastText = nil, nil, ""
  if wasSleepy then self:flash("stretch", now, 1.2)
  elseif opts.attachments then self:flash("uploading", now, 0.8)
  elseif opts.resumed then self:flash("remembered", now, 0.9)
  else self:flash("acknowledge", now, 0.9) end
  self:setSteady(opts.attachments and "reading" or "listening", now)
end

function Mood:hold(on, now)
  self.held = on
  if on then self:setSteady("waiting", now) end
end

function Mood:queued(on, now)
  self.waiting = on
  self.waitSince = on and (self.waitSince or now) or nil
end

-- Applies a chat event (chat_panel's events: status, thinking, plan, text,
-- tool, tool_result, permission, session, done, error, build).
function Mood:event(ev, now)
  local t = ev.type
  if t == "status" then
    if (ev.text or ""):lower():find("connect", 1, true) then self:setSteady("connecting", now) end
  elseif t == "session" then
    self:flash("syncing", now, 0.8)
  elseif t == "thinking" then
    self.thinkSince = self.thinkSince or now
    self:setSteady("thinking", now)
  elseif t == "plan" then
    self:setSteady("planning", now)
  elseif t == "text" then
    self.thinkSince = nil
    self.lastText = ev.text or self.lastText
    self:setSteady("writing", now)
  elseif t == "tool" then
    local m = Mood.toolMood(ev.name, ev.tool, ev.kind)
    local thoughtLong = self.thinkSince and (now - self.thinkSince) >= 4
    self.thinkSince = nil
    self.tools = self.tools + 1
    self.toolSince = now
    self.lastKind = m
    if ev.kind == "edit" then
      self.edits = self.edits + 1
      if thoughtLong then self:flash("eureka", now, 0.9) end
    end
    if self.tools > 40 then self:flash("overloaded", now, 1.5)
    elseif not thoughtLong then self:flash("tool_pick", now, 0.4) end
    -- Many edits in a row: working hard.
    if ev.kind == "edit" and self.edits >= 6 and m == "drawing" then m = "working_hard" end
    self:setSteady(m, now)
  elseif t == "tool_result" then
    self.toolSince = nil
    if ev.ok == false then
      self.failures = self.failures + 1
      local detail = (ev.detail or ""):lower()
      if detail:find("no such tool", 1, true) then self:flash("confused", now, 1.5)
      elseif self.failures >= 3 then self:flash("flustered", now, 1.5)
      else self:flash("retry", now, 1.0) end
    elseif self.lastKind == "searching" or self.lastKind == "browsing" or self.lastKind == "rummaging" then
      self:flash("found", now, 0.7)
    end
  elseif t == "permission" then
    self:setSteady("need_approval", now)
  elseif t == "build" then
    self:setSteady("building", now)
  elseif t == "done" then
    self.turn, self.idleSince = false, now
    local text = ev.text or ""
    if text:find("Stopped", 1, true) then self:flash("apologetic", now, 3)
    elseif text:find("stopped early", 1, true) then self:flash("stuck", now, 4)
    elseif self.lastText:match("%?%s*$") then self:setSteady("asking", now); return
    elseif self.edits >= 8 then self:flash("celebrate", now, 2.4)
    elseif self.edits >= 3 then self:flash("proud", now, 2.4)
    else self:flash("done", now, 2) end
    self:setSteady("idle", now)
  elseif t == "error" then
    self.turn, self.idleSince = false, now
    self:flash("error", now, 4)
    self:setSteady("idle", now)
  end
end

-- What idling looks like: a slow cycle, then sleep.
local IDLE_CYCLE = { { "idle", 6 }, { "look_around", 4 }, { "idle", 5 }, { "wander", 3 }, { "idle", 6 }, { "zone_out", 4 } }
local IDLE_LOOP = 0
for _, s in ipairs(IDLE_CYCLE) do IDLE_LOOP = IDLE_LOOP + s[2] end

-- The mood now, and the seconds since it began (for its animation).
function Mood:current(now)
  if self.react and now < self.reactUntil then return self.react, now - self.reactSince end
  self.react = nil
  if self.turn then
    if self.held then return "waiting", now - self.steadySince end
    if self.steady == "thinking" and self.thinkSince and now - self.thinkSince >= Mood.DEEP_AFTER then
      return "deep_thinking", now - self.thinkSince - Mood.DEEP_AFTER
    end
    if self.toolSince and now - self.toolSince >= Mood.LOADING_AFTER then return "loading", now - self.toolSince end
    return self.steady, now - self.steadySince
  end
  if self.waiting then
    if now - self.waitSince >= Mood.IMPATIENT_AFTER then return "impatient", now - self.waitSince end
    return "waiting", now - self.waitSince
  end
  if self.steady ~= "idle" then return self.steady, now - self.steadySince end
  local idle = now - self.idleSince
  if idle >= Mood.SLEEP_AFTER then return "sleepy", idle - Mood.SLEEP_AFTER end
  local at = idle % IDLE_LOOP
  for _, s in ipairs(IDLE_CYCLE) do
    if at < s[2] then return s[1], at end
    at = at - s[2]
  end
  return "idle", idle
end

-- Asking stays until the user answers; a new send clears it.
function Mood:answered(now) if self.steady == "asking" then self:setSteady("idle", now); self.idleSince = now end end

return Mood
