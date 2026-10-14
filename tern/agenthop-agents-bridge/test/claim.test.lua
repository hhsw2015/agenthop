#!/usr/bin/env lua
-- Fixture for the A1 claim model. Lua 5.5. Loads the PRODUCTION claim module (../claim.luau) — the SAME file window.luau does
-- `require("./claim")` on — so there is no mirror copy: a single-line change to the claim gate in claim.luau turns these checks RED AND
-- changes production together (review TA-A1-GATE / EL-3-GATE). Run from the plugin dir: `lua test/claim.test.lua`.
--
-- Covers: the claim gate (read-fail / empty-partial / remove-EACCES / interleaved race / normal), op classification, sync dispatch, and
-- the exactly-once boundary (claim then crash before result => a blind non-idempotent reissue double-executes). fs/cx are injected mocks
-- with fault injection and side-effect counters.

local here = (arg[0] or ""):match("^(.*/)") or "./"
local M = assert(loadfile(here .. "../claim.luau"))() -- the production module

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end

-- mock fs: files[path]=text; faults[path]={read=?,remove=?}; counts read/remove calls
local function newFs()
  local fs = { files = {}, faults = {}, readCalls = {}, removeCalls = {} }
  fs.read = function(path)
    fs.readCalls[path] = (fs.readCalls[path] or 0) + 1
    local f = fs.faults[path]
    if f and f.read then error("EIO") end
    return fs.files[path]
  end
  fs.remove = function(path)
    fs.removeCalls[path] = (fs.removeCalls[path] or 0) + 1
    local f = fs.faults[path]
    if f and f.remove then error("EACCES") end
    if fs.files[path] == nil then error("ENOENT") end
    fs.files[path] = nil
  end
  return fs
end

-- mock cx: counts side effects
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

-- ===== op classes =====
ck("class: list is read-only", M.classOf("list") == "read-only")
ck("class: transcript is read-only", M.classOf("transcript") == "read-only")
ck("class: wait is read-only", M.classOf("wait") == "read-only")
ck("class: ask is non-idempotent", M.classOf("ask") == "non-idempotent")
ck("class: start is non-idempotent", M.classOf("start") == "non-idempotent")

-- ===== claim gate =====
do -- normal
  local fs = newFs(); fs.files["/r.json"] = '{"op":"ask"}'
  local claimed, text = M.claim(fs.read, fs.remove, "/r.json")
  ck("gate: normal -> claimed + text", claimed == true and text == '{"op":"ask"}')
  ck("gate: normal -> removed once, file gone", fs.removeCalls["/r.json"] == 1 and fs.files["/r.json"] == nil)
end
do -- read failure (crash-recovery): no remove, file retained
  local fs = newFs(); fs.files["/r.json"] = '{"op":"ask"}'; fs.faults["/r.json"] = { read = true }
  local claimed = M.claim(fs.read, fs.remove, "/r.json")
  ck("gate: read-fail -> not claimed", claimed == false)
  ck("gate: read-fail -> remove NEVER called", fs.removeCalls["/r.json"] == nil)
  ck("gate: read-fail -> file retained for retry", fs.files["/r.json"] ~= nil)
end
do -- empty/partial write (TA-A1-PUBLISH): a half-written request is NOT claimed/destroyed; retried, then claimed when complete
  local fs = newFs(); fs.files["/p.json"] = ""
  local claimed = M.claim(fs.read, fs.remove, "/p.json")
  ck("gate: empty(partial) -> not claimed", claimed == false)
  ck("gate: empty(partial) -> remove NEVER called (not destroyed)", fs.removeCalls["/p.json"] == nil)
  ck("gate: empty(partial) -> file retained", fs.files["/p.json"] ~= nil)
  fs.files["/p.json"] = '{"op":"list"}'
  local c2, t2 = M.claim(fs.read, fs.remove, "/p.json")
  ck("gate: once complete -> claimed", c2 == true and t2 == '{"op":"list"}')
end
do -- remove EACCES: not claimed, file retained (safe direction: no double-run)
  local fs = newFs(); fs.files["/e.json"] = '{"op":"start"}'; fs.faults["/e.json"] = { remove = true }
  local claimed = M.claim(fs.read, fs.remove, "/e.json")
  ck("gate: remove-EACCES -> not claimed", claimed == false)
  ck("gate: remove-EACCES -> file retained", fs.files["/e.json"] ~= nil)
end
do -- interleaved race: both VMs read the same text, the loser's remove hits ENOENT => exactly one claims
  local removed = false
  local rd = function(_) return '{"op":"ask"}' end
  local rm = function(_) if removed then error("ENOENT") end ; removed = true end
  local a = (M.claim(rd, rm, "/x"))
  local b = (M.claim(rd, rm, "/x"))
  ck("gate: interleaved race -> exactly one wins", a == true and b == false)
end

-- ===== dispatch =====
do
  local cx, calls = newCx()
  ck("execute: list -> ok, called once", M.execute(cx, { op = "list" }).ok == true and calls.list == 1)
  ck("execute: ask -> ok, called once", M.execute(cx, { op = "ask", agent = 1, text = "hi" }).ok == true and calls.ask == 1)
  ck("execute: start -> ok + pane", (function() local r = M.execute(cx, { op = "start", prompt = "p", cwd = "/" }) ; return r.ok == true and r.pane == 42 end)())
  ck("execute: unknown op -> error", M.execute(cx, { op = "frobnicate" }).ok == false)
end

-- ===== exactly-once boundary: claim + execute then crash before result => blind reissue double-executes =====
do
  local cx, calls = newCx()
  local fs = newFs(); fs.files["/x1.json"] = '{"op":"ask"}'
  if (M.claim(fs.read, fs.remove, "/x1.json")) then M.execute(cx, { op = "ask" }) end -- "crash" before answer
  ck("boundary: op ran once (side effect)", calls.ask == 1)
  ck("boundary: request claimed/gone", fs.files["/x1.json"] == nil)
  fs.files["/x2.json"] = '{"op":"ask"}'
  if (M.claim(fs.read, fs.remove, "/x2.json")) then M.execute(cx, { op = "ask" }) end -- blind reissue (the WRONG recovery)
  ck("boundary: blind reissue double-executes (=> HOLD rule for non-idempotent)", calls.ask == 2)
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
