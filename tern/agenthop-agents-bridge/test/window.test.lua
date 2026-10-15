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
    for k, x in pairs(v) do parts[#parts + 1] = string.format("%q:%s", tostring(k), encode(x)) end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
  elseif t == "string" then return string.format("%q", v)
  else return tostring(v) end
end
local function decode(s)
  local op = s:match('"op":"(%w+)"')
  if not op then error("bad json") end
  return { op = op, prompt = s:match('"prompt":"([^"]*)"'), code = s:match('"code":"([^"]*)"'), cwd = "/" }
end

-- ---- hook registry: sleep continuations share hook "await"; each command is hook "command <id>" ----
local sleepPending = {}  -- await-hook continuations
local commands = {}      -- id -> run fn
local files, dirs, requests = {}, {}, {}
local opCalls = { list = 0, start = 0, stop = 0 }
local carlyCalls = 0 -- every tern.carly.* call (tasks/cancel/schedule)
clock = 1000      -- global so the tern.now mock can advance it
local timers = {}     -- tern.timer callbacks (the TIMER hook)

local cx = {
  agents = {
    list = function() opCalls.list = opCalls.list + 1; return {
      { pane = 1, session = 2, model = "m", state = "idle", busy = false, at_prompt = true, alive = true, cwd = "/c", tab = 3, title = "t",
        command = string.rep("x", 200), agent_command = string.rep("y", 200), focused = true, program = "tern" } } end,
    start = function() opCalls.start = opCalls.start + 1; return 42 end,
    stop = function() opCalls.stop = opCalls.stop + 1 end,
  },
}

_G.tern = {
  getenv = function(k) if k == "HOME" then return "/h" elseif k == "TERN_WINDOW_KEY" then return "win-A" end end,
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
  carly = { tasks = function() carlyCalls = carlyCalls + 1; return {} end,
            cancel = function() carlyCalls = carlyCalls + 1 end,
            schedule = function() carlyCalls = carlyCalls + 1; return 7 end },
  timer = function(_ms, fn) timers[#timers + 1] = fn; return { cancel = function() end } end,
  sleep = function(_ms) return { next = function(_, fn) sleepPending[#sleepPending + 1] = fn end } end,
  command = function(def) commands[def.id] = def.run end,
}

package.loaded["./claim"] = assert(loadfile(here .. "../claim.luau"))()
assert(loadfile(here .. "../window.luau"))()

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
commands["arm"](cx)
ck("r3: the `arm` command arms (tern.carly called, sentinel.json recorded)", carlyCalls >= 2 and files["/h/.agenthop/tern-panes/sentinel.json"] ~= nil)

-- r4 ②③: VM identity + per-tick cost published in agents.json
local js0 = files[AGENTS] or ""
ck("r4 ②: agents.json carries window (TERN_WINDOW_KEY) and a vm id", js0:find('"window":"win-A"', 1, true) ~= nil and js0:match('"vm":"[%x%-]+"') ~= nil)
ck("r4 ③: agents.json carries tick_ms (previous tick's cost) and tick_ms_max", tonumber(js0:match('"tick_ms":([%d%.]+)')) ~= nil and tonumber(js0:match('"tick_ms_max":([%d%.]+)')) ~= nil)

-- ---- 2. the mirror chain never runs drain work: pumping it with pending requests claims nothing ----
requests["s1.json"] = '{"op":"start","prompt":"p"}'
requests["l1.json"] = '{"op":"stop"}'
pumpMirror(); pumpMirror()
ck("mirror chain: two timer ticks advance tick (3→4)", tickOf() == 4)
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
ck("isolation: with drain-start disabled, the mirror tick still advances (4→5)", tickOf() == 5)
ck("isolation: the start request stays queued (UNKNOWN recovery is the swarm's: reload)", requests["s2.json"] ~= nil)

-- ---- 5. slim mirror: only the swarm-read fields; the long command strings are dropped ----
local js = files[AGENTS] or ""
ck("slim: agents.json keeps pane/state/busy/at_prompt/alive/cwd/title", js:find('"pane":1', 1, true) and js:find('"at_prompt":true', 1, true) and js:find('"title":"t"', 1, true))
ck("slim: agents.json drops command / agent_command / focused / program", not js:find("xxxx", 1, true) and not js:find("yyyy", 1, true) and not js:find('"focused"', 1, true) and not js:find('"program"', 1, true))

-- ---- 6. manual mirror command advances the tick too ----
commands["mirror"](cx)
ck("mirror command: a manual kick advances tick (5→6)", tickOf() == 6)

-- ---- 7. eval op (fast class): compiled with loadstring/load, called with cx, value returned ----
requests["e1.json"] = '{"op":"eval","code":"return #cx.agents:list()"}'
commands["drain"](cx)
local er = files[RES .. "e1.json"] or ""
ck("eval: runs via drain and returns the value", er:find('"ok":true', 1, true) ~= nil and er:find('"value":1', 1, true) ~= nil)
requests["e2.json"] = '{"op":"eval","code":"return ("}'
commands["drain"](cx)
ck("eval: a compile error is reported, not thrown", (files[RES .. "e2.json"] or ""):find("eval compile", 1, true) ~= nil)

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
