--!strict
-- agenthop agents-bridge v1 — A1 (production). A THIN window-half shim: it adds NO detection logic of its own; it mirrors Tern's
-- native cx.agents layer to a file-JSON control plane the bash swarm reads/writes, herdr-style. Authoritative wire contract and the
-- claim/recovery semantics live in PROTOCOL.md. A2 (patrol sentinel) and A3 (OSC alert) extend this same plugin in later commits.
--
-- Claim model (spike r1-r5, PROTOCOL.md §3): execute ONLY after a successful remove-claim; a read failure never deletes the request;
-- this is AT-MOST-ONCE per claim, NOT crash-safe exactly-once (tern.fs exposes no rename/O_EXCL). Recovery is the swarm's job and is
-- op-class-specific: read-only ops may re-issue with a new id; non-idempotent ops HOLD on UNKNOWN (never auto-reissue). Each result
-- echoes its op `class` so the swarm's recovery is self-describing.
--
-- The pure request dispatch (classify + execute + the claim decision) is mirrored by test/claim.test.lua — KEEP THE TWO IN SYNC.

local HOME = tern.getenv("HOME") or ""
local CTL = HOME .. "/.agenthop/tern-panes" -- control-plane dir shared with the bash swarm
local REQ = CTL .. "/requests"
local RES = CTL .. "/results"
local POLL_MS = 750 -- status-mirror cadence. POLL_MS only sets the scheduling interval; it does NOT bound a tick's duration.

-- op classes (PROTOCOL.md §2.1). Drives the swarm's UNKNOWN-recovery; echoed in each result.
local READ_ONLY: { [string]: boolean } = { list = true, transcript = true, wait = true }
local function classOf(op: string): string
  return READ_ONLY[op] and "read-only" or "non-idempotent"
end

local function ensure()
  for _, d in { CTL, REQ, RES } do
    if not tern.fs.exists(d) then
      pcall(function() tern.fs.mkdir(d) end)
    end
  end
end

-- STATUS mirror: snapshot cx.agents:list() to agents.json. Advisory/overwrite; a torn read self-heals next poll (PROTOCOL.md §1).
local ticks = 0
local function mirror(cx)
  ticks += 1
  local ok, agents = pcall(function() return cx.agents:list() end)
  local payload = {
    ts = tern.now(),
    tick = ticks, -- liveness: must advance every POLL_MS
    agents = ok and agents or tern.json.array({}),
    error = (not ok) and tostring(agents) or nil,
  }
  pcall(function() tern.fs.write(CTL .. "/agents.json", tern.json.encode(payload)) end)
end

local function answer(id: string, result)
  pcall(function() tern.fs.write(RES .. "/" .. id .. ".json", tern.json.encode(result)) end)
end

-- Execute one claimed, decoded request synchronously. `wait` is async (see drain) and never reaches here. Pure over cx.agents;
-- mirrored by test/claim.test.lua. Every op is pcall-guarded so a single failing op cannot throw out of the drain loop.
local function execute(cx, req): { [string]: any }
  local op = req.op
  if op == "list" then
    return { ok = true, agents = cx.agents:list() }
  elseif op == "transcript" then
    local o, t = pcall(function() return cx.agents:transcript(req.agent, { last = req.last }) end)
    return { ok = o, transcript = o and t or nil, error = (not o) and tostring(t) or nil }
  elseif op == "ask" then
    local o, e = pcall(function() cx.agents:ask(req.agent, req.text) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  elseif op == "start" then
    -- WARNING (PROTOCOL.md §4): start is synchronous and may be long; calling it from this status poll is a known design risk.
    local o, p = pcall(function()
      return cx.agents:start({ prompt = req.prompt, cwd = req.cwd, command = req.command, how = req.how })
    end)
    return { ok = o, pane = o and p or nil, error = (not o) and tostring(p) or nil }
  elseif op == "interrupt" then
    local o, e = pcall(function() cx.agents:interrupt(req.agent) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  elseif op == "stop" then
    local o, e = pcall(function() cx.agents:stop(req.agent) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  else
    return { ok = false, error = "unknown op: " .. tostring(op) }
  end
end

-- CLAIM + DISPATCH. Execution is gated on a SUCCESSFUL remove (the claim), not on a successful read. read-fail => no delete, retried
-- next tick. ENOENT on remove => another VM claimed it; skip. (PROTOCOL.md §3.) Mirrored by test/claim.test.lua.
local function drain(cx)
  local names = {}
  pcall(function() names = tern.fs.list(REQ) end)
  for _, name in names do
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local text = ""
      local okRead = pcall(function() text = tern.fs.read(REQ .. "/" .. name) end)
      local okClaim = okRead and pcall(function() tern.fs.remove(REQ .. "/" .. name) end)
      if okClaim then -- we hold the claim: exactly this VM owns the request now
        local okDec, req = pcall(function() return tern.json.decode(text) end)
        if okDec and type(req) == "table" and type(req.op) == "string" then
          local class = classOf(req.op)
          if req.op == "wait" then
            -- async: hand to :next so a long idle-wait never stalls the poll (PROTOCOL.md §2.1)
            local okW, aw = pcall(function() return cx.agents:wait(req.agent, { timeout = req.timeout }) end)
            if okW then
              aw:next(function(message, err)
                answer(id, { ok = (err == nil), class = class, message = message, error = err })
              end)
            else
              answer(id, { ok = false, class = class, error = tostring(aw) })
            end
          else
            local result = execute(cx, req)
            result.class = class
            answer(id, result)
          end
        else
          answer(id, { ok = false, error = "bad request json" })
        end
      end
    end
  end
end

-- Poll loop: reschedules via tern.sleep():next() (the documented way a continuation gets a fresh WindowCx). Reschedule is
-- UNCONDITIONAL — a tick with no cx just skips the work. drain is pcall-wrapped so an unexpected throw skips one tick (the request
-- stays for the next) rather than killing the loop. Reload tears down this VM, so no explicit stop flag is needed.
local function step(cx)
  if cx ~= nil then
    ensure()
    mirror(cx)
    pcall(function() drain(cx) end)
  end
  tern.sleep(POLL_MS):next(function(_, _, nextCx) step(nextCx) end)
end

step(nil) -- kick off; the first sleep's :next delivers the window cx
