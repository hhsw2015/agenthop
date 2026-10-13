--!strict
-- agenthop agents-bridge (tern-migration spike, deliverable ②). A THIN window-half shim: it adds NO detection logic of its own —
-- it mirrors cx.agents (Tern's native agent layer) to a file-JSON control plane the bash swarm reads/writes, herdr-style.
--
--   STATUS  mirror : <CTL>/agents.json          ← cx.agents:list() every POLL_MS (pane/state/last_message per agent block)
--   REQUEST inbox  : <CTL>/requests/<id>.json   → bash writes {op, agent?, text?, ...}; bridge consumes once (claimed by remove)
--   RESULT  outbox : <CTL>/results/<id>.json     ← bridge writes {ok, ...} ; wait() answers later via :next (never blocks the tick)
--
-- Why this shape: cx.agents is a Lua window-half API — the swarm is bash. The bridge is the shim mirror-24's eval called for.
-- All IO via tern.fs (sync, plugin-trusted, relative-to-plugin or absolute). The window tick must stay cheap (50ms budget): list()
-- /ask/start/interrupt/stop are sync and bounded; wait() is async and handed to :next so a long idle-wait never stalls the loop.

local HOME = tern.getenv("HOME") or ""
local CTL = HOME .. "/.agenthop/tern-panes" -- control-plane dir shared with the bash swarm (herdr-style location)
local REQ = CTL .. "/requests"
local RES = CTL .. "/results"
local POLL_MS = 750 -- status-mirror cadence; far inside herdr's own poll. Per-tick work stays well under the window budget.

local function ensure()
  for _, d in { CTL, REQ, RES } do
    if not tern.fs.exists(d) then
      pcall(function() tern.fs.mkdir(d) end)
    end
  end
end

-- STATUS: snapshot cx.agents:list() to agents.json. A torn read on the bash side self-heals on the next poll, so a plain write is
-- enough for a status mirror (unlike the swarm's own kv.json, this file is advisory, not a durable obligation).
local ticks = 0
local function mirror(cx)
  ticks += 1
  local ok, agents = pcall(function() return cx.agents:list() end)
  local payload = {
    ts = tern.now(),
    tick = ticks, -- spike diagnostic: confirms the poll loop is alive (must advance every POLL_MS)
    agents = ok and agents or tern.json.array({}),
    error = (not ok) and tostring(agents) or nil,
  }
  pcall(function() tern.fs.write(CTL .. "/agents.json", tern.json.encode(payload)) end)
end

local function answer(id, result)
  pcall(function() tern.fs.write(RES .. "/" .. id .. ".json", tern.json.encode(result)) end)
end

-- REQUESTS: drain each request file exactly once (remove = claim), decode, dispatch to cx.agents, write the result. One op/file;
-- the file name (minus .json) is the request id the bash side polls results/<id>.json for.
-- FINDING (spike ①): cx.agents:start is synchronous and blocks the single-threaded window VM while the agent opens — called from
-- this poll loop it froze the mirror (tick stopped advancing). list/ask/interrupt/stop are fast; wait is async via :next. So start is
-- processed here too but flagged: in production, long-blocking ops belong in a user/palette action context (tern.command) or a
-- dedicated non-mirroring window, not the status poll. list() (the mirror) is read-only and safe in the loop — that is proven.
local function drain(cx)
  local names = {}
  pcall(function() names = tern.fs.list(REQ) end)
  for _, name in names do
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local text = ""
      local okRead = pcall(function() text = tern.fs.read(REQ .. "/" .. name) end)
      pcall(function() tern.fs.remove(REQ .. "/" .. name) end) -- consume once: a re-list won't re-run a claimed request
      if okRead then
        local okDec, req = pcall(function() return tern.json.decode(text) end)
        if okDec and type(req) == "table" then
          local op = req.op
          if op == "list" then
            answer(id, { ok = true, agents = cx.agents:list() })
          elseif op == "ask" then
            local o, e = pcall(function() cx.agents:ask(req.agent, req.text) end)
            answer(id, { ok = o, error = (not o) and tostring(e) or nil })
          elseif op == "start" then
            local o, p = pcall(function()
              return cx.agents:start({ prompt = req.prompt, cwd = req.cwd, command = req.command, how = req.how })
            end)
            answer(id, { ok = o, pane = o and p or nil, error = (not o) and tostring(p) or nil })
          elseif op == "transcript" then
            local o, t = pcall(function() return cx.agents:transcript(req.agent, { last = req.last }) end)
            answer(id, { ok = o, transcript = o and t or nil, error = (not o) and tostring(t) or nil })
          elseif op == "interrupt" then
            local o, e = pcall(function() cx.agents:interrupt(req.agent) end)
            answer(id, { ok = o, error = (not o) and tostring(e) or nil })
          elseif op == "stop" then
            local o, e = pcall(function() cx.agents:stop(req.agent) end)
            answer(id, { ok = o, error = (not o) and tostring(e) or nil })
          elseif op == "wait" then
            -- async: hand off to :next so a long idle-wait never blocks the window tick (the eval's explicit 50ms constraint)
            local okW, aw = pcall(function() return cx.agents:wait(req.agent, { timeout = req.timeout }) end)
            if okW then
              aw:next(function(message, err)
                answer(id, { ok = (err == nil), message = message, error = err })
              end)
            else
              answer(id, { ok = false, error = tostring(aw) })
            end
          else
            answer(id, { ok = false, error = "unknown op: " .. tostring(op) })
          end
        else
          answer(id, { ok = false, error = "bad request json" })
        end
      end
    end
  end
end

-- The poll loop reschedules itself via tern.sleep():next(), the documented way a continuation gets a fresh WindowCx (per the API:
-- "plugins use :next(function(message, err, cx) ... end)"). A bare re-armed tern.timer can fire with cx == nil; the earlier draft
-- early-returned on that and never rescheduled, so the loop died after one tick. Here the reschedule is UNCONDITIONAL: a tick with
-- no cx just skips the work and the next sleep still fires. Reload tears down this VM, so the closure needs no explicit stop flag.
local function step(cx)
  if cx ~= nil then
    ensure()
    mirror(cx)
    local ok, err = pcall(function() drain(cx) end) -- spike diagnostic: surface any drain throw instead of killing the loop
    if not ok then
      pcall(function() tern.fs.write(CTL .. "/bridge-error.txt", tern.now() .. " drain: " .. tostring(err)) end)
    end
  end
  tern.sleep(POLL_MS):next(function(_, _, nextCx) step(nextCx) end)
end

step(nil) -- kick off; the first sleep's :next delivers the window cx, then every tick thereafter
