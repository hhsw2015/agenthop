#!/usr/bin/env lua
-- Fixture for the A2 patrol sentinel (r2). Lua 5.5. Loads the REAL sentinel.luau (same file Tern schedules — no drift), mocks `tern`
-- and `cx`, drives check(ev, cx, state) directly. Run from the plugin dir: `lua test/sentinel.test.lua`.
-- Covers r1: content-filter / permission / stall / osc_alert / read-failure / stall-reset. Covers r2: ① liveness beat + coordinator_stale
-- mutual-watch, ② batch coverage (every pane body-scanned over rounds). (④ CPA probe is bash — see cpa-probe.test.sh.)

local here = (arg[0] or ""):match("^(.*/)") or "./"
local load_check = assert(loadfile(here .. "../sentinel.luau"))

local failures = 0
local function check_(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end

local HOME = "/tmp/sentinel-test-home"
local L0 = HOME .. "/.agenthop/carly"
local MY_BEAT = L0 .. "/carly-patrol.beat"
local COORD_BEAT = HOME .. "/.agenthop/swarm/coordinator.beat" -- pinned contract path (NOT the L0 root)
local NOW = 1000000 -- tern.now() monotonic ms (stall timing)
local NOW_SEC = 1700000000 -- os.time() wall-clock epoch seconds (beats); controllable for deterministic ① tests
os.time = function() return NOW_SEC end -- override the global the sentinel calls for wall-clock
local writes, dirs = {}, {}
local function resetWrites() writes, dirs = {}, {} end
tern = {
  now = function() return NOW end,
  getenv = function(k) return k == "HOME" and HOME or nil end,
  fs = {
    exists = function(p) return dirs[p] == true or writes[p] ~= nil end,
    mkdir = function(p) dirs[p] = true end,
    write = function(p, t) writes[p] = t end,
    read = function(p) return writes[p] end,
  },
  -- minimal json that round-trips the `ts` field (enough for beats; alert bodies are not structurally asserted here)
  json = {
    encode = function(v) return '{"ts":' .. tostring((type(v) == "table" and v.ts) or "null") .. '}' end,
    decode = function(s)
      local n = type(s) == "string" and s:match('"ts":(%-?%d+)') or nil
      if n then return { ts = tonumber(n) } end
      return nil
    end,
  },
}

local function mockCx(panes, reads)
  local session = {}
  function session:panes() return panes end
  function session:read(pane, _) return reads and reads[pane] end
  return { session = session }
end
local function mockCxReadThrows(panes)
  local session = {}
  function session:panes() return panes end
  function session:read(_, _) error("read failed") end
  return { session = session }
end
local function countAlertFiles()
  local n = 0
  for p in pairs(writes) do if p:find("/alerts/", 1, true) then n = n + 1 end end
  return n
end
local function panesFromString(out) -- collect pane ids named in a returned "kind@paneN" string
  local set = {}
  if type(out) == "string" then for id in out:gmatch("@pane(%d+)") do set[tonumber(id)] = true end end
  return set
end

-- ===== r1: permission / content_filter / quiet =====
do
  local c = load_check()
  resetWrites()
  local cx = mockCx({ { pane = 1, kind = "terminal", program = "zsh", cwd = "/w", busy = false, alert = false } },
    { [1] = { kind = "terminal", lines = { "running", "Allow this tool? [y/n]" } } })
  local out = c({}, cx, {})
  check_("permission: returns string", type(out) == "string" and out:find("permission@pane1", 1, true) ~= nil)
  check_("permission: one alert file", countAlertFiles() == 1)
end
do
  local c = load_check()
  resetWrites()
  local cx = mockCx({ { pane = 2, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = false } },
    { [2] = { kind = "agent", lines = { "I cannot assist with that request" } } })
  local out = c({}, cx, {})
  check_("content_filter: detected", type(out) == "string" and out:find("content_filter@pane2", 1, true) ~= nil)
end
do
  local c = load_check()
  resetWrites()
  local cx = mockCx({ { pane = 3, kind = "terminal", program = "zsh", cwd = "/w", busy = false, alert = false } },
    { [3] = { kind = "terminal", lines = { "all good" } } })
  local out = c({}, cx, {})
  check_("quiet: nil + no alert files", out == nil and countAlertFiles() == 0)
end

-- ===== r1: osc_alert (now metadata-sweep, fires regardless of read) =====
do
  local c = load_check()
  resetWrites()
  local cx = mockCx({ { pane = 4, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = true } },
    { [4] = { kind = "agent", lines = { "ordinary" } } })
  local out = c({}, cx, {})
  check_("osc_alert: alert=true fires", type(out) == "string" and out:find("osc_alert@pane4", 1, true) ~= nil)
end
do -- TA-A2-READ: osc_alert survives unreadable body (metadata sweep does not read)
  local c = load_check()
  resetWrites()
  local cx = mockCxReadThrows({ { pane = 5, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = true } })
  local out = c({}, cx, {})
  check_("TA-A2-READ: osc_alert fires with unreadable body", type(out) == "string" and out:find("osc_alert@pane5", 1, true) ~= nil)
end

-- ===== r1: stall + TA-A2-STALL =====
do
  local c = load_check()
  resetWrites()
  local st = {}
  local busy = { { pane = 6, kind = "agent", program = "omp", cwd = "/w", busy = true } }
  local reads = { [6] = { kind = "agent", lines = { "thinking" } } }
  NOW = 2000000
  check_("stall: first sight quiet", c({}, mockCx(busy, reads), st) == nil)
  NOW = 2000000 + 3 * 60 * 1000 + 1
  check_("stall: fires after 3min continuous busy", (c({}, mockCx(busy, reads), st) or ""):find("stall@pane6", 1, true) ~= nil)
end
do -- idle during read-error still resets (TA-A2-STALL combination)
  local c = load_check()
  resetWrites()
  local st = {}
  local busy = { { pane = 7, kind = "agent", program = "omp", cwd = "/w", busy = true } }
  local idle = { { pane = 7, kind = "agent", program = "omp", cwd = "/w", busy = false } }
  local reads = { [7] = { kind = "agent", lines = { "same" } } }
  NOW = 3000000
  c({}, mockCx(busy, reads), st)
  NOW = NOW + 120 * 1000
  c({}, mockCxReadThrows(idle), st) -- idle + unreadable => metadata reset
  NOW = NOW + 120 * 1000
  check_("TA-A2-STALL: idle-during-read-error resets (no false stall)", c({}, mockCx(busy, reads), st) == nil)
end

-- ===== r2 ①: liveness beat + coordinator_stale mutual-watch (BARE epoch seconds, host wall-clock os.time) =====
do -- my beat is bare epoch seconds (one line), readable by the swarm's plain reader — NOT JSON, NOT monotonic
  local c = load_check()
  resetWrites()
  NOW_SEC = 1700000000
  c({}, mockCx({}, {}), {})
  check_("beat: carly-patrol.beat = bare epoch seconds", writes[MY_BEAT] ~= nil and (writes[MY_BEAT]:gsub("%s+", "")) == tostring(NOW_SEC))
end
do -- a real coordinator.beat sample (bare epoch), 25 min old => stale (wall-clock seconds)
  local c = load_check()
  resetWrites()
  NOW_SEC = 1700000000
  writes[COORD_BEAT] = tostring(NOW_SEC - 25 * 60) .. "\n"
  local out = c({}, mockCx({}, {}), {})
  check_("coordinator_stale: stale bare-epoch beat => alert", type(out) == "string" and out:find("coordinator_stale", 1, true) ~= nil)
end
do -- fresh (1 min old) => no alert
  local c = load_check()
  resetWrites()
  NOW_SEC = 1700000000
  writes[COORD_BEAT] = tostring(NOW_SEC - 60)
  local out = c({}, mockCx({}, {}), {})
  check_("coordinator_stale: fresh beat => no alert", out == nil)
end
do -- PATH GATE: the reader watches ~/.agenthop/swarm/coordinator.beat (the coordinator's pinned write path), NOT the L0 carly root.
  -- A STALE beat at the OLD carly path + a FRESH beat at the swarm path => no alert (reads swarm). Then STALE at swarm => alert.
  local OLD = L0 .. "/coordinator.beat"
  local c = load_check()
  resetWrites()
  NOW_SEC = 1700000000
  writes[OLD] = tostring(NOW_SEC - 25 * 60) .. "\n"   -- stale, wrong place
  writes[COORD_BEAT] = tostring(NOW_SEC - 60) .. "\n" -- fresh, contract place
  check_("coordinator_stale PATH: fresh at swarm + stale at old carly path => no alert (reads swarm)", c({}, mockCx({}, {}), {}) == nil)
  c = load_check()
  resetWrites()
  writes[OLD] = tostring(NOW_SEC - 60) .. "\n"            -- fresh, wrong place
  writes[COORD_BEAT] = tostring(NOW_SEC - 25 * 60) .. "\n" -- stale, contract place
  local out = c({}, mockCx({}, {}), {})
  check_("coordinator_stale PATH: stale at swarm + fresh at old carly path => alert (reads swarm)", type(out) == "string" and out:find("coordinator_stale", 1, true) ~= nil)
end
do -- bad carriers (empty / non-numeric / legacy JSON) => no crash, no false alert
  for _, bad in ipairs({ "", "garbage", '{"ts":1700000000}' }) do
    local c = load_check()
    resetWrites()
    NOW_SEC = 1700000000
    writes[COORD_BEAT] = bad
    local okCall, out = pcall(c, {}, mockCx({}, {}), {})
    local label = (bad == "" and "empty") or (bad:sub(1, 1) == "{" and "legacyJSON") or "nonnumeric"
    check_("coordinator_stale: bad carrier (" .. label .. ") => no-crash no-alert", okCall and out == nil)
  end
end

-- ===== r2 ②: batch coverage — every pane body-scanned over ceil(N/batch) rounds =====
do
  local c = load_check()
  resetWrites()
  local st = {}
  local panes, reads = {}, {}
  for i = 1, 6 do -- 6 panes, batch_size 4 => 2 rounds to cover all; alert=false so only body-scan (permission) names a pane
    panes[i] = { pane = i, kind = "agent", program = "omp", cwd = "/w", busy = false, alert = false }
    reads[i] = { kind = "agent", lines = { "Allow this tool? [y/n]" } }
  end
  NOW = 8000000
  local o1 = c({}, mockCx(panes, reads), st) -- round 1
  local o2 = c({}, mockCx(panes, reads), st) -- round 2 (offset advanced)
  local round1 = panesFromString(o1)
  local n1 = 0; for _ in pairs(round1) do n1 = n1 + 1 end
  local covered = {}
  for id in pairs(round1) do covered[id] = true end
  for id in pairs(panesFromString(o2)) do covered[id] = true end
  local nAll = 0; for _ in pairs(covered) do nAll = nAll + 1 end
  check_("batch: one round body-scans <= batch_size (4) panes", n1 >= 1 and n1 <= 4)
  check_("batch: all 6 panes covered over 2 rounds (offset advances)", nAll == 6)
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
