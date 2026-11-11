-- Updates of the user's stable instance (docs/INSTANCES.md): "Check for
-- Updates..." in the AI Agent menu, and a note in the chat when the stable
-- branch has something new. The bridge does the work (update.check,
-- update.prepare, update.install, which run tools/stable.mjs); the dev
-- instance's bridge refuses, so nothing happens there.
--
--   dofile("updates.lua")(Panel, { request = ..., prompter = ..., Prompter = ...,
--     note = function(kind, text) end, saveAndQuit = function() end })

return function(Panel, ctx)
  local request, prompter, Prompter = ctx.request, ctx.prompter, ctx.Prompter

  local function notesText(r)
    local lines = {}
    for i, n in ipairs(r.notes or {}) do
      if i > 12 then lines[#lines + 1] = "..."; break end
      lines[#lines + 1] = "- " .. n
    end
    return lines
  end

  -- Builds (if needed) while the user keeps working, then asks to restart.
  local function prepareAndInstall(r)
    ctx.note("status", r.needsBuild and "Building the update (Aseprite changed: this takes a while; keep working)..."
      or "Preparing the update...")
    request("update.prepare", {}, function(_, err)
      if err then ctx.note("error", "The update failed: " .. tostring(err.message or err)); return end
      ctx.note("status", "The update is ready.")
      local q = { id = "update", title = "AI Agent update ready",
        text = { "Restart Aseprite now to install it?", "Open sprites are saved and reopened." },
        buttons = { "Restart now", "Later" } }
      if prompter.ask(q) ~= 1 then
        ctx.note("status", "The update will install when you choose Check for Updates again.")
        return
      end
      request("update.install", {}, function(_, e2)
        if e2 then ctx.note("error", "Couldn't start the installer: " .. tostring(e2.message or e2)); return end
        ctx.saveAndQuit()
      end)
    end)
  end

  -- Menu: shows what is new and offers to update.
  function Panel.checkUpdates()
    request("update.check", {}, function(r, err)
      if err then prompter.ask(Prompter.notice("Check for Updates", err.message or tostring(err))); return end
      if r.upToDate then prompter.ask(Prompter.notice("Check for Updates", "The AI Agent is up to date (" .. tostring(r.installed):sub(1, 9) .. ").")); return end
      local text = { "A new version is available (" .. tostring(r.available):sub(1, 9) .. "):" }
      for _, l in ipairs(notesText(r)) do text[#text + 1] = l end
      if r.needsBuild then text[#text + 1] = "Aseprite itself changed: it is rebuilt on this computer first." end
      local q = { id = "update", title = "AI Agent update", text = text, buttons = { "Update", "Later" } }
      if prompter.ask(q) == 1 then prepareAndInstall(r) end
    end)
  end

  -- At startup: a quiet note in the chat when an update is available.
  function Panel.noticeUpdates()
    request("update.check", {}, function(r, err)
      if err or not r or r.upToDate then return end
      ctx.note("status", "An AI Agent update is available: AI Agent menu > Check for Updates...")
    end)
  end
end
