#!/usr/bin/env lua
-- Fixture for the A2 promptless patrol sentinel. Lua 5.5. Loads the REAL sentinel.luau (same file Tern schedules — no drift), mocks
-- the `tern` and `cx` globals, and drives the returned check(ev, cx, state) directly. Run from the plugin dir: `lua test/sentinel.test.lua`.
-- Covers: content-filter / permission / stall detection, quiet path, stall-resets-on-change, and the dual output (durable alert file +
-- returned Carly string). Has teeth: the stall case needs persistent state + time advance; a reset of either turns it RED.

local here = (arg[0] or ""):match("^(.*/)") or "./"
local load_check = assert(loadfile(here .. "../sentinel.luau"))

local failures = 0
local function check_(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end

-- ---- controllable clock + mock tern (sentinel.luau references the global `tern`) ----
local NOW = 1000000
local writes = {} -- path -> content (captures durable alert writes)
local dirs = {}
tern = {
  now = function() return NOW end,
  getenv = function(k) return k == "HOME" and "/tmp/sentinel-test-home" or nil end,
  fs = {
    exists = function(p) return dirs[p] == true end,
    mkdir = function(p) dirs[p] = true end,
    write = function(p, t) writes[p] = t end,
    read = function(p) return writes[p] end,
  },
  json = { encode = function(_) return "{}" end }, -- content not asserted here; A1/sid-hook cover JSON
}

-- ---- mock cx ----
local function mockCx(panes, reads)
  local session = {}
  function session:panes() return panes end
  function session:read(pane, _) return reads[pane] end
  return { session = session }
end

local function countAlertFiles()
  local n = 0
  for _ in pairs(writes) do n = n + 1 end
  return n
end
local function resetWrites() writes = {} ; tern.fs.write = function(p, t) writes[p] = t end end

-- =========================== scenarios ===========================

-- permission detection + dual path (durable file + returned string)
do
  local check = load_check()
  resetWrites()
  local cx = mockCx(
    { { pane = 1, kind = "terminal", program = "zsh", cwd = "/w", busy = false } },
    { [1] = { kind = "terminal", lines = { "running step 3", "Allow this tool? [y/n]" } } }
  )
  local out = check({}, cx, {})
  check_("permission: returns a Carly string", type(out) == "string" and out:find("permission@pane1", 1, true) ~= nil)
  check_("permission: wrote a durable alert file", countAlertFiles() == 1)
  check_("permission: self-timed (ms in string)", out:find("ms", 1, true) ~= nil)
end

-- content-filter detection
do
  local check = load_check()
  resetWrites()
  local cx = mockCx(
    { { pane = 2, kind = "agent", program = "omp", cwd = "/w", busy = false } },
    { [2] = { kind = "agent", lines = { "I cannot assist with that request", "..." } } }
  )
  local out = check({}, cx, {})
  check_("content_filter: detected + string", type(out) == "string" and out:find("content_filter@pane2", 1, true) ~= nil)
  check_("content_filter: durable file written", countAlertFiles() == 1)
end

-- quiet: benign content => nil, no alert file
do
  local check = load_check()
  resetWrites()
  local cx = mockCx(
    { { pane = 3, kind = "terminal", program = "zsh", cwd = "/w", busy = false } },
    { [3] = { kind = "terminal", lines = { "all good", "tests passed" } } }
  )
  local out = check({}, cx, {})
  check_("quiet: returns nil", out == nil)
  check_("quiet: no alert file", countAlertFiles() == 0)
end

-- stall: busy + unchanged hash across runs with time advance >= stall_ms => stall; needs persistent state
do
  local check = load_check()
  resetWrites()
  local state = {}
  local panes = { { pane = 4, kind = "agent", program = "omp", cwd = "/w", busy = true } }
  local reads = { [4] = { kind = "agent", lines = { "thinking...", "still working" } } }
  local cx = mockCx(panes, reads)
  NOW = 2000000
  local out1 = check({}, cx, state) -- first sight: records since=NOW, no stall yet
  check_("stall: first sight is quiet", out1 == nil)
  NOW = 2000000 + 3 * 60 * 1000 + 1 -- advance past stall_ms, same (unchanged) tail
  local out2 = check({}, cx, state)
  check_("stall: fires after stall_ms unchanged + busy", type(out2) == "string" and out2:find("stall@pane4", 1, true) ~= nil)
end

-- stall resets when content changes (no false stall)
do
  local check = load_check()
  resetWrites()
  local state = {}
  local panes = { { pane = 5, kind = "agent", program = "omp", cwd = "/w", busy = true } }
  local cx = mockCx(panes, { [5] = { kind = "agent", lines = { "line A" } } })
  NOW = 3000000
  check({}, cx, state)
  NOW = 3000000 + 3 * 60 * 1000 + 1
  -- content changed => hash differs => since resets => no stall
  cx = mockCx(panes, { [5] = { kind = "agent", lines = { "line B (progress)" } } })
  local out = check({}, cx, state)
  check_("stall: does NOT fire when content changed", out == nil)
end

-- not-busy never stalls even if unchanged
do
  local check = load_check()
  resetWrites()
  local state = {}
  local panes = { { pane = 6, kind = "agent", program = "omp", cwd = "/w", busy = false } }
  local cx = mockCx(panes, { [6] = { kind = "agent", lines = { "idle at prompt" } } })
  NOW = 4000000
  check({}, cx, state)
  NOW = 4000000 + 3 * 60 * 1000 + 1
  local out = check({}, cx, state)
  check_("stall: not-busy never stalls", out == nil)
end

-- A3: OSC-driven pane.alert flag folds into the stream as osc_alert (benign text => only the alert flag fires)
do
  local check = load_check()
  resetWrites()
  local cx = mockCx(
    { { pane = 7, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = true } },
    { [7] = { kind = "agent", lines = { "some ordinary output" } } }
  )
  local out = check({}, cx, {})
  check_("osc_alert: pane.alert=true folds into the stream", type(out) == "string" and out:find("osc_alert@pane7", 1, true) ~= nil)
  check_("osc_alert: durable file written", countAlertFiles() == 1)
end

-- A3: no osc_alert when pane.alert is false/absent (benign text)
do
  local check = load_check()
  resetWrites()
  local cx = mockCx(
    { { pane = 8, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = false } },
    { [8] = { kind = "agent", lines = { "some ordinary output" } } }
  )
  local out = check({}, cx, {})
  check_("osc_alert: absent when alert=false", out == nil)
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
