-- Apply area (#88): the whole change as data. `apply` runs a list of ops
-- (layers, cels and pixels, frames, tags, palette) in order inside ONE
-- transaction, so the change is one undo step. Every op runs in its own
-- pcall so every failing op is reported (by its path, ops[0] first); when
-- any op fails, or for a dry run, the transaction is rolled back and
-- nothing changes. A dry run therefore checks the ops against the live
-- sprite exactly and returns what they would change.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_apply.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua
--
-- Frame numbers in an op are the sprite's frames when that op runs (after
-- the frames earlier ops added or deleted). Layers are ids ("L12") or
-- names, including layers added by earlier ops.

return function(handlers, D)
  local px, layerById, wireParams, view = D.px, D.layerById, D.wireParams, D.view

  local DIRS = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, ["ping-pong"] = AniDir.PING_PONG,
                 ["ping-pong-reverse"] = AniDir.PING_PONG_REVERSE }

  -- Op name -> the keys it takes (besides `op`): protocol.json applyOps,
  -- the one definition the bridge's apply tool and the fake share (#116).
  local KEYS = {}
  for name, params in pairs(D.protocol.applyOps) do
    if name ~= "description" then
      local keys = {}
      for k in pairs(params) do keys[#keys + 1] = k end
      KEYS[name] = keys
    end
  end
  -- Ops a sub-agent may run: the scope guard checks pixels and cels only.
  local SCOPED = { pixels = true, rect = true, line = true, clear_cel = true, move_cel = true }

  local function fail(msg) error(msg, 0) end
  local function isInt(v) return math.type(v) == "integer" end
  local function range(list)
    if #list == 0 then return "none" end
    local out, i = {}, 1
    while i <= #list do
      local j = i
      while j < #list and list[j + 1] == list[j] + 1 do j = j + 1 end
      out[#out + 1] = i == j and tostring(list[i]) or (list[i] .. "-" .. list[j])
      i = j + 1
    end
    return table.concat(out, ",")
  end

  handlers.apply = function(params)
    -- The request's sprite (#90), which need not be the active one.
    local site = D.site()
    local sprite = site.sprite
    local ops = params.ops
    if type(ops) ~= "table" or #ops == 0 then error("ops must list at least one op") end
    local scoped = type(params.scope) == "table"
    local startLayer, startFrame = site.layer, site.frame

    local function layerOf(ref, what)
      if ref == nil then fail((what or "layer") .. " is required") end
      local l = layerById(ref, sprite)
      if not l then fail("Layer not found: " .. tostring(ref)) end
      return l
    end
    local function imageLayer(ref)
      local l = layerOf(ref)
      if l.isGroup or l.isTilemap or not l.isImage then fail(l.name .. " is not an image layer") end
      return l
    end
    local function frameOf(f)
      local n = f or math.min(startFrame, #sprite.frames)
      if not isInt(n) or n < 1 or n > #sprite.frames then
        fail(string.format("Frame %s is out of range (1-%d)", tostring(n), #sprite.frames))
      end
      return n
    end
    local function framesOf(spec, default)
      local ok, out = pcall(wireParams.resolveFrames, spec, #sprite.frames, math.min(startFrame, #sprite.frames), default)
      if not ok then fail((tostring(out):gsub("^[^\n]-%.lua:%d+: ", ""))) end
      return out
    end
    local function blendOf(name)
      local mode = view.BLEND_MODES[name]
      if not mode then fail("Unknown blend mode: " .. tostring(name)) end
      return mode
    end
    local function opacityOf(v)
      if not isInt(v) or v < 0 or v > 255 then fail("opacity must be an integer from 0 to 255") end
      return v
    end
    -- One color for a shape: '#rrggbb[aa]', '.' or 'transparent', or a palette index.
    local function colorValue(c)
      if c == nil then fail("color is required") end
      local key
      if c == "." or c == "transparent" then key = "."
      elseif isInt(c) then
        local pal = sprite.palettes[1]
        if c < 0 or c >= #pal then fail(string.format("palette index %d is past the palette's end (%d colors)", c, #pal)) end
        key = sprite.colorMode == ColorMode.INDEXED and tostring(c) or px.colorHex(pal:getColor(c))
      elseif type(c) == "string" then
        if not pcall(px.parseHex, c) then fail(tostring(c) .. " is not a color (use #rrggbb, #rrggbbaa, '.' or a palette index)") end
        key = c:sub(1, 1) == "#" and c or ("#" .. c)
      else
        fail("color must be a hex color, '.' or a palette index")
      end
      local resolve = D.gridKeys(sprite, nil)
      local v, why = resolve(key)
      if v == nil then fail(why) end
      return v
    end
    -- Writes into a layer's cel; the change runs now (inside apply's transaction).
    local function writeCel(op, writes, what)
      local layer = D.pixelLayer(sprite, op.layer or (startLayer and ("L" .. startLayer.id)), what)
      local frame = frameOf(op.frame)
      local result, commit = D.celWrites(sprite, layer, frame, writes)
      if commit then commit() end
      return string.format("%s frame %d: %d of %d pixels changed", layer.name, frame, result.changed, result.written)
    end
    local function inCanvas(x, y) return x >= 0 and y >= 0 and x < sprite.width and y < sprite.height end
    -- Places l above or below ref (in ref's group), or on top of a group.
    local function place(l, op)
      if op.above ~= nil and op.below ~= nil then fail("give above or below, not both") end
      local ref = op.above ~= nil and layerOf(op.above, "above") or op.below ~= nil and layerOf(op.below, "below") or nil
      if ref == l then fail("a layer can't be placed next to itself") end
      local parent
      if op.parent ~= nil then
        parent = layerOf(op.parent, "parent")
        if not parent.isGroup then fail(parent.name .. " is not a group") end
        local p = parent
        while p and p ~= sprite do
          if p == l then fail("a group can't go inside itself") end
          p = p.parent
        end
        if ref and ref.parent ~= parent then fail(ref.name .. " is not in the group " .. parent.name) end
      end
      if ref then
        l.parent = ref.parent
        l.stackIndex = op.above ~= nil and ref.stackIndex + 1 or ref.stackIndex
        return (op.above ~= nil and "above " or "below ") .. ref.name
      elseif parent then
        l.parent = parent
        return "into " .. parent.name
      end
    end

    local made = {}   -- layers added: { layer, name }
    local RUN = {}

    RUN.add_layer = function(op)
      if type(op.name) ~= "string" or op.name == "" then fail("name is required") end
      local l = op.group and sprite:newGroup() or sprite:newLayer()
      l.name = op.name
      local where = place(l, op)
      if op.blend ~= nil or op.opacity ~= nil then
        if l.isGroup then fail("blend and opacity are for image layers") end
        if op.blend ~= nil then l.blendMode = blendOf(op.blend) end
        if op.opacity ~= nil then l.opacity = opacityOf(op.opacity) end
      end
      if op.visible == false then l.isVisible = false end
      made[#made + 1] = { layer = l, name = l.name }
      return string.format("Added %s %s%s", l.isGroup and "group" or "layer", l.name, where and (" " .. where) or "")
    end

    RUN.set_layer = function(op)
      local l = layerOf(op.layer)
      local parts, old = {}, l.name
      if op.name ~= nil then
        if type(op.name) ~= "string" or op.name == "" then fail("name must be text") end
        l.name = op.name; parts[#parts + 1] = "renamed " .. op.name
      end
      if op.visible ~= nil then l.isVisible = op.visible and true or false; parts[#parts + 1] = op.visible and "shown" or "hidden" end
      if op.locked ~= nil then l.isEditable = not op.locked; parts[#parts + 1] = op.locked and "locked" or "unlocked" end
      if op.opacity ~= nil or op.blend ~= nil then
        if l.isGroup then fail("blend and opacity are for image layers; " .. l.name .. " is a group") end
        if op.opacity ~= nil then l.opacity = opacityOf(op.opacity); parts[#parts + 1] = "opacity " .. op.opacity end
        if op.blend ~= nil then l.blendMode = blendOf(op.blend); parts[#parts + 1] = "blend " .. op.blend end
      end
      if #parts == 0 then fail("nothing to set: give name, visible, locked, opacity or blend") end
      return "Layer " .. old .. ": " .. table.concat(parts, ", ")
    end

    RUN.move_layer = function(op)
      local l = layerOf(op.layer)
      if op.above == nil and op.below == nil and op.parent == nil then fail("give above, below or parent") end
      return "Moved " .. l.name .. " " .. place(l, op)
    end

    RUN.delete_layer = function(op)
      local l = layerOf(op.layer)
      local name = l.name
      sprite:deleteLayer(l)
      return "Deleted layer " .. name
    end

    RUN.pixels = function(op)
      local writes = D.gridWrites(sprite, op.rows, op.legend, op.x or 0, op.y or 0)
      return writeCel(op, writes, "pixels")
    end

    RUN.rect = function(op)
      for _, k in ipairs{ "x", "y", "w", "h" } do
        if not isInt(op[k]) then fail(k .. " must be a whole number") end
      end
      if op.w < 1 or op.h < 1 then fail("w and h must be at least 1") end
      local v = colorValue(op.color)
      local writes = {}
      local x1, y1 = op.x + op.w - 1, op.y + op.h - 1
      for y = math.max(op.y, 0), math.min(y1, sprite.height - 1) do
        for x = math.max(op.x, 0), math.min(x1, sprite.width - 1) do
          if op.fill ~= false or x == op.x or x == x1 or y == op.y or y == y1 then writes[#writes + 1] = { x, y, v } end
        end
      end
      return writeCel(op, writes, "rect")
    end

    RUN.line = function(op)
      local pts = op.points
      if type(pts) ~= "table" or #pts == 0 then fail("points must list at least one [x, y]") end
      for i, p in ipairs(pts) do
        if type(p) ~= "table" or not isInt(p[1]) or not isInt(p[2]) then fail(string.format("points[%d] must be [x, y] in whole pixels", i - 1)) end
      end
      local v = colorValue(op.color)
      local writes, seen = {}, {}
      local function plot(x, y)
        local k = y * 65536 + x
        if inCanvas(x, y) and not seen[k] then seen[k] = true; writes[#writes + 1] = { x, y, v } end
      end
      plot(pts[1][1], pts[1][2])
      for i = 2, #pts do
        -- Bresenham from the previous point.
        local x0, y0, x1, y1 = pts[i - 1][1], pts[i - 1][2], pts[i][1], pts[i][2]
        local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
        local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
        local err = dx + dy
        while true do
          plot(x0, y0)
          if x0 == x1 and y0 == y1 then break end
          local e2 = 2 * err
          if e2 >= dy then err = err + dy; x0 = x0 + sx end
          if e2 <= dx then err = err + dx; y0 = y0 + sy end
        end
      end
      return writeCel(op, writes, "line")
    end

    RUN.clear_cel = function(op)
      local l = imageLayer(op.layer)
      local cleared = {}
      for _, f in ipairs(framesOf(op.frames, "active")) do
        local cel = l:cel(f)
        if cel then sprite:deleteCel(cel); cleared[#cleared + 1] = f end
      end
      return string.format("Cleared %s in frames %s", l.name, range(cleared))
    end

    RUN.move_cel = function(op)
      local l = imageLayer(op.layer)
      local dx, dy = op.dx or 0, op.dy or 0
      if not isInt(dx) or not isInt(dy) then fail("dx and dy must be whole pixels") end
      local moved, done = {}, {}
      for _, f in ipairs(framesOf(op.frames, "active")) do
        local cel = l:cel(f)
        -- Linked cels share one position: move it once.
        if cel and not done[cel.image.id] then
          done[cel.image.id] = true
          cel.position = Point(cel.position.x + dx, cel.position.y + dy)
          moved[#moved + 1] = f
        end
      end
      return string.format("Moved %s cels in frames %s by %d,%d", l.name, range(moved), dx, dy)
    end

    RUN.add_frames = function(op)
      local count = op.count or 1
      if not isInt(count) or count < 1 or count > 256 then fail("count must be from 1 to 256") end
      local after = op.after or #sprite.frames
      if not isInt(after) or after < 1 or after > #sprite.frames then
        fail(string.format("after must be a frame from 1 to %d", #sprite.frames))
      end
      if op.duration ~= nil and (not isInt(op.duration) or op.duration < 1) then fail("duration must be whole ms of at least 1") end
      local seconds = op.duration and op.duration / 1000 or sprite.frames[after].duration
      for k = 1, count do
        local nf = sprite:newEmptyFrame(after + k)
        nf.duration = seconds
      end
      if not op.empty then
        local function each(layers)
          for _, l in ipairs(layers) do
            if l.isGroup then each(l.layers)
            elseif l.isImage then
              local cel = l:cel(after)
              if cel then
                for k = 1, count do sprite:newCel(l, after + k, cel.image:clone(), cel.position) end
              end
            end
          end
        end
        each(sprite.layers)
      end
      return string.format("Added %d %s after frame %d (%s, %d ms)", count, count == 1 and "frame" or "frames", after,
        op.empty and "empty" or "copies of frame " .. after, math.floor(seconds * 1000 + 0.5))
    end

    RUN.delete_frames = function(op)
      if op.frames == nil then fail("frames is required") end
      local list = framesOf(op.frames)
      table.sort(list)
      local uniq = {}
      for _, f in ipairs(list) do if uniq[#uniq] ~= f then uniq[#uniq + 1] = f end end
      if #uniq >= #sprite.frames then fail("can't delete every frame; a sprite keeps at least one") end
      for i = #uniq, 1, -1 do sprite:deleteFrame(uniq[i]) end
      return "Deleted frames " .. range(uniq)
    end

    RUN.set_duration = function(op)
      if not isInt(op.ms) or op.ms < 1 then fail("ms must be whole ms of at least 1") end
      local list = framesOf(op.frames, "all")
      for _, f in ipairs(list) do sprite.frames[f].duration = op.ms / 1000 end
      return string.format("Frames %s: %d ms", range(list), op.ms)
    end

    local function tagNamed(name)
      for _, t in ipairs(sprite.tags) do if t.name == name then return t end end
    end
    RUN.set_tag = function(op)
      if type(op.name) ~= "string" or op.name == "" then fail("name is required") end
      local n = #sprite.frames
      for _, k in ipairs{ "from", "to" } do
        if op[k] ~= nil and (not isInt(op[k]) or op[k] < 1 or op[k] > n) then
          fail(string.format("%s must be a frame from 1 to %d", k, n))
        end
      end
      if op.direction ~= nil and not DIRS[op.direction] then
        fail("direction must be forward, reverse, ping-pong or ping-pong-reverse")
      end
      if op["repeat"] ~= nil and (not isInt(op["repeat"]) or op["repeat"] < 0) then fail("repeat must be a whole number, 0 = loop") end
      local tag, isNew = tagNamed(op.name), false
      local from = op.from or (tag and tag.fromFrame.frameNumber)
      local to = op.to or (tag and tag.toFrame.frameNumber)
      if not tag and (not from or not to) then fail("a new tag needs from and to") end
      if from > to then fail(string.format("from (%d) is after to (%d)", from, to)) end
      if not tag then
        tag = sprite:newTag(from, to); tag.name = op.name; isNew = true
      else
        tag.fromFrame = sprite.frames[from]; tag.toFrame = sprite.frames[to]
      end
      if op.direction ~= nil then tag.aniDir = DIRS[op.direction] end
      if op["repeat"] ~= nil then tag.repeats = op["repeat"] end
      if op.rename ~= nil then
        if type(op.rename) ~= "string" or op.rename == "" then fail("rename must be text") end
        tag.name = op.rename
      end
      return string.format("%s tag %s %d-%d", isNew and "Added" or "Set", tag.name, from, to)
    end

    RUN.delete_tag = function(op)
      local tag = tagNamed(op.name)
      if not tag then fail("No tag named " .. tostring(op.name)) end
      sprite:deleteTag(tag)
      return "Deleted tag " .. op.name
    end

    local function colorList(op)
      if type(op.colors) ~= "table" or #op.colors == 0 then fail("colors must list at least one color") end
      for i, c in ipairs(op.colors) do
        if type(c) ~= "string" or not pcall(px.parseHex, c) then fail(string.format("colors[%d]: %s is not a color", i - 1, tostring(c))) end
      end
      return op.colors
    end
    RUN.set_palette = function(op)
      local colors = colorList(op)
      D.paletteColors(sprite, colors, false)
      return string.format("Palette set to %d colors", #colors)
    end
    RUN.append_palette = function(op)
      local added = D.paletteColors(sprite, colorList(op), true)
      return string.format("Palette: added %d colors", added)
    end

    local changes, errors = {}, {}
    local function runOp(i, op)
      local path = string.format("ops[%d]", i - 1)
      if type(op) ~= "table" or type(op.op) ~= "string" then
        errors[#errors + 1] = { op = i - 1, path = path, message = "expected an object with an op" }
        return
      end
      local keys = KEYS[op.op]
      if not keys then
        errors[#errors + 1] = { op = i - 1, path = path, type = op.op, message = "unknown op '" .. op.op .. "'" }
        return
      end
      local allowed = { op = true }
      for _, k in ipairs(keys) do allowed[k] = true end
      for k in pairs(op) do
        if not allowed[k] then
          errors[#errors + 1] = { op = i - 1, path = path .. "." .. tostring(k), type = op.op, message = "unknown param '" .. tostring(k) .. "'" }
          return
        end
      end
      if scoped and not SCOPED[op.op] then
        errors[#errors + 1] = { op = i - 1, path = path, type = op.op,
          message = "sub-agents can only use pixels, rect, line, clear_cel and move_cel; leave " .. op.op .. " to the lead agent" }
        return
      end
      local ok, res = pcall(RUN[op.op], op)
      if ok then
        changes[#changes + 1] = res
      else
        local msg = tostring(type(res) == "table" and (res.message or res) or res):gsub("^[^\n]-%.lua:%d+: ", "")
        errors[#errors + 1] = { op = i - 1, path = path, type = op.op, message = msg }
      end
    end

    local rollback = false
    local ok, err = pcall(D.transaction, sprite, params.label or "Apply", function()
      for i, op in ipairs(ops) do runOp(i, op) end
      if #errors > 0 or params.dry_run then
        rollback = true
        error("apply: rolled back")
      end
    end)
    if not ok and not rollback then error(err) end

    -- The active layer and frame stay what they were (when they still exist).
    local keepLayer = startLayer and pcall(function() return startLayer.name end) and startLayer or nil
    D.select(site, startFrame <= #sprite.frames and startFrame or nil, keepLayer)
    app.refresh()

    local applied = not rollback
    local layers = {}
    if applied then
      for _, m in ipairs(made) do layers[#layers + 1] = { name = m.name, id = "L" .. m.layer.id } end
    end
    return {
      ok = #errors == 0, applied = applied, dryRun = params.dry_run == true,
      errors = errors, changes = changes, layers = layers, frames = #sprite.frames,
    }
  end
end
