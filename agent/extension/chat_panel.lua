-- AI Agent chat panel: a dialog (docked on this fork) where the user types
-- requests. The bridge runs the agent CLI (Claude Code or Codex) and streams
-- events back; this file draws the conversation and sends prompts.
--
-- Loaded by agent.lua: `local Panel = dofile(path)(deps)` where deps has
--   request(method, params, callback), isConnected(), contextString(), stateBlock(),
--   mentionTargets(), resolveUri(uri), selectUri(uri), ensureBridge(callback),
--   preferences, Conversation (conversation.lua, for its text helpers),
--   turns (a Turn controller, turns.lua), optionally prompter (prompter.lua's
--   interface; app.alert / app.tip when absent) and Composer (composer.lua;
--   loaded from this folder when absent).
--
-- The draft (prompt text, mentions, Attachments, the skill chip, the /
-- picker) and what Enter does with it live in the Composer; this file
-- reads the prompt box, asks the Composer, and carries out its outcome.
--
-- The conversation itself (entries, timings, tool status, conversation ids)
-- lives in the Conversation module, and each reply's lifecycle (captures,
-- finishing, revert/restore, changes since the last reply) in the Turn
-- controller (turns.lua); this file only draws them and keeps view state
-- (expanded rows, layout caches, scroll). Questions and tips go through
-- the Prompter (prompter.lua), so tests can answer them.
--
-- Conversation layout:
--   user messages      right-aligned bubbles
--   agent turns        "● Claude" header, then one row per step:
--                      "Thought for 3s >", "<icon> Add Shadow layer (ok) >",
--                      the reply text, and "Worked for 1m 49s".
-- Rows with details (thinking text, tool input/output) expand on click.

-- The input box's hint text.
local PLACEHOLDER = "Draw, edit or animate..."

-- composer.lua and prompter.lua sit next to this file.
local here = debug.getinfo(1, "S").source:match("^@(.*[/\\])") or ""
local function loadComposer() return dofile(here .. "composer.lua") end
local Prompter = dofile(here .. "prompter.lua")
local Mascot = dofile(here .. "mascot.lua")

return function(deps)
  local Panel = {}

  local dlg = nil
  local turns = assert(deps.turns, "turns required: turns.lua")
  local conv = turns.conversation
  local prompter = deps.prompter or Prompter.app()
  local expanded = setmetatable({}, { __mode = "k" })   -- entry -> true
  local caches = setmetatable({}, { __mode = "k" })     -- entry -> wrapped lines per field
  local scrollPx = 0          -- distance scrolled up from the bottom, in pixels
  local hitRows = {}          -- clickable rows from the last paint: { y0, y1, entry }
  local hitLinks = {}         -- links drawn in the last paint: { x0, y0, x1, y1, uri }
  local hitButtons = {}       -- buttons: { x0, y0, x1, y1, action, entry, index }
  local contentH, viewH = 0, 0
  -- The draft: prompt, mentions, Attachments, the skill chip and the /
  -- picker (#35), whose matches show at the bottom of the log.
  local composer = (deps.Composer or loadComposer()).new{
    commands = function() return deps.savedCommands and deps.savedCommands:load() or {} end,
    selectionEmpty = function() return not app.sprite or app.sprite.selection.isEmpty end,
    stateBlock = function() return deps.stateBlock() end,
    -- What changed since the agent's last reply (#19), if anything.
    changes = function() return turns:changesSince() end,
    expandMentions = deps.Conversation.expandMentions,
  }
  local hitChip = nil          -- where the chip is drawn (click removes it)
  local hitCards = {}          -- attachment cards' ✕ boxes (click removes that image)

  -- The text without its last character. Whole UTF-8 characters: cutting a
  -- byte off "…" or "—" leaves invalid UTF-8, which crashes text shaping.
  local function dropLastChar(t)
    local last = utf8.offset(t, -1)
    return last and t:sub(1, last - 1) or t:sub(1, #t - 1)
  end
  local hitSuggest = {}
  local refreshCatalog       -- defined with the picker below
  local providers = { "claude" }
  local ticker = nil
  local animT = 0              -- seconds of mascot animation (ticker steps; os.time is whole seconds)
  -- Messages sent while the agent works wait here and go one by one when the
  -- turn ends. Stop pauses the queue; Send now (on a queued row) stops the
  -- turn and sends that one next.
  local queue = {}
  local queuePaused = false

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
    highlight = Color(82, 82, 94),   -- the picker's selected row
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
        local status, turnAction = turns:view(e)
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
          local action = turnAction
          local label = (action == "revert" and "Revert") or (action == "restore" and "Restore") or nil
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
            hitButtons[#hitButtons + 1] = { x0 = x, y0 = y - u // 2, x1 = x + bw, y1 = y + lh + u // 2, entry = e, action = action }
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
      -- The mascot (the logo's face) thinks while the turn runs.
      local ms = math.max(3, (lh * 3) // Mascot.HEIGHT)
      local mw, mh = Mascot.size(ms)
      addRow(mh, function(y)
        local pose = Mascot.pose(animT)
        Mascot.draw(gc, pad, y, ms, pose)
        gc.color = C.dim
        gc:fillText(pose.word .. "... " .. formatSeconds(conv:elapsed() or 0), pad + mw + u * 2, y + (mh - lh) // 2)
      end, nil, u * 2)
    end

    -- Queued messages, each with Send now and ✕.
    for qi, q in ipairs(queue) do
      addRow(lh + u, function(y)
        local x = pad
        local tag = queuePaused and "Paused" or "Queued"
        local tw = gc:measureText(tag).width + u * 4
        gc.color = C.rule
        gc:beginPath()
        gc:roundedRect(Rectangle(x, y, tw, lh + u // 2), u * 2, u * 2)
        gc:fill()
        gc.color = C.accent
        gc:fillText(tag, x + u * 2, y + u // 4)
        -- Buttons on the right.
        local right = w - pad
        local function button(label, action)
          local bw = gc:measureText(label).width + u * 4
          right = right - bw
          gc.color = C.bubble
          gc:beginPath()
          gc:roundedRect(Rectangle(right, y, bw, lh + u // 2), u * 2, u * 2)
          gc:fill()
          gc.color = C.text
          gc:fillText(label, right + u * 2, y + u // 4)
          hitButtons[#hitButtons + 1] = { x0 = right, y0 = y, x1 = right + bw, y1 = y + lh + u, action = action, index = qi }
          right = right - u * 2
        end
        button("✕", "queue_remove")
        button("Send now", "queue_send_now")
        local text = (q.shown or ""):gsub("\n.*", "")
        local maxW = right - (x + tw + u * 2)
        if gc:measureText(text).width > maxW then
          while #text > 1 and gc:measureText(text .. "…").width > maxW do text = dropLastChar(text) end
          text = text .. "…"
        end
        gc.color = C.dim
        gc:fillText(text, x + tw + u * 2, y + u // 4)
      end, nil, u)
    end

    if #rows == 0 then
      local h, draw = textBlock({}, "t",
        "Ask the agent to change the open sprite.\nExample: add a Shadow layer under this one at 50%.",
        pad, textW, C.dim)
      addRow(h, draw, nil, 0)
    end
    return rows, pad
  end

  -- Attachment cards: a thumbnail of each pending image with a short name and
  -- ✕, in a strip at the bottom of the log, just above the prompt.
  local function paintCards(gc, w, h)
    hitCards = {}
    local list = composer:attachments()
    if #list == 0 then return 0 end
    local lh = gc:measureText("Ag").height
    local u = math.max(2, lh // 3)
    local box, gap = lh * 4, u * 2
    local stripH = box + lh + u * 4
    local top = h - stripH
    gc.color = C.bubble
    gc:fillRect(Rectangle(0, top, w, stripH))
    local x = gap
    for i, a in ipairs(list) do
      if x + box > w then break end
      local y = top + u * 2
      -- A checker behind the image, so transparency reads as transparent.
      local cell = math.max(2, box // 8)
      for cy = 0, box - 1, cell do
        for cx = 0, box - 1, cell do
          gc.color = ((cx // cell + cy // cell) % 2 == 0) and Color(92, 92, 100) or Color(70, 70, 78)
          gc:fillRect(Rectangle(x + cx, y + cy, math.min(cell, box - cx), math.min(cell, box - cy)))
        end
      end
      local img = a.thumb or nil   -- read when attached; loading a file while painting re-enters paint
      if img then
        local iw, ih = img.width, img.height
        local sc = box / math.max(iw, ih)
        if sc >= 1 then sc = math.floor(sc) end
        local dw, dh = math.max(1, math.floor(iw * sc)), math.max(1, math.floor(ih * sc))
        gc:drawImage(img, Rectangle(0, 0, iw, ih), Rectangle(x + (box - dw) // 2, y + (box - dh) // 2, dw, dh))
      end
      -- ✕ in the card's top-right corner.
      local xw = lh + u
      gc.color = C.bg
      gc:fillRect(Rectangle(x + box - xw, y, xw, xw))
      gc.color = C.text
      gc:fillText("✕", x + box - xw + (xw - gc:measureText("✕").width) // 2, y + (xw - lh) // 2)
      hitCards[#hitCards + 1] = { x0 = x + box - xw, y0 = y, x1 = x + box, y1 = y + xw, index = i }
      local name = a.short or a.label or ""
      if gc:measureText(name).width > box then
        while #name > 1 and gc:measureText(name .. "…").width > box do name = dropLastChar(name) end
        name = name .. "…"
      end
      gc.color = C.dim
      gc:fillText(name, x, y + box + u)
      x = x + box + gap
    end
    return stripH
  end

  local function paint(ev)
    local gc = ev.context
    local w, h = gc.width, gc.height
    gc.color = C.bg
    gc:fillRect(Rectangle(0, 0, w, h))
    h = h - paintCards(gc, w, h)

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
    hitChip = nil
    local items, index, pickedSkill = composer:suggestions(), composer:suggestionIndex(), composer:pickedSkill()
    if #items > 0 then
      local lh = gc:measureText("Ag").height
      local u = math.max(2, lh // 3)
      local rowH = lh * 2 + u * 2
      local n = math.min(#items, 6)
      -- Up/Down move the highlight; the list scrolls to keep it in view.
      local first = math.max(1, math.min(index - n + 1, #items - n + 1))
      if index < first then first = index end
      local boxH = n * rowH + u * 2
      local top = h - boxH
      gc.color = C.bubble
      gc:fillRect(Rectangle(0, top, w, boxH))
      for i = 1, n do
        local k = first + i - 1
        local it = items[k]
        local ry = top + u + (i - 1) * rowH
        if k == index then   -- Enter picks the highlighted match
          gc.color = C.highlight
          gc:fillRect(Rectangle(0, ry, w, rowH))
          gc.color = C.accent
          gc:fillRect(Rectangle(0, ry, math.max(2, u), rowH))
        end
        local x = u * 3
        gc.color = C.text
        gc:fillText(it.title, x, ry + u)
        gc.color = C.faint
        local tag = it.kind == "command" and ("/" .. it.name)
          or ((it.category or "Skill") .. (it.source == "user" and " · your skill" or ""))
        gc:fillText(tag, x + gc:measureText(it.title).width + u * 3, ry + u)
        gc.color = C.dim
        local desc = it.description or ""
        local maxW = w - x * 2
        if gc:measureText(desc).width > maxW then
          while #desc > 1 and gc:measureText(desc .. "…").width > maxW do desc = dropLastChar(desc) end
          desc = desc .. "…"
        end
        gc:fillText(desc, x, ry + u + lh)
        hitSuggest[#hitSuggest + 1] = { y0 = ry, y1 = ry + rowH, item = it }
      end
      if #items > n then
        gc.color = C.faint
        local more = string.format("%d/%d", index, #items)
        gc:fillText(more, w - gc:measureText(more).width - u * 3, top + u)
      end
    elseif pickedSkill then
      -- The picked skill as a chip just above the prompt; ✕ (or Backspace
      -- in an empty prompt) removes it.
      local lh = gc:measureText("Ag").height
      local u = math.max(2, lh // 3)
      local label = "/ " .. pickedSkill.title .. "   ✕"
      local cw, ch = gc:measureText(label).width + u * 4, lh + u * 2
      local cx, cy = u * 2, h - ch - u
      gc.color = C.accent
      gc:fillRect(Rectangle(cx, cy, cw, ch))
      gc.color = C.bg
      gc:fillText(label, cx + u * 2, cy + u)
      hitChip = { x0 = cx, y0 = cy, x1 = cx + cw, y1 = cy + ch }
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
      dlg:modify{ id = "send", text = b and "&Queue" or "&Send" }
      dlg:modify{ id = "stop", enabled = b }
    end
    if b and not ticker and dlg then
      -- Repaint for the mascot's moves and the "Working... Ns" counter.
      animT = 0
      ticker = Timer{ interval = 0.1, ontick = function() animT = animT + 0.1; if dlg then dlg:repaint() end end }
      ticker:start()
    elseif not b then
      stopTicker()
      if dlg then dlg:repaint() end
    end
  end

  function Panel.onEvent(ev)
    -- The agent may have changed the document; keep the context line current.
    if ev.type == "tool_result" or ev.type == "done" or ev.type == "error" then refreshContext() end
    -- The Turn controller claims edit steps' captures and finishes the turn.
    local r = turns:apply(ev)
    if r.status then updateStatus(r.status) end
    if r.permission then Panel.askPermission(r.permission) end
    if r.build then Panel.onBuild(r.build) end
    if r.turnEnded then
      updateStatus("")
      syncBusy()
      Panel.sendQueued()
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
    dlg:modify{ id = "prompt", text = composer:insertMention(target, dlg.data.prompt or "") }
  end

  -- The @ picker: selection, active layer/cel, layers, tags, frames, palette, slices.
  local function openPicker()
    local targets = deps.mentionTargets()
    if #targets == 0 then prompter.tip("Open a sprite to mention its layers, frames or colors"); return end
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
  local function updateAttachments()
    if dlg then dlg:repaint() end
  end

  -- kind: "selection" | "layer" | "frame", or { path = "..." } for an image file.
  function Panel.attach(kind)
    if not deps.attachments then return false end
    Panel.open()
    local a, err
    if type(kind) == "table" then a, err = deps.attachments:file(kind.path)
    elseif kind == "clipboard" then a, err = deps.attachments:clipboard()
    else a, err = deps.attachments:make(kind) end
    if not a then prompter.tip(err or "Could not attach that"); return false end
    deps.attachments:thumbnail(a)
    local ok, why = composer:addAttachment(a)
    if not ok then prompter.tip(why); return false end
    updateAttachments()
    return true
  end

  function Panel.pendingAttachments() return composer:pendingAttachments() end
  function Panel.clearAttachments() composer:clearAttachments(); updateAttachments() end
  function Panel.removeAttachment(i) composer:removeAttachment(i); updateAttachments() end

  local function pickImageFile()
    local d = Dialog{ title = "Attach image" }
    d:file{ id = "path", label = "Image", open = true, filetypes = deps.attachments.EXTENSIONS }
    d:button{ id = "ok", text = "&Attach", focus = true }
    d:button{ id = "cancel", text = "&Cancel" }
    d:show()
    if d.data.ok and d.data.path ~= "" then Panel.attach{ path = d.data.path } end
  end

  -- An animated file (GIF, WebP, .aseprite, ...) becomes frames as it is,
  -- with its own timing: a new sprite, or a new layer of the open sprite
  -- from a frame on (the bridge's import_animation, no agent turn).
  local function importAnimation()
    if not deps.attachments then return end
    local d = Dialog{ title = "Import animation as frames" }
    d:file{ id = "path", label = "File", open = true, filetypes = deps.attachments.EXTENSIONS }
    local sprite = app.sprite
    d:combobox{ id = "into", label = "Into", option = sprite and "A new layer here" or "A new sprite",
                options = sprite and { "A new layer here", "A new sprite" } or { "A new sprite" } }
    if sprite then
      d:number{ id = "frame", label = "From frame", text = tostring(app.frame and app.frame.frameNumber or 1), decimals = 0 }
    end
    d:button{ id = "ok", text = "&Import", focus = true }
    d:button{ id = "cancel", text = "&Cancel" }
    d:show()
    local data = d.data
    if not data.ok or data.path == "" then return end
    local params = { path = data.path, into = data.into == "A new layer here" and "layer" or "new" }
    if params.into == "layer" then params.frame = math.max(1, math.floor(tonumber(data.frame) or 1)) end
    Panel.importAnimation(params)
  end

  -- params: { path, into = "new" | "layer", frame }; the result shows in the log.
  function Panel.importAnimation(params)
    deps.request("import.animation", params, function(result, err)
      if err then conv:note("error", "Import failed: " .. tostring(err.message or err))
      else conv:note("status", result.text) end
      changed()
    end)
  end

  local function openAttachMenu()
    local menu = Dialog()
    menu:menuItem{ text = "Attach selection", onclick = function() Panel.attach("selection") end }
    menu:menuItem{ text = "Attach active layer", onclick = function() Panel.attach("layer") end }
    menu:menuItem{ text = "Attach active frame", onclick = function() Panel.attach("frame") end }
    menu:menuItem{ text = "Attach image file...", onclick = pickImageFile }
    menu:menuItem{ text = "Paste image from clipboard", onclick = function() Panel.attach("clipboard") end }
    menu:separator{}
    menu:menuItem{ text = "Import animation as frames...", onclick = importAnimation }
    if #composer:pendingAttachments() > 0 then
      menu:separator{}
      menu:menuItem{ text = "Clear attachments", onclick = Panel.clearAttachments }
    end
    menu:showMenu()
  end

  -- The / picker (#35): the Skill Catalog from the bridge goes to the Composer.
  refreshCatalog = function()
    deps.request("skills.list", {}, function(result)
      if result and result.skills then
        local rows = {}
        for _, s in ipairs(result.skills) do
          local needs = {}
          for _, n in ipairs(s.needs or {}) do needs[#needs + 1] = n end
          rows[#rows + 1] = { kind = "skill", name = s.name, title = s.title, source = s.source,
            description = s.description, category = s.category, needs = needs }
        end
        composer:setCatalog(rows)
      end
    end)
  end

  function Panel.matches(query) return composer:matches(query) end

  -- Shows a pick: the new prompt, and tips for what the skill needs.
  local function showPick(r)
    if dlg then dlg:modify{ id = "prompt", text = r.text } end
    for _, tip in ipairs(r.tips) do prompter.tip(tip) end
  end

  -- Picking a match: a skill becomes the chip, a saved command "/name ".
  function Panel.pickSuggestion(it)
    if not dlg or not it then return end
    showPick(composer:pick(it))
    dlg:repaint()
  end

  function Panel.suggestions() return composer:suggestions() end
  function Panel.suggestionIndex() return composer:suggestionIndex() end
  function Panel.pickedSkill() local s = composer:pickedSkill(); return s and s.name or nil end
  function Panel.clearPickedSkill()
    composer:clearPickedSkill()
    if dlg then dlg:repaint() end
  end

  -- Keys in the prompt (the textedit's onkeydown, and tests). Returns true
  -- when the key was used here, so the box doesn't handle it too.
  function Panel.onPromptKey(code, mods)
    -- Cmd+V / Ctrl+V with an image (and no text) on the clipboard attaches
    -- the image; the box itself only pastes text.
    if code == "KeyV" and mods and (mods.metaKey or mods.ctrlKey) and deps.attachments
       and deps.attachments:clipboardHasImage() then
      Panel.attach("clipboard")
      return true
    end
    local r = composer:onKey(code, dlg and (dlg.data.prompt or "") or nil)
    if not r then return false end
    if r.kind == "pick" then showPick(r) end
    if dlg then dlg:repaint() end
    return true
  end

  -- Typing "@" at the end of the prompt opens the picker; a prompt that is
  -- just "/query" shows matching skills and commands.
  local function onPromptChange()
    if not dlg then return end
    local r = composer:onTextChange(dlg.data.prompt or "")
    if r.mentionPicker then openPicker() end
    if r.needCatalog then refreshCatalog() end
    if r.suggestChanged then dlg:repaint() end
  end
  Panel.onPromptChange = onPromptChange

  -- "/name args" runs a saved command right away, with no agent turn (#26).
  local function runSlashCommand(r)
    local result = deps.savedCommands:run(r.name, deps.savedCommands.parseArgs(r.args))
    conv:note("user", r.text)
    if result.ok then
      conv:note("status", "Ran /" .. r.name .. (result.value ~= nil and (": " .. json.encode(result.value)) or ""))
    else
      conv:note("error", "/" .. r.name .. ": " .. tostring(result.error))
    end
    dlg:modify{ id = "prompt", text = "" }
    refreshContext()
    changed()
  end

  -- Starts the agent turn for a "send" outcome.
  local function startTurn(r)
    local p = r.payload
    deps.preferences.mode = p.mode:sub(1, 1):upper() .. p.mode:sub(2)
    deps.preferences.provider = p.provider
    updateAttachments()
    -- The message, and where this reply starts in the undo history (#22).
    turns:start(app.sprite, { text = r.shown, provider = p.provider, mode = p.mode, skill = r.skillTitle })
    dlg:modify{ id = "prompt", text = "" }
    syncBusy()
    changed()
    updateStatus("Connecting...")

    local function fail(text)
      turns:fail(text)
      syncBusy()
      updateStatus("")
      changed()
    end

    deps.ensureBridge(function(ok, err)
      if not ok then return fail(err or "Could not reach the bridge") end
      -- The bridge builds the agent's message from these parts (#55).
      deps.request("chat.send", {
        prompt = p.prompt, state = p.state, changes = p.changes, provider = p.provider,
        sessions = conv:conversationIds(),
        attachments = p.attachments,
        mode = p.mode,
      }, function(_, error)
        if error then
          fail(error.message or tostring(error))
        else
          updateStatus("")
        end
      end)
    end)
  end

  local function confirmDeveloper() return prompter.ask(Prompter.developerQuestion()) == 1 end

  -- Enter, Send, Panel.submit: asks the Composer what to do with the draft.
  -- providerOverride / modeOverride come from Panel.submit (scripts, Apply
  -- plan): the provider list may not be loaded yet right after opening.
  local function send(providerOverride, modeOverride)
    if not dlg then return end
    local ctx = {
      text = dlg.data.prompt or "",
      provider = providerOverride or dlg.data.provider or providers[1],
      mode = modeOverride or (dlg.data.mode or "Agent"):lower(),
      developerConfirmed = deps.preferences.developerConfirmed,
    }
    local r = composer:decide(ctx)
    if r.kind == "confirm_developer" then
      if not confirmDeveloper() then return end
      deps.preferences.developerConfirmed = true
      ctx.developerConfirmed = true
      r = composer:decide(ctx)
    end
    if r.kind == "tip" then prompter.tip(r.message); dlg:repaint()
    elseif r.kind == "command" then runSlashCommand(r)
    elseif r.kind == "pick" then showPick(r); dlg:repaint()
    elseif r.kind == "send" then
      if conv:isBusy() then
        -- The agent is working: the message waits for the end of the turn.
        r.queued = true
        queue[#queue + 1] = r
        dlg:modify{ id = "prompt", text = "" }
        updateAttachments()
        changed()
      else
        startTurn(r)
      end
    end
  end

  -- Sends the first queued message when no turn runs (after a turn ends,
  -- or from Send now). A queued message takes the State block and changes
  -- as they are now.
  function Panel.sendQueued()
    if conv:isBusy() or queuePaused or #queue == 0 or not dlg then return false end
    local r = table.remove(queue, 1)
    r.payload.state, r.payload.changes = composer:freshContext()
    startTurn(r)
    return true
  end

  -- Send now: this queued message goes next; a running turn is stopped first
  -- (its end sends it).
  function Panel.sendNow(index)
    local item = queue[index or 1]
    if not item then return false end
    table.remove(queue, index or 1)
    table.insert(queue, 1, item)
    queuePaused = false
    if conv:isBusy() then deps.request("chat.stop", {}, function() end)
    else Panel.sendQueued() end
    changed()
    return true
  end

  function Panel.removeQueued(index)
    if not queue[index] then return false end
    table.remove(queue, index)
    if #queue == 0 then queuePaused = false end
    changed()
    return true
  end

  -- The queued messages' texts (tests and scripts).
  function Panel.queued()
    local out = {}
    for _, q in ipairs(queue) do out[#out + 1] = q.shown end
    return out, queuePaused
  end

  -- Stop pauses the queue, so the next message doesn't start on its own.
  function Panel.stop()
    if #queue > 0 then queuePaused = true end
    deps.request("chat.stop", {}, function() end)
    changed()
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
  function Panel.setPrompt(text) if dlg then composer:setText(text); dlg:modify{ id = "prompt", text = text } end end
  -- Adds a mention as the picker would (for tests and other scripts).
  function Panel.mention(name, uri) insertMention{ name = name, uri = uri } end
  function Panel.close() if dlg then dlg:close() end end
  function Panel.refreshContext()
    refreshContext()
    if dlg then dlg:repaint() end   -- undo/redo changes the replies' state
  end

  -- Revert or restore a reply (#22): header is the reply's header entry, nil
  -- for the last reply. Reverting over later edits asks first, unless force.
  function Panel.replyAction(header, action, force)
    local ok, why, needsForce = turns:action(header, action, force)
    if needsForce and prompter.ask(Prompter.revertQuestion()) == 1 then
      ok, why = turns:action(header, action, true)
    end
    if not ok and why then prompter.tip(why) end
    refreshContext()
    if dlg then dlg:repaint() end
    return ok and true or false
  end

  -- A button in the log: Revert/Restore, Developer mode, variations, Apply plan.
  function Panel.buttonAction(action, entry, index)
    if action == "revert" or action == "restore" then return Panel.replyAction(entry, action) end
    if action == "dev_apply" then return Panel.applyDevChanges() end
    if action == "queue_send_now" then return Panel.sendNow(index) end
    if action == "queue_remove" then return Panel.removeQueued(index) end
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
      if not ok and why then prompter.tip(why) end
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
    return false
  end

  -- A permission request from the agent (ACP): ask, then answer the bridge.
  function Panel.askPermission(req)
    local options = req.options or {}
    local chosen = options[prompter.ask(Prompter.permissionQuestion(req))]
    deps.request("chat.permission", { requestId = req.requestId, optionId = chosen and chosen.optionId or "" }, function() end)
    conv:recordPermission(req.text, chosen and (chosen.name or chosen.optionId) or "rejected")
    changed()
  end

  ---------------------------------------------------------------------------
  -- Developer mode (#28)
  ---------------------------------------------------------------------------

  -- Saves the conversation and open sprites, asks the bridge to start the
  -- fork's build again once Aseprite has quit, then quits.
  function Panel.relaunch()
    deps.request("dev.relaunch", {}, function(_, err)
      if err then prompter.ask(Prompter.notice("Relaunch", err.message or tostring(err))); return end
      deps.saveForRelaunch(conv:serialize())
      app.exit()
    end)
  end

  -- Shows what changed; rebuilds when C++ changed, then relaunches.
  function Panel.applyDevChanges()
    deps.request("dev.status", {}, function(st, err)
      if err then prompter.tip(err.message or "Developer mode is not available"); return end
      local question, tip = Prompter.applyQuestion(st)
      if not question then prompter.tip(tip); return end
      if prompter.ask(question) ~= 1 then return end
      -- The agent works in its own worktree: bring its commits into the
      -- user's checkout first, then build or relaunch from there.
      deps.request("dev.apply", {}, function(applied, e1)
        if e1 then
          -- In the log too, so the agent (and tests) can see why.
          conv:note("error", "Couldn't apply: " .. (e1.message or tostring(e1)))
          changed()
          prompter.ask(Prompter.notice("Apply the agent's changes", e1.message or tostring(e1)))
          return
        end
        if applied and applied.commits and applied.commits > 0 then
          conv:note("status", "Applied " .. applied.commits .. " commit(s) to " .. (st.base or "your branch") .. ".")
        end
        if st.needsBuild then
          conv:note("status", "Building Aseprite...")
          changed()
          deps.request("dev.build", {}, function(_, e2) if e2 then conv:note("error", e2.message); changed() end end)
        else
          Panel.relaunch()
        end
      end)
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
    if prompter.ask(Prompter.discardQuestion()) ~= 1 then return false end
    deps.request("dev.discard", {}, function(r, err)
      if err then prompter.ask(Prompter.notice("Discard", err.message or tostring(err))); return end
      conv:note("status", "Discarded the agent's work (" .. (r.stash or "nothing uncommitted") .. ")"
        .. (r.reverted and ("; " .. r.branch .. " is back where it was") or "") .. ".")
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
        if not r.ok then prompter.ask(Prompter.notice(c.title, tostring(r.error))) end
      end }
      d:button{ text = c.enabled == false and "Enable" or "Disable", onclick = function()
        deps.request("commands.setEnabled", { name = c.name, enabled = c.enabled == false }, function(_, err)
          if err then prompter.tip(err.message or "Could not change it") else S:reload() end
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
          if err then prompter.tip(err.message or "Nothing to revert to")
          else prompter.tip("Restored /" .. c.name .. " from " .. tostring(result.restored)); S:reload() end
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
        return Panel.buttonAction(index and "pick_variation" or "discard_variations", list[i], index)
      end
    end
    return false
  end

  function Panel.applyLastPlan()
    local list = conv:entries()
    for i = #list, 1, -1 do
      if list[i].kind == "worked" and list[i].applyPlan then return Panel.buttonAction("apply_plan", list[i]) end
    end
    return false
  end

  -- New chat: the bridge forgets the conversation ids and the panel its messages.
  function Panel.newChat()
    queue, queuePaused = {}, false
    deps.request("chat.reset", {}, function() end)
    conv:reset()
    composer:newConversation()
    if dlg then syncBusy(); updateStatus(""); changed() end
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
    if not composer:hasCatalog() and deps.isConnected() then refreshCatalog() end
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
        for _, c in ipairs(hitCards) do
          if ev.x >= c.x0 and ev.x <= c.x1 and ev.y >= c.y0 and ev.y <= c.y1 then
            Panel.removeAttachment(c.index)
            return
          end
        end
        if hitChip and ev.x >= hitChip.x0 and ev.x <= hitChip.x1 and ev.y >= hitChip.y0 and ev.y <= hitChip.y1 then
          Panel.clearPickedSkill()
          return
        end
        for _, s in ipairs(hitSuggest) do
          if ev.y >= s.y0 and ev.y <= s.y1 then Panel.pickSuggestion(s.item); return end
        end
        for _, b in ipairs(hitButtons) do
          if ev.x >= b.x0 and ev.x <= b.x1 and ev.y >= b.y0 and ev.y <= b.y1 then
            Panel.buttonAction(b.action, b.entry, b.index)
            return
          end
        end
        for _, l in ipairs(hitLinks) do
          if ev.x >= l.x0 and ev.x <= l.x1 and ev.y >= l.y0 and ev.y <= l.y1 then
            if not deps.selectUri(l.uri) then prompter.tip("That no longer exists") end
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
        -- Arrows, Enter and Escape drive the / picker; Backspace removes the skill chip;
        -- Cmd+V with an image on the clipboard attaches it.
        onkeydown = function(ev) if Panel.onPromptKey(ev.code, ev) then ev.stopPropagation() end end,
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
    dlg:button{ id = "stop", text = "S&top", enabled = false, onclick = function() Panel.stop() end }
    dlg:button{ id = "new", text = "&New chat", onclick = function() Panel.newChat() end }
    dlg:show{ wait = false }
    syncBusy()
    Panel.onConnectionChange(deps.isConnected())
  end

  return Panel
end
