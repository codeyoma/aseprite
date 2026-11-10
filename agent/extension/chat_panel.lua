-- AI Agent chat panel: a non-modal dialog where the user types requests.
-- The bridge runs the agent CLI (Claude Code or Codex) and streams events
-- back; this file only draws the conversation and sends prompts.
--
-- Loaded by agent.lua: `local Panel = dofile(path)(deps)` where deps has
--   request(method, params, callback), isConnected(), contextString(),
--   ensureBridge(callback), preferences.

return function(deps)
  local Panel = {}

  local dlg = nil
  local entries = {}        -- { kind = "...", text = "...", status = nil|"ok"|"failed" }
  local scrollFromBottom = 0
  local busy = false
  local providers = { "claude" }
  local sessionIds = {}      -- provider -> conversation id, so chats survive bridge restarts
  local MAX_ENTRIES = 400

  local COLORS = {
    bg = Color(28, 29, 35),
    user = Color(255, 214, 140),
    text = Color(232, 232, 236),
    thinking = Color(128, 128, 140),
    tool = Color(130, 170, 210),
    ok = Color(120, 200, 130),
    failed = Color(240, 110, 110),
    error = Color(240, 110, 110),
    status = Color(150, 150, 160),
  }

  local function add(kind, text)
    entries[#entries + 1] = { kind = kind, text = text }
    if #entries > MAX_ENTRIES then table.remove(entries, 1) end
    scrollFromBottom = 0
    if dlg then dlg:repaint() end
  end

  -- Wrap text to the canvas width, measuring with the graphics context.
  local function wrap(gc, text, maxWidth)
    local lines = {}
    for paragraph in (text .. "\n"):gmatch("(.-)\n") do
      local line = ""
      for word in paragraph:gmatch("%S+") do
        local candidate = line == "" and word or (line .. " " .. word)
        if gc:measureText(candidate).width <= maxWidth then
          line = candidate
        else
          if line ~= "" then lines[#lines + 1] = line end
          -- Hard-break words longer than the line.
          while gc:measureText(word).width > maxWidth and #word > 1 do
            local cut = #word
            while cut > 1 and gc:measureText(word:sub(1, cut)).width > maxWidth do cut = cut - 1 end
            lines[#lines + 1] = word:sub(1, cut)
            word = word:sub(cut + 1)
          end
          line = word
        end
      end
      lines[#lines + 1] = line
    end
    return lines
  end

  local function entryLines(gc, e, width)
    local prefix, color = "", COLORS[e.kind] or COLORS.text
    if e.kind == "user" then prefix = "You: "
    elseif e.kind == "tool" then
      prefix = "  > "
      if e.status == "ok" then color = COLORS.tool
      elseif e.status == "failed" then color = COLORS.failed end
    elseif e.kind == "thinking" then prefix = "  (thinking) "
    elseif e.kind == "error" then prefix = "Error: " end
    local text = prefix .. e.text
    if e.kind == "tool" then
      text = text .. (e.status == "ok" and "  [ok]" or e.status == "failed" and "  [failed]" or "  ...")
    end
    local out = {}
    for _, l in ipairs(wrap(gc, text, width)) do out[#out + 1] = { text = l, color = color } end
    return out
  end

  local function paint(ev)
    local gc = ev.context
    local w, h = gc.width, gc.height
    gc.color = COLORS.bg
    gc:fillRect(Rectangle(0, 0, w, h))

    local baseH = gc:measureText("Ag").height
    local gap = 3
    local pad = 6
    local all = {}
    for i, e in ipairs(entries) do
      for _, l in ipairs(entryLines(gc, e, w - pad * 2)) do all[#all + 1] = l end
      if i < #entries and (entries[i + 1].kind == "user") then all[#all + 1] = { text = "", color = COLORS.text } end
    end
    if #all == 0 then
      all = { { text = "Ask the agent to change the open sprite.", color = COLORS.status },
              { text = "Example: add a Shadow layer under this one at 50%.", color = COLORS.status } }
    end

    -- Text with glyphs from a fallback font (e.g. Korean, curly quotes) is
    -- taller and drawn lower, so measure every line instead of assuming one height.
    for _, l in ipairs(all) do
      l.h = (l.text == "") and baseH or math.max(baseH, gc:measureText(l.text).height)
    end

    -- Fill the canvas from the bottom, skipping `scrollFromBottom` lines.
    local maxScroll = math.max(0, #all - 1)
    if scrollFromBottom > maxScroll then scrollFromBottom = maxScroll end
    local last = #all - scrollFromBottom
    local first, used = last + 1, 0
    while first > 1 and used + all[first - 1].h + gap <= h - pad * 2 do
      first = first - 1
      used = used + all[first].h + gap
    end
    -- When scrolled to the top, start at the top instead of leaving a gap.
    if first == 1 then
      while last < #all and used + all[last + 1].h + gap <= h - pad * 2 do
        last = last + 1
        used = used + all[last].h + gap
      end
    end

    local y = pad
    for i = first, last do
      gc.color = all[i].color
      gc:fillText(all[i].text, pad, y)
      y = y + all[i].h + gap
    end
  end

  local function updateStatus(text)
    if dlg then dlg:modify{ id = "status", text = text } end
  end

  local function refreshContext()
    if dlg then dlg:modify{ id = "context", text = "Context: " .. deps.contextString() } end
  end

  local function setBusy(b)
    busy = b
    if dlg then
      dlg:modify{ id = "send", enabled = not b }
      dlg:modify{ id = "stop", enabled = b }
    end
  end

  function Panel.onEvent(ev)
    local t = ev.type
    -- The agent may have changed the document; keep the context line current.
    if t == "tool_result" or t == "done" or t == "error" then refreshContext() end
    if t == "session" then
      if ev.provider then sessionIds[ev.provider] = ev.sessionId end
    elseif t == "text" then add("text", ev.text or "")
    elseif t == "thinking" then add("thinking", ev.text or "")
    elseif t == "tool" then add("tool", ev.tool or "tool")
    elseif t == "tool_result" then
      for i = #entries, 1, -1 do
        local e = entries[i]
        if e.kind == "tool" and e.status == nil and e.text == ev.tool then
          e.status = ev.ok and "ok" or "failed"
          break
        end
      end
      if dlg then dlg:repaint() end
    elseif t == "status" then updateStatus(ev.text or "")
    elseif t == "error" then add("error", ev.text or "error"); setBusy(false); updateStatus("")
    elseif t == "done" then
      if ev.text then add("status", ev.text) end
      setBusy(false)
      updateStatus("")
    end
  end

  function Panel.onConnectionChange(isConnected)
    if not dlg then return end
    updateStatus(isConnected and "" or "Bridge not connected")
    if isConnected then
      deps.request("chat.info", {}, function(result)
        if not result or not result.providers then return end
        local list = {}
        if result.providers.claude then list[#list + 1] = "claude" end
        if result.providers.codex then list[#list + 1] = "codex" end
        if #list > 0 then
          providers = list
          local current = deps.preferences.provider or list[1]
          dlg:modify{ id = "provider", options = list, option = current }
        end
        if result.busy then setBusy(true) end
      end)
    end
  end

  local function send()
    if busy or not dlg then return end
    local prompt = dlg.data.prompt or ""
    if prompt:match("^%s*$") then return end
    local provider = dlg.data.provider or providers[1]
    deps.preferences.provider = provider
    local context = deps.contextString()

    add("user", prompt)
    dlg:modify{ id = "prompt", text = "" }
    setBusy(true)
    updateStatus("Connecting...")

    deps.ensureBridge(function(ok, err)
      if not ok then
        add("error", err or "Could not reach the bridge")
        setBusy(false)
        updateStatus("")
        return
      end
      deps.request("chat.send", {
        prompt = prompt, context = context, provider = provider, sessionId = sessionIds[provider] or "",
      }, function(_, error)
        if error then
          add("error", error.message or tostring(error))
          setBusy(false)
          updateStatus("")
        end
      end)
    end)
  end

  -- Lets other scripts (and tests) send a prompt without typing it.
  function Panel.submit(prompt, provider)
    Panel.open()
    dlg:modify{ id = "prompt", text = prompt }
    if provider then dlg:modify{ id = "provider", option = provider } end
    send()
  end

  function Panel.isBusy() return busy end
  function Panel.isOpen() return dlg ~= nil end
  function Panel.promptText() return dlg and dlg.data.prompt or nil end
  function Panel.close() if dlg then dlg:close() end end
  function Panel.entries() return entries end

  function Panel.open()
    if dlg then return end
    dlg = Dialog{
      title = "AI Agent",
      resizeable = true,
      -- Docks in the main window on this fork (dockable script dialogs);
      -- stock Aseprite ignores these fields and shows a floating dialog.
      dockable = true,
      id = "aseprite-agent.chat",
      onclose = function() dlg = nil end,
    }
    dlg:canvas{
      id = "log",
      width = 200,      -- minimum; the canvas expands with the dialog or dock
      height = 240,
      hexpand = true,
      vexpand = true,
      onpaint = paint,
      onwheel = function(ev)
        scrollFromBottom = math.max(0, scrollFromBottom + (ev.deltaY < 0 and 3 or -3))
        dlg:repaint()
      end,
    }
    dlg:newrow()
    dlg:label{ id = "context", text = "Context: " .. deps.contextString(), hexpand = true }
    dlg:newrow()
    dlg:label{ id = "status", text = deps.isConnected() and "" or "Bridge not connected", hexpand = true }
    dlg:newrow()
    dlg:entry{
      id = "prompt",
      text = "",
      placeholder = "Draw, edit or animate...",
      focus = true,
      hexpand = true,
    }
    dlg:newrow()
    dlg:combobox{ id = "provider", options = providers, option = deps.preferences.provider or providers[1] }
    dlg:button{ id = "send", text = "&Send", onclick = send }
    dlg:button{ id = "stop", text = "S&top", enabled = false, onclick = function()
      deps.request("chat.stop", {}, function() end)
    end }
    dlg:button{ id = "new", text = "&New chat", onclick = function()
      deps.request("chat.reset", {}, function() end)
      entries = {}
      sessionIds = {}
      setBusy(false)
      updateStatus("")
      dlg:repaint()
    end }
    dlg:show{ wait = false }
    Panel.onConnectionChange(deps.isConnected())
  end

  function Panel.refreshContext() refreshContext() end

  return Panel
end
