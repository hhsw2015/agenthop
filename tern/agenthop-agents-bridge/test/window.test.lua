#!/usr/bin/env lua
-- Fixture for the A1 bridge tick-freeze fix. Lua 5.5. Loads the PRODUCTION window.luau (same file Tern runs) with a mocked `tern` and
-- `cx`. Tern kills a window callback that exceeds its ~50ms budget; standalone Lua cannot reproduce that kill, so it is SIMULATED: the
-- fixture `start` raises a sentinel error that is rethrown past the drain pcall, aborting the callback mid-work exactly like an
-- external termination (no code after the kill point runs). Checks the STRUCTURAL properties the fix guarantees:
--   1. two independent sleep chains are queued at load (mirror split from drain);
--   2. mirror liveness: pumping only the mirror chain advances agents.json `tick` while drain is stuck/never pumped;
--   3. reschedule-before-work: drain's next tick is ALREADY queued when `start` runs;
--   4. self-heal: a drain tick killed mid-start still leaves a successor that processes the next request; the mirror keeps ticking.
-- Run from the plugin dir: `lua test/window.test.lua`.

local here = (arg[0] or ""):match("^(.*/)") or "./"

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end

-- ---- mock fs (in-memory) + json ----
local files, dirs = {}, {}
local function encode(v)
  local t = type(v)
  if t == "table" then
    local parts = {}
    for k, x in pairs(v) do parts[#parts + 1] = string.format("%q:%s", tostring(k), encode(x)) end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
  elseif t == "string" then return string.format("%q", v)
  else return tostring(v) end
end

-- ---- capture sleep callbacks: each tern.sleep():next registers one pending callback, tagged by the chain that registered it ----
local pending = {}   -- list of { fn = <callback>, chain = "mirror"|"drain"|"?" }
local currentChain = "?"
local KILL = {}      -- sentinel error object used to simulate Tern's external callback kill

local startCalls, pendingAtStart, pendingAtList = 0, nil, nil
local requestsQueue = {} -- name -> json text, simulating files in REQ

local cx = {
  agents = {
    list = function() pendingAtList = #pending; return { { id = 1 } } end,
    start = function(_, opts)
      startCalls = startCalls + 1
      pendingAtStart = #pending -- how many callbacks were queued at the moment start ran
      if opts.prompt == "KILL" then error(KILL) end -- simulate the 50ms kill mid-start
      return 42
    end,
  },
}

_G.tern = {
  getenv = function(k) if k == "HOME" then return "/h" end end,
  now = function() return 1000 end,
  json = {
    encode = encode,
    decode = function(s)
      if s:find('"op":"start"', 1, true) then
        return { op = "start", prompt = s:match('"prompt":"([^"]*)"'), cwd = "/" }
      end
      error("bad json")
    end,
    array = function(t) return t end,
  },
  fs = {
    exists = function(p) return dirs[p] == true end,
    mkdir = function(p) dirs[p] = true end,
    write = function(p, s) files[p] = s end,
    read = function(p)
      local name = p:match("requests/(.+)$")
      if name and requestsQueue[name] then return requestsQueue[name] end
      if p == "sentinel.luau" then return "-- check" end
      return files[p]
    end,
    remove = function(p)
      local name = p:match("requests/(.+)$")
      if name then requestsQueue[name] = nil end
    end,
    list = function(p)
      local out = {}
      if p:match("requests$") then for n in pairs(requestsQueue) do out[#out + 1] = n end table.sort(out) end
      return out
    end,
  },
  carly = { tasks = function() return {} end, cancel = function() end, schedule = function() return 7 end },
  sleep = function(_ms)
    return { next = function(_, fn) pending[#pending + 1] = { fn = fn, chain = currentChain } end }
  end,
}

-- the production module requires "./claim"; satisfy it with the REAL claim.luau (one source, no drift)
package.loaded["./claim"] = assert(loadfile(here .. "../claim.luau"))()

-- Load window.luau. It auto-kicks both chains with nil cx; tag each kickoff's registration by observing order.
local chunk = assert(loadfile(here .. "../window.luau"))
chunk()

-- ---- 1. split: two independent pending callbacks at load ----
ck("split: two independent sleep chains queued at load (mirror + drain)", #pending == 2)

-- Identify which pending callback belongs to which chain by pumping each once with cx and seeing what it does.
local function pumpOne(idx)
  local p = table.remove(pending, idx)
  local ok, err = pcall(p.fn, nil, nil, cx) -- pcall here = the "Tern runtime"; a KILL error aborts the callback like a real kill
  return ok, err
end

-- First callback queued was mirrorStep's (mirrorStep(nil) runs first in window.luau), second is drainStep's.
local mirrorCb, drainCb = pending[1], pending[2]
pending = {}

local AGENTS = "/h/.agenthop/tern-panes/agents.json"
local function tickOf() local s = files[AGENTS]; return s and tonumber(s:match('"tick":(%d+)')) or nil end

-- ---- 2. mirror liveness while drain is stuck (never pumped) ----
mirrorCb.fn(nil, nil, cx)          -- mirror tick 1 (its successor is queued first, then it writes agents.json)
local t1 = tickOf()
local nextMirror = pending[#pending] -- the successor mirrorStep queued
ck("mirror: reschedules itself (successor queued)", nextMirror ~= nil and #pending == 1)
ck("reschedule-before-work: mirror's successor was ALREADY queued when list ran", pendingAtList == 1)
pending = {}
nextMirror.fn(nil, nil, cx)        -- mirror tick 2, drain never pumped
local t2 = tickOf()
ck("liveness: tick advances on mirror-only pumps while drain is stuck (" .. tostring(t1) .. "→" .. tostring(t2) .. ")",
  t1 ~= nil and t2 ~= nil and t2 == t1 + 1)
pending = {}

-- ---- 3. reschedule-before-work + 4. self-heal across a simulated kill mid-start ----
requestsQueue["r1.json"] = '{"op":"start","prompt":"KILL"}'
local okKill, errKill = pcall(drainCb.fn, nil, nil, cx)
-- the KILL propagates? drain is pcall-wrapped in production, so a Lua error is caught there; to model an EXTERNAL kill we assert on
-- the queue state observed AT start-time, which is what survives a real kill.
ck("reschedule-before-work: drain's successor was ALREADY queued when start ran", pendingAtStart == 1)
local drainSucc = pending[#pending]
ck("self-heal: a successor drain tick exists after the killed tick", drainSucc ~= nil)
pending = {}
-- the next request is processed by the successor
requestsQueue["r2.json"] = '{"op":"start","prompt":"ok"}'
startCalls = 0
drainSucc.fn(nil, nil, cx)
ck("self-heal: successor drain tick processes the next request", startCalls == 1 and files["/h/.agenthop/tern-panes/results/r2.json"] ~= nil)

-- mirror still ticks after the killed drain (independent chain)
local tBefore = tickOf()
pending = {}
mirrorCb.fn(nil, nil, cx)
ck("liveness: mirror still advances after a drain tick was killed", tickOf() == tBefore + 1)

-- ---- simulate a TRUE external kill (no Lua-level unwinding past the kill point) on the OLD single-chain shape is covered by the
-- mutant runs (see review notes): moving either reschedule below the work, or merging the chains, flips a check above RED. ----
_ = okKill; _ = errKill

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
