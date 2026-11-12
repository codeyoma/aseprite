-- Chat rows (#115): the layout of the Chat Panel's log, apart from the panel. build(gc, w) turns the current
-- chat's entries into rows: each has a height, a gap after it and a draw(y) function; clickable rows carry their
-- entry. Drawing a row records what it put on screen that can be clicked (buttons, links, sent-image thumbnails) in
-- the hits the build returns, so the panel only paints rows and routes clicks. It measures and draws through the gc
-- it is given, so a test can pass a recording one: no window, no dialog, no file or socket access.
--
--   local Rows = dofile("chat_rows.lua")
--   local rows = Rows.new{ C = colors, conv = function() return conv end, turns = function() return turns end,
--     chats = chats, expanded = expanded, deps = deps, thumbCache = {}, thumbWanted = {}, Mascot = Mascot,
--     animT = function() return t end, memoryOptions = { "Remember", "Don't remember" } }
--   local list, pad, hits = rows.build(gc, width)

local M = {}

-- The panel's colors, set by build (the icons below read them).
local C = {}

function M.dropLastChar(t)
  local last = utf8.offset(t, -1)
  return last and t:sub(1, last - 1) or t:sub(1, #t - 1)
end

function M.formatSeconds(s)
  s = math.max(0, math.floor(s + 0.5))
  if s < 60 then return s .. "s" end
  return string.format("%dm %ds", s // 60, s % 60)
end

-- Wrap text to maxWidth (pixels), measuring with the graphics context.
function M.wrap(gc, text, maxWidth)
  local lines = {}
  for paragraph in (text .. "\n"):gmatch("(.-)\n") do
    local line = ""
    -- ASCII spaces only: %S follows the C locale, and Windows' (en-US) counts byte 0xA0 inside UTF-8
    -- characters (the "레" of 레이어) as a space; a split character crashes text shaping.
    for word in paragraph:gmatch("[^ \t\r\n\f\v]+") do
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

---------------------------------------------------------------------------
-- Icons (drawn with paths so they scale with the font)
---------------------------------------------------------------------------

function M.iconPencil(gc, x, y, s, color)
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

function M.iconEye(gc, x, y, s, color)
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

function M.iconCheck(gc, x, y, s, ok)
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

function M.iconSpinner(gc, x, y, s)
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

function M.iconChevron(gc, x, y, s, expanded)
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

local iconPencil, iconEye, iconCheck, iconSpinner, iconChevron = M.iconPencil, M.iconEye, M.iconCheck, M.iconSpinner, M.iconChevron
local wrap, dropLastChar, formatSeconds = M.wrap, M.dropLastChar, M.formatSeconds

function M.new(ctx)
  local caches = setmetatable({}, { __mode = "k" })     -- entry -> wrapped lines per field

  -- Wrapped lines are cached per entry, field and width.
  local function wrapCached(gc, e, field, text, maxWidth)
    caches[e] = caches[e] or {}
    local c = caches[e][field]
    if c and c.w == maxWidth and c.text == text then return c.lines end
    local lines = wrap(gc, text, maxWidth)
    caches[e][field] = { w = maxWidth, text = text, lines = lines }
    return lines
  end

  local self = {}

  -- The rows for the current width, the pad around them, and the hits their draw functions fill.
  function self.build(gc, w)
    C = ctx.C
    local expanded, chats, deps, Mascot = ctx.expanded, ctx.chats, ctx.deps, ctx.Mascot
    local thumbCache, thumbWanted, MEMORY_OPTIONS = ctx.thumbCache, ctx.thumbWanted, ctx.memoryOptions
    local conv, turns, animT = ctx.conv(), ctx.turns(), ctx.animT()
    local hits = { buttons = {}, links = {}, thumbs = {} }
    local hitButtons, hitLinks, hitThumbs = hits.buttons, hits.links, hits.thumbs
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

    -- A card: text with an accent bar, then option buttons (wrapped to the
    -- width); the chosen one stays highlighted. ask_user and remember_style.
    local function cardRows(e, text, options, action, hint)
      local lines = wrapCached(gc, e, "text", text, textW - u * 4)
      local qh = 0
      for _, l in ipairs(lines) do qh = qh + lineHeight(l) + u // 2 end
      addRow(qh + u * 2, function(y)
        gc.color = C.accent
        gc:fillRect(Rectangle(pad, y, u, qh + u))
        gc.color = C.text
        local ty = y + u // 2
        for _, l in ipairs(lines) do gc:fillText(l, pad + u * 3, ty); ty = ty + lineHeight(l) + u // 2 end
      end, nil, u)
      local rowsOf, row, rowW = {}, {}, 0
      for i, label in ipairs(options) do
        local bw = gc:measureText(label).width + u * 6
        if #row > 0 and rowW + bw > textW then rowsOf[#rowsOf + 1] = row; row, rowW = {}, 0 end
        row[#row + 1] = { label = label, w = bw, index = i }
        rowW = rowW + bw + u * 2
      end
      if #row > 0 then rowsOf[#rowsOf + 1] = row end
      for _, r in ipairs(rowsOf) do
        addRow(lh + u * 2, function(y)
          local x = pad + u * 3
          for _, b in ipairs(r) do
            local chosen = e.answered == b.label
            gc.color = chosen and C.accent or C.rule
            gc:beginPath()
            gc:roundedRect(Rectangle(x, y, b.w, lh + u), u * 2, u * 2)
            gc:fill()
            gc.color = (e.answered and not chosen) and C.faint or C.text
            gc:fillText(b.label, x + u * 3, y + u // 2)
            if not e.answered then
              hitButtons[#hitButtons + 1] = { x0 = x, y0 = y, x1 = x + b.w, y1 = y + lh + u, action = action, entry = e, index = b.index }
            end
            x = x + b.w + u * 2
          end
        end, nil, u)
      end
      if not e.answered and hint then
        addRow(lh, function(y)
          gc.color = C.faint
          gc:fillText(hint, pad + u * 3, y)
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
          -- Rewind (#93): restore the sprite or the conversation to before this message, or branch from here.
          if not busy then
            local mark = "↶"
            local mw = gc:measureText(mark).width
            local mx, my = x0 - mw - u * 3, y + (bh - lh) // 2
            gc.color = e.checkpoint and C.dim or C.faint
            gc:fillText(mark, mx, my)
            hitButtons[#hitButtons + 1] = { x0 = mx - u, y0 = my - u, x1 = mx + mw + u, y1 = my + lh + u, action = "rewind", entry = e }
          end
          gc.color = C.bubbleText
          local ty = y + u * 2
          for _, l in ipairs(lines) do
            gc:fillText(l, x0 + bx, ty)
            ty = ty + lineHeight(l) + u // 2
          end
        end, nil, (e.images and #e.images > 0) and u * 2 or u * 4)
        -- The images sent with it: small cards under the bubble, right-aligned. Hover shows one large; a click opens it.
        if e.images and #e.images > 0 then
          local box = lh * 3
          addRow(box, function(y)
            local x = w - pad - (#e.images * (box + u * 2) - u * 2)
            for _, im in ipairs(e.images) do
              local cell = math.max(2, box // 6)
              for cy = 0, box - 1, cell do
                for cx = 0, box - 1, cell do
                  gc.color = ((cx // cell + cy // cell) % 2 == 0) and Color(92, 92, 100) or Color(70, 70, 78)
                  gc:fillRect(Rectangle(x + cx, y + cy, math.min(cell, box - cx), math.min(cell, box - cy)))
                end
              end
              local img = im.path and thumbCache[im.path]
              if img then
                local sc = box / math.max(img.width, img.height)
                if sc >= 1 then sc = math.floor(sc) end
                local dw, dh = math.max(1, math.floor(img.width * sc)), math.max(1, math.floor(img.height * sc))
                gc:drawImage(img, Rectangle(0, 0, img.width, img.height), Rectangle(x + (box - dw) // 2, y + (box - dh) // 2, dw, dh))
              elseif im.path and thumbCache[im.path] == nil then
                thumbWanted[im.path] = true
              end
              hitThumbs[#hitThumbs + 1] = { x0 = x, y0 = y, x1 = x + box, y1 = y + box, path = im.path, label = im.label }
              x = x + box + u * 2
            end
          end, nil, u * 4)
        end

      elseif k == "header" then
        local status, turnAction, mixed = turns:view(e)
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
          if status == "undone" or status == "partly undone" or (mixed and status == "done") then
            local note = mixed and status == "done" and "shared with another chat: no revert"
              or (status == "undone" and "reverted" or "partly undone")
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

      elseif k == "question" then
        -- ask_user: the question, then its options as buttons; a click sends the option as the user's message.
        cardRows(e, e.text, e.options or {}, "answer_question", "Pick one, or type your own answer below.")

      elseif k == "memory" then
        -- remember_style (#93): the proposed entry, kept only when the user approves it.
        cardRows(e, "Remember for this project? " .. (e.topic or "note") .. ": " .. (e.text or ""),
          MEMORY_OPTIONS, "answer_memory", "Approved entries show in the State block of every message.")

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

    -- The mascot shows the chat's mood: working while its turn runs,
    -- results after, idling and sleeping in between (mascot_mood.lua).
    do
      local ms = math.max(3, (lh * 3) // Mascot.HEIGHT)
      local mw, mh = Mascot.size(ms)
      addRow(mh, function(y)
        local name, t = chats.current.mood:current(animT)
        Mascot.draw(gc, pad, y, ms, Mascot.frame(name, t))
        gc.color = C.dim
        local word = Mascot.label(name)
        if busy then word = word .. "... " .. formatSeconds(conv:elapsed() or 0) end
        gc:fillText(word, pad + mw + u * 2, y + (mh - lh) // 2)
      end, nil, u * 2)
    end

    -- Queued messages, each with Send now and ✕.
    for qi, q in ipairs(chats.current.queue) do
      addRow(lh + u, function(y)
        local x = pad
        local tag = chats.current.queuePaused and "Paused" or "Queued"
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

    if #conv:entries() == 0 then
      local h, draw = textBlock({}, "t",
        "Ask the agent to change the open sprite.\nExample: add a Shadow layer under this one at 50%.",
        pad, textW, C.dim)
      addRow(h, draw, nil, 0)
    end
    return rows, pad, hits
  end

  return self
end

return M
