-- AI Agent chat panel: a dialog (docked on this fork) where the user types
-- requests. The bridge runs the agent CLI (Claude Code or Codex) and streams
-- events back; this file draws the conversation and sends prompts.
--
-- Loaded by agent.lua: `local Panel = dofile(path)(deps)` where deps has
--   request(method, params, callback), isConnected(), contextString(),
--   ensureBridge(callback), preferences.
--
-- Conversation layout:
--   user messages      right-aligned bubbles
--   agent turns        "● Claude" header, then one row per step:
--                      "Thought for 3s >", "<icon> Add Shadow layer (ok) >",
--                      the reply text, and "Worked for 1m 49s".
-- Rows with details (thinking text, tool input/output) expand on click.

return function(deps)
  local Panel = {}

  local dlg = nil
  local entries = {}          -- see Panel.onEvent for the shapes
  local scrollPx = 0          -- distance scrolled up from the bottom, in pixels
  local hitRows = {}          -- clickable rows from the last paint: { y0, y1, entry }
  local contentH, viewH = 0, 0
  local busy = false
  local providers = { "claude" }
  local sessionIds = {}       -- provider -> conversation id, so chats survive bridge restarts
  local turnStart, lastEvent = nil, nil
  local ticker = nil
  local MAX_ENTRIES = 400

  local C = {
    bg = Color(38, 38, 41),
    text = Color(228, 228, 232),
    dim = Color(150, 150, 158),
    faint = Color(110, 110, 118),
    bubble = Color(58, 58, 64),
    bubbleText = Color(240, 240, 244),
    accent = Color(222, 184, 135),
    ok = Color(88, 200, 120),
    failed = Color(235, 100, 100),
    rule = Color(60, 60, 66),
  }

  local PROVIDER_NAMES = { claude = "Claude", codex = "Codex" }

  local function now() return os.time() end

  local function formatSeconds(s)
    s = math.max(0, math.floor(s + 0.5))
    if s < 60 then return s .. "s" end
    return string.format("%dm %ds", s // 60, s % 60)
  end

  local function add(e)
    entries[#entries + 1] = e
    if #entries > MAX_ENTRIES then table.remove(entries, 1) end
    scrollPx = 0
    if dlg then dlg:repaint() end
    return e
  end

  ---------------------------------------------------------------------------
  -- Text layout
  ---------------------------------------------------------------------------

  -- Wrap text to maxWidth (pixels), measuring with the graphics context.
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
          -- Hard-break words longer than the line (UTF-8 aware).
          while gc:measureText(word).width > maxWidth and (utf8.len(word) or 0) > 1 do
            local cut = utf8.len(word)
            while cut > 1 and gc:measureText(word:sub(1, utf8.offset(word, cut + 1) - 1)).width > maxWidth do
              cut = cut - 1
            end
            local byte = utf8.offset(word, cut + 1) - 1
            lines[#lines + 1] = word:sub(1, byte)
            word = word:sub(byte + 1)
          end
          line = word
        end
      end
      lines[#lines + 1] = line
    end
    return lines
  end

  -- Wrapped lines are cached per entry, field and width.
  local function wrapCached(gc, e, field, text, maxWidth)
    e.cache = e.cache or {}
    local c = e.cache[field]
    if c and c.w == maxWidth and c.text == text then return c.lines end
    local lines = wrap(gc, text, maxWidth)
    e.cache[field] = { w = maxWidth, text = text, lines = lines }
    return lines
  end

  ---------------------------------------------------------------------------
  -- Icons (drawn with paths so they scale with the font)
  ---------------------------------------------------------------------------

  local function iconPencil(gc, x, y, s, color)
    gc.color = color
    gc.strokeWidth = math.max(1, s / 8)
    gc:beginPath()
    gc:moveTo(x + s * 0.15, y + s * 0.85)
    gc:lineTo(x + s * 0.30, y + s * 0.45)
    gc:lineTo(x + s * 0.70, y + s * 0.05)
    gc:lineTo(x + s * 0.95, y + s * 0.30)
    gc:lineTo(x + s * 0.55, y + s * 0.70)
    gc:closePath()
    gc:moveTo(x + s * 0.15, y + s * 0.85)
    gc:lineTo(x + s * 0.55, y + s * 0.70)
    gc:moveTo(x, y + s)
    gc:lineTo(x + s * 0.45, y + s)
    gc:stroke()
  end

  local function iconEye(gc, x, y, s, color)
    gc.color = color
    gc.strokeWidth = math.max(1, s / 8)
    gc:beginPath()
    gc:moveTo(x, y + s * 0.5)
    gc:cubicTo(x + s * 0.25, y + s * 0.05, x + s * 0.75, y + s * 0.05, x + s, y + s * 0.5)
    gc:cubicTo(x + s * 0.75, y + s * 0.95, x + s * 0.25, y + s * 0.95, x, y + s * 0.5)
    gc:stroke()
    gc:beginPath()
    gc:oval(Rectangle(x + s * 0.36, y + s * 0.36, s * 0.28, s * 0.28))
    gc:fill()
  end

  local function iconCheck(gc, x, y, s, ok)
    gc.color = ok and C.ok or C.failed
    gc.strokeWidth = math.max(1, s / 9)
    gc:beginPath()
    gc:oval(Rectangle(x, y, s, s))
    gc:stroke()
    gc:beginPath()
    if ok then
      gc:moveTo(x + s * 0.28, y + s * 0.52)
      gc:lineTo(x + s * 0.44, y + s * 0.68)
      gc:lineTo(x + s * 0.73, y + s * 0.36)
    else
      gc:moveTo(x + s * 0.33, y + s * 0.33)
      gc:lineTo(x + s * 0.67, y + s * 0.67)
      gc:moveTo(x + s * 0.67, y + s * 0.33)
      gc:lineTo(x + s * 0.33, y + s * 0.67)
    end
    gc:stroke()
  end

  local function iconSpinner(gc, x, y, s)
    gc.color = C.dim
    local t = os.clock() * 6
    for i = 0, 2 do
      local a = (i / 3) * math.pi * 2 + t
      local r = s * 0.12
      gc:beginPath()
      gc:oval(Rectangle(x + s / 2 + math.cos(a) * s * 0.32 - r, y + s / 2 + math.sin(a) * s * 0.32 - r, r * 2, r * 2))
      gc:fill()
    end
  end

  local function iconChevron(gc, x, y, s, expanded)
    gc.color = C.dim
    gc.strokeWidth = math.max(1, s / 8)
    gc:beginPath()
    if expanded then
      gc:moveTo(x + s * 0.2, y + s * 0.35)
      gc:lineTo(x + s * 0.5, y + s * 0.65)
      gc:lineTo(x + s * 0.8, y + s * 0.35)
    else
      gc:moveTo(x + s * 0.35, y + s * 0.2)
      gc:lineTo(x + s * 0.65, y + s * 0.5)
      gc:lineTo(x + s * 0.35, y + s * 0.8)
    end
    gc:stroke()
  end

  ---------------------------------------------------------------------------
  -- Painting
  ---------------------------------------------------------------------------

  -- Builds the rows for the current width. Each row has a height, a gap
  -- after it and a draw(y) function; clickable rows also carry their entry.
  local function buildRows(gc, w)
    local lh = gc:measureText("Ag").height
    local u = math.max(2, lh // 3)       -- spacing unit
    local pad = u * 3
    local icon = math.floor(lh * 0.9)
    local textW = w - pad * 2
    local rows = {}

    local function lineHeight(text)
      return text == "" and lh or math.max(lh, gc:measureText(text).height)
    end

    local function textBlock(e, field, text, x, maxW, color)
      local lines = wrapCached(gc, e, field, text, maxW)
      local h = 0
      for _, l in ipairs(lines) do h = h + lineHeight(l) + u // 2 end
      return h, function(y)
        gc.color = color
        for _, l in ipairs(lines) do
          gc:fillText(l, x, y)
          y = y + lineHeight(l) + u // 2
        end
      end
    end

    local function addRow(h, draw, entry, gap)
      rows[#rows + 1] = { h = h, draw = draw, entry = entry, gap = gap or u * 2 }
    end

    -- A step row: [icon] label [status] [chevron], plus the expanded detail.
    local function stepRow(e, drawIcon, label, labelColor, status)
      local hasDetail = (e.detail and e.detail ~= "") or (e.result and e.result ~= "")
      local x = pad + (drawIcon and icon + u * 2 or 0)
      local labelLines = wrapCached(gc, e, "label", label, math.max(lh, textW - (x - pad) - icon * 2 - u * 4))
      local first = labelLines[1] or ""
      if #labelLines > 1 then first = first .. "…" end
      local h = lineHeight(first)
      addRow(h, function(y)
        if drawIcon then drawIcon(gc, pad, y + (h - icon) / 2, icon) end
        gc.color = labelColor
        gc:fillText(first, x, y)
        local cx = x + gc:measureText(first).width + u * 2
        if status == "ok" or status == "failed" then
          iconCheck(gc, cx, y + (h - icon) / 2, icon, status == "ok")
          cx = cx + icon + u * 2
        elseif status == "running" then
          iconSpinner(gc, cx, y + (h - icon) / 2, icon)
          cx = cx + icon + u * 2
        end
        if hasDetail then iconChevron(gc, cx, y + (h - icon) / 2, icon, e.expanded) end
      end, hasDetail and e or nil, e.expanded and u or u * 2)

      if e.expanded and hasDetail then
        local parts = {}
        if e.detail and e.detail ~= "" then parts[#parts + 1] = e.detail end
        if e.result and e.result ~= "" then parts[#parts + 1] = "→ " .. e.result end
        local bh, draw = textBlock(e, "detail", table.concat(parts, "\n"), x, textW - (x - pad), C.faint)
        addRow(bh, draw, nil, u * 2)
      end
    end

    for _, e in ipairs(entries) do
      local k = e.kind
      if k == "user" then
        local maxW = math.floor(w * 0.8)
        local bx = u * 3
        local lines = wrapCached(gc, e, "text", e.text, maxW - bx * 2)
        local tw, th = 0, 0
        for _, l in ipairs(lines) do
          tw = math.max(tw, gc:measureText(l).width)
          th = th + lineHeight(l) + u // 2
        end
        local bw, bh = tw + bx * 2, th + u * 4
        addRow(bh, function(y)
          local x0 = w - pad - bw
          gc.color = C.bubble
          gc:beginPath()
          gc:roundedRect(Rectangle(x0, y, bw, bh), u * 4, u * 4)
          gc:fill()
          gc.color = C.bubbleText
          local ty = y + u * 2
          for _, l in ipairs(lines) do
            gc:fillText(l, x0 + bx, ty)
            ty = ty + lineHeight(l) + u // 2
          end
        end, nil, u * 4)

      elseif k == "header" then
        addRow(lh, function(y)
          local d = math.floor(lh * 0.55)
          gc.color = C.accent
          gc:beginPath()
          gc:oval(Rectangle(pad, y + (lh - d) / 2, d, d))
          gc:fill()
          gc.color = C.text
          gc:fillText(e.text, pad + d + u * 2, y)
        end, nil, u * 3)

      elseif k == "thought" then
        e.detail = e.text
        stepRow(e, nil, "Thought for " .. formatSeconds(e.secs or 0), C.dim, nil)

      elseif k == "tool" then
        local drawIcon = function(g, x, y, s)
          if e.toolKind == "edit" then iconPencil(g, x, y, s, C.dim) else iconEye(g, x, y, s, C.dim) end
        end
        stepRow(e, drawIcon, e.text, C.text, e.status or (busy and "running" or nil))

      elseif k == "text" then
        local h, draw = textBlock(e, "text", e.text, pad, textW, C.text)
        addRow(h, draw, nil, u * 3)

      elseif k == "worked" then
        addRow(lh + u * 2, function(y)
          gc.color = C.dim
          gc:fillText("Worked for " .. formatSeconds(e.secs or 0), pad, y)
          gc.color = C.rule
          gc:fillRect(Rectangle(pad, y + lh + u, w - pad * 2, math.max(1, u // 3)))
        end, nil, u * 4)

      elseif k == "error" then
        local h, draw = textBlock(e, "text", e.text, pad, textW, C.failed)
        addRow(h, draw, nil, u * 3)

      else -- "status"
        local h, draw = textBlock(e, "text", e.text, pad, textW, C.dim)
        addRow(h, draw, nil, u * 3)
      end
    end

    if busy and turnStart then
      addRow(lh, function(y)
        iconSpinner(gc, pad, y + (lh - icon) / 2, icon)
        gc.color = C.dim
        gc:fillText("Working... " .. formatSeconds(now() - turnStart), pad + icon + u * 2, y)
      end, nil, u * 2)
    end

    if #rows == 0 then
      local h, draw = textBlock({}, "t",
        "Ask the agent to change the open sprite.\nExample: add a Shadow layer under this one at 50%.",
        pad, textW, C.dim)
      addRow(h, draw, nil, 0)
    end
    return rows, pad
  end

  local function paint(ev)
    local gc = ev.context
    local w, h = gc.width, gc.height
    gc.color = C.bg
    gc:fillRect(Rectangle(0, 0, w, h))

    local rows, pad = buildRows(gc, w)
    local total = pad * 2
    for _, r in ipairs(rows) do total = total + r.h + r.gap end
    contentH, viewH = total, h

    -- Bottom-anchored: newest rows at the bottom; scrollPx moves up.
    local maxScroll = math.max(0, total - h)
    if scrollPx > maxScroll then scrollPx = maxScroll end
    local y = (total <= h) and pad or (h - total + scrollPx + pad)

    hitRows = {}
    for _, r in ipairs(rows) do
      if y + r.h >= 0 and y <= h then r.draw(y) end
      if r.entry then hitRows[#hitRows + 1] = { y0 = y, y1 = y + r.h, entry = r.entry } end
      y = y + r.h + r.gap
    end
  end

  ---------------------------------------------------------------------------
  -- State updates
  ---------------------------------------------------------------------------

  local function updateStatus(text)
    if dlg then dlg:modify{ id = "status", text = text } end
  end

  local function refreshContext()
    if dlg then dlg:modify{ id = "context", text = "Context: " .. deps.contextString() } end
  end

  local function stopTicker()
    if ticker then ticker:stop(); ticker = nil end
  end

  local function setBusy(b)
    busy = b
    if dlg then
      dlg:modify{ id = "send", enabled = not b }
      dlg:modify{ id = "stop", enabled = b }
    end
    if b and not ticker and dlg then
      -- Repaint for the spinner and the "Working... Ns" counter.
      ticker = Timer{ interval = 0.25, ontick = function() if dlg then dlg:repaint() end end }
      ticker:start()
    elseif not b then
      stopTicker()
      if dlg then dlg:repaint() end
    end
  end

  local function finishTurn(text)
    if turnStart then add{ kind = "worked", secs = now() - turnStart } end
    if text then add{ kind = "status", text = text } end
    turnStart = nil
    setBusy(false)
    updateStatus("")
  end

  local function sinceLast()
    local t = now()
    local s = t - (lastEvent or t)
    lastEvent = t
    return s
  end

  -- Entry shapes:
  --   { kind = "user" | "header" | "text" | "status" | "error", text }
  --   { kind = "thought", text, secs }
  --   { kind = "tool", text, id, toolKind = "edit"|"read", detail, status, result }
  --   { kind = "worked", secs }
  function Panel.onEvent(ev)
    local t = ev.type
    -- The agent may have changed the document; keep the context line current.
    if t == "tool_result" or t == "done" or t == "error" then refreshContext() end

    if t == "session" then
      if ev.provider then sessionIds[ev.provider] = ev.sessionId end
    elseif t == "text" then
      sinceLast()
      add{ kind = "text", text = ev.text or "" }
    elseif t == "thinking" then
      add{ kind = "thought", text = ev.text or "", secs = sinceLast() }
    elseif t == "tool" then
      sinceLast()
      add{ kind = "tool", text = ev.tool or "tool", id = ev.id, toolKind = ev.kind, detail = ev.detail }
    elseif t == "tool_result" then
      sinceLast()
      for i = #entries, 1, -1 do
        local e = entries[i]
        if e.kind == "tool" and e.status == nil and ((ev.id and e.id == ev.id) or (not ev.id and e.text == ev.tool)) then
          e.status = ev.ok and "ok" or "failed"
          e.result = ev.detail
          e.cache = nil
          break
        end
      end
      if dlg then dlg:repaint() end
    elseif t == "status" then
      updateStatus(ev.text or "")
    elseif t == "error" then
      add{ kind = "error", text = ev.text or "error" }
      finishTurn()
    elseif t == "done" then
      finishTurn(ev.text)
    end
  end

  function Panel.onConnectionChange(isConnected)
    if not dlg then return end
    updateStatus(isConnected and "" or "Bridge not connected")
    if isConnected then
      deps.request("chat.info", {}, function(result)
        if not result or not result.providers or not dlg then return end
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

    add{ kind = "user", text = prompt }
    add{ kind = "header", text = PROVIDER_NAMES[provider] or provider }
    turnStart, lastEvent = now(), now()
    dlg:modify{ id = "prompt", text = "" }
    setBusy(true)
    updateStatus("Connecting...")

    deps.ensureBridge(function(ok, err)
      if not ok then
        add{ kind = "error", text = err or "Could not reach the bridge" }
        finishTurn()
        return
      end
      deps.request("chat.send", {
        prompt = prompt, context = context, provider = provider, sessionId = sessionIds[provider] or "",
      }, function(_, error)
        if error then
          add{ kind = "error", text = error.message or tostring(error) }
          finishTurn()
        else
          updateStatus("")
        end
      end)
    end)
  end

  ---------------------------------------------------------------------------
  -- Public API
  ---------------------------------------------------------------------------

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
  function Panel.setPrompt(text) if dlg then dlg:modify{ id = "prompt", text = text } end end
  function Panel.close() if dlg then dlg:close() end end
  function Panel.refreshContext() refreshContext() end

  -- Entries as plain records (for tests and other scripts).
  function Panel.entries()
    local out = {}
    for _, e in ipairs(entries) do
      out[#out + 1] = { kind = e.kind, text = e.text, status = e.status, secs = e.secs }
    end
    return out
  end

  -- Expands every row with details (for screenshots and tests).
  function Panel.expandAll(state)
    for _, e in ipairs(entries) do e.expanded = state ~= false end
    if dlg then dlg:repaint() end
  end

  function Panel.open()
    if dlg then return end
    dlg = Dialog{
      title = "AI Agent",
      resizeable = true,
      -- Docks in the main window on this fork (dockable script dialogs);
      -- stock Aseprite ignores these fields and shows a floating dialog.
      dockable = true,
      id = "aseprite-agent.chat",
      onclose = function() stopTicker(); dlg = nil end,
    }
    dlg:canvas{
      id = "log",
      width = 200,      -- minimum; the canvas expands with the dialog or dock
      height = 240,
      autoscaling = false,      -- full resolution, so the system font stays crisp
      font = "system",
      fontsize = 13,
      hexpand = true,
      vexpand = true,
      onpaint = paint,
      onwheel = function(ev)
        local step = 48
        scrollPx = math.max(0, math.min(math.max(0, contentH - viewH), scrollPx + (ev.deltaY < 0 and step or -step)))
        dlg:repaint()
      end,
      onmousedown = function(ev)
        for _, r in ipairs(hitRows) do
          if ev.y >= r.y0 and ev.y <= r.y1 then
            r.entry.expanded = not r.entry.expanded
            dlg:repaint()
            return
          end
        end
      end,
    }
    dlg:newrow()
    dlg:label{ id = "context", text = "Context: " .. deps.contextString(), hexpand = true, font = "system", fontsize = 11 }
    dlg:newrow()
    dlg:label{ id = "status", text = deps.isConnected() and "" or "Bridge not connected", hexpand = true,
               font = "system", fontsize = 11 }
    dlg:newrow()
    -- Multi-line box that wraps and grows (this fork's dlg:textedit);
    -- stock Aseprite falls back to a single-line entry.
    local hasTextEdit = pcall(function()
      dlg:textedit{
        id = "prompt",
        text = "",
        placeholder = "Draw, edit or animate...",
        minlines = 1,
        maxlines = 5,
        focus = true,
        font = "system",
        fontsize = 13,
        onsubmit = function() send() end,   -- Enter sends, Shift+Enter adds a line
      }
    end)
    if not hasTextEdit then
      dlg:entry{ id = "prompt", text = "", placeholder = "Draw, edit or animate...", focus = true, hexpand = true }
    end
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
      turnStart = nil
      setBusy(false)
      updateStatus("")
      dlg:repaint()
    end }
    dlg:show{ wait = false }
    if busy then setBusy(true) end
    Panel.onConnectionChange(deps.isConnected())
  end

  return Panel
end
