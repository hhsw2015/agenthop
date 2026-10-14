#!/usr/bin/env lua
-- Fixture for the window-half WIRING (the fs/cx glue that the pure fixtures can't reach). Loads the PRODUCTION
-- window.luau under Lua 5.5 with a fake `tern`/`cx` and an in-memory, fault-injectable filesystem -- the same file
-- Tern loads via its window entry -- so there is no mirror copy. Covers:
--   TE-SOURCE-UNKNOWN  — a read/list FAULT is UNKNOWN (fail / null / keep-last-good), never a false 0/empty/env-default.
--   TE-SNAPSHOT-COMMIT — the canvas mirror + success toast only happen when the authoritative write succeeded.
--   TE-FOCUS           — a focus failure surfaces an error toast (not swallowed).
--   TE-SOURCE-PATH     — wayfinding points at the REAL source read (env override), not a hardcoded default.
--   TE-ACTIVE-LABEL    — the snapshot's "active reviews" counts ACTIVE rows, raw rows shown separately.
-- Faults are injected via the fake tern APIs — NOT a claim of real EACCES.
--
-- Run from the plugin dir:  lua test/window.test.lua

local here = (arg[0] or ""):match("^(.*/)") or "./"
local PLUGIN = here .. ".."

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then
    failures = failures + 1
  end
end

-- ---- JSON: array marker + null sentinel + an encoder that renders the sentinel as `null` ------------------------
local ARRAY = {}
local JNULL = setmetatable({}, { __tostring = function() return "null" end })
local ESC = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function enc(v)
  if v == nil or v == JNULL then
    return "null"
  end
  local tv = type(v)
  if tv == "boolean" then
    return v and "true" or "false"
  elseif tv == "number" then
    if v == math.floor(v) then
      return string.format("%d", v)
    end
    return tostring(v)
  elseif tv == "string" then
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
      return ESC[c] or string.format("\\u%04x", string.byte(c))
    end) .. '"'
  elseif tv == "table" then
    local marked = getmetatable(v) == ARRAY
    local n, seq = 0, true
    for k in pairs(v) do
      if type(k) ~= "number" then
        seq = false
        break
      end
      n = n + 1
    end
    if marked or (seq and n > 0) then
      local len = marked and #v or n
      local parts = {}
      for i = 1, len do
        parts[i] = enc(v[i])
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do
      keys[#keys + 1] = k
    end
    table.sort(keys, function(a, b)
      return tostring(a) < tostring(b)
    end)
    local parts = {}
    for _, k in ipairs(keys) do
      parts[#parts + 1] = '"' .. tostring(k) .. '":' .. enc(v[k])
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

-- ---- host: a fresh in-memory world + a loaded window.luau wired to it -------------------------------------------
local function newHost(override)
  local HOME = "/h"
  local AGENTHOP = HOME .. "/.agenthop"
  local SWARM = AGENTHOP .. "/swarm"
  local CARLY = AGENTHOP .. "/carly"
  local P = {
    reports = override and (HOME .. "/custom-reports") or (HOME .. "/Work/review-reports"),
    reviewQueue = SWARM .. "/review-queue",
    board = SWARM .. "/board",
    decisions = AGENTHOP .. "/console/decision-batches",
    alerts = CARLY .. "/alerts",
    inbox = AGENTHOP .. "/inbox/sid1",
    carly = CARLY,
    progress = SWARM .. "/PROGRESS.md",
    flags = SWARM .. "/dispatcher.log",
    snapshot = CARLY .. "/canvas-snapshot.md",
    batchJson = AGENTHOP .. "/console/decision-batches/batch-one/batch.json",
  }

  local files, dirs, existing, decode = {}, {}, {}, {}
  local err = { read = {}, list = {}, write = {}, exists = {} }
  local reads, lists, writes = 0, 0, 0

  local function putFile(path, text)
    files[path] = text
    existing[path] = true
  end
  local function putJson(path, obj)
    local text = enc(obj)
    decode[text] = obj
    putFile(path, text)
  end
  local function putDir(path, names)
    dirs[path] = names or {}
    existing[path] = true
  end

  -- standard world
  putDir(P.carly, {})
  putDir(P.reports, { "seat-active-review-queue.json" })
  putDir(P.reviewQueue, {})
  putDir(P.board, { "work.claimed.sid.json" })
  putDir(P.decisions, { "batch-one" })
  putDir(P.alerts, { "alert.json" })
  putDir(P.inbox, { "message.json" })
  existing[P.batchJson] = true -- batch-one HAS batch.json, no consumed.json => one unresolved ruling
  putJson(P.reports .. "/seat-active-review-queue.json", { active = { task = "thing-r2", sha = "abc1234" } })
  putFile(P.progress, "## 周期 #1(older)\none\n## 周期 #2(newer)\ntwo\n")
  putFile(P.flags, "flags: BOARD_ADMIT=off REVIEW_AUTOSCALE=on TG_ENTRY=off (defaults)\n")
  putFile(P.snapshot, "OLD-SNAPSHOT")
  putFile("snapshot-check.luau", "return function() end") -- plugin-relative source read by armSchedule

  local herdrObj = {
    result = { snapshot = { agents = { {
      agent_session = { value = "sid1" },
      terminal_title_stripped = "Fixture Agent",
      agent_status = "working",
      pane_id = "w1:p1",
    } } } },
  }
  local herdrText = enc(herdrObj)
  decode[herdrText] = herdrObj
  decode["{}"] = {}
  local response = { status = 0, stdout = herdrText }

  -- fake tern
  local tern = { plugin = { id = "swarm-observatory" }, now = function() return 1000000000 end }
  tern.getenv = function(k)
    if k == "HOME" then
      return HOME
    elseif k == "SWARM_REVIEW_REPORTS" and override then
      return P.reports
    end
    return nil
  end
  tern.fs = {
    exists = function(p)
      if err.exists[p] then
        error("exists fault: " .. p)
      end
      return existing[p] == true
    end,
    read = function(p)
      reads = reads + 1
      if err.read[p] then
        error("EACCES read: " .. p)
      end
      return files[p]
    end,
    list = function(p)
      lists = lists + 1
      if err.list[p] then
        error("EACCES list: " .. p)
      end
      return dirs[p] or {}
    end,
    write = function(p, text)
      writes = writes + 1
      if err.write[p] then
        error("EACCES write: " .. p)
      end
      files[p] = text
      existing[p] = true
    end,
    mkdir = function(p)
      existing[p] = true
      dirs[p] = dirs[p] or {}
    end,
  }
  tern.json = {
    encode = enc,
    decode = function(t)
      local o = decode[t]
      if o == nil then
        error("no fixture decode for: " .. tostring(t))
      end
      return o
    end,
    array = function(t)
      return setmetatable(t, ARRAY)
    end,
    null = JNULL,
  }
  local kv = {}
  tern.kv = { get = function(k) return kv[k] end, set = function(k, v) kv[k] = v end }
  local pending = nil
  tern.process = { run = function(argv, opts, cb)
    assert(argv[2] == "api" and argv[3] == "snapshot")
    pending = cb
  end }
  local exports, context, scheduled = {}, nil, nil
  tern.carly = {
    export = function(n, meta, fn) exports[n] = { meta = meta, fn = fn } end,
    context = function(fn) context = fn end,
    tasks = function() return {} end,
    cancel = function() end,
    schedule = function(spec) scheduled = spec; return 1 end,
  }
  local commands, routeFn, events = {}, nil, {}
  tern.command = function(c) commands[c.id] = c end
  tern.route = { link = function(fn) routeFn = fn end }
  tern.on = function(n, fn) events[n] = fn end
  tern.timer = function() end

  -- fake cx
  local canvas = "OLD-CANVAS"
  local toasts, focuses = {}, {}
  local failFocus = false
  local cx = {}
  cx.canvas = {
    list = function() return { { owner = "swarm-observatory", title = "Swarm cold-start", pane = 9 } } end,
    set = function(_, pane, o) canvas = o.md end,
    open = function(_, o) canvas = o.md; return 9 end,
  }
  cx.layout = { focus = function(_, pane)
    if failFocus then
      error("focus fault")
    end
    focuses[#focuses + 1] = pane
  end }
  cx.session = { resolve = function(_, spec)
    if spec == "Fixture Agent" then
      return 9
    end
    return nil
  end }
  function cx:toast(kind, title, body)
    toasts[#toasts + 1] = { kind = kind, title = title, body = body }
  end
  function cx:action(id)
    assert(id == "plugin.swarm-observatory.refresh")
    commands.refresh.run(cx)
  end

  -- load the PRODUCTION window.luau in an env wired to the fakes
  local mods = {}
  local env = setmetatable({ tern = tern, os = os }, { __index = _G })
  env.require = function(n)
    assert(n == "./budget" or n == "./parse" or n == "./snapshot", "unexpected require: " .. tostring(n))
    if not mods[n] then
      mods[n] = assert(loadfile(PLUGIN .. "/" .. n:sub(3) .. ".luau"))()
    end
    return mods[n]
  end
  assert(loadfile(PLUGIN .. "/window.luau", "t", env))()

  local function invoke(name, a)
    local call = {}
    function call:reply(v) self.value = v end
    function call:fail(e) self.error = e end
    function call:wait(_) return "WAIT" end
    local fn = exports[name].fn
    if name == "swarm_status" then
      local ret = fn(cx, call)
      assert(ret == "WAIT" and pending, "swarm_status must register a process cb and wait")
      local cb = pending
      pending = nil
      cb(response)
      return call.value, call.error
    end
    local ret
    if name == "swarm_progress" then
      ret = fn(a, cx, call)
    else
      ret = fn(cx, call)
    end
    if call.error ~= nil then
      return nil, call.error
    end
    if ret == "WAIT" then
      return call.value, call.error
    end
    return ret, nil
  end

  return {
    paths = P,
    jnull = JNULL,
    err = err,
    invoke = invoke,
    refreshCmd = function() commands.refresh.run(cx) end, -- runs the refresh command (fix 2 toast discipline)
    coldstart = function() if events.window_start then events.window_start(cx) end end,
    context = function() return context and context(cx) or nil end,
    route = function(url) return routeFn({ url = url }, cx) end,
    canvas = function() return canvas end,
    snapshotFile = function() return files[P.snapshot] end,
    setResponseStdout = function(s) response.stdout = s end,
    putJson = putJson,
    putFile = putFile,
    putDir = putDir,
    setFailFocus = function(v) failFocus = v end,
    toasts = toasts,
    focuses = focuses,
    ioCounts = function() return reads, lists, writes end,
  }
end

local function lastToast(h)
  return h.toasts[#h.toasts]
end

-- ================================================================================================================
-- normal: all four exports return real data; refresh double-writes; context reads the kv only.
-- ================================================================================================================
do
  local h = newHost(false)
  local st, es = h.invoke("swarm_status")
  local q, eq = h.invoke("swarm_queue")
  local pr, ep = h.invoke("swarm_progress", 20)
  local fl, ef = h.invoke("swarm_flags")
  ck("normal swarm_status ok, 1 seat", es == nil and st and #st.seats == 1)
  ck("normal swarm_status inboxDepth = 1 (message.json)", st.seats[1].inboxDepth == 1)
  ck("normal swarm_queue ok, 1 review (reviewing)", eq == nil and q and #q.reviews == 1 and q.reviews[1].state == "reviewing")
  ck("normal swarm_progress ok, 2 cycles", ep == nil and pr and #pr.cycles == 2)
  ck("normal swarm_flags ok, BOARD_ADMIT=off (from the log, not env)", ef == nil and fl and fl.flags.BOARD_ADMIT == "off")
  ck("normal swarm_flags opt-in TG_ENTRY off -> dormant", fl.flags.TG_ENTRY == "dormant")

  h.refreshCmd()
  ck("normal refresh: snapshot file == canvas mirror (double-write)", h.snapshotFile() == h.canvas())
  ck("normal refresh: success toast emitted", lastToast(h).kind == "success")
  local r1, l1, w1 = h.ioCounts()
  local ctx = h.context()
  local r2, l2, w2 = h.ioCounts()
  ck("normal context one-liner = 在审1|候裁1|告警1", ctx == "在审1|候裁1|告警1")
  ck("normal context performs NO fs IO (reads kv only)", r1 == r2 and l1 == l2 and w1 == w2)
end

-- ================================================================================================================
-- TE-SOURCE-UNKNOWN: a read/list FAULT is UNKNOWN -> fail / null / keep-last-good; never a false 0/empty/env-default.
-- ================================================================================================================
do
  local h = newHost(false)
  h.refreshCmd() -- build a good kv cache first
  local before = h.context()
  ck("source-unknown: good cache before faults = 在审1|候裁1|告警1", before == "在审1|候裁1|告警1")

  for _, p in ipairs({ h.paths.reports, h.paths.reviewQueue, h.paths.board, h.paths.decisions, h.paths.alerts, h.paths.inbox }) do
    h.err.list[p] = true
  end
  h.err.read[h.paths.progress] = true
  h.err.read[h.paths.flags] = true

  local st, es = h.invoke("swarm_status")
  local q, eq = h.invoke("swarm_queue")
  local pr, ep = h.invoke("swarm_progress", 20)
  local fl, ef = h.invoke("swarm_flags")

  ck("source-unknown: swarm_status still replies (herdr shape ok), no error", es == nil and st and #st.seats == 1)
  ck("source-unknown: seat inboxDepth is UNKNOWN (json null), NOT 0", st.seats[1].inboxDepth == h.jnull and st.seats[1].inboxDepth ~= 0)
  ck("source-unknown: swarm_queue FAILS (not an empty queue)", q == nil and type(eq) == "string" and eq:find("unreadable", 1, true) ~= nil)
  ck("source-unknown: swarm_progress FAILS (not an empty history)", pr == nil and type(ep) == "string" and ep:find("unreadable", 1, true) ~= nil)
  ck("source-unknown: swarm_flags FAILS (does NOT fall back to env defaults)", fl == nil and type(ef) == "string" and ef:find("unreadable", 1, true) ~= nil)

  h.refreshCmd() -- updateCountsKv must SKIP on unknown -> context keeps the last-good value, no false zeros
  ck("source-unknown: context KEEPS last-good (no flip to 在审0|候裁0|告警0)", h.context() == "在审1|候裁1|告警1")
end

-- ================================================================================================================
-- TE-SOURCE-UNKNOWN face 1 (r3): a per-batch batch.json EXISTS-probe fault is UNKNOWN -> keep the last-good 候裁,
-- never fold the probe fault to a false count (which hid an awaiting-ruling batch: 候裁 1 -> 0).
-- ================================================================================================================
do
  local h = newHost(false)
  h.refreshCmd() -- good cache: batch-one has batch.json + no consumed.json => 候裁 1
  local before = h.context()
  ck("ruling-probe-fault: good cache = 在审1|候裁1|告警1", before == "在审1|候裁1|告警1")
  h.err.exists[h.paths.batchJson] = true -- the batch-one batch.json existence probe now throws
  h.refreshCmd() -- countRulingBatches -> unknown -> updateCountsKv SKIPS -> last-good kept (NOT 候裁 0)
  ck("ruling-probe-fault: 候裁 kept (NOT folded to a false 0) when batch.json probe faults", h.context() == before)
end

-- ================================================================================================================
-- TE-SOURCE-UNKNOWN face 2 (r3): a corrupt review-report (decode error / non-table root / wrong-type known field) is
-- UNKNOWN, not a legal empty queue -> swarm_queue FAILS + context keeps last-good (never 在审 1 -> 0).
-- ================================================================================================================
do
  local cases = {
    { name = "decode-error {broken", apply = function(h, p) h.putFile(p, "{broken") end },       -- unregistered text => decode errors
    { name = "non-table root 123", apply = function(h, p) h.putJson(p, 123) end },               -- decodes to a number
    { name = "wrong-type active", apply = function(h, p) h.putJson(p, { active = "not-a-record" }) end },
    -- r4: a valid bucket holding bad records (validate to the leaf, not the container)
    { name = "pending=[123] non-table elem", apply = function(h, p) h.putJson(p, { pending = { 123 } }) end },
    { name = "pending map-not-array", apply = function(h, p) h.putJson(p, { pending = { task = "queued-r1", sha = "abc1234" } }) end },
    { name = "active.sha wrong leaf", apply = function(h, p) h.putJson(p, { active = { task = "thing-r2", sha = { bad = true } } }) end },
  }
  for _, c in ipairs(cases) do
    local h = newHost(false)
    local reportPath = h.paths.reports .. "/seat-active-review-queue.json"
    h.refreshCmd()
    local before = h.context()
    c.apply(h, reportPath) -- replace the valid report with a corrupt payload
    local q, eq = h.invoke("swarm_queue")
    ck("corrupt-queue [" .. c.name .. "]: swarm_queue FAILS (not reviews=[])", q == nil and type(eq) == "string")
    h.refreshCmd()
    ck("corrupt-queue [" .. c.name .. "]: context keeps last-good (not 在审 0)", h.context() == before)
  end
end

-- ================================================================================================================
-- TE-SOURCE-UNKNOWN backup loop (r4): the backup review-queue dir is the SECOND input ring. A row whose known leaf is
-- the wrong type (e.g. state a table) must be UNKNOWN too -> swarm_queue FAILS + context keeps last-good (never 在审 0).
-- ================================================================================================================
do
  local h = newHost(false)
  h.refreshCmd()
  local before = h.context() -- 在审1|候裁1|告警1 (from the reports loop)
  local qfile = h.paths.reviewQueue .. "/happycapy-active-review-queue.json"
  h.putDir(h.paths.reviewQueue, { "happycapy-active-review-queue.json" })
  h.putJson(qfile, { item = "thing-r1", sha = "abc1234", state = { bad = true } }) -- state wrong leaf type
  local q, eq = h.invoke("swarm_queue")
  ck("backup-queue bad row: swarm_queue FAILS (not an exported object-state row)", q == nil and type(eq) == "string")
  h.refreshCmd()
  ck("backup-queue bad row: context keeps last-good (not 在审 0)", h.context() == before)
  -- positive control: a well-typed backup row is accepted and adds a reviewing review
  local h2 = newHost(false)
  h2.putDir(h2.paths.reviewQueue, { "happycapy-active-review-queue.json" })
  h2.putJson(h2.paths.reviewQueue .. "/happycapy-active-review-queue.json", { item = "extra-r1", sha = "def5678", state = "reviewing" })
  local q2, eq2 = h2.invoke("swarm_queue")
  ck("backup-queue good row: swarm_queue ok, 2 reviews", eq2 == nil and q2 and #q2.reviews == 2)
end

-- ================================================================================================================
-- TE-SOURCE-UNKNOWN (swarm_status shape): a snapshot lacking .result.snapshot.agents is UNKNOWN, not zero seats.
-- ================================================================================================================
do
  local h = newHost(false)
  h.setResponseStdout("{}")
  local st, es = h.invoke("swarm_status")
  ck("bad-shape: swarm_status FAILS (not empty seats)", st == nil and type(es) == "string")
end

-- ================================================================================================================
-- TE-SNAPSHOT-COMMIT: on write failure keep the old canvas + error toast; never success-toast a failed refresh.
-- ================================================================================================================
do
  local h = newHost(false)
  h.err.write[h.paths.snapshot] = true
  h.refreshCmd()
  ck("snapshot-commit: authoritative file unchanged (OLD-SNAPSHOT)", h.snapshotFile() == "OLD-SNAPSHOT")
  ck("snapshot-commit: canvas mirror unchanged (OLD-CANVAS)", h.canvas() == "OLD-CANVAS")
  ck("snapshot-commit: last toast is an ERROR (not success)", lastToast(h).kind == "error")
  local successes = 0
  for _, t in ipairs(h.toasts) do
    if t.kind == "success" then
      successes = successes + 1
    end
  end
  ck("snapshot-commit: no success toast at all", successes == 0)
end

-- ================================================================================================================
-- TE-FOCUS: a focus failure surfaces an error toast; resolve-nil and unknown subtype also toast; files pass through.
-- ================================================================================================================
do
  local h = newHost(false)
  ck("route: non-swarm url passes through (nil)", h.route("https://example.invalid/") == nil)
  local f = h.route("swarm://file/private/fact.md")
  ck("route: swarm://file rewrites to a path", type(f) == "table" and f.path == "/private/fact.md")
  h.route("swarm://bogus/x")
  ck("route: unknown subtype toasts error", lastToast(h).kind == "error")
  h.route("swarm://pane/missing")
  ck("route: unresolved seat toasts error", lastToast(h).kind == "error")

  local before = #h.toasts
  local okOut = h.route("swarm://pane/9")
  ck("route: resolved pane focuses, handled, NO new toast", okOut.handled == true and h.focuses[#h.focuses] == 9 and #h.toasts == before)

  local before2 = #h.toasts
  h.setFailFocus(true)
  local out = h.route("swarm://pane/9")
  ck("focus-fails: handled=true AND a NEW error toast (focus error not swallowed)",
    out.handled == true and #h.toasts == before2 + 1 and lastToast(h).kind == "error")
end

-- ================================================================================================================
-- TE-SOURCE-PATH: wayfinding points at the REAL source read (SWARM_REVIEW_REPORTS override), not a hardcoded default.
-- ================================================================================================================
do
  local h = newHost(true) -- SWARM_REVIEW_REPORTS = /h/custom-reports
  local q, eq = h.invoke("swarm_queue")
  ck("source-path: swarm_queue reads the overridden reports dir (1 review)", eq == nil and q and #q.reviews == 1)
  h.refreshCmd()
  local md = h.snapshotFile()
  ck("source-path: snapshot links the REAL custom-reports source", md:find("swarm://file/h/custom-reports", 1, true) ~= nil)
  ck("source-path: snapshot drops the nonexistent ACTIVE-REVIEW-QUEUE.md default", md:find("ACTIVE-REVIEW-QUEUE.md", 1, true) == nil)
end

-- ================================================================================================================
-- TE-ACTIVE-LABEL: a done-only queue is 0 active reviews (rows: 1) in the snapshot; context 在审 is 0.
-- ================================================================================================================
do
  local h = newHost(false)
  h.putJson(h.paths.reports .. "/seat-active-review-queue.json", { completedCurrent = { task = "finished-r1", sha = "abc1234" } })
  h.refreshCmd()
  local md = h.snapshotFile()
  ck("active-label: snapshot says active reviews **0** (rows: 1) for a done-only queue", md:find("active reviews: **0** (rows: 1)", 1, true) ~= nil)
  ck("active-label: context 在审0 (done row is not reviewing)", h.context() == "在审0|候裁1|告警1")
end

print("")
if failures == 0 then
  print("PASS (0 failures)")
  os.exit(0)
else
  print("FAIL (" .. failures .. " failure(s))")
  os.exit(1)
end
