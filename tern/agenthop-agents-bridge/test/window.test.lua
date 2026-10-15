#!/usr/bin/env lua
-- Fixture for the A1 bridge r2 (command-triggered drains). Lua 5.5. Loads the PRODUCTION window.luau (same file Tern runs) with a
-- mocked `tern` and `cx`, plus the PRODUCTION claim.luau.
--
-- WHAT THIS PROVES (and what it does not): Tern disables work per HOOK — every tern.sleep():next continuation is one hook (`await`),
-- each tern.command is its own hook (`command <id>`); a hook over the ~50ms budget is disabled until `tern plugin reload`. That host
-- behaviour cannot run in standalone Lua, so the fixture MODELS it: the mock records which hook each callback belongs to, and a
-- "disabled" hook simply stops being invoked. The checks are STRUCTURAL evidence that slow `start` runs only on its own hook and that
-- the mirror tick and fast ops sit on different hooks — NOT a reproduction of Tern's budget kill. The live gate is bridge-smoke.sh.
-- Run from the plugin dir: `lua test/window.test.lua`.

local here = (arg[0] or ""):match("^(.*/)") or "./"

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end

-- ---- mock json (only what the bridge needs: encode for files, decode for requests) ----
local function encode(v)
  local t = type(v)
  if t == "table" then
    local parts = {}
    if #v > 0 then -- a sequence encodes as a JSON array (as tern.json does), so a status written then re-read round-trips
      for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, x in pairs(v) do parts[#parts + 1] = string.format("%q:%s", tostring(k), encode(x)) end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
  elseif t == "string" then return string.format("%q", v)
  else return tostring(v) end
end
-- A REAL minimal JSON decoder (objects, arrays, strings with \uXXXX/escapes, numbers, true/false/null) so the fixture can prove
-- classification uses the DECODED top-level op (BTF-SV-P2-1): escaped keys/values and nested "op" fields must decode faithfully.
local function decode(s)
  local i = 1
  local function ws() i = s:find("[^ \t\r\n]", i) or (#s + 1) end
  local val
  local function str()
    i = i + 1
    local out = {}
    while true do
      local c = s:sub(i, i)
      if c == "" then error("bad json") end
      if c == '"' then i = i + 1; return table.concat(out) end
      if c == "\\" then
        local e = s:sub(i + 1, i + 1)
        if e == "u" then out[#out + 1] = utf8.char(tonumber(s:sub(i + 2, i + 5), 16)); i = i + 6
        else out[#out + 1] = ({ n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" })[e] or e; i = i + 2 end
      else out[#out + 1] = c; i = i + 1 end
    end
  end
  function val()
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      i = i + 1; local o = {}; ws()
      if s:sub(i, i) == "}" then i = i + 1; return o end
      while true do
        ws(); local k = str(); ws()
        if s:sub(i, i) ~= ":" then error("bad json") end
        i = i + 1; o[k] = val(); ws()
        local d = s:sub(i, i); i = i + 1
        if d == "}" then return o elseif d ~= "," then error("bad json") end
      end
    elseif c == "[" then
      i = i + 1; local a = {}; ws()
      if s:sub(i, i) == "]" then i = i + 1; return a end
      while true do
        a[#a + 1] = val(); ws()
        local d = s:sub(i, i); i = i + 1
        if d == "]" then return a elseif d ~= "," then error("bad json") end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4; return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5; return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4; return nil
    else
      local n = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not n or n == "" then error("bad json") end
      i = i + #n; return tonumber(n)
    end
  end
  local v = val(); ws()
  if i <= #s then error("bad json") end
  return v
end

-- ---- hook registry: sleep continuations share hook "await"; each command is hook "command <id>" ----
local sleepPending = {}  -- await-hook continuations
local commands = {}      -- id -> run fn
local files, dirs, requests = {}, {}, {}
local opCalls = { list = 0, start = 0, stop = 0 }
local carlyCalls = 0 -- every tern.carly.* call (tasks/cancel/schedule)
carlyTasks, carlySchedules, carlyCancels, kvStore = 0, 0, {}, {}
clock = 1000      -- global so the tern.now mock can advance it
local timers = {}     -- tern.timer callbacks (the TIMER hook)

local cx = {
  session = {
    panes = function()
      opCalls.panes = (opCalls.panes or 0) + 1
      return {
        { pane = 1, kind = "agent", title = "t", cwd = "/c", tab = 3, program = "tern", busy = false, at_prompt = true, alert = false,
          parked = false, focused = true, running = { line = string.rep("z", 200), ms = 5 } },
        { pane = 9, kind = "terminal", title = "shell", cwd = "/c", tab = 3, program = "/bin/zsh", busy = false },
      }
    end,
  },
  agents = {
    list = function() opCalls.list = opCalls.list + 1; return {
      { pane = 1, session = 2, model = "m", state = "idle", busy = false, at_prompt = true, alive = true, cwd = "/c", tab = 3, title = "t",
        command = string.rep("x", 200), agent_command = string.rep("y", 200), focused = true, program = "tern" } } end,
    start = function() opCalls.start = opCalls.start + 1; return 42 end,
    stop = function() opCalls.stop = opCalls.stop + 1 end,
  },
}

_G.tern = {
  getenv = function(k)
    if k == "HOME" then return "/h" elseif k == "TERN_WINDOW_KEY" then return "win-A"
    elseif k == "AGENTHOP_BRIDGE_DEBUG_PHASE" then return DEBUG_PHASE end
  end,
  now = function() clock = clock + 7; return clock end, -- monotonic ms; each call advances 7ms so tick_ms is measurable
  json = { encode = encode, decode = decode, array = function(t) return t end },
  fs = {
    exists = function(p) return dirs[p] == true end,
    mkdir = function(p) dirs[p] = true end,
    write = function(p, s) files[p] = s end,
    read = function(p)
      local name = p:match("requests/(.+)$")
      if name then return requests[name] end
      if p == "sentinel.luau" then return "-- check" end
      return files[p]
    end,
    remove = function(p) local name = p:match("requests/(.+)$"); if name then requests[name] = nil end end,
    list = function(p)
      local out = {}
      if p:match("requests$") then for n in pairs(requests) do out[#out + 1] = n end table.sort(out) end
      return out
    end,
  },
  carly = { tasks = function() carlyCalls = carlyCalls + 1; carlyTasks = carlyTasks + 1
              return { { id = 31, title = "agenthop tern patrol" }, { id = 32, title = "agenthop tern patrol" }, { id = 99, title = "other" } } end,
            cancel = function(id) carlyCalls = carlyCalls + 1; carlyCancels[#carlyCancels + 1] = id end,
            schedule = function() carlyCalls = carlyCalls + 1; carlySchedules = carlySchedules + 1; return 7 end },
  kv = { get = function(k) return kvStore[k] end, set = function(k, v) kvStore[k] = v end },
  timer = function(_ms, fn) timers[#timers + 1] = fn; return { cancel = function() end } end,
  sleep = function(_ms) return { next = function(_, fn) sleepPending[#sleepPending + 1] = fn end } end,
  command = function(def) commands[def.id] = def.run end,
}

package.loaded["./claim"] = assert(loadfile(here .. "../claim.luau"))()
-- r10 GATE: load window.luau in an env whose globals are READ-ONLY, like Tern's plugin VM. Any global write (e.g. `_G.x = …` or an
-- undeclared assignment) raises here exactly as it does live — "passes locally, dies in Tern" (r9 @613e691, 10:56 syntax) turns RED.
local SANDBOX = setmetatable({}, {
  __index = _G,
  __newindex = function(_, k) error("attempt to modify a readonly table (global '" .. tostring(k) .. "')", 2) end,
})
rawset(SANDBOX, "_G", SANDBOX) -- `_G.x = …` inside the plugin hits the same read-only proxy
local loadedOk, __bridge_test = pcall(assert(loadfile(here .. "../window.luau", "t", SANDBOX)))
ck("r10 gate: window.luau loads with a READ-ONLY _G (no global writes, as in Tern's VM)", loadedOk == true)
if not loadedOk then print("   load error: " .. tostring(__bridge_test)); os.exit(1) end

local AGENTS = "/h/.agenthop/tern-panes/agents.json"
local RES = "/h/.agenthop/tern-panes/results/"
local function tickOf() local s = files[AGENTS]; return s and tonumber(s:match('"tick":(%d+)')) or nil end
local function pumpMirror() local fn = table.remove(timers, 1); fn(cx) end -- r4: the mirror chain lives on the TIMER hook

-- ---- 1. registration (r4): NOTHING on the await hook; the mirror chain is on the TIMER hook; four commands, each its own hook ----
ck("r4: ZERO sleep continuations at load (the await hook is unused)", #sleepPending == 0)
ck("hooks: commands drain / drain-start / mirror / arm registered (each its own `command <id>` hook)",
  type(commands["drain"]) == "function" and type(commands["drain-start"]) == "function" and type(commands["mirror"]) == "function"
  and type(commands["arm"]) == "function")
ck("r4: exactly ONE timer queued at load (the mirror chain, on the TIMER hook)", #timers == 1)

-- r3/r4 tooth: the timer (mirror) hook must NEVER call tern.carly.* — the arm runs ONLY on its own command hook
pumpMirror()
ck("r4: first mirror timer tick makes NO tern.carly.* call and ticks (tick 1)", carlyCalls == 0 and tickOf() == 1)
ck("r4: the timer chain renews itself (successor timer queued)", #timers == 1)
pumpMirror()
ck("r4: later mirror timer ticks still make NO tern.carly.* call", carlyCalls == 0)
-- #1036 ②: arm is three commands, ONE tern.carly call per hook (11:36:16 live: three calls in one hook crossed 50ms)
local function carlyDelta(fn) local c0 = carlyCalls; fn(); return carlyCalls - c0 end
local SENT = "/h/.agenthop/tern-panes/sentinel.json"
ck("#1036/r11: commands arm-scan / arm-cancel-next registered; the kv-addressed arm-cancel is GONE", type(commands["arm-scan"]) == "function" and type(commands["arm-cancel-next"]) == "function" and commands["arm-cancel"] == nil)
ck("r9: NO arm-schedule command in the plugin (even one tern.carly.schedule exceeded 50ms in a hook; the swarm schedules via CLI)", commands["arm-schedule"] == nil)
-- r9/r11 arming protocol: arm-scan READ-ONLY (ids+count); arm-cancel-next takes NO arguments and NO kv — it reads the ids the last
-- scan recorded, keeps the NEWEST (largest id), cancels one other, and KEEPS the obligation on failure.
local function sent() return files[SENT] or "" end
local function kvTouched() local n = 0; for _ in pairs(kvStore) do n = n + 1 end; return n end
ck("r11: arm-cancel-next before any scan (no sentinel.json) = cancel-unknown, ZERO tern.carly calls", carlyDelta(function() commands["arm-cancel-next"](cx) end) == 0 and sent():find('"step":"cancel-unknown"', 1, true) ~= nil)
-- the scan fixture returns ours = {32, 31} UNSORTED would be stronger: reorder the mock so the newest is listed FIRST
tern.carly.tasks = function() carlyCalls = carlyCalls + 1; carlyTasks = carlyTasks + 1
  return { { id = 33, title = "agenthop tern patrol" }, { id = 31, title = "agenthop tern patrol" }, { id = 99, title = "other" }, { id = 32, title = "agenthop tern patrol" } } end
ck("r9: arm-scan = exactly ONE tern.carly call (tasks), read-only (no cancel, no schedule)", carlyDelta(function() commands["arm-scan"](cx) end) == 1 and #carlyCancels == 0 and carlySchedules == 0)
ck("r9: arm-scan records ids + count of OUR patrols (3), scheduled=false when count~=1", sent():find('"step":"scanned"', 1, true) ~= nil and sent():find('"count":3', 1, true) ~= nil and sent():find('"scheduled":false', 1, true) ~= nil)
ck("r11: arm-cancel-next #1 cancels the SMALLEST (31), one tern.carly call, step=cancelled-one, count 2", carlyDelta(function() commands["arm-cancel-next"](cx) end) == 1 and carlyCancels[1] == 31 and sent():find('"step":"cancelled-one"', 1, true) ~= nil and sent():find('"count":2', 1, true) ~= nil)
ck("r11: arm-cancel-next #2 cancels 32 next (works from its OWN rewritten status, no re-scan needed), count 1, scheduled=true", carlyDelta(function() commands["arm-cancel-next"](cx) end) == 1 and carlyCancels[2] == 32 and sent():find('"count":1', 1, true) ~= nil and sent():find('"scheduled":true', 1, true) ~= nil)
ck("r11: the NEWEST (33) and the unrelated task 99 were never cancelled", #carlyCancels == 2 and carlyCancels[1] ~= 33 and carlyCancels[2] ~= 33)
ck("r11: count==1 ⇒ arm-cancel-next is idle, ZERO tern.carly calls (never cancels the last patrol)", carlyDelta(function() commands["arm-cancel-next"](cx) end) == 0 and sent():find('"step":"cancel-idle"', 1, true) ~= nil and #carlyCancels == 2)
ck("r11: zero kv reads/writes across the whole arm-cancel-next path", kvTouched() == 0)
-- failure keeps the obligation: ids/count unchanged, the same id is retried next time
commands["arm-scan"](cx)
local realCancel = tern.carly.cancel
tern.carly.cancel = function(id) carlyCalls = carlyCalls + 1; error("EIO") end
commands["arm-cancel-next"](cx)
ck("r11: cancel FAILED ⇒ step=cancel-failed, obligation KEPT (count still 3, id 31 named)", sent():find('"step":"cancel-failed"', 1, true) ~= nil and sent():find('"count":3', 1, true) ~= nil and sent():find('"id":31', 1, true) ~= nil)
tern.carly.cancel = function(id) carlyCalls = carlyCalls + 1; return false end
commands["arm-cancel-next"](cx)
ck("r11: cancel returned false ⇒ obligation KEPT (count still 3)", sent():find('"step":"cancel-failed"', 1, true) ~= nil and sent():find('"count":3', 1, true) ~= nil)
tern.carly.cancel = realCancel
local nBefore = #carlyCancels
commands["arm-cancel-next"](cx)
ck("r11: after the failures the SAME id (31) is retried", #carlyCancels == nBefore + 1 and carlyCancels[#carlyCancels] == 31)
-- a corrupt status (non-number id) is UNKNOWN, never treated as "nothing to cancel"
files[SENT] = '{"step":"scanned","ids":["31"],"count":1}'
ck("r11: non-number ids in sentinel.json ⇒ cancel-unknown, ZERO tern.carly calls", carlyDelta(function() commands["arm-cancel-next"](cx) end) == 0 and sent():find('"step":"cancel-unknown"', 1, true) ~= nil)
-- BTF-R8-P2-3: a status WRITE failure is reported as failure (never as progress)
commands["arm-scan"](cx)
local realWrite = tern.fs.write
tern.fs.write = function(p, t) if p:find("sentinel.json", 1, true) then error("ENOSPC") end return realWrite(p, t) end
ck("r9 P2-3: arm-scan whose sentinel.json write fails returns false (never claimed as progress)", __bridge_test.armScan() == false)
ck("r9 P2-3: arm-cancel-next whose status write fails returns false even though the cancel ran", __bridge_test.armCancelNext() == false)
tern.fs.write = realWrite
ck("#1036: legacy `arm` = the cheap first step only (ONE tern.carly call)", carlyDelta(function() commands["arm"](cx) end) == 1)

-- r4 ②③: VM identity + per-tick cost published in agents.json
local js0 = files[AGENTS] or ""
ck("r4 ②: agents.json carries window (TERN_WINDOW_KEY) and a vm id", js0:find('"window":"win-A"', 1, true) ~= nil and js0:match('"vm":"[%x%-]+"') ~= nil)
ck("r4 ③: agents.json carries tick_ms (previous tick's cost) and tick_ms_max", tonumber(js0:match('"tick_ms":([%d%.]+)')) ~= nil and tonumber(js0:match('"tick_ms_max":([%d%.]+)')) ~= nil)

-- r6: the TICK never calls cx.agents:list() (~28ms + ~25ms encode live); it reads cx.session:panes() (~0.17ms)
ck("r6: mirror ticks so far called agents:list() ZERO times", opCalls.list == 0)
ck("r6: mirror ticks read cx.session:panes()", (opCalls.panes or 0) >= 1)
local js6 = files[AGENTS] or ""
ck("r6: only kind==agent panes are mirrored (terminal pane 9 dropped)", js6:find('"pane":1', 1, true) ~= nil and js6:find('"pane":9', 1, true) == nil)
ck("r6: agents.json is small (<2KB) and drops the long `running` line", #js6 < 2048 and not js6:find("zzzz", 1, true))
ck("r6: alive derived from exited==nil", js6:find('"alive":true', 1, true) ~= nil)

-- r6: phase breadcrumbs are OFF by default (each is a file write — the cost class the tick avoids) and ON via the debug switch
local PHASEF = "/h/.agenthop/tern-panes/mirror-phase.json"
ck("r6: no mirror-phase.json by default (debug switch off)", files[PHASEF] == nil)
DEBUG_PHASE = "1"
commands["mirror"](cx)
ck("r6: with AGENTHOP_BRIDGE_DEBUG_PHASE=1 the crumb file is written, last crumb = done with per-segment ms",
  (files[PHASEF] or ""):find('"phase":"done"', 1, true) ~= nil and (files[PHASEF] or ""):find('"panes_ms":', 1, true) ~= nil
  and (files[PHASEF] or ""):find('"encode_ms":', 1, true) ~= nil)
DEBUG_PHASE = nil
ck("r6: agents.json carries phase_ms of the previous completed tick", (files[AGENTS] or ""):find('"phase_ms":', 1, true) ~= nil)

-- ---- 2. the mirror chain never runs drain work: pumping it with pending requests claims nothing ----
requests["s1.json"] = '{"op":"start","prompt":"p"}'
requests["l1.json"] = '{"op":"stop"}'
pumpMirror(); pumpMirror()
ck("mirror chain: two timer ticks advance tick (4→5)", tickOf() == 5)
ck("mirror chain: timer ticks claim NO requests and run NO start (drain only on its commands)",
  requests["s1.json"] ~= nil and requests["l1.json"] ~= nil and opCalls.start == 0 and opCalls.stop == 0)

-- ---- 3. op-class routing: `drain` takes fast ops only; `drain-start` takes start only ----
commands["drain"](cx)
ck("drain: runs the fast op (stop) and writes its result", opCalls.stop == 1 and files[RES .. "l1.json"] ~= nil)
ck("drain: leaves the start request UNCLAIMED for drain-start", requests["s1.json"] ~= nil and opCalls.start == 0)
commands["drain-start"](cx)
ck("drain-start: runs start and writes its result", opCalls.start == 1 and files[RES .. "s1.json"] ~= nil and requests["s1.json"] == nil)

-- ---- 4. hook isolation model: drain-start DISABLED (never invoked again) ⇒ drain + mirror still serve ----
requests["s2.json"] = '{"op":"start","prompt":"p"}' -- would go to the disabled drain-start
requests["l2.json"] = '{"op":"stop"}'
commands["drain"](cx)
pumpMirror()
ck("isolation: with drain-start disabled, drain still serves fast ops", files[RES .. "l2.json"] ~= nil)
ck("isolation: with drain-start disabled, the mirror tick still advances (5→6)", tickOf() == 6)
ck("isolation: the start request stays queued (UNKNOWN recovery is the swarm's: reload)", requests["s2.json"] ~= nil)

-- ---- 5. slim mirror: only the swarm-read fields; the long command strings are dropped ----
local js = files[AGENTS] or ""
ck("slim: agents.json keeps pane/busy/at_prompt/alive/cwd/title/program", js:find('"pane":1', 1, true) and js:find('"at_prompt":true', 1, true) and js:find('"title":"t"', 1, true) and js:find('"program":"tern"', 1, true))
ck("slim: agents.json drops command / agent_command / focused / running", not js:find("xxxx", 1, true) and not js:find("yyyy", 1, true) and not js:find('"focused"', 1, true) and not js:find("zzzz", 1, true))

-- ---- 6. manual mirror command advances the tick too ----
commands["mirror"](cx)
ck("mirror command: a manual kick advances tick (6→7)", tickOf() == 7)

-- ---- 7. eval op (fast class): compiled with loadstring/load, called with cx, value returned ----
requests["e1.json"] = '{"op":"eval","code":"return #cx.agents:list()"}'
commands["drain"](cx)
local er = files[RES .. "e1.json"] or ""
ck("eval: runs via drain and returns the value", er:find('"ok":true', 1, true) ~= nil and er:find('"value":1', 1, true) ~= nil)
requests["e2.json"] = '{"op":"eval","code":"return ("}'
commands["drain"](cx)
ck("eval: a compile error is reported, not thrown", (files[RES .. "e2.json"] or ""):find("eval compile", 1, true) ~= nil)

-- ---- r7: one request per drain trigger (the swarm triggers one drain per publish) ----
for k in pairs(requests) do requests[k] = nil end
requests["q1.json"] = '{"op":"stop"}'
requests["q2.json"] = '{"op":"stop"}'
requests["q3.json"] = '{"op":"stop"}'
local stopsBefore = opCalls.stop
commands["drain"](cx)
ck("r7: one drain trigger handles AT MOST ONE request (q1), the rest wait", opCalls.stop == stopsBefore + 1
  and files[RES .. "q1.json"] ~= nil and requests["q2.json"] ~= nil and requests["q3.json"] ~= nil)
commands["drain"](cx); commands["drain"](cx)
ck("r7: subsequent triggers drain the rest in FIFO order", opCalls.stop == stopsBefore + 3 and requests["q2.json"] == nil and requests["q3.json"] == nil)

-- ---- #1036 ①: the timer is a foreground ACCELERATOR — it stops itself when a callback fires late (napped/backgrounded) ----
-- earlier sections consumed timers by hand; take the live chain's CURRENT pending callback (exactly one exists while running)
ck("#1036: a running timer chain has exactly one pending callback", #timers == 1)
local onTime = table.remove(timers, 1)
onTime(cx) -- fires on time (mock clock advances only ~7ms per tern.now call)
ck("#1036: an ON-TIME callback renews exactly one successor", #timers == 1)
local late = table.remove(timers, 1)
clock = clock + 5000 -- this callback fires ~5s late (App Nap / background coalescing)
late(cx)
ck("#1036: a LATE callback re-arms NOTHING (the chain stops itself instead of batching into the budget)", #timers == 0)
commands["mirror"](cx)
ck("#1036: agents.json reports timer=stopped-late on the next mirror", (files[AGENTS] or ""):find('"timer":"stopped-late"', 1, true) ~= nil)
ck("#1036: the next `mirror` COMMAND (the 5s sweep) restarts the accelerator (one pending callback again)", #timers == 1)
commands["mirror"](cx)
ck("#1036: after restart agents.json reports timer=running", (files[AGENTS] or ""):find('"timer":"running"', 1, true) ~= nil)
ck("#1036: repeated mirror commands while running do NOT stack extra timer chains", #timers == 1)

-- ---- r9: a timer chain that Tern simply STOPS delivering (no kill, live 12:38–12:40) must not be reported "running" ----
for i = #timers, 1, -1 do table.remove(timers, i) end
commands["mirror"](cx)                 -- restart: one fresh chain pending
local pendingNow = #timers
clock = clock + 5000                   -- 5s pass and the pending callback is NEVER delivered (the stall)
commands["mirror"](cx)                 -- the 5s command sweep
ck("r9: a stalled chain (callback never delivered) is reported timer=overdue, not running", (files[AGENTS] or ""):find('"timer":"overdue"', 1, true) ~= nil)
ck("r9: that sweep restarts the accelerator (a new chain is pending)", #timers == pendingNow + 1)
for i = #timers - 1, 1, -1 do table.remove(timers, i) end -- the stalled callback never fires; keep only the fresh one
commands["mirror"](cx)
ck("r9: after the restart the next sweep reports running again", (files[AGENTS] or ""):find('"timer":"running"', 1, true) ~= nil)

-- ---- BTF-SV-P2-1: classify by DECODED top-level op (escaped key / escaped value / nested field) + plain controls ----
for k in pairs(requests) do requests[k] = nil end
local function runOnly(cmd, body)
  for k in pairs(requests) do requests[k] = nil end
  requests["z.json"] = body
  local s0, st0 = opCalls.stop, opCalls.start
  commands[cmd](cx)
  return { claimed = requests["z.json"] == nil, stop = opCalls.stop - s0, start = opCalls.start - st0 }
end
local esc = runOnly("drain", '{"op":"st\\u0061rt","prompt":"p","cwd":"/"}')
ck("P2-1 escaped VALUE (st\\u0061rt = start): fast drain does NOT claim/run it", not esc.claimed and esc.start == 0)
local escS = runOnly("drain-start", '{"op":"st\\u0061rt","prompt":"p","cwd":"/"}')
ck("P2-1 escaped VALUE: drain-start claims and runs it as start", escS.claimed and escS.start == 1)
local key = runOnly("drain-start", '{"\\u006fp":"start","prompt":"p","cwd":"/"}')
ck("P2-1 escaped KEY (\\u006fp = op): drain-start claims and runs start", key.claimed and key.start == 1)
local nest = runOnly("drain-start", '{"op":"stop","agent":1,"meta":{"op":"start"}}')
ck("P2-1 NESTED op:start inside a stop: drain-start does NOT claim it", not nest.claimed and nest.stop == 0)
local nestF = runOnly("drain", '{"op":"stop","agent":1,"meta":{"op":"start"}}')
ck("P2-1 NESTED: fast drain claims and runs stop (the top-level op)", nestF.claimed and nestF.stop == 1 and nestF.start == 0)
local pS = runOnly("drain-start", '{"op":"start","prompt":"p","cwd":"/"}')
local pF = runOnly("drain", '{"op":"stop","agent":1}')
ck("P2-1 controls: plain start → drain-start, plain stop → drain", pS.claimed and pS.start == 1 and pF.claimed and pF.stop == 1)
local bad = runOnly("drain", '{ not json')
ck("P2-1: undecodable request goes to fast drain (reported, never stranded on drain-start)", bad.claimed and (files[RES .. "z.json"] or ""):find("bad request json", 1, true) ~= nil)

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
