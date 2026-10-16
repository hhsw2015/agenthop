-- agenthop agents-bridge v1 — A1 (production). A THIN window-half shim: it mirrors Tern's native cx.agents layer to a file-JSON control
-- plane the bash swarm reads/writes, herdr-style. Authoritative wire contract + claim/recovery semantics: PROTOCOL.md. A2 (promptless
-- patrol sentinel, registered via tern.carly.schedule) ships in this same plugin; A3 (OSC 9;4 alert) reader is in the sentinel, emitter
-- is osc-alert-hook.sh.
--
-- The claim GATE + op classification + sync dispatch live in claim.luau and are REQUIRED here (and loaded by test/claim.test.lua) — ONE
-- shared source, so a single-line change to the gate changes production and turns the test RED together (review TA-A1-GATE). Claim model:
-- execute ONLY after a successful remove-claim; a read failure or an empty/partial read never deletes; at-most-once per claim, NOT
-- crash-safe exactly-once (tern.fs has no rename/O_EXCL). Recovery is the swarm's job, op-class-specific (PROTOCOL.md §3).

local claim = require("./claim")
local screen = require("./screen")
local classify = require("./classify")

local HOME = tern.getenv("HOME") or ""
local CTL = HOME .. "/.agenthop/tern-panes" -- control-plane dir shared with the bash swarm
local REQ = CTL .. "/requests"
local RES = CTL .. "/results"
local POLL_MS = 750 -- status-mirror cadence. POLL_MS only sets the scheduling interval; it does NOT bound a tick's duration.

local function ensure()
  for _, d in ipairs({ CTL, REQ, RES }) do
    if not tern.fs.exists(d) then
      pcall(function() tern.fs.mkdir(d) end)
    end
  end
end

-- STATUS mirror (PROTOCOL.md §1): a minimal agent-pane snapshot (r6: from cx.session:panes(), NOT cx.agents:list()) to agents.json.
-- Advisory/overwrite; a torn read self-heals next poll.
-- r4 ②: identity of THIS VM, so two windows' VMs overwriting one agents.json are distinguishable (one dead, one alive must not look
-- like "still ticking"). `window` = TERN_WINDOW_KEY when the daemon exposes it; `vm` = a per-load random id (changes on every reload).
local VM_ID = string.format("%x-%x", math.floor(tern.now() * 1000) % 0x7fffffff, math.random(0, 0x7fffffff))
local WINDOW_KEY = tern.getenv("TERN_WINDOW_KEY")
local ticks = 0
local lastMs = nil -- r4 ③: wall cost (ms) of the PREVIOUS mirror tick, published so a >50ms tail is observable in agents.json itself
local maxMs = 0
local lastPhase = nil -- r5: previous completed tick's cumulative ms per segment
local timerState = "running" -- #1036: "running" | "stopped-late"; declared BEFORE mirror() so mirror publishes the live value
local timerDue = nil -- monotonic ms the next timer callback is due (nil = no chain pending)
-- r9 (live 12:38–12:40): Tern can simply STOP delivering timer callbacks — the chain stalled with no kill logged and Tern frontmost.
-- A callback that never arrives cannot run the late-detection, so "running" would be a lie. Report what is OBSERVABLE: if the next
-- callback is past due by more than TIMER_LATE_MS, the accelerator is "overdue" (stalled or napped); the 5s command sweep is the only
-- liveness source and keeps ticking regardless.
local TIMER_LATE_MS = 400
-- r11: monotonic ms of the last timer callback that REALLY arrived (nil = never since load), published as timer_fired_at so "never
-- delivered" is readable directly. agents.json is only rewritten by a tick, so once callbacks stop the file freezes with whatever the
-- last write said (often "running", written by the mirror command that just restarted the chain); timer_fired_at is the field that
-- does not lie. The timerDue == nil branch is defensive: mirrorTimer always records the due time before arming.
local timerFiredAt = nil
local function timerReport()
  if timerState ~= "running" then return timerState end
  if timerDue == nil or tern.now() - timerDue > TIMER_LATE_MS then return "overdue" end
  return "running"
end
-- r6 CHEAP SOURCE (coordinator's live split timing, clean VM): cx.agents:list() costs ~28ms (8 agents; cross-session aggregation +
-- last_message text) and tern.json.encode of its result another ~25ms (18 KB) — together the 40-50ms+ tick that killed every hook in
-- r1-r4. cx.session:panes() costs ~0.17ms and its PaneInfo already carries what the mirror publishes. So the mirror NEVER calls
-- agents:list(): it filters panes() to kind=="agent" and builds a minimal table (target <2KB, <3ms/tick). model/state/last_message are
-- not on PaneInfo and are dropped from the tick; the `list` op (request path, not the tick) still returns the full agents:list().
local agentPanes = claim.slimAgents -- r7: one shared source with the `list` op (claim.luau)
-- #1115 T1: per-pane screen state of this window's TUI seats (screen.luau). Filled by the `screen` command, published by mirror.
local screens = {}
local lastScreenPane = nil

-- r5 phase breadcrumbs kept as an OPT-IN debug switch (kv `bridge.debug_phase` = true, or env AGENTHOP_BRIDGE_DEBUG_PHASE=1), OFF by
-- default: each crumb is a file write, which is exactly the cost class the tick must avoid in production.
local PHASE = CTL .. "/mirror-phase.json"
local function debugPhase()
  if tern.getenv("AGENTHOP_BRIDGE_DEBUG_PHASE") == "1" then return true end
  local ok, v = pcall(function() return tern.kv and tern.kv.get("bridge.debug_phase") end)
  return ok and v == true
end
local function crumb(on, tick, phase, t0, extra)
  if not on then return end
  pcall(function()
    tern.fs.write(PHASE, string.format('{"vm":"%s","tick":%d,"phase":"%s","at_ms":%.2f%s}', VM_ID, tick, phase, tern.now() - t0, extra or ""))
  end)
end

local function mirror(cx)
  local t0 = tern.now()
  ticks = ticks + 1
  local dbg = debugPhase()
  crumb(dbg, ticks, "panes", t0)
  local ok, panes = pcall(function() return cx.session:panes() end)
  local tPanes = tern.now() - t0
  crumb(dbg, ticks, "build", t0, string.format(',"panes_ms":%.2f', tPanes))
  local agents = ok and agentPanes(panes) or {}
  local tBuild = tern.now() - t0
  local payload = {
    ts = tern.now(),
    tick = ticks, -- liveness: advances on every mirror call (command-triggered, plus the best-effort timer chain)
    vm = VM_ID,
    window = WINDOW_KEY,
    tick_ms = lastMs, -- cost of the previous COMPLETED tick
    tick_ms_max = maxMs,
    timer = timerReport(), -- #1036: "running" | "stopped-late" | "overdue" (see timerReport); the command sweep is the liveness source
    timer_fired_at = timerFiredAt, -- r11: tern.now() of the last delivered timer callback; absent = never delivered since load
    phase_ms = lastPhase, -- previous completed tick's cumulative ms per segment
    agents = (#agents > 0) and agents or tern.json.array({}),
    screens = screen.publicAll(screens), -- #1115 T1b: pane id -> published {state, rule, agent, visible_*, observed_at, try, tried_at}
    error = (not ok) and tostring(panes) or nil,
  }
  crumb(dbg, ticks, "encode", t0, string.format(',"panes_ms":%.2f,"build_ms":%.2f', tPanes, tBuild))
  local okEnc, text = pcall(function() return tern.json.encode(payload) end)
  local tEnc = tern.now() - t0
  crumb(dbg, ticks, "write", t0, string.format(',"panes_ms":%.2f,"build_ms":%.2f,"encode_ms":%.2f', tPanes, tBuild, tEnc))
  if okEnc then pcall(function() tern.fs.write(CTL .. "/agents.json", text) end) end
  lastMs = tern.now() - t0
  if lastMs > maxMs then maxMs = lastMs end
  lastPhase = { panes = tPanes, build = tBuild, encode = tEnc, write = lastMs }
  crumb(dbg, ticks, "done", t0, string.format(',"panes_ms":%.2f,"build_ms":%.2f,"encode_ms":%.2f,"write_ms":%.2f', tPanes, tBuild, tEnc, lastMs))
end

local function answer(id, result)
  pcall(function() tern.fs.write(RES .. "/" .. id .. ".json", tern.json.encode(result)) end)
end

-- CLAIM + DISPATCH via the shared claim.luau. The gate (read -> empty-skip -> remove-claim) is claim.claim; op class is claim.classOf;
-- sync dispatch is claim.execute. `wait` is async and handled here via :next (PROTOCOL.md §2.1). r2 ②: each drain command handles ONE
-- op class — `drain-start` only `start`, `drain` everything else — and a request of the other class is left UNCLAIMED (peeked, not
-- removed) for the other command, so a disabled slow `start` hook cannot strand or block fast ops.
local function handle(cx, id, text)
  local okDec, req = pcall(function() return tern.json.decode(text) end)
  if not (okDec and type(req) == "table" and type(req.op) == "string") then
    answer(id, { ok = false, error = "bad request json" }) -- claimed but undecodable: report, do not silently drop
    return
  end
  local class = claim.classOf(req.op)
  if req.op == "wait" then
    -- async: hand to :next so a long idle-wait never stalls the command
    local okW, aw = pcall(function() return cx.agents:wait(req.agent, { timeout = req.timeout }) end)
    if okW then
      aw:next(function(message, err)
        answer(id, { ok = (err == nil), class = class, message = message, error = err })
      end)
    else
      answer(id, { ok = false, class = class, error = tostring(aw) })
    end
  else
    local result = claim.execute(cx, req)
    result.class = class
    answer(id, result)
  end
end

-- r7: a drain trigger handles AT MOST ONE request of its class (the swarm triggers one drain per publish), so one slow op cannot
-- push a trigger past the 50ms hook budget by stacking several requests; the rest wait for the next `plugins run`.
local DRAIN_MAX_PER_TRIGGER = 1
local function drain(cx, wantStart)
  local names = {}
  pcall(function() names = tern.fs.list(REQ) end)
  table.sort(names) -- deterministic FIFO by publish name
  local handled = 0
  for _, name in ipairs(names) do
    if handled >= DRAIN_MAX_PER_TRIGGER then break end
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local path = REQ .. "/" .. name
      -- BTF-SV-P2-1: classify by the DECODED top-level op, never a text regex (an escaped `st\u0061rt` or a nested `"op":"start"`
      -- inside another field made classification and execution disagree). Undecodable ⇒ the fast `drain` claims it and reports
      -- "bad request json" (claim.handle), so a malformed request can never strand on drain-start.
      local okPeek, peek = pcall(function() return tern.fs.read(path) end)
      local okDec, req = false, nil
      if okPeek and type(peek) == "string" then okDec, req = pcall(function() return tern.json.decode(peek) end) end
      local isStart = okDec and type(req) == "table" and req.op == "start"
      if isStart == wantStart then -- this command's op class only; the other class is left for its own command
        local claimed, text = claim.claim(
          function(p) return tern.fs.read(p) end,
          function(p) tern.fs.remove(p) end,
          path
        )
        if claimed then handle(cx, id, text); handled = handled + 1 end -- we hold the claim: exactly this VM owns it now
      end
    end
  end
end

-- A2: register the promptless patrol sentinel (tern.carly.schedule, every 1m, no model turn). Check source is sentinel.luau (loaded
-- relative to the plugin dir). Dedup by title across reloads/windows: cancel any prior task with our title, then schedule one fresh.
-- tern.carly.* needs a SCOPED window callback, so this runs from inside the poll loop. Returns true only when the arming status was
-- durably recorded, so a transient failure (e.g. control dir missing) is retried next tick (dedup keeps the retry idempotent) — TA-A2-ARM.
local PATROL_TITLE = "agenthop tern patrol"
-- #1036 ② / r9 / r11 ARMING PROTOCOL. Only `tern.carly.schedule` is expensive (>50ms, unstable — it disabled `arm-schedule` live);
-- tasks() (~2.2ms) and cancel are cheap. tern 0.8.3's `ctl carly task` has add but NO list / cancel, so listing and cancelling must
-- stay here; ONLY the schedule step lives outside the plugin (arm-schedule.sh: `tern ctl carly task add`, '#' escaped). Commands:
--   arm-scan        — READ-ONLY. tern.carly.tasks() ⇒ sentinel.json {step:"scanned", ids:[…], count, scheduled = (count == 1)}.
--                     It never cancels and never schedules, so it is also the post-add VERIFIER (only tasks() counts, never ctl's ok).
--   arm-cancel-next — no arguments, no kv: reads the ids the last arm-scan recorded in sentinel.json, KEEPS the newest (largest id),
--                     cancels ONE of the others (the smallest), and rewrites sentinel.json {step:"cancelled-one", ids, count}. A failed
--                     cancel keeps the obligation (step:"cancel-failed", ids/count unchanged). r11: this replaces the kv-addressed
--                     cancel — the bridge's data dir is written by the bridge only (an outside kv.json write races tern.kv's own).
-- The swarm (#1033 sweep) drives: arm-scan → while count>1: arm-cancel-next → count==0 ⇒ arm-schedule.sh → arm-scan to verify
-- count==1. Idempotent by title: count==1 ⇒ scheduled, add nothing.
-- r8 BTF-R8-P2-3: a status WRITE failure is reported as such (the command's own result is never claimed as progress when
-- sentinel.json could not record it).
local SENTINEL_STATUS = CTL .. "/sentinel.json"
local function writeStatus(status)
  return pcall(function() tern.fs.write(SENTINEL_STATUS, tern.json.encode(status)) end)
end
local function idList(ids) return (#ids > 0) and ids or tern.json.array({}) end
local function armScan()
  local ids = {}
  local ok, err = pcall(function()
    for _, t in ipairs(tern.carly.tasks()) do
      if t.title == PATROL_TITLE then ids[#ids + 1] = t.id end
    end
  end)
  if not ok then return writeStatus({ ts = tern.now(), scheduled = false, step = "scan-failed", error = tostring(err) }) and false end
  return writeStatus({ ts = tern.now(), step = "scanned", ids = idList(ids), count = #ids, scheduled = (#ids == 1) })
end
-- the ids recorded by the last scan (or by a previous arm-cancel-next), sorted; nil = UNKNOWN (absent / unreadable / not all numbers)
local function recordedIds()
  local okR, text = pcall(function() return tern.fs.read(SENTINEL_STATUS) end)
  if not (okR and type(text) == "string") then return nil end
  local okD, st = pcall(function() return tern.json.decode(text) end)
  if not (okD and type(st) == "table" and type(st.ids) == "table") then return nil end
  local ids = {}
  for _, v in ipairs(st.ids) do
    if type(v) ~= "number" then return nil end
    ids[#ids + 1] = v
  end
  table.sort(ids)
  return ids
end
local function armCancelNext()
  local ids = recordedIds()
  if ids == nil then
    return writeStatus({ ts = tern.now(), step = "cancel-unknown", error = "no readable ids in sentinel.json; run arm-scan first" }) and false
  end
  if #ids <= 1 then
    return writeStatus({ ts = tern.now(), step = "cancel-idle", ids = idList(ids), count = #ids, scheduled = (#ids == 1) })
  end
  local victim = ids[1] -- smallest; the largest (newest) is the one kept
  local okC, res = pcall(function() return tern.carly.cancel(victim) end)
  if not okC or res == false then
    -- KEEP the obligation: ids/count unchanged, so the next arm-cancel-next retries the same id
    writeStatus({ ts = tern.now(), step = "cancel-failed", id = victim, ids = ids, count = #ids, scheduled = false,
      error = okC and "cancel returned false" or tostring(res) })
    return false
  end
  local rest = {}
  for i = 2, #ids do rest[#rest + 1] = ids[i] end
  return writeStatus({ ts = tern.now(), step = "cancelled-one", id = victim, ids = idList(rest), count = #rest, scheduled = (#rest == 1) })
end

-- r2 SCHEDULING (bridge tick-freeze, corrected root cause — PROTOCOL.md §4). Tern disables at HOOK granularity: every
-- tern.sleep():next continuation is the SAME hook (`await`), so ONE continuation over the ~50ms budget disables ALL of this VM's
-- timer continuations ("await exceeded 50 ms", disabled until reload) — already-queued successors are NOT delivered either. Two sleep
-- chains therefore cannot isolate each other (r1 premise, refuted live by the coordinator). Each `tern.command` IS its own hook
-- (`command <id>`), so slow work is moved onto commands the swarm triggers via `tern ctl plugins run plugin.<plugin>.<id>`:
--   * mirror      — the liveness tick stays on the sleep chain (slimmed to stay far under budget) and is also a command for a manual kick;
--   * drain       — fast ops (list/transcript/ask/interrupt/stop/eval/wait); its own hook;
--   * drain-start — ONLY `start` (synchronous, can exceed the budget); a disabled drain-start never disables drain or the mirror.
-- If a hook IS disabled, recovery is the swarm's: detect (tick stalled >5s, or no result 2s after a drain trigger) ⇒ `tern plugin
-- reload` (tick restarts from 1, <2s). This is isolation + external reload, NOT in-VM self-healing.
-- r3: the A2 sentinel arm is OFF the mirror tick. registerSentinel makes three cross-VM tern.carly calls (tasks + cancel + schedule);
-- inside the first await tick that alone crossed the 50ms budget and disabled the whole await hook (live 11:05:40). It now runs ONLY
-- on its own `arm` command hook (`tern ctl plugins run plugin.agenthop-agents-bridge.arm`, triggered by the swarm after each
-- load/reload). If that hook is disabled, only arming is lost; the mirror and the drains keep running. Dedup-by-title keeps a repeat
-- arm idempotent.

local function mirrorTick(cx)
  ensure()
  mirror(cx) -- no tern.carly.* here: the await hook carries ONLY the cheap mirror
end

-- r4 ①: the mirror is OFF the await hook. Primary driver = the `mirror` COMMAND (its own hook `command mirror`) triggered by the swarm
-- sweep every ~5s (`tern ctl plugins run plugin.agenthop-agents-bridge.mirror`); a slow call there disables only that command until
-- reload, never drains or arm. Secondary = a best-effort self-renewing `tern.timer` chain on the TIMER hook (not await); if Tern ever
-- disables the timer hook the chain stops and the command-driven mirror carries liveness alone. Each timer tick renews BEFORE working.
-- #1036: the timer chain is ONLY a foreground accelerator, never a liveness source. Live 12:01:42 the timer hook was killed while
-- tick_ms was 0.28ms — the work was cheap; the CALLBACK was late (macOS App Nap / background timer coalescing delays it, and the
-- delayed callback is charged to the 50ms budget). Liveness is the swarm's 5s `mirror` command sweep (#1033). So the chain:
--   * self-stops when a callback fires far later than scheduled (lateness > TIMER_LATE_MS ⇒ we are napped/backgrounded): no
--     successor is queued, so a late batch can never hit the budget; it reports `timer` = "stopped-late" in agents.json;
--   * may be disabled by Tern without alarm (the command sweep keeps the mirror alive);
--   * restarts on the next `mirror` COMMAND run (the sweep), i.e. as soon as we are serviced on time again.
-- r13 BTF-R10-P2-1: a restart must not leave TWO chains. The overdue callback a restart gives up on is still queued inside Tern; if
-- it arrives later it would read the NEW timerDue, look on time, and re-arm — a second chain. Each chain carries its generation; a
-- callback whose generation is not current returns at once (no renew, no timer_fired_at, no tick).
local timerGen = 0
local function mirrorTimer(cx, gen)
  local now = tern.now()
  if timerDue ~= nil and now - timerDue > TIMER_LATE_MS then
    timerState = "stopped-late" -- napped/backgrounded: do not re-arm; the command sweep restarts us
    timerDue = nil
    return
  end
  timerDue = now + POLL_MS
  tern.timer(POLL_MS, function(nextCx)
    if gen ~= timerGen then return end -- a superseded chain's callback: dropped (no renew, no timer_fired_at, no tick)
    timerFiredAt = tern.now()
    mirrorTimer(nextCx, gen)
  end)
  if cx ~= nil then mirrorTick(cx) end
end

tern.command({ id = "arm-scan", title = "agenthop bridge: list patrol tasks (read-only; also the post-add verifier)", run = function() ensure(); armScan() end })
tern.command({ id = "arm-cancel-next", title = "agenthop bridge: cancel one extra patrol task (keeps the newest)", run = function() ensure(); armCancelNext() end })
-- `arm` (compatibility: #1033's sweep and agenthop_tern's recovery call it) = arm-scan (read-only). One tern.carly call per hook.
tern.command({ id = "arm", title = "agenthop bridge: arm step 1 = list patrol tasks (then arm-cancel-next extras / arm-schedule.sh)", run = function() ensure(); armScan() end })
-- L5: every chain restart is recorded in diag.json (last one wins; the sweep's orphan pass ages the file out), so "Tern stopped
-- delivering timer callbacks" is readable after the fact. A disabled `mirror` COMMAND hook cannot be healed from inside the VM —
-- this command then never runs; recovery from that is the sweep's reload (tern-bridge-sweep.ts, L5 owed-ready re-reload).
local DIAG = CTL .. "/diag.json"
tern.command({ id = "mirror", title = "agenthop bridge: mirror now", run = function(cx)
  local rep = timerReport()
  mirrorTick(cx) -- publishes the CURRENT timer state (stopped-late / overdue is reported, then the restart below takes effect)
  if rep ~= "running" then -- the accelerator stopped itself or stalled: restart ONE fresh chain (a stalled one never re-fires)
    pcall(function()
      tern.fs.write(DIAG, tern.json.encode({ ts = tern.now(), vm = VM_ID, event = "timer-rearm", reason = rep, tick = ticks,
        timer_fired_at = timerFiredAt }))
    end)
    timerGen = timerGen + 1 -- supersede the old chain: its pending callback (if Tern ever delivers it) is dropped
    timerState = "running"
    timerDue = nil
    mirrorTimer(nil, timerGen)
  end
end })
-- #1115 T1 `screen`: ONE pane read + ONE classify per run, on its own hook. Also written to screens/<vm>.json so every window's VM
-- publishes its own panes (a VM reads only its window); readers merge the files by pane id. Each entry carries observed_at (wall
-- epoch seconds); stale or missing = UNKNOWN for the reader. A read that fails changes only try/tried_at (no new information).
local SCREENS_DIR = CTL .. "/screens"
local function screenRound(cx)
  local okP, panes = pcall(function() return cx.session:panes() end)
  if not okP or type(panes) ~= "table" then return end -- UNKNOWN round: nothing learned, nothing changed
  screen.prune(screens, panes)
  local id = screen.pick(screen.eligible(panes, classify.agent_for), lastScreenPane)
  if id ~= nil then
    lastScreenPane = id
    local p = nil
    for _, x in ipairs(panes) do if x.pane == id then p = x end end
    local okR, read = pcall(function() return cx.session:read(id, { as = "table", lines = 24, scrollback = true }) end)
    local okW, wall = pcall(os.time)
    local program = p and p.program
    screen.record(screens, id, okR and read or nil, program, p and p.title, classify.agent_for(program), classify.classify, tern.now(),
      (okW and wall) or 0)
  end
  pcall(function()
    if not tern.fs.exists(SCREENS_DIR) then tern.fs.mkdir(SCREENS_DIR) end
    tern.fs.write(SCREENS_DIR .. "/" .. VM_ID .. ".json", tern.json.encode({ vm = VM_ID, window = WINDOW_KEY, ts = tern.now(), screens = screen.publicAll(screens) }))
  end)
end
tern.command({ id = "screen", title = "agenthop bridge: classify one TUI pane", run = function(cx) ensure(); screenRound(cx) end })
tern.command({ id = "drain", title = "agenthop bridge: drain requests", run = function(cx) ensure(); pcall(function() drain(cx, false) end) end })
tern.command({ id = "drain-start", title = "agenthop bridge: drain start requests", run = function(cx) ensure(); pcall(function() drain(cx, true) end) end })

mirrorTimer(nil, timerGen) -- A1 best-effort mirror chain on the TIMER hook (the swarm-triggered `mirror` command is the primary driver)
-- r4: NO arm on the timer hook — that hook now carries the mirror chain, and the arm's three cross-VM tern.carly calls must not be
-- able to disable it. Arming runs only on the `arm` command (its own hook), which the swarm triggers after every load/reload.

-- r10 test seam: the chunk's RETURN value (Tern ignores a plugin chunk's return; the fixture reads it). NEVER write globals — Tern's
-- plugin VM _G is READ-ONLY (r9's `_G.__bridge_test = …` raised "attempt to modify a readonly table" at load and muted the plugin live).
return { armScan = armScan, armCancelNext = armCancelNext }
