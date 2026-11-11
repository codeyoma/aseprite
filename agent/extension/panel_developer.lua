-- Developer mode in the chat panel (#28): apply or discard the agent's
-- changes to the fork's source, build, relaunch. Installs its functions on
-- the Panel table; the panel calls them from log buttons and build events.
--
--   dofile("panel_developer.lua")(Panel, {
--     request = ..., prompter = ..., Prompter = ..., conv = function() return conv end,
--     changed = function() ... end, saveForRelaunch = function(data) ... end,
--   })

return function(Panel, ctx)
  local request, prompter, Prompter, changed = ctx.request, ctx.prompter, ctx.Prompter, ctx.changed
  local function conv() return ctx.conv() end

  -- Saves the conversation and open sprites, asks the bridge to start the
  -- fork's build again once Aseprite has quit, then quits.
  function Panel.relaunch()
    request("dev.relaunch", {}, function(_, err)
      if err then prompter.ask(Prompter.notice("Relaunch", err.message or tostring(err))); return end
      ctx.saveForRelaunch(conv():serialize())
      app.exit()
    end)
  end

  -- Shows what changed; rebuilds when C++ changed, then relaunches.
  function Panel.applyDevChanges()
    request("dev.status", {}, function(st, err)
      if err then prompter.tip(err.message or "Developer mode is not available"); return end
      local question, tip = Prompter.applyQuestion(st)
      if not question then prompter.tip(tip); return end
      if prompter.ask(question) ~= 1 then return end
      -- The agent works in its own worktree: bring its commits into the
      -- user's checkout first, then build or relaunch from there.
      request("dev.apply", {}, function(applied, e1)
        if e1 then
          -- In the log too, so the agent (and tests) can see why.
          conv():note("error", "Couldn't apply: " .. (e1.message or tostring(e1)))
          changed()
          prompter.ask(Prompter.notice("Apply the agent's changes", e1.message or tostring(e1)))
          return
        end
        if applied and applied.commits and applied.commits > 0 then
          conv():note("status", "Applied " .. applied.commits .. " commit(s) to " .. (st.base or "your branch") .. ".")
        end
        if st.needsBuild then
          conv():note("status", "Building Aseprite...")
          changed()
          request("dev.build", {}, function(_, e2) if e2 then conv():note("error", e2.message); changed() end end)
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
    if not conv():isBusy() then
      Panel.submit("The build failed. Fix these errors, then tell me to rebuild:\n" .. (ev.text or ""), nil, "developer")
    end
  end

  function Panel.discardDevChanges()
    if prompter.ask(Prompter.discardQuestion()) ~= 1 then return false end
    request("dev.discard", {}, function(r, err)
      if err then prompter.ask(Prompter.notice("Discard", err.message or tostring(err))); return end
      conv():note("status", "Discarded the agent's work (" .. (r.stash or "nothing uncommitted") .. ")"
        .. (r.reverted and ("; " .. r.branch .. " is back where it was") or "") .. ".")
      changed()
    end)
    return true
  end

end
