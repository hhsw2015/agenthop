-- #1115 T1b screen-state fixture ([liveness]). Loads the PRODUCTION screen.luau + classify.luau. Covers the publish state machine
-- ported from upstream herdr agent_detection.rs @143bf5f (UPSTREAM-DETECTION.md §4): startup grace, working→idle hold (4th sample /
-- 700ms cap), visible_idle / → working / → blocked immediate, stable blocker refresh, skip_state_update, UNKNOWN samples (read
-- failed / slow / error keep the published state), agent change, rotation, pruning, acp panes not eligible; plus the five REAL
-- Claude Code 2.1.293 screens (PROTOCOL §10) through the real classify.
-- Run: lua test/screen.test.lua   (from tern/agenthop-agents-bridge)
local here = (arg and arg[0] or ""):match("^(.*/)") or "./"
local root = here .. "../"
local MAN = assert(loadfile(root .. "manifests.luau"))()
local UCL = assert(loadfile(root .. "uclasses.luau"))()
local real_require = require
require = function(name)
  if name == "./manifests" then return MAN end
  if name == "./uclasses" then return UCL end
  return real_require(name)
end
local C = assert(loadfile(root .. "classify.luau"))()
local S = assert(loadfile(root .. "screen.luau"))()

local fails, n = 0, 0
local function ck(name, cond) n = n + 1; if cond then print("ok   - " .. name) else fails = fails + 1; print("FAIL - " .. name) end end
local function fixture(name)
  local f = assert(io.open(here .. "fixtures/tui/" .. name .. ".txt")); local s = f:read("a"); f:close()
  local t = assert(io.open(here .. "fixtures/tui/" .. name .. ".title")); local title = t:read("a"); t:close()
  local lines = {}; for l in (s .. "\n"):gmatch("(.-)\n") do lines[#lines + 1] = l end
  return lines, title
end
local CLAUDE = "/Users/wowdd1/.local/share/claude/versions/2.1.293 --model claude-opus-5-5"
local P = 12382390714370
local K = tostring(P)
local READ = { lines = { "x" } }

-- a scripted classifier: each call returns the next result
local function script(list) local i = 0; return function() i = i + 1; return list[i] or list[#list] end end
local W, I, B, Iv = { state = "working" }, { state = "idle" }, { state = "blocked", visible_blocker = true }, { state = "idle", visible_idle = true }

-- drive one pane past the startup grace (first sample + the expiry sample), returning states and the clock after it
local function settled(classify)
  local st = {}
  S.record(st, P, READ, CLAUDE, "", "claude", classify, 0, 100)
  S.record(st, P, READ, CLAUDE, "", "claude", classify, 3100, 103)
  return st, 3100
end

-- ---- startup grace ----
do
  local st = {}
  local e = S.record(st, P, READ, CLAUDE, "", "claude", script({ W }), 0, 100)
  ck("grace: first sample of a pane publishes unknown, try=grace (never idle)", e.state == "unknown" and e.try == "grace" and st[K] == e)
  e = S.record(st, P, READ, CLAUDE, "", "claude", script({ W }), 2000, 102)
  ck("grace: still inside 3s ⇒ not classified", e.state == "unknown" and e.try == "grace")
  e = S.record(st, P, READ, CLAUDE, "", "claude", script({ W }), 3100, 103)
  ck("grace: the sample on which it expires is skipped too (upstream)", e.state == "unknown" and e.try == "grace")
  e = S.record(st, P, READ, CLAUDE, "", "claude", script({ W }), 3200, 104)
  ck("grace: next sample classifies (working)", e.state == "working" and e.try == "ok" and e.observed_at == 104)
end

-- ---- working → plain idle: hold, release on the 4th consecutive idle sample (100ms apart) ----
do
  local cls = script({ W, I, I, I, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  ck("hold: working published", st[K].state == "working")
  for k = 1, 3 do
    S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100 + 100 * k, 110 + k)
    ck(("hold: idle sample %d keeps working published (try=held)"):format(k), st[K].state == "working" and st[K].try == "held")
  end
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 500, 115)
  ck("hold: 4th consecutive idle sample publishes idle", st[K].state == "idle" and st[K].try == "ok")
end
-- ---- the 700ms cap releases at the bridge's real cadence (samples seconds apart) ----
do
  local cls = script({ W, I, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 5100, 115)
  ck("cap: first idle sample is held", st[K].state == "working" and st[K].try == "held")
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 10100, 120)
  ck("cap: the next idle sample ≥700ms later publishes idle", st[K].state == "idle")
end
-- ---- any other sample clears the hold ----
do
  local cls = script({ W, I, W, I, I })
  local st, t = settled(cls)
  for k, _ in ipairs({ 1, 2, 3, 4 }) do S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100 * k, 110 + k) end
  ck("hold reset: idle, working, idle ⇒ the idle after the working starts a NEW hold (still working)", st[K].state == "working" and st[K].try == "held")
end
-- ---- immediate transitions ----
do
  local cls = script({ W, Iv })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111)
  ck("working → visible_idle ⇒ idle immediately (no hold)", st[K].state == "idle" and st[K].visible_idle == true)
end
do
  local cls = script({ I, B })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111)
  ck("idle → blocked ⇒ immediate, visible_blocker kept", st[K].state == "blocked" and st[K].visible_blocker == true)
  local cls2 = script({ W })
  S.record(st, P, READ, CLAUDE, "", "claude", cls2, t + 300, 112)
  ck("blocked → working ⇒ immediate", st[K].state == "working")
end
do
  local cls = script({ W, B })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111)
  ck("working → blocked ⇒ immediate (the hold applies only to working → idle)", st[K].state == "blocked")
end
-- ---- visible flags are masked by state (upstream) ----
do
  local cls = script({ { state = "working", visible_blocker = true } })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  ck("mask: visible_blocker on a working result is dropped", st[K].state == "working" and st[K].visible_blocker == false)
end
-- ---- stable blocker refresh: re-published every ≥800ms ----
do
  local cls = script({ B, B, B })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  local r0 = st[K].refreshed
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 500, 111)
  ck("refresh: within 800ms the refresh clock does not move", st[K].refreshed == r0)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 1000, 112)
  ck("refresh: ≥800ms later the blocker is re-published (refresh clock moves)", st[K].refreshed == t + 1000 and st[K].state == "blocked")
end
-- ---- skip_state_update ----
do
  local cls = script({ W, I, { state = "unknown", skip_state_update = true }, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 300, 112)
  ck("skip rule: no publish, try=skip, pending hold cleared", st[K].state == "working" and st[K].try == "skip" and st[K].pending_since == nil)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 400, 113)
  ck("skip rule: the idle after it starts a fresh hold (held, not published)", st[K].state == "working" and st[K].try == "held")
end
-- ---- UNKNOWN samples keep the published state ----
do
  local cls = script({ W })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  local e = S.record(st, P, nil, CLAUDE, "", "claude", cls, t + 200, 170)
  ck("unreadable: try=unreadable, state/observed_at kept, tried_at moves", e.try == "unreadable" and e.state == "working" and e.observed_at == 110 and e.tried_at == 170)
  e = S.record(st, P, { lines = {} }, CLAUDE, "", "claude", cls, t + 300, 171)
  ck("empty read: unreadable", e.try == "unreadable" and e.state == "working")
  e = S.record(st, P, READ, CLAUDE, "", "claude", function() return { state = "unknown", rule = "slow" } end, t + 400, 172)
  ck("classify out of budget: try=slow, kept", e.try == "slow" and e.state == "working" and e.observed_at == 110)
  e = S.record(st, P, READ, CLAUDE, "", "claude", function() error("boom") end, t + 500, 173)
  ck("classify raised: try=error, kept", e.try == "error" and e.state == "working")
  e = S.record(st, P, READ, CLAUDE, "", "claude", function() return { state = 7 } end, t + 600, 174)
  ck("classify returned junk: try=error, kept", e.try == "error" and e.state == "working")
end
-- ---- an out-of-enum state string is a failed attempt, never a publish, and it does not clear the working→idle hold ----
do
  local cls = script({ W, { state = "not-a-state" }, I, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  local e = S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111)
  ck("enum: \"not-a-state\" ⇒ try=error, working kept, observed_at not moved", e.try == "error" and e.state == "working" and e.observed_at == 110)
  e = S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 300, 112)
  ck("enum: the plain idle after it is HELD (the bad sample did not stand in for a confirmation)", e.state == "working" and e.try == "held")
end
do
  local cls = script({ W, I, { state = "sleeping" }, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111) -- held, pending n=0
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 300, 112) -- bad
  ck("enum: a bad sample inside a hold keeps the pending clock (no reset, no publish)", st[K].pending_since == t + 200 and st[K].state == "working")
end
-- ---- agent change ⇒ unknown + new grace ----
do
  local cls = script({ W })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  local e = S.record(st, P, READ, "codex", "", "codex", cls, t + 200, 111)
  ck("agent change: unknown + grace again", e.state == "unknown" and e.agent == "codex" and e.try == "grace")
end
-- ---- monotonic clock stepping back (Tern's tern.now should not, but a bad clock must not wedge the hold) ----
do
  local cls = script({ W, I, I, I, I, I })
  local st, t = settled(cls)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 100, 110)
  S.record(st, P, READ, CLAUDE, "", "claude", cls, t + 200, 111) -- held
  for k = 1, 3 do S.record(st, P, READ, CLAUDE, "", "claude", cls, t - 100000 * k, 111 + k) end -- clock goes far back
  ck("clock back: the confirmation count still releases the hold (count bound, not only time)", st[K].state == "idle")
end

-- ---- the real screens through the real classify (published after grace) ----
for _, case in ipairs({
  { "claude-idle-fresh", "idle" }, { "claude-idle-after-turn", "idle" },
  { "claude-working-early", "working" }, { "claude-working-mid", "working" }, { "claude-blocked-write", "blocked" },
}) do
  local lines, title = fixture(case[1])
  local st = {}
  S.record(st, P, { lines = lines }, CLAUDE, title, "claude", C.classify, 0, 100)
  S.record(st, P, { lines = lines }, CLAUDE, title, "claude", C.classify, 3100, 103)
  local t0 = os.clock()
  local e = S.record(st, P, { lines = lines }, CLAUDE, title, "claude", C.classify, 3200, 104)
  local ms = (os.clock() - t0) * 1000
  ck(case[1] .. ": published " .. case[2], e.state == case[2] and e.try == "ok")
  ck(case[1] .. ": classify + record within the 5ms classify budget (" .. string.format("%.2f", ms) .. "ms)", ms < C.BUDGET_MS + 2)
end

-- ---- eligibility, rotation, pruning, public view ----
do
  local panes = {
    { pane = 30, program = "tern" }, { pane = 20, program = CLAUDE }, { pane = 10, program = "codex -a never -s danger-full-access" },
    { pane = 40, program = "/bin/zsh" }, { pane = 50, program = CLAUDE, exited = 0 },
  }
  local el = S.eligible(panes, C.agent_for)
  ck("eligible: live panes whose program classify knows, sorted (10 codex, 20 claude)", #el == 2 and el[1] == 10 and el[2] == 20)
  ck("pick: first / next / wraps / continues after a vanished one / none",
    S.pick(el, nil) == 10 and S.pick(el, 10) == 20 and S.pick(el, 20) == 10 and S.pick(el, 15) == 20 and S.pick({}, 10) == nil)
  local states = { ["10"] = { state = "idle" }, ["99"] = { state = "working" } }
  S.prune(states, panes)
  ck("prune: a pane no longer in the window is dropped; live ones kept", states["99"] == nil and states["10"] ~= nil)
  local pub = S.public({ state = "working", grace_until = 5, pending_since = 1, pending_n = 2, refreshed = 3, observed_at = 9, try = "ok" })
  ck("public view: no monotonic-clock fields leak; flags are booleans",
    pub.grace_until == nil and pub.pending_since == nil and pub.refreshed == nil and pub.visible_idle == false and pub.observed_at == 9)
end

print(("%d/%d ok"):format(n - fails, n))
if fails > 0 then os.exit(1) end
