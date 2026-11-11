-- My Commands dialog (#26): run, enable or disable, view the source of and
-- revert saved commands. Installs Panel.manageCommands.
--
--   dofile("commands_dialog.lua")(Panel, { savedCommands = ..., request = ..., prompter = ..., Prompter = ... })

return function(Panel, ctx)
  local request, prompter, Prompter = ctx.request, ctx.prompter, ctx.Prompter
  -- My Commands: run, enable/disable, source, revert to the previous version (#26).
  function Panel.manageCommands()
    local S = ctx.savedCommands
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
        request("commands.setEnabled", { name = c.name, enabled = c.enabled == false }, function(_, err)
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
        request("commands.revert", { name = c.name }, function(result, err)
          if err then prompter.tip(err.message or "Nothing to revert to")
          else prompter.tip("Restored /" .. c.name .. " from " .. tostring(result.restored)); S:reload() end
        end)
      end }
    end
    d:separator{}
    d:button{ text = "Close" }
    d:show{ wait = false }
  end

end
