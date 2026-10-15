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
-- r6 CHEAP SOURCE (coordinator's live split timing, clean VM): cx.agents:list() costs ~28ms (8 agents; cross-session aggregation +
-- last_message text) and tern.json.encode of its result another ~25ms (18 KB) — together the 40-50ms+ tick that killed every hook in
-- r1-r4. cx.session:panes() costs ~0.17ms and its PaneInfo already carries what the mirror publishes. So the mirror NEVER calls
-- agents:list(): it filters panes() to kind=="agent" and builds a minimal table (target <2KB, <3ms/tick). model/state/last_message are
-- not on PaneInfo and are dropped from the tick; the `list` op (request path, not the tick) still returns the full agents:list().
local agentPanes = claim.slimAgents -- r7: one shared source with the `list` op (claim.luau)

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
    phase_ms = lastPhase, -- previous completed tick's cumulative ms per segment
    agents = (#agents > 0) and agents or tern.json.array({}),
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
      local okPeek, peek = pcall(function() return tern.fs.read(path) end)
      local isStart = okPeek and type(peek) == "string" and peek:find('"op"%s*:%s*"start"') ~= nil
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
local function registerSentinel()
  local status = { ts = tern.now(), scheduled = false }
  local okSrc, src = pcall(function() return tern.fs.read("sentinel.luau") end)
  if not okSrc or type(src) ~= "string" then
    status.error = "sentinel.luau unreadable" -- the bridge (A1) still runs without the sentinel
  else
    pcall(function()
      for _, t in ipairs(tern.carly.tasks()) do
        if t.title == PATROL_TITLE then
          pcall(function() tern.carly.cancel(t.id) end)
        end
      end
    end)
    local okSched, idOrErr = pcall(function()
      return tern.carly.schedule({ title = PATROL_TITLE, when = "every 1m", check = src })
    end)
    status.scheduled = okSched
    if okSched then
      status.id = idOrErr
    else
      status.error = tostring(idOrErr)
    end
  end
  local okWrite = pcall(function() tern.fs.write(CTL .. "/sentinel.json", tern.json.encode(status)) end)
  return okWrite -- only "armed" once the status is durably recorded (dir now ensured first)
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
local sentinelArmed = false
local function arm(cx)
  if cx == nil or sentinelArmed then return end
  ensure() -- TA-A2-ARM: control dirs exist BEFORE arming, so the sentinel.json write cannot ENOENT on first boot
  if registerSentinel() then
    sentinelArmed = true -- else leave false: a later timer/`arm` command retries (dedup-by-title makes the retry safe)
  end
end

local function mirrorTick(cx)
  ensure()
  mirror(cx) -- no tern.carly.* here: the await hook carries ONLY the cheap mirror
end

-- r4 ①: the mirror is OFF the await hook. Primary driver = the `mirror` COMMAND (its own hook `command mirror`) triggered by the swarm
-- sweep every ~5s (`tern ctl plugins run plugin.agenthop-agents-bridge.mirror`); a slow call there disables only that command until
-- reload, never drains or arm. Secondary = a best-effort self-renewing `tern.timer` chain on the TIMER hook (not await); if Tern ever
-- disables the timer hook the chain stops and the command-driven mirror carries liveness alone. Each timer tick renews BEFORE working.
local function mirrorTimer(cx)
  tern.timer(POLL_MS, function(nextCx) mirrorTimer(nextCx) end)
  if cx ~= nil then mirrorTick(cx) end
end

tern.command({ id = "arm", title = "agenthop bridge: arm patrol sentinel", run = function(cx) sentinelArmed = false; arm(cx) end })
tern.command({ id = "mirror", title = "agenthop bridge: mirror now", run = function(cx) mirrorTick(cx) end })
tern.command({ id = "drain", title = "agenthop bridge: drain requests", run = function(cx) ensure(); pcall(function() drain(cx, false) end) end })
tern.command({ id = "drain-start", title = "agenthop bridge: drain start requests", run = function(cx) ensure(); pcall(function() drain(cx, true) end) end })

mirrorTimer(nil) -- A1 best-effort mirror chain on the TIMER hook (the swarm-triggered `mirror` command is the primary driver)
-- r4: NO arm on the timer hook — that hook now carries the mirror chain, and the arm's three cross-VM tern.carly calls must not be
-- able to disable it. Arming runs only on the `arm` command (its own hook), which the swarm triggers after every load/reload.
