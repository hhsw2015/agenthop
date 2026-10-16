-- agenthop agents-bridge — screen state for TUI seats (#1115 T1b, [liveness]).
--
-- One `screen` command run = AT MOST ONE pane read (cx.session:read, ~23ms live) + one classify (classify.luau, BUDGET_MS = 5)
-- + bookkeeping; the run is far under Tern's 50ms hook budget and runs on its OWN command hook, so a slow run can disable only
-- `screen`, never `mirror` / `drain`. The pane is picked round-robin among this window's panes whose program classify recognises
-- (claude / codex / … — TUI seats; `tern acp` panes report program "tern" and are skipped).
--
-- PUBLISHED STATE follows upstream herdr's publish state machine (src/pane/agent_detection.rs @ 143bf5f; see UPSTREAM-DETECTION.md
-- §4), applied to the samples this bridge gets (one per pane every few seconds) on Tern's MONOTONIC clock (tern.now, ms):
--   * startup grace: a pane seen for the first time (or whose agent changed) publishes "unknown" and is not classified for
--     STARTUP_GRACE_MS; the sample on which the grace expires is skipped too (as upstream).
--   * skip_state_update rule matched ⇒ no publish, pending idle cleared.
--   * working → plain idle (not visible_idle / visible_blocker): HOLD; publish idle at the 4th consecutive idle sample or once
--     PENDING_IDLE_CAP_MS has passed since the first one; any other sample clears the hold. working → visible_idle ⇒ immediate.
--   * → working, → blocked ⇒ immediate; a continuing visible blocker is re-published every STABLE_REFRESH_MS.
--   * upstream does NOT treat PTY bytes as working; it only skips re-reading an idle pane whose content counter did not move. The
--     plugin VM cannot see PTY bytes, so this port always reads the chosen pane (cost is bounded by one read per run).
-- Recorded per pane (the JSON the readers merge):
--   state / rule / agent / visible_*   — the PUBLISHED values
--   observed_at                        — wall-clock epoch seconds of the last sample that confirmed the published state
--   try / tried_at                     — the LAST attempt: "ok" | "grace" | "held" | "skip" | "unreadable" | "slow" | "error"
-- UNKNOWN: a failed read, a slow or raising classify changes only try/tried_at — no new information is never idle. Readers treat a
-- missing entry or an observation older than their freshness limit as UNKNOWN.
--
-- Lua 5.5 ∩ Luau subset (as sentinel.luau): loaded by window.luau in Tern and by test/screen.test.lua in plain Lua.

local M = {}

M.STARTUP_GRACE_MS = 3000   -- AGENT_STARTUP_GRACE_WINDOW
M.PENDING_IDLE_CONFIRMATIONS = 3
M.PENDING_IDLE_CAP_MS = 700 -- AGENT_PENDING_IDLE_CAP
M.STABLE_REFRESH_MS = 800   -- STABLE_VISIBLE_SIGNAL_REFRESH

-- next pane to read: round-robin over `eligible` (sorted pane ids), continuing after `last`. nil when there is none. Pure.
function M.pick(eligible, last)
  if #eligible == 0 then return nil end
  if last ~= nil then
    for _, id in ipairs(eligible) do
      if id > last then return id end
    end
  end
  return eligible[1]
end

-- panes this window can classify, as sorted ids. `agentFor(program)` is classify.agent_for. Pure.
function M.eligible(panes, agentFor)
  local out = {}
  for _, p in ipairs(panes or {}) do
    if type(p.pane) == "number" and p.exited == nil and agentFor(p.program) ~= nil then out[#out + 1] = p.pane end
  end
  table.sort(out)
  return out
end

local function vis(cls, name, state) return cls[name] == true and cls.state == state end -- upstream masks each flag by state

-- One sample for `pane`. `states` is keyed by tostring(pane id) (ids are ~1e13: as numeric keys a JSON encoder sees a sparse array).
-- `read` = the BlockRead or nil, `agent` = classify.agent_for(program), `mono` = monotonic ms, `wall` = epoch seconds. Pure.
function M.record(states, pane, read, program, title, agent, classify, mono, wall)
  local key = tostring(pane)
  local prev = states[key]
  local e = {}
  if prev ~= nil then for k, v in pairs(prev) do e[k] = v end end
  e.tried_at = wall
  states[key] = e

  -- a new pane, or its agent changed ⇒ unknown + grace (upstream: state Unknown, flags cleared, grace until now + 3s)
  if prev == nil or prev.agent ~= agent then
    e.state, e.rule, e.agent = "unknown", nil, agent
    e.visible_idle, e.visible_blocker, e.visible_working = false, false, false
    e.grace_until, e.pending_since, e.pending_n, e.refreshed = mono + M.STARTUP_GRACE_MS, nil, nil, nil
    e.observed_at, e.try = wall, "grace"
    return e
  end
  if e.grace_until ~= nil then
    if mono < e.grace_until then e.try = "grace"; return e end
    e.grace_until = nil; e.try = "grace" -- upstream skips the tick on which the grace expires too
    return e
  end

  if type(read) ~= "table" or type(read.lines) ~= "table" or #read.lines == 0 then e.try = "unreadable"; return e end
  local ok, cls = pcall(classify, read.lines, title, program)
  if not ok or type(cls) ~= "table" or type(cls.state) ~= "string" then e.try = "error"; return e end
  if cls.rule == "slow" then e.try = "slow"; return e end -- classify's own budget ran out: no new information
  if cls.skip_state_update == true then e.pending_since, e.pending_n = nil, nil; e.try = "skip"; return e end

  local nv = { idle = vis(cls, "visible_idle", "idle"), blocker = vis(cls, "visible_blocker", "blocked"), working = vis(cls, "visible_working", "working") }
  -- working → plain idle: hold (upstream should_hold_working_to_idle)
  if e.state == "working" and cls.state == "idle" and not nv.idle and not nv.blocker then
    if e.pending_since == nil then
      e.pending_since, e.pending_n = mono, 0
      e.try = "held"; return e
    end
    e.pending_n = e.pending_n + 1
    if mono - e.pending_since < M.PENDING_IDLE_CAP_MS and e.pending_n < M.PENDING_IDLE_CONFIRMATIONS then
      e.try = "held"; return e
    end
  end
  e.pending_since, e.pending_n = nil, nil

  local changed = cls.state ~= e.state or nv.idle ~= e.visible_idle or nv.blocker ~= e.visible_blocker or nv.working ~= e.visible_working
  local refresh = nv.blocker and e.visible_blocker and (e.refreshed == nil or mono - e.refreshed >= M.STABLE_REFRESH_MS)
  if changed or refresh then
    e.state, e.rule = cls.state, cls.rule
    e.visible_idle, e.visible_blocker, e.visible_working = nv.idle, nv.blocker, nv.working
    e.refreshed = (nv.blocker or nv.working) and mono or nil
  end
  e.observed_at = wall -- this sample confirmed (or set) the published state
  e.try = "ok"
  return e
end

-- drop entries for panes that are gone from this window (so a closed seat does not keep a stale state forever). Pure.
function M.prune(states, livePanes)
  local live = {}
  for _, p in ipairs(livePanes or {}) do if type(p.pane) == "number" then live[tostring(p.pane)] = true end end
  for id in pairs(states) do if not live[id] then states[id] = nil end end
end

-- the JSON view of one entry (drops the internal clock fields, which are on Tern's monotonic clock and mean nothing elsewhere)
function M.public(e)
  return { state = e.state, rule = e.rule, agent = e.agent, visible_idle = e.visible_idle == true, visible_blocker = e.visible_blocker == true,
    visible_working = e.visible_working == true, observed_at = e.observed_at, try = e.try, tried_at = e.tried_at }
end
function M.publicAll(states)
  local out = {}
  for k, e in pairs(states) do out[k] = M.public(e) end
  return out
end

return M
