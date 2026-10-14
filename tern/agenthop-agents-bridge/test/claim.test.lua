#!/usr/bin/env lua
-- Fixture for the agents-bridge claim model (A1). Lua 5.5 (Tern runs Luau; this is the review-blessed "downgraded mirror" harness).
--
-- It MIRRORS window.luau's drain claim decision — claim-by-remove, read-fail-never-delete, op-class classification — and exercises
-- the three fixture classes the spike review demanded: crash-recovery, concurrency-race, idempotency/robustness. KEEP IN SYNC with
-- window.luau: if the drain gating changes there, change `drainOnce` here. Run: `lua test/claim.test.lua` (exit 0 = pass).
--
-- Side effects are modeled with a mock fs (per-request fault injection: read EIO / remove EACCES) and a mock cx whose cx.agents
-- methods count invocations, so "executed once / not executed / executed twice" is directly assertable.

local failures = 0
local function check(name, cond)
  if cond then
    print("ok   - " .. name)
  else
    print("FAIL - " .. name)
    failures = failures + 1
  end
end

-- ---- op classes: must match window.luau READ_ONLY/classOf ----
local READ_ONLY = { list = true, transcript = true, wait = true }
local function classOf(op) return READ_ONLY[op] and "read-only" or "non-idempotent" end

-- ---- mock fs: requests keyed by name; results keyed by id; faults[name] = {read=?, remove=?} ----
local function newFs()
  local fs = { req = {}, res = {}, faults = {} }
  function fs.put(name, reqTable) fs.req[name] = reqTable end
  function fs.list()
    local t = {}
    for k in pairs(fs.req) do t[#t + 1] = k end
    table.sort(t)
    return t
  end
  function fs.read(name)
    local f = fs.faults[name]
    if f and f.read then error("EIO") end
    return fs.req[name] -- returns the (pre-parsed) request table; a plain string models malformed JSON
  end
  function fs.remove(name)
    local f = fs.faults[name]
    if f and f.remove then error("EACCES") end
    if fs.req[name] == nil then error("ENOENT") end
    fs.req[name] = nil
  end
  function fs.writeResult(id, tbl) fs.res[id] = tbl end
  return fs
end

-- ---- mock cx: counts side effects ----
local function newCx()
  local calls = { list = 0, ask = 0, start = 0, interrupt = 0, stop = 0, transcript = 0 }
  local agents = {}
  function agents:list() calls.list = calls.list + 1 ; return {} end
  function agents:ask(_, _) calls.ask = calls.ask + 1 end
  function agents:start(_) calls.start = calls.start + 1 ; return 42 end
  function agents:interrupt(_) calls.interrupt = calls.interrupt + 1 end
  function agents:stop(_) calls.stop = calls.stop + 1 end
  function agents:transcript(_, _) calls.transcript = calls.transcript + 1 ; return {} end
  return { agents = agents }, calls
end

-- decode mirror: a table is a valid request; a string models malformed JSON (decode throws)
local function decode(x)
  if type(x) == "table" then return x end
  error("bad json")
end

-- execute mirror (window.luau execute(); wait is handled inline in drainOnce)
local function execute(cx, req)
  local op = req.op
  if op == "list" then return { ok = true, agents = cx.agents:list() }
  elseif op == "transcript" then return { ok = true, transcript = cx.agents:transcript(req.agent, {}) }
  elseif op == "ask" then cx.agents:ask(req.agent, req.text) ; return { ok = true }
  elseif op == "start" then return { ok = true, pane = cx.agents:start({}) }
  elseif op == "interrupt" then cx.agents:interrupt(req.agent) ; return { ok = true }
  elseif op == "stop" then cx.agents:stop(req.agent) ; return { ok = true }
  else return { ok = false, error = "unknown op: " .. tostring(op) } end
end

-- drainOnce mirror of window.luau drain inner body. `crashAfterClaim` models a crash between claim and result write (exactly-once
-- boundary): the op still runs (side effect), but no result is written.
local function drainOnce(fs, cx, crashAfterClaim)
  for _, name in ipairs(fs.list()) do
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local okRead, text = pcall(fs.read, name)
      local okClaim = okRead and pcall(fs.remove, name)
      if okClaim then
        local okDec, req = pcall(decode, text)
        if okDec and type(req) == "table" and type(req.op) == "string" then
          local class = classOf(req.op)
          local result = execute(cx, req)
          result.class = class
          if not crashAfterClaim then fs.writeResult(id, result) end
        else
          fs.writeResult(id, { ok = false, error = "bad request json" })
        end
      end
    end
  end
end

-- =========================== scenarios ===========================

-- op-class classification
check("class: list is read-only", classOf("list") == "read-only")
check("class: transcript is read-only", classOf("transcript") == "read-only")
check("class: wait is read-only", classOf("wait") == "read-only")
check("class: ask is non-idempotent", classOf("ask") == "non-idempotent")
check("class: start is non-idempotent", classOf("start") == "non-idempotent")

-- happy path: a read-only op executes once, result written, request drained
do
  local fs, cx = newFs(), nil
  local calls
  cx, calls = newCx()
  fs.put("h.json", { op = "list" })
  drainOnce(fs, cx)
  check("happy: list executed once", calls.list == 1)
  check("happy: request drained", fs.req["h.json"] == nil)
  check("happy: result written ok+class", fs.res["h"] ~= nil and fs.res["h"].ok == true and fs.res["h"].class == "read-only")
end

-- CRASH-RECOVERY: read failure => request NOT deleted, NOT executed; retried next tick (then succeeds)
do
  local fs = newFs()
  local cx, calls = newCx()
  fs.put("r.json", { op = "ask", agent = 5, text = "hi" })
  fs.faults["r.json"] = { read = true }
  drainOnce(fs, cx)
  check("crash: read-fail does NOT execute", calls.ask == 0)
  check("crash: read-fail does NOT delete the request", fs.req["r.json"] ~= nil)
  check("crash: read-fail writes no result", fs.res["r"] == nil)
  fs.faults["r.json"] = nil -- next tick, fault cleared
  drainOnce(fs, cx)
  check("crash: recovered on next tick (executed once)", calls.ask == 1 and fs.req["r.json"] == nil)
end

-- CONCURRENCY-RACE: two VMs both read the same request, then both try to remove. Exactly one claims+executes; the other gets ENOENT
-- and skips. (Models window.luau's single-winner remove-claim across window VMs.)
do
  local fs = newFs()
  local cxA, callsA = newCx()
  local cxB, callsB = newCx()
  fs.put("c.json", { op = "ask", agent = 5, text = "hi" })
  -- interleave: A reads, B reads (both see it), A removes+executes, B remove fails ENOENT => skip
  local okReadA, textA = pcall(fs.read, "c.json")
  local okReadB, textB = pcall(fs.read, "c.json")
  local okClaimA = okReadA and pcall(fs.remove, "c.json")
  local okClaimB = okReadB and pcall(fs.remove, "c.json")
  if okClaimA then local r = execute(cxA, decode(textA)) ; fs.writeResult("c", r) end
  if okClaimB then local r = execute(cxB, decode(textB)) ; fs.writeResult("c", r) end
  check("concurrency: exactly one VM claimed", (okClaimA and not okClaimB) or (okClaimB and not okClaimA))
  check("concurrency: executed exactly once across VMs", (callsA.ask + callsB.ask) == 1)
  check("concurrency: request gone after the single claim", fs.req["c.json"] == nil)
end

-- IDEMPOTENCY/ROBUSTNESS: remove EACCES => NOT executed (safe direction: no double-run), request left stuck-but-unexecuted
do
  local fs = newFs()
  local cx, calls = newCx()
  fs.put("e.json", { op = "start", prompt = "p", cwd = "/tmp" })
  fs.faults["e.json"] = { remove = true }
  drainOnce(fs, cx)
  check("robust: remove-EACCES does NOT execute (no double-run)", calls.start == 0)
  check("robust: remove-EACCES leaves the request in place", fs.req["e.json"] ~= nil)
end

-- EXACTLY-ONCE BOUNDARY: claim succeeds, op runs (side effect), then crash before the result write => UNKNOWN. A blind new-id reissue
-- of a NON-IDEMPOTENT op double-executes. This is why PROTOCOL.md §3.3 forbids auto-reissue for non-idempotent ops.
do
  local fs = newFs()
  local cx, calls = newCx()
  fs.put("x1.json", { op = "ask", agent = 5, text = "hi" })
  drainOnce(fs, cx, true) -- crash after claim, before result
  check("boundary: op ran once (side effect happened)", calls.ask == 1)
  check("boundary: request claimed (gone)", fs.req["x1.json"] == nil)
  check("boundary: no result => UNKNOWN to the caller", fs.res["x1"] == nil)
  -- blind reissue with a new id (the WRONG recovery for a non-idempotent op) => double side effect
  fs.put("x2.json", { op = "ask", agent = 5, text = "hi" })
  drainOnce(fs, cx)
  check("boundary: blind reissue of non-idempotent op double-executes (hence HOLD rule)", calls.ask == 2)
end

-- bad json: claimed, but decode fails => error result, request still drained
do
  local fs = newFs()
  local cx, calls = newCx()
  fs.put("b.json", "NOT_A_TABLE") -- string models malformed JSON
  drainOnce(fs, cx)
  check("badjson: no op executed", calls.ask == 0 and calls.list == 0)
  check("badjson: error result written", fs.res["b"] ~= nil and fs.res["b"].ok == false)
  check("badjson: request drained", fs.req["b.json"] == nil)
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
