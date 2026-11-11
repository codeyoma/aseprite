-- Attachments (#21): render what the user wants the agent to see (the
-- selection, the active layer, the active frame, the clipboard image) to a
-- PNG, or take an image file, so the chat can send it with the next message.
-- Any file Aseprite opens can be attached; the bridge converts what the
-- model can't take as it is (animations become a sheet of frames).
--
--   local Attachments = dofile("attachments.lua").new{ dir = ..., snapshot = H.snapshot, Uri = H.Uri,
--                                                       writeImage = function(img, path) ... end }
--   local a, err = Attachments:make("selection")  -- { label, path, uri } or nil, error
--   Attachments:file("/path/ref.gif")              -- an image file the user picked
--   Attachments:clipboard()                        -- the image on the clipboard
--
-- Rendered images are upscaled with nearest neighbor to at most 512 px.
-- Writing files goes through opts.writeImage, which agent.lua provides:
-- Aseprite asks permission per script file, and agent.lua is trusted.

local M = {}
M.__index = M

M.MAX_SIDE = 512

function M.new(opts)
  return setmetatable({
    dir = assert(opts.dir, "dir required"),
    snapshot = assert(opts.snapshot, "snapshot required"),
    Uri = assert(opts.Uri, "Uri required"),
    writeImage = assert(opts.writeImage, "writeImage required"),
    -- Returns the clipboard Image or nil; agent.lua reads it (Aseprite asks
    -- permission per script file).
    clipboardImage = opts.clipboardImage or function() return nil end,
    -- True when the clipboard holds an image and no text (Cmd+V then attaches).
    clipboardHasImage = opts.clipboardHasImage or function() return false end,
    -- Reads an image file (agent.lua: Image{ fromFile }), for thumbnails.
    readImage = opts.readImage or function() return nil end,
    counter = 0,
  }, M)
end

-- RGB image of the active frame (or one layer), from the snapshot handler.
function M:render(layer)
  local header, bytes = self.snapshot{ layer = layer and layer.name or nil }
  local img = Image(header.width, header.height, ColorMode.RGB)
  img.bytes = bytes
  return img, header.frame
end

local function upscale(img)
  local s = math.max(1, math.floor(M.MAX_SIDE / math.max(img.width, img.height)))
  if s > 1 then img:resize(img.width * s, img.height * s) end
  return img
end

function M:save(img)
  self.counter = self.counter + 1
  local path = app.fs.joinPath(self.dir, string.format("%d-%d.png", os.time(), self.counter))
  self.writeImage(upscale(img), path)
  return path
end

-- kind: "selection" | "layer" | "frame". Returns { label, path, uri } or nil, error.
function M:make(kind)
  local sprite = app.sprite
  if not sprite then return nil, "Open a sprite first" end
  local ok, result, err = pcall(function()
    if kind == "selection" then
      local sel = sprite.selection
      if not sel or sel.isEmpty then return nil, "Select an area first" end
      local img, frame = self:render(nil)
      local b = sel.bounds:intersect(Rectangle(0, 0, img.width, img.height))
      if b.isEmpty then return nil, "The selection is outside the canvas" end
      local crop = Image(img, b)
      return {
        label = string.format("selection %dx%d at %d,%d (frame %d)", b.width, b.height, b.x, b.y, frame),
        path = self:save(crop), uri = self.Uri.selection(), short = "selection",
      }
    elseif kind == "layer" then
      local layer = app.layer
      if not layer then return nil, "No active layer" end
      if layer.isGroup then return nil, "Pick a layer, not a group" end
      local img, frame = self:render(layer)
      return { label = string.format("layer %s (frame %d)", layer.name, frame), short = layer.name,
               path = self:save(img), uri = self.Uri.layer(layer) }
    elseif kind == "frame" then
      local img, frame = self:render(nil)
      return { label = string.format("frame %d", frame), short = "frame " .. frame,
               path = self:save(img), uri = self.Uri.frame(frame) }
    end
    return nil, "Unknown attachment: " .. tostring(kind)
  end)
  if not ok then return nil, tostring(result) end
  return result, err
end

-- File types the panel offers; the bridge (attachments.ts) accepts the same.
M.EXTENSIONS = { "png", "jpg", "jpeg", "gif", "webp", "bmp", "tga", "pcx", "qoi", "ico",
                 "psd", "psb", "flc", "fli", "ase", "aseprite" }

local function isImageExtension(ext)
  for _, e in ipairs(M.EXTENSIONS) do if e == ext then return true end end
  return false
end

-- An image file the user picked.
function M:file(path)
  if not path or path == "" then return nil, "No file" end
  if not isImageExtension(app.fs.fileExtension(path):lower()) then
    return nil, "Attach an image file (" .. table.concat(M.EXTENSIONS, ", ") .. ")"
  end
  if not app.fs.isFile(path) then return nil, "File not found" end
  return { label = "image " .. app.fs.fileName(path), short = app.fs.fileName(path), path = path }
end

-- A small image of attachment a for its card (the first frame of a file),
-- read once and kept on a; nil when the file can't be read.
M.THUMB_SIDE = 128
function M:thumbnail(a)
  if a.thumb == nil then
    local ok, img = pcall(self.readImage, a.path)
    if ok and img then
      local s = M.THUMB_SIDE / math.max(img.width, img.height)
      if s < 1 then
        img = Image(img)
        img:resize(math.max(1, math.floor(img.width * s)), math.max(1, math.floor(img.height * s)))
      end
      a.thumb = img
    else
      a.thumb = false
    end
  end
  return a.thumb or nil
end

function M:clipboardHasImage()
  local ok, has = pcall(self.clipboardHasImage)
  return ok and has == true
end

-- The image on the clipboard (a screenshot, a copied reference).
function M:clipboard()
  local ok, img = pcall(self.clipboardImage)
  if not ok then return nil, "Could not read the clipboard: " .. tostring(img) end
  if not img then return nil, "The clipboard has no image" end
  if img.colorMode ~= ColorMode.RGB then
    local rgb = Image(img.width, img.height, ColorMode.RGB)
    rgb:drawImage(img)
    img = rgb
  end
  return { label = string.format("pasted image %dx%d", img.width, img.height), short = "pasted", path = self:save(img) }
end

return M
