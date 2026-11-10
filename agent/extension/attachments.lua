-- Attachments (#21): render what the user wants the agent to see (the
-- selection, the active layer, the active frame) to a PNG, or take an image
-- file, so the chat can send it with the next message.
--
--   local Attachments = dofile("attachments.lua").new{ dir = ..., snapshot = H.snapshot, Uri = H.Uri,
--                                                       writeImage = function(img, path) ... end }
--   local a, err = Attachments:make("selection")  -- { label, path, uri } or nil, error
--   Attachments:file("/path/ref.png")              -- an image file the user picked
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
        path = self:save(crop), uri = self.Uri.selection(),
      }
    elseif kind == "layer" then
      local layer = app.layer
      if not layer then return nil, "No active layer" end
      if layer.isGroup then return nil, "Pick a layer, not a group" end
      local img, frame = self:render(layer)
      return { label = string.format("layer %s (frame %d)", layer.name, frame), path = self:save(img), uri = self.Uri.layer(layer) }
    elseif kind == "frame" then
      local img, frame = self:render(nil)
      return { label = string.format("frame %d", frame), path = self:save(img), uri = self.Uri.frame(frame) }
    end
    return nil, "Unknown attachment: " .. tostring(kind)
  end)
  if not ok then return nil, tostring(result) end
  return result, err
end

-- An image file the user picked.
function M:file(path)
  if not path or path == "" then return nil, "No file" end
  local ext = app.fs.fileExtension(path):lower()
  if not (ext == "png" or ext == "jpg" or ext == "jpeg" or ext == "gif" or ext == "webp") then
    return nil, "Attach a PNG, JPEG, GIF or WebP image"
  end
  if not app.fs.isFile(path) then return nil, "File not found" end
  return { label = "image " .. app.fs.fileName(path), path = path }
end

return M
