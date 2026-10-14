-- snapshot-check — the A6 promptless freshness check source (contract section 2: "update = an A2-style 1-minute
-- check OR an explicit refresh command").
--
-- window.luau reads this file as a STRING and passes it to tern.carly.schedule({ when = "every 1m", check = ... }),
-- exactly as agenthop-agents-bridge schedules sentinel.luau. The scheduler compiles this source and calls the
-- returned function(ev, cx, state) every minute with NO model turn. It stays self-contained (a scheduled check does
-- not require()) and does the one thing A6 needs: re-run the snapshot refresh by dispatching the plugin's own
-- `refresh` action (WindowCx:action runs "plugin.<id>.<command>"), which rewrites the authoritative snapshot file
-- and the canvas pane. Returning nil is quiet (no escalation, no model turn).

return function(ev, cx, state)
  pcall(function()
    cx:action("plugin.swarm-observatory.refresh")
  end)
  return nil
end
