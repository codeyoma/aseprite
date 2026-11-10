-- AI Agent chat panel: a dialog (docked on this fork) where the user types
-- requests. The bridge runs the agent CLI (Claude Code or Codex) and streams
-- events back; this file draws the conversation and sends prompts.
--
-- Loaded by agent.lua: `local Panel = dofile(path)(deps)` where deps has
--   request(method, params, callback), isConnected(), contextString(), stateBlock(),
--   mentionTargets(), resolveUri(uri), selectUri(uri), TurnHistory (turn_history.lua),
--   ensureBridge(callback), preferences, Conversation (conversation.lua).
--
-- The conversation itself (entries, timings, tool status, conversation ids)
-- lives in the Conversation module; this file only draws it and keeps view
-- state (expanded rows, layout caches, scroll).
--
-- Conversation layout:
--   user messages      right-aligned bubbles
--   agent turns        "● Claude" header, then one row per step:
--                      "Thought for 3s >", "<icon> Add Shadow layer (ok) >",
--                      the reply text, and "Worked for 1m 49s".
-- Rows with details (thinking text, tool input/output) expand on click.

-- The input box's hint text.
local PLACEHOLDER = "Draw, edit or animate..."

return function(deps)
  local Panel = {}

  local dlg = nil
  local conv = deps.Conversation.new{ clock = os.time }
  local expanded = setmetatable({}, { __mode = "k" })   -- entry -> true
  local caches = setmetatable({}, { __mode = "k" })     -- entry -> wrapped lines per field
  local scrollPx = 0          -- distance scrolled up from the bottom, in pixels
  local hitRows = {}          -- clickable rows from the last paint: { y0, y1, entry }
  local hitLinks = {}         -- links drawn in the last paint: { x0, y0, x1, y1, uri }
  local hitButtons = {}       -- Revert/Restore buttons: { x0, y0, x1, y1, action }
  local turns = setmetatable({}, { __mode = "k" })   -- header entry -> Turn History record
  local currentTurn = nil     -- the running turn's record
  local lastTurn = nil        -- the last finished turn, for "changes since your last reply"
  local mentions = {}         -- @[label] -> aseprite:// URI for the draft being typed
  local lastPrompt = ""
  local contentH, viewH = 0, 0
  -- The / picker (#35): the Skill Catalog from the bridge, and the matches
  -- shown at the bottom of the log while the prompt is "/query".
  local catalogRows = {}
  local suggest = nil          -- { items = { { kind, name, title, source, description, needs } } }
  local hitSuggest = {}
  local refreshCatalog       -- defined with the picker below
  local providers = { "claude" }
  local ticker = nil

  local C = {
    bg = Color(38, 38, 41),
    text = Color(228, 228, 232),
    dim = Color(150, 150, 158),
    faint = Color(110, 110, 118),
    bubble = Color(58, 58, 64),
    link = Color(120, 170, 255),
    bubbleText = Color(240, 240, 244),
    accent = Color(222, 184, 135),
    ok = Color(88, 200, 120),
    failed = Color(235, 100, 100),
    rule = Color(60, 60, 66),
  }

  local function formatSeconds(s)
    s = math.max(0, math.floor(s + 0.5))
    if s < 60 then return s .. "s" end
    return string.format("%dm %ds", s // 60, s % 60)
  end

  -- New content scrolls back to the bottom.
  local function changed()
    scrollPx = 0
    if dlg then dlg:repaint() end
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
    caches[e] = caches[e] or {}
    local c = caches[e][field]
    if c and c.w == maxWidth and c.text == text then return c.lines end
    local lines = wrap(gc, text, maxWidth)
    caches[e][field] = { w = maxWidth, text = text, lines = lines }
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
    local function stepRow(e, drawIcon, label, labelColor, status, detail, result)
      local hasDetail = (detail and detail ~= "") or (result and result ~= "") or e.capture ~= nil
      local open = expanded[e]
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
        if hasDetail then iconChevron(gc, cx, y + (h - icon) / 2, icon, open) end
      end, hasDetail and e or nil, open and u or u * 2)

      if open and hasDetail and ((detail and detail ~= "") or (result and result ~= "")) then
        local parts = {}
        if detail and detail ~= "" then parts[#parts + 1] = detail end
        if result and result ~= "" then parts[#parts + 1] = "→ " .. result end
        local bh, draw = textBlock(e, "detail", table.concat(parts, "\n"), x, textW - (x - pad), C.faint)
        addRow(bh, draw, nil, u * 2)
      end

      -- Before | After | Changes thumbnails of an edit step (#23).
      if open and e.capture then
        local cap = e.capture
        local gap = u * 2
        local avail = textW - (x - pad)
        local box = math.min(math.floor((avail - gap * 2) / 3), u * 40)
        local iw, ih = cap.after.width, cap.after.height
        local s = box / math.max(iw, ih)
        if s >= 1 then s = math.floor(s) end
        local dw, dh = math.max(1, math.floor(iw * s)), math.max(1, math.floor(ih * s))
        local caption = cap.changed == 1 and "1 px changed" or (cap.changed .. " px changed")
        local thumbs = { { "Before", cap.before }, { "After", cap.after }, { caption, cap.diff } }
        addRow(dh + lh + u, function(y)
          for i, t in ipairs(thumbs) do
            local tx = x + (i - 1) * (box + gap)
            gc.color = C.rule
            gc:fillRect(Rectangle(tx, y, dw, dh))
            if t[2] then
              gc:drawImage(t[2], Rectangle(0, 0, t[2].width, t[2].height), Rectangle(tx, y, dw, dh))
            end
            gc.color = C.faint
            gc:fillText(t[1], tx, y + dh + u)
          end
        end, nil, u * 2)
      end
    end

    local busy = conv:isBusy()
    local turnUndone = false     -- steps of a reverted reply are drawn faint
    for _, e in ipairs(conv:entries()) do
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
        local turn = turns[e]
        local status = turn and turn.finish and deps.TurnHistory.status(turn) or nil
        turnUndone = (status == "undone")
        addRow(lh, function(y)
          local d = math.floor(lh * 0.55)
          gc.color = C.accent
          gc:beginPath()
          gc:oval(Rectangle(pad, y + (lh - d) / 2, d, d))
          gc:fill()
          gc.color = C.text
          gc:fillText(e.text, pad + d + u * 2, y)
          -- Revert / Restore for the whole reply (#22).
          local action, label
          if status == "done" or status == "partly undone" then
            if deps.TurnHistory.canRevert(turn) then action, label = "revert", "Revert" end
          elseif status == "undone" then
            action, label = "restore", "Restore"
          end
          local x = w - pad
          if label then
            local bw = gc:measureText(label).width + u * 4
            x = x - bw
            gc.color = C.rule
            gc:beginPath()
            gc:roundedRect(Rectangle(x, y - u // 2, bw, lh + u), u * 2, u * 2)
            gc:fill()
            gc.color = C.text
            gc:fillText(label, x + u * 2, y)
            hitButtons[#hitButtons + 1] = { x0 = x, y0 = y - u // 2, x1 = x + bw, y1 = y + lh + u // 2, turn = turn, action = action }
          end
          if status == "undone" or status == "partly undone" then
            local note = status == "undone" and "reverted" or "partly undone"
            gc.color = C.dim
            gc:fillText(note, x - gc:measureText(note).width - u * 3, y)
          end
        end, nil, u * 3)

      elseif k == "thought" then
        stepRow(e, nil, "Thought for " .. formatSeconds(e.secs or 0), C.dim, nil, e.text)

      elseif k == "tool" then
        local drawIcon = function(g, x, y, s)
          if e.toolKind == "edit" then iconPencil(g, x, y, s, C.dim) else iconEye(g, x, y, s, C.dim) end
        end
        stepRow(e, drawIcon, e.text, turnUndone and C.faint or C.text, e.status or (busy and "running" or nil), e.detail, e.result)

      elseif k == "plan" then
        -- The agent's plan as a checklist (ACP).
        addRow(lh, function(y)
          gc.color = C.dim
          gc:fillText("Plan", pad, y)
        end, nil, u)
        for _, it in ipairs(e.items or {}) do
          local mark = it.status == "completed" and "[x]" or (it.status == "in_progress" and "[>]" or "[ ]")
          local color = it.status == "completed" and C.dim or C.text
          local h, draw = textBlock(it, "plan", mark .. " " .. it.content, pad + u * 2, textW - u * 2, color)
          addRow(h, draw, nil, u)
        end
        rows[#rows].gap = u * 3

      elseif k == "text" then
        -- Replies may cite objects as [label](aseprite://...) links (#20).
        local display, links = deps.Conversation.parseLinks(e.text)
        local lines = wrapCached(gc, e, "text", display, textW)
        local h = 0
        for _, l in ipairs(lines) do h = h + lineHeight(l) + u // 2 end
        addRow(h, function(y)
          local li = 1   -- next link to place
          for _, l in ipairs(lines) do
            gc.color = C.text
            gc:fillText(l, pad, y)
            -- Overdraw link labels that fall on this line, in order.
            local searchFrom = 1
            while li <= #links do
              local link = links[li]
              local s, eIdx = l:find(link.label, searchFrom, true)
              if not s then break end
              if deps.resolveUri(link.uri) then   -- stale links stay plain text
                local x0 = pad + gc:measureText(l:sub(1, s - 1)).width
                local w = gc:measureText(link.label).width
                local lh2 = lineHeight(l)
                gc.color = C.link
                gc:fillText(link.label, x0, y)
                gc:fillRect(Rectangle(x0, y + lh2 - 2, w, 1))
                hitLinks[#hitLinks + 1] = { x0 = x0, y0 = y, x1 = x0 + w, y1 = y + lh2, uri = link.uri }
              end
              searchFrom = eIdx + 1
              li = li + 1
            end
            y = y + lineHeight(l) + u // 2
          end
        end, nil, u * 3)

      elseif k == "variations" then
        -- Thumbnails to keep one variation, or Discard (#25).
        local gap = u * 2
        local n = math.max(1, #e.items)
        local box = math.min(math.floor((textW - gap * (n - 1)) / math.min(n, 4)), u * 32)
        addRow(lh, function(y)
          gc.color = C.dim
          gc:fillText("Variations of " .. e.task .. (e.resolved and (": " .. e.resolved) or ""), pad, y)
          if not e.resolved then
            local label = "Discard"
            local bw = gc:measureText(label).width + u * 4
            local x = w - pad - bw
            gc.color = C.rule
            gc:beginPath()
            gc:roundedRect(Rectangle(x, y - u // 2, bw, lh + u), u * 2, u * 2)
            gc:fill()
            gc.color = C.text
            gc:fillText(label, x + u * 2, y)
            hitButtons[#hitButtons + 1] = { x0 = x, y0 = y - u // 2, x1 = x + bw, y1 = y + lh + u // 2,
              action = "discard_variations", entry = e }
          end
        end, nil, u * 2)
        if not e.resolved then
          local perRow = math.min(n, 4)
          for row = 0, math.ceil(n / perRow) - 1 do
            addRow(box + lh + u, function(y)
              for col = 1, perRow do
                local i = row * perRow + col
                local it = e.items[i]
                if it then
                  local tx = pad + (col - 1) * (box + gap)
                  local iw, ih = it.image.width, it.image.height
                  local s = box / math.max(iw, ih)
                  if s >= 1 then s = math.floor(s) end
                  local dw, dh = math.max(1, math.floor(iw * s)), math.max(1, math.floor(ih * s))
                  gc.color = C.rule
                  gc:fillRect(Rectangle(tx, y, box, box))
                  gc:drawImage(it.image, Rectangle(0, 0, iw, ih), Rectangle(tx + (box - dw) // 2, y + (box - dh) // 2, dw, dh))
                  gc.color = C.faint
                  gc:fillText("Keep v" .. i, tx, y + box + u)
                  hitButtons[#hitButtons + 1] = { x0 = tx, y0 = y, x1 = tx + box, y1 = y + box + lh,
                    action = "pick_variation", entry = e, index = i }
                end
              end
            end, nil, u * 2)
          end
        end

      elseif k == "worked" then
        addRow(lh + u * 2, function(y)
          gc.color = C.dim
          local label = "Worked for " .. formatSeconds(e.secs or 0)
          gc:fillText(label, pad, y)
          -- Badge from the turn's last pixel-art check (#29).
          if e.check then
            local bx = pad + gc:measureText(label).width + u * 3
            local clean = e.check.errors == 0 and e.check.warnings == 0
            iconCheck(gc, bx, y + (lh - icon) / 2, icon, e.check.errors == 0)
            gc.color = e.check.errors > 0 and C.failed or C.dim
            local note = clean and "Checked"
              or (e.check.errors > 0 and string.format("%d error%s", e.check.errors, e.check.errors == 1 and "" or "s")
                or string.format("%d warning%s", e.check.warnings, e.check.warnings == 1 and "" or "s"))
            gc:fillText(note, bx + icon + u * 2, y)
          end
          -- Developer mode (#28): apply the agent's changes, or discard them.
          if e.devActions then
            local x = w - pad
            for _, b in ipairs({ { "Discard", "dev_discard", C.rule, C.text }, { "Rebuild & Relaunch", "dev_apply", C.accent, C.bubbleText } }) do
              local bw = gc:measureText(b[1]).width + u * 4
              x = x - bw
              gc.color = b[3]
              gc:beginPath()
              gc:roundedRect(Rectangle(x, y - u // 2, bw, lh + u), u * 2, u * 2)
              gc:fill()
              gc.color = b[4]
              gc:fillText(b[1], x + u * 2, y)
              hitButtons[#hitButtons + 1] = { x0 = x, y0 = y - u // 2, x1 = x + bw, y1 = y + lh + u // 2, action = b[2], entry = e }
              x = x - u * 2
            end
          end
          -- Plan mode (#24): carry out the plan in Agent mode.
          if e.applyPlan then
            local label2 = e.planApplied and "Plan applied" or "Apply plan"
            local bw = gc:measureText(label2).width + u * 4
            local x = w - pad - bw
            if not e.planApplied then
              gc.color = C.accent
              gc:beginPath()
              gc:roundedRect(Rectangle(x, y - u // 2, bw, lh + u), u * 2, u * 2)
              gc:fill()
              hitButtons[#hitButtons + 1] = { x0 = x, y0 = y - u // 2, x1 = x + bw, y1 = y + lh + u // 2,
                action = "apply_plan", entry = e }
            end
            gc.color = e.planApplied and C.dim or C.bubbleText
            gc:fillText(label2, x + u * 2, y)
          end
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

    if busy then
      addRow(lh, function(y)
        iconSpinner(gc, pad, y + (lh - icon) / 2, icon)
        gc.color = C.dim
        gc:fillText("Working... " .. formatSeconds(conv:elapsed() or 0), pad + icon + u * 2, y)
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
    hitLinks = {}
    hitButtons = {}
    for _, r in ipairs(rows) do
      if y + r.h >= 0 and y <= h then r.draw(y) end
      if r.entry then hitRows[#hitRows + 1] = { y0 = y, y1 = y + r.h, entry = r.entry } end
      y = y + r.h + r.gap
    end

    -- Skill and command matches over the bottom of the log, just above the input.
    hitSuggest = {}
    if suggest and #suggest.items > 0 then
      local lh = gc:measureText("Ag").height
      local u = math.max(2, lh // 3)
      local rowH = lh * 2 + u * 2
      local n = math.min(#suggest.items, 6)
      local boxH = n * rowH + u * 2
      local top = h - boxH
      gc.color = C.bubble
      gc:fillRect(Rectangle(0, top, w, boxH))
      for i = 1, n do
        local it = suggest.items[i]
        local ry = top + u + (i - 1) * rowH
        if i == 1 then   -- Enter picks the first match
          gc.color = C.rule
          gc:fillRect(Rectangle(0, ry, w, rowH))
        end
        local x = u * 3
        gc.color = C.text
        gc:fillText(it.title, x, ry + u)
        gc.color = C.faint
        local tag = it.kind == "command" and ("/" .. it.name) or (it.source == "user" and "your skill" or "skill")
        gc:fillText(tag, x + gc:measureText(it.title).width + u * 3, ry + u)
        gc.color = C.dim
        local desc = it.description or ""
        local maxW = w - x * 2
        if gc:measureText(desc).width > maxW then
          while #desc > 1 and gc:measureText(desc .. "…").width > maxW do desc = desc:sub(1, #desc - 1) end
          desc = desc .. "…"
        end
        gc:fillText(desc, x, ry + u + lh)
        hitSuggest[#hitSuggest + 1] = { y0 = ry, y1 = ry + rowH, item = it }
      end
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

  -- Enables Send/Stop and runs the repaint ticker while a turn runs.
  local function syncBusy()
    local b = conv:isBusy()
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

  function Panel.onEvent(ev)
    -- The agent may have changed the document; keep the context line current.
    if ev.type == "tool_result" or ev.type == "done" or ev.type == "error" then refreshContext() end
    local r = conv:apply(ev)
    if r.status then updateStatus(r.status) end
    -- Attach the before/after capture to each successful edit step (#23).
    if ev.type == "tool_result" and ev.ok and deps.capture and currentTurn then
      for i = #conv:entries(), 1, -1 do
        local e = conv:entries()[i]
        if e.kind == "tool" and e.id == ev.id then
          if e.toolKind == "edit" and not e.capture then e.capture = deps.capture:claim(currentTurn.captureSeq) end
          break
        end
      end
    end
    if r.permission then Panel.askPermission(r.permission) end
    if r.build then Panel.onBuild(r.build) end
    if r.turnEnded and currentTurn then
      deps.TurnHistory.finish(currentTurn, app.sprite)
      lastTurn, currentTurn = currentTurn, nil
    end
    if r.turnEnded then
      updateStatus("")
      syncBusy()
    end
    changed()
  end

  function Panel.onConnectionChange(isConnected)
    if not dlg then return end
    updateStatus(isConnected and "" or "Bridge not connected")
    if isConnected then
      refreshCatalog()
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
        if result.busy then syncBusy() end
      end)
    end
  end

  -- Inserts a mention token for a picker choice, replacing a typed "@".
  local function insertMention(target)
    if not dlg then return end
    local text = dlg.data.prompt or ""
    if text:sub(-1) == "@" then text = text:sub(1, -2) end
    local sep = (text == "" or text:match("%s$")) and "" or " "
    mentions[target.name] = target.uri
    text = text .. sep .. "@[" .. target.name .. "] "
    lastPrompt = text
    dlg:modify{ id = "prompt", text = text }
  end

  -- The @ picker: selection, active layer/cel, layers, tags, frames, palette, slices.
  local function openPicker()
    local targets = deps.mentionTargets()
    if #targets == 0 then app.tip("Open a sprite to mention its layers, frames or colors"); return end
    local menu = Dialog()
    local group = nil
    for _, t in ipairs(targets) do
      if t.group ~= group then
        group = t.group
        if group ~= "" then menu:separator{ text = group } end
      end
      menu:menuItem{ text = t.label, onclick = function() insertMention(t) end }
    end
    menu:showMenu()
  end

  -- Attachments (#21): images that go with the next message.
  local pending = {}
  local function updateAttachments()
    if not dlg then return end
    local names = {}
    for _, a in ipairs(pending) do names[#names + 1] = a.label end
    dlg:modify{ id = "attachments", text = #names > 0 and ("Attached: " .. table.concat(names, ", ")) or "",
                visible = #names > 0 }
  end

  -- kind: "selection" | "layer" | "frame", or { path = "..." } for an image file.
  function Panel.attach(kind)
    if not deps.attachments then return false end
    Panel.open()
    local a, err
    if type(kind) == "table" then a, err = deps.attachments:file(kind.path)
    else a, err = deps.attachments:make(kind) end
    if not a then app.tip(err or "Could not attach that"); return false end
    if #pending >= 8 then app.tip("At most 8 attachments per message"); return false end
    pending[#pending + 1] = a
    updateAttachments()
    return true
  end

  function Panel.pendingAttachments()
    local out = {}
    for _, a in ipairs(pending) do out[#out + 1] = { label = a.label, path = a.path, uri = a.uri } end
    return out
  end

  local function pickImageFile()
    local d = Dialog{ title = "Attach image" }
    d:file{ id = "path", label = "Image", open = true, filetypes = { "png", "jpg", "jpeg", "gif", "webp" } }
    d:button{ id = "ok", text = "&Attach", focus = true }
    d:button{ id = "cancel", text = "&Cancel" }
    d:show()
    if d.data.ok and d.data.path ~= "" then Panel.attach{ path = d.data.path } end
  end

  local function openAttachMenu()
    local menu = Dialog()
    menu:menuItem{ text = "Attach selection", onclick = function() Panel.attach("selection") end }
    menu:menuItem{ text = "Attach active layer", onclick = function() Panel.attach("layer") end }
    menu:menuItem{ text = "Attach active frame", onclick = function() Panel.attach("frame") end }
    menu:menuItem{ text = "Attach image file...", onclick = pickImageFile }
    if #pending > 0 then
      menu:separator{}
      menu:menuItem{ text = "Clear attachments", onclick = function() pending = {}; updateAttachments() end }
    end
    menu:showMenu()
  end

  -- The / picker (#35): skills from the catalog and saved commands that
  -- match every typed word, best matches first.
  refreshCatalog = function()
    deps.request("skills.list", {}, function(result)
      if result and result.skills then
        catalogRows = {}
        for _, s in ipairs(result.skills) do
          local needs = {}
          for _, n in ipairs(s.needs or {}) do needs[#needs + 1] = n end
          catalogRows[#catalogRows + 1] = { kind = "skill", name = s.name, title = s.title, source = s.source,
            description = s.description, category = s.category, needs = needs }
        end
      end
    end)
  end

  function Panel.matches(query)
    local items = {}
    for _, s in ipairs(catalogRows) do
      if s.source ~= "guide" then items[#items + 1] = s end
    end
    if deps.savedCommands then
      for _, c in ipairs(deps.savedCommands:load()) do
        if c.enabled ~= false then
          items[#items + 1] = { kind = "command", name = c.name, title = c.title, description = c.description, source = "command" }
        end
      end
    end
    local words = {}
    for w in (query or ""):lower():gmatch("%S+") do words[#words + 1] = w end
    local out = {}
    for _, it in ipairs(items) do
      local head = (it.name .. " " .. it.title):lower()
      local all = head .. " " .. (it.description or ""):lower() .. " " .. (it.category or ""):lower()
      local score, ok = 0, true
      for _, w in ipairs(words) do
        if not all:find(w, 1, true) then ok = false; break end
        score = score + (head:sub(1, #w) == w and 3 or (head:find(w, 1, true) and 2 or 1))
      end
      if ok then out[#out + 1] = { it = it, score = score } end
    end
    table.sort(out, function(a, b)
      if a.score ~= b.score then return a.score > b.score end
      return a.it.title < b.it.title
    end)
    local list = {}
    for _, o in ipairs(out) do list[#list + 1] = o.it end
    return list
  end

  local function setSuggest(items)
    suggest = items and { items = items } or nil
    if dlg then dlg:repaint() end
  end

  -- Picking a match: a skill becomes "/skill:name " (the message then runs
  -- with that skill), a saved command "/name ".
  function Panel.pickSuggestion(it)
    if not dlg or not it then return end
    lastPrompt = it.kind == "command" and ("/" .. it.name .. " ") or ("/skill:" .. it.name .. " ")
    dlg:modify{ id = "prompt", text = lastPrompt }
    setSuggest(nil)
    for _, n in ipairs(it.needs or {}) do
      if n == "image" and #pending == 0 then app.tip("This skill needs an image: attach one with +") end
    end
  end

  function Panel.suggestions() return suggest and suggest.items or {} end

  local function skillByName(name)
    for _, s in ipairs(catalogRows) do if s.name == name then return s end end
  end

  -- Typing "@" at the end of the prompt opens the picker; a prompt that is
  -- just "/query" shows matching skills and commands.
  local function onPromptChange()
    if not dlg then return end
    local text = dlg.data.prompt or ""
    local grew = #text == #lastPrompt + 1 and text:sub(1, #lastPrompt) == lastPrompt
    lastPrompt = text
    if grew and text:sub(-1) == "@" then openPicker() end
    local query = text:match("^/([^%s]*)$")
    if query and not query:match("^skill:") then
      if #catalogRows == 0 then refreshCatalog() end
      setSuggest(Panel.matches((query:gsub("[-_]", " "))))
    elseif suggest then
      setSuggest(nil)
    end
  end
  Panel.onPromptChange = onPromptChange

  -- "/name args" runs a saved command right away, with no agent turn (#26).
  -- Returns true when the prompt was a saved command.
  local function runSlashCommand(prompt)
    if not deps.savedCommands then return false end
    local name, rest = prompt:match("^%s*/([%w%-]+)%s*(.-)%s*$")
    if not name then return false end
    deps.savedCommands:load()
    if not deps.savedCommands:get(name) then return false end
    local r = deps.savedCommands:run(name, deps.savedCommands.parseArgs(rest))
    conv:note("user", prompt)
    if r.ok then
      conv:note("status", "Ran /" .. name .. (r.value ~= nil and (": " .. json.encode(r.value)) or ""))
    else
      conv:note("error", "/" .. name .. ": " .. tostring(r.error))
    end
    lastPrompt = ""
    dlg:modify{ id = "prompt", text = "" }
    refreshContext()
    changed()
    return true
  end

  -- providerOverride / modeOverride come from Panel.submit (scripts, Apply
  -- plan): the provider list may not be loaded yet right after opening.
  local function send(providerOverride, modeOverride)
    if conv:isBusy() or not dlg then return end
    local prompt = dlg.data.prompt or ""
    if prompt:match("^%s*$") then return end
    -- Enter on a bare "/query" picks the best match instead of sending.
    if suggest and #suggest.items > 0 and prompt:match("^/[^%s]*$") then
      Panel.pickSuggestion(suggest.items[1])
      return
    end
    setSuggest(nil)
    if runSlashCommand(prompt) then return end
    -- A skill that needs an image waits for an attachment (#35).
    local skillName = prompt:match("^%s*/skill:([%w%-_]+)")
    local skill = skillName and skillByName(skillName)
    if skill then
      for _, n in ipairs(skill.needs or {}) do
        if n == "image" and #pending == 0 then
          app.tip(skill.title .. " needs an image: attach one with + first")
          return
        end
      end
    end
    local provider = providerOverride or dlg.data.provider or providers[1]
    local mode = modeOverride or (dlg.data.mode or "Agent"):lower()
    if mode == "developer" and not deps.preferences.developerConfirmed then
      local yes
      if Panel.confirmDeveloper then yes = Panel.confirmDeveloper()
      else
        yes = app.alert{ title = "Developer mode", text = {
          "In Developer mode the agent edits this Aseprite fork's source code",
          "and can run commands in the repository (it asks you first).",
          "Its changes go on a dev/ branch; Rebuild & Relaunch applies them.",
        }, buttons = { "Turn on", "Cancel" } } == 1
      end
      if not yes then return end
      deps.preferences.developerConfirmed = true
    end
    deps.preferences.mode = mode:sub(1, 1):upper() .. mode:sub(2)
    deps.preferences.provider = provider
    -- The document's state goes with every message (#18), after what changed
    -- since the agent's last reply (#19), if anything.
    local state = deps.stateBlock()
    local changes = lastTurn and lastTurn.sprite == app.sprite and deps.TurnHistory.changesSince(lastTurn) or nil
    if changes then state = changes .. "\n" .. state end

    -- @[label] tokens become "label (aseprite://...)" for the agent (#20).
    local expanded = deps.Conversation.expandMentions(prompt, mentions)
    mentions = {}
    lastPrompt = ""
    -- Attached images go as image blocks; the text says what each one is.
    local attachments, shown = {}, prompt
    for i, a in ipairs(pending) do
      attachments[#attachments + 1] = { label = a.label, path = a.path }
      -- The path lets tools read the image (source "file").
      expanded = expanded .. string.format("\n[Attached image %d: %s%s, file %s]", i, a.label, a.uri and (" (" .. a.uri .. ")") or "", a.path)
      shown = shown .. "\nAttached: " .. a.label
    end
    pending = {}
    updateAttachments()
    -- The header names the skill, so the bubble shows only the request.
    if skill then shown = shown:gsub("^%s*/skill:[%w%-_]+%s*", "", 1) end
    conv:send(shown, provider, mode, skill and skill.title or nil)
    -- Record where this reply starts in the undo history (#22).
    local header = conv:entries()[#conv:entries()]
    currentTurn = deps.TurnHistory.begin(app.sprite)
    currentTurn.captureSeq = deps.capture and deps.capture:seq() or 0
    turns[header] = currentTurn
    dlg:modify{ id = "prompt", text = "" }
    syncBusy()
    changed()
    updateStatus("Connecting...")

    local function fail(text)
      conv:fail(text)
      if currentTurn then deps.TurnHistory.finish(currentTurn, app.sprite); currentTurn = nil end
      syncBusy()
      updateStatus("")
      changed()
    end

    deps.ensureBridge(function(ok, err)
      if not ok then return fail(err or "Could not reach the bridge") end
      deps.request("chat.send", {
        prompt = expanded, state = state, provider = provider,
        sessionId = conv:conversationId(mode == "developer" and (provider .. ":dev") or provider) or "",
        attachments = #attachments > 0 and attachments or nil,
        mode = mode,
      }, function(_, error)
        if error then
          fail(error.message or tostring(error))
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
  -- mode: "agent" | "ask" | "plan" (nil keeps the selected mode).
  function Panel.submit(prompt, provider, mode)
    Panel.open()
    dlg:modify{ id = "prompt", text = prompt }
    if provider then dlg:modify{ id = "provider", option = provider } end
    if mode then dlg:modify{ id = "mode", option = mode:sub(1, 1):upper() .. mode:sub(2) } end
    send(provider, mode)
  end

  function Panel.isBusy() return conv:isBusy() end
  function Panel.placeholder() return PLACEHOLDER end
  function Panel.isOpen() return dlg ~= nil end
  function Panel.promptText() return dlg and dlg.data.prompt or nil end
  function Panel.setPrompt(text) if dlg then lastPrompt = text; dlg:modify{ id = "prompt", text = text } end end
  -- Adds a mention as the picker would (for tests and other scripts).
  function Panel.mention(name, uri) insertMention{ name = name, uri = uri } end
  function Panel.close() if dlg then dlg:close() end end
  function Panel.refreshContext()
    refreshContext()
    if dlg then dlg:repaint() end   -- undo/redo changes the replies' state
  end

  -- Revert or restore a reply (#22). Reverting over later edits asks first.
  function Panel.turnAction(turn, action, entry, index)
    if action == "dev_apply" then return Panel.applyDevChanges() end
    if action == "dev_discard" then return Panel.discardDevChanges() end
    if action == "pick_variation" or action == "discard_variations" then
      if not entry or entry.resolved then return false end
      local V = deps.variations()
      local ok, why
      if action == "pick_variation" then
        ok, why = V.pick(entry.task, index, entry.prompt)
        if ok then entry.resolved = "Kept v" .. index end
      else
        ok, why = V.discard(entry.task)
        if ok then entry.resolved = "Discarded" end
      end
      if not ok and why then app.tip(why) end
      refreshContext()
      if dlg then dlg:repaint() end
      return ok and true or false
    end
    if action == "apply_plan" then
      if conv:isBusy() or (entry and entry.planApplied) then return false end
      if entry then entry.planApplied = true end
      Panel.submit("Carry out the plan above.", nil, "agent")
      return true
    end
    local TH = deps.TurnHistory
    local ok, why
    if action == "restore" then
      ok, why = TH.restore(turn)
    else
      ok, why = TH.revert(turn)
      if not ok and TH.hasLaterEdits(turn) then
        local answer = app.alert{ title = "Revert reply",
          text = { "You edited the sprite after this reply.", "Reverting also undoes those edits (they stay redoable)." },
          buttons = { "Revert anyway", "Cancel" } }
        if answer == 1 then ok, why = TH.revert(turn, true) end
      end
    end
    if not ok and why then app.tip(why) end
    refreshContext()
    if dlg then dlg:repaint() end
    return ok
  end

  -- A permission request from the agent (ACP): ask, then answer the bridge.
  -- Tests can set Panel.permissionAnswer to a function(request) -> option index.
  function Panel.askPermission(req)
    local options = req.options or {}
    local labels = {}
    for i, o in ipairs(options) do labels[i] = o.name or o.optionId end
    if #labels == 0 then labels = { "OK" } end
    local index
    if Panel.permissionAnswer then
      index = Panel.permissionAnswer(req)
    else
      index = app.alert{ title = "AI Agent asks permission", text = { "The agent wants to use:", req.text or "a tool" }, buttons = labels }
    end
    local chosen = options[index]
    deps.request("chat.permission", { requestId = req.requestId, optionId = chosen and chosen.optionId or "" }, function() end)
    conv:recordPermission(req.text, chosen and (chosen.name or chosen.optionId) or "rejected")
    changed()
  end

  -- The most recent reply's record, and actions on it (tests, other scripts).
  function Panel.lastTurn() return lastTurn end

  -- Entries as plain records (for tests and other scripts).
  ---------------------------------------------------------------------------
  -- Developer mode (#28)
  ---------------------------------------------------------------------------

  -- Saves the conversation and open sprites, asks the bridge to start the
  -- fork's build again once Aseprite has quit, then quits.
  function Panel.relaunch()
    deps.request("dev.relaunch", {}, function(_, err)
      if err then app.alert{ title = "Relaunch", text = err.message or tostring(err) }; return end
      deps.saveForRelaunch(conv:serialize())
      app.exit()
    end)
  end

  -- Shows what changed; rebuilds when C++ changed, then relaunches.
  -- Tests can set Panel.confirmApply to function(status) -> bool.
  function Panel.applyDevChanges()
    deps.request("dev.status", {}, function(st, err)
      if err then app.tip(err.message or "Developer mode is not available"); return end
      if #st.files == 0 then app.tip("The agent hasn't changed anything yet"); return end
      local lines = { "Branch " .. st.branch .. ": " .. #st.files .. " file(s) changed" }
      for i = 1, math.min(#st.files, 10) do lines[#lines + 1] = "  " .. st.files[i] end
      if #st.files > 10 then lines[#lines + 1] = "  ..." end
      lines[#lines + 1] = st.needsBuild and "C++ changed: Aseprite will be rebuilt, then restarted." or "Only scripts changed: Aseprite will restart."
      local go
      if Panel.confirmApply then go = Panel.confirmApply(st)
      else go = app.alert{ title = "Apply the agent's changes", text = lines,
        buttons = { st.needsBuild and "Rebuild && Relaunch" or "Relaunch", "Cancel" } } == 1 end
      if not go then return end
      if st.needsBuild then
        conv:note("status", "Building Aseprite...")
        changed()
        deps.request("dev.build", {}, function(_, e2) if e2 then conv:note("error", e2.message); changed() end end)
      else
        Panel.relaunch()
      end
    end)
    return true
  end

  -- A finished build: relaunch, or send the errors to the agent to fix.
  function Panel.onBuild(ev)
    if ev.ok then Panel.relaunch(); return end
    if not conv:isBusy() then
      Panel.submit("The build failed. Fix these errors, then tell me to rebuild:\n" .. (ev.text or ""), nil, "developer")
    end
  end

  function Panel.discardDevChanges()
    local yes
    if Panel.confirmApply then yes = Panel.confirmApply({ discard = true })
    else
      yes = app.alert{ title = "Discard the agent's changes", text = {
        "Uncommitted changes go into a git stash (git stash pop brings them back)",
        "and the repository returns to the branch it was on. Commits on the dev/ branch stay.",
      }, buttons = { "Discard", "Cancel" } } == 1
    end
    if not yes then return false end
    deps.request("dev.discard", {}, function(r, err)
      if err then app.alert{ title = "Discard", text = err.message or tostring(err) }; return end
      conv:note("status", "Discarded the changes (" .. (r.stash or "nothing uncommitted") .. "); back on " .. r.branch .. ".")
      changed()
    end)
    return true
  end

  function Panel.restoreConversation(data)
    conv:restore(data)
    Panel.open()
    conv:note("status", "Aseprite restarted with the agent's changes.")
    changed()
  end

  -- My Commands: run, enable/disable, source, revert to the previous version (#26).
  function Panel.manageCommands()
    local S = deps.savedCommands
    if not S then return end
    local list = S:load()
    local d = Dialog{ title = "My Commands" }
    if #list == 0 then
      d:label{ text = "No saved commands yet. Ask the agent to save something it did as a command." }
    end
    for _, c in ipairs(list) do
      d:separator{ text = "/" .. c.name .. (c.enabled == false and " (disabled)" or "") }
      d:label{ text = c.title .. ": " .. (c.description or "") }
      d:newrow()
      d:button{ text = "Run", enabled = c.enabled ~= false, onclick = function()
        local r = S:run(c.name, {})
        if not r.ok then app.alert{ title = c.title, text = tostring(r.error) } end
      end }
      d:button{ text = c.enabled == false and "Enable" or "Disable", onclick = function()
        deps.request("commands.setEnabled", { name = c.name, enabled = c.enabled == false }, function(_, err)
          if err then app.tip(err.message or "Could not change it") else S:reload() end
        end)
        d:close()
      end }
      d:button{ text = "Source", onclick = function()
        local src = Dialog{ title = "/" .. c.name }
        pcall(function()
          src:textedit{ id = "code", text = S.readFile(S:path(c.name)) or "", minlines = 12, maxlines = 24, font = "system" }
        end)
        src:button{ text = "Close" }
        src:show()
      end }
      d:button{ text = "Revert", onclick = function()
        deps.request("commands.revert", { name = c.name }, function(result, err)
          if err then app.tip(err.message or "Nothing to revert to")
          else app.tip("Restored /" .. c.name .. " from " .. tostring(result.restored)); S:reload() end
        end)
      end }
    end
    d:separator{}
    d:button{ text = "Close" }
    d:show{ wait = false }
  end

  -- Variations from the agent's propose_variations tool (#25).
  function Panel.showVariations(info)
    Panel.open()
    conv:addVariations(info.task, info.items)
    changed()
  end

  -- Keeps variation `index` (or discards all when index is nil) of the newest variations entry.
  function Panel.resolveVariations(index)
    local list = conv:entries()
    for i = #list, 1, -1 do
      if list[i].kind == "variations" and not list[i].resolved then
        return Panel.turnAction(nil, index and "pick_variation" or "discard_variations", list[i], index)
      end
    end
    return false
  end

  function Panel.applyLastPlan()
    local list = conv:entries()
    for i = #list, 1, -1 do
      if list[i].kind == "worked" and list[i].applyPlan then return Panel.turnAction(nil, "apply_plan", list[i]) end
    end
    return false
  end

  function Panel.entries()
    local out = {}
    for _, e in ipairs(conv:entries()) do
      out[#out + 1] = { kind = e.kind, text = e.text, status = e.status, secs = e.secs,
        changed = e.capture and e.capture.changed or nil, applyPlan = e.applyPlan, planApplied = e.planApplied,
        task = e.task, resolved = e.resolved, count = e.items and #e.items or nil, result = e.result }
    end
    return out
  end

  -- Expands every row with details (for screenshots and tests).
  -- state: true / false, or "captures" to expand only edit steps with thumbnails.
  function Panel.expandAll(state)
    for _, e in ipairs(conv:entries()) do
      if state == "captures" then expanded[e] = e.capture and true or nil
      else expanded[e] = (state ~= false) or nil end
    end
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
      fontsize = 7.5,   -- x UI scale (e.g. 15 px at 200%), close to Aseprite's own text
      hexpand = true,
      vexpand = true,
      onpaint = paint,
      onwheel = function(ev)
        local step = 48
        scrollPx = math.max(0, math.min(math.max(0, contentH - viewH), scrollPx + (ev.deltaY < 0 and step or -step)))
        dlg:repaint()
      end,
      onmousedown = function(ev)
        for _, s in ipairs(hitSuggest) do
          if ev.y >= s.y0 and ev.y <= s.y1 then Panel.pickSuggestion(s.item); return end
        end
        for _, b in ipairs(hitButtons) do
          if ev.x >= b.x0 and ev.x <= b.x1 and ev.y >= b.y0 and ev.y <= b.y1 then
            Panel.turnAction(b.turn, b.action, b.entry, b.index)
            return
          end
        end
        for _, l in ipairs(hitLinks) do
          if ev.x >= l.x0 and ev.x <= l.x1 and ev.y >= l.y0 and ev.y <= l.y1 then
            if not deps.selectUri(l.uri) then app.tip("That no longer exists") end
            return
          end
        end
        for _, r in ipairs(hitRows) do
          if ev.y >= r.y0 and ev.y <= r.y1 then
            expanded[r.entry] = (not expanded[r.entry]) or nil
            dlg:repaint()
            return
          end
        end
      end,
    }
    dlg:newrow()
    dlg:label{ id = "context", text = "Context: " .. deps.contextString(), hexpand = true, font = "system", fontsize = 6.5 }
    dlg:newrow()
    dlg:label{ id = "status", text = deps.isConnected() and "" or "Bridge not connected", hexpand = true,
               font = "system", fontsize = 6.5 }
    dlg:newrow()
    dlg:label{ id = "attachments", text = "", hexpand = true, font = "system", fontsize = 6.5, visible = false }
    dlg:newrow()
    -- Multi-line box that wraps and grows (this fork's dlg:textedit);
    -- stock Aseprite falls back to a single-line entry.
    local hasTextEdit = pcall(function()
      dlg:textedit{
        id = "prompt",
        text = "",
        placeholder = PLACEHOLDER,
        minlines = 1,
        maxlines = 5,
        focus = true,
        font = "system",
        fontsize = 7.5,
        onchange = onPromptChange,          -- "@" opens the mention picker
        onsubmit = function() send() end,   -- Enter sends, Shift+Enter adds a line
      }
    end)
    if not hasTextEdit then
      dlg:entry{ id = "prompt", text = "", placeholder = PLACEHOLDER, focus = true, hexpand = true }
    end
    dlg:newrow()
    dlg:combobox{ id = "provider", options = providers, option = deps.preferences.provider or providers[1] }
    -- Agent edits; Ask and Plan only read the document (#24).
    -- Developer (#28) lets the agent change this fork; it asks once before the first use.
    dlg:combobox{ id = "mode", options = { "Agent", "Ask", "Plan", "Developer" }, option = deps.preferences.mode or "Agent" }
    dlg:button{ id = "attach", text = "+", onclick = openAttachMenu }
    dlg:button{ id = "mention", text = "@", onclick = openPicker }
    dlg:button{ id = "send", text = "&Send", onclick = function() send() end }
    dlg:button{ id = "stop", text = "S&top", enabled = false, onclick = function()
      deps.request("chat.stop", {}, function() end)
    end }
    dlg:button{ id = "new", text = "&New chat", onclick = function()
      deps.request("chat.reset", {}, function() end)
      conv:reset()
      syncBusy()
      updateStatus("")
      changed()
    end }
    dlg:show{ wait = false }
    syncBusy()
    Panel.onConnectionChange(deps.isConnected())
  end

  return Panel
end
