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
-- CLAIM MODEL (review TERN-1 fix): execution is gated on a SUCCESSFUL remove, NOT on a successful read. remove() is the claim —
-- POSIX unlink is atomic, so when two window VMs both read the same request only one remove succeeds; the loser gets ENOENT and
-- skips. A read failure leaves the request in place (never delete what we could not read) and it is retried next tick. This is
-- AT-MOST-ONCE per claim, NOT crash-safe exactly-once: tern.fs exposes no rename/O_EXCL (see tern.d.luau), and a crash between the
-- claim and the results write loses that result. A remove failing with EACCES leaves the request stuck-but-unexecuted (safe
-- direction: no double-run). The bridge does not, and cannot here, provide exactly-once.
--
-- UNKNOWN RECOVERY (review TERN-1-R2): a missing results/<id>.json after a bounded wait means UNKNOWN, and UNKNOWN DOES NOT release
-- the dedup obligation (swarm ruling). "Cannot confirm it ran" is NOT "may assume it did not". So recovery is OP-CLASS-SPECIFIC:
--   * read-only (list/transcript): re-issue freely with a new id — a repeat is just another observation, no side effect.
--   * non-idempotent (start/ask): DO NOT auto-reissue. The op may have run and only the receipt was lost; a blind re-issue
--     double-executes. The caller must either verify the original op's effect, carry an independent business idempotency key, or
--     explicitly accept the duplicate risk / HOLD for a human. The bridge never promises generic new-id reissue as safe recovery.
--
-- FINDING (start, design risk — review TERN-3): in the ONE observed run, a non-empty-prompt default-OMP start issued from this poll
-- loop left the mirror tick frozen with no result. Separately, the reviewer saw an ISOLATED palette action hit "command start
-- exceeded 50 ms, disabled until reload". These are DIFFERENT observations, not proven to share a cause; a tick/record freeze
-- cannot by itself distinguish budget-exit, plugin-disable, exception, or sustained blocking — "start blocks the VM" is NOT
-- established. Treat calling start (or any potentially long op) from this status poll as a DESIGN RISK to avoid, not a proven
-- property; moving such ops to an action context / dedicated window is a SUGGESTION, not a validated landing. list() is read-only
-- and is the only path exercised here without a stall — an observation, not a safety proof.
local function drain(cx)
  local names = {}
  pcall(function() names = tern.fs.list(REQ) end)
  for _, name in names do
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local text = ""
      local okRead = pcall(function() text = tern.fs.read(REQ .. "/" .. name) end)
      local okClaim = okRead and pcall(function() tern.fs.remove(REQ .. "/" .. name) end) -- claim = atomic unlink; read-fail => no delete
      if okClaim then -- we hold the claim: exactly this VM owns the request now (loser VMs / read failures fall through and skip)
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
