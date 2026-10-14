-- Swarm Observatory — window half (Luau; Carly lives only in the window context).
--
-- Line 2 of the Tern-adoption parallel contract (docs/swarm/tern-batch2-contracts.md section 2):
--   A6 — a cold-start canvas + an authoritative Markdown snapshot, wayfinding whose every line is a durable file
--        path, refreshed by a 1-minute promptless check or an explicit command.
--   A8 v1 — four READ-ONLY Carly observation exports (swarm_status / swarm_queue / swarm_progress / swarm_flags),
--        each capped at 16 KiB JSON with a `truncated` flag. Frozen signatures (contract-first).
--
-- Everything read-only over herdr + the durable swarm files; the ONLY write is the snapshot this plugin owns
-- (~/.agenthop/carly/canvas-snapshot.md) plus the canvas pane. Pure logic lives in budget.luau / parse.luau /
-- snapshot.luau (also unit-tested under Lua 5.5); this file only wires the tern/cx I/O to them.

local budget = require("./budget")
local parse = require("./parse")
local snapshot = require("./snapshot")

-- ---- paths (all read-only except SNAPSHOT) ---------------------------------------------------------------------
local HOME = tern.getenv("HOME") or ""
local AGENTHOP = HOME .. "/.agenthop"
local INBOX_DIR = AGENTHOP .. "/inbox"
local SWARM_DIR = AGENTHOP .. "/swarm"
local CARLY_DIR = AGENTHOP .. "/carly"
local DECISION_BATCHES = AGENTHOP .. "/console/decision-batches" -- 候裁M source: one dir per 呈批 batch, RESOLVED iff it has consumed.json (decision-batch-v1)
local DISPATCH_LOG = SWARM_DIR .. "/dispatcher.log"
local PROGRESS = SWARM_DIR .. "/PROGRESS.md"
local BOARD_DIR = SWARM_DIR .. "/board"
local REVIEW_QUEUE_DIR = SWARM_DIR .. "/review-queue"
local REVIEW_REPORTS = tern.getenv("SWARM_REVIEW_REPORTS") or (HOME .. "/Work/review-reports")
local ALERTS_DIR = CARLY_DIR .. "/alerts" -- A2 sentinel's alert files (read-only here); counted for 告警K
local SNAPSHOT = CARLY_DIR .. "/canvas-snapshot.md" -- the ONE file this plugin writes
local HERDR = tern.getenv("HERDR_BIN") or (HOME .. "/.local/bin/herdr")

local CANVAS_TITLE = "Swarm cold-start"
local ABOUT = "Cold-start wayfinding for the agenthop swarm. Each line points at a durable file; the fact is always in the file. Authoritative snapshot: ~/.agenthop/carly/canvas-snapshot.md. Read-only observatory; no actions."
local SCHED_TITLE = "swarm observatory snapshot"

-- ---- small safe I/O wrappers -----------------------------------------------------------------------------------
-- FC-2 three-state I/O: a READ/LIST FAULT is UNKNOWN and must never be folded to a false zero/empty/env-default.
-- We gate on tern.fs.exists so a confirmed-absent source (ENOENT) is distinguished from an unreadable one (fault).
-- The documented null sentinel for an unknown optional field (per Tern: "unknown optional fields are tern.json.null").
local JSON_NULL = tern.json.null

local function nowTs()
  local ok, t = pcall(function()
    return os.time()
  end)
  if ok and type(t) == "number" then
    return t
  end
  return math.floor(tern.now() / 1000) -- fallback: monotonic-derived, still a number
end

-- true / false / nil(=the exists check itself faulted, so we cannot tell absent from present => treat as unknown)
local function existsSafe(path)
  local ok, yes = pcall(function()
    return tern.fs.exists(path)
  end)
  if not ok then
    return nil
  end
  return yes and true or false
end

-- readFileState(path) -> status, text :  "ok",text | "absent",nil | "unknown",nil
local function readFileState(path)
  local ex = existsSafe(path)
  if ex == nil then
    return "unknown", nil
  end
  if not ex then
    return "absent", nil -- confirmed-absent (ENOENT): a real empty, NOT a fault
  end
  local ok, txt = pcall(function()
    return tern.fs.read(path)
  end)
  if ok and type(txt) == "string" then
    return "ok", txt
  end
  return "unknown", nil -- present but unreadable: a fault
end

-- listDirState(path) -> status, names :  "ok",names | "absent",{} | "unknown",{}
local function listDirState(path)
  local ex = existsSafe(path)
  if ex == nil then
    return "unknown", {}
  end
  if not ex then
    return "absent", {}
  end
  local ok, names = pcall(function()
    return tern.fs.list(path)
  end)
  if ok and type(names) == "table" then
    return "ok", names
  end
  return "unknown", {}
end

-- inbox depth = unclaimed top-level .json messages in ~/.agenthop/inbox/<sid>/ (bus semantics, parse.countJsonFiles).
-- A read-fault on the inbox dir is UNKNOWN (JSON null), never a false 0; an absent dir is a real empty (0).
local function inboxDepth(sid)
  if type(sid) ~= "string" or sid == "" then
    return 0
  end
  local status, names = listDirState(INBOX_DIR .. "/" .. sid)
  if status == "unknown" then
    return JSON_NULL
  end
  return parse.countJsonFiles(names)
end

-- Collect every reviewer's active-review-queue into review rows (shared by swarm_queue and the A6 summary count).
-- Returns (reviews, unknownSource): unknownSource is nil when every source was readable (ok or confirmed-absent),
-- or the path of the FIRST unreadable source (a listing fault or a report-file read fault) otherwise. Callers must
-- treat a non-nil unknownSource as UNKNOWN (fail / keep last-good), never as an empty queue.
local function collectReviews()
  local reviews = {}
  local lstatus, names = listDirState(REVIEW_REPORTS)
  if lstatus == "unknown" then
    return reviews, REVIEW_REPORTS
  end
  for _, nm in ipairs(names) do
    local seat = type(nm) == "string" and nm:match("^(.-)%-active%-review%-queue%.json$") or nil
    if seat then
      local fstatus, txt = readFileState(REVIEW_REPORTS .. "/" .. nm)
      if fstatus == "unknown" then
        return reviews, REVIEW_REPORTS .. "/" .. nm
      elseif fstatus == "ok" and txt then
        local okd, obj = pcall(function()
          return tern.json.decode(txt)
        end)
        if okd and type(obj) == "table" then
          for _, r in ipairs(parse.parseReviewQueue(obj, seat)) do
            reviews[#reviews + 1] = r
          end
        end
      end
    end
  end
  -- future-proof: ~/.agenthop/swarm/review-queue/<item>.json, each a ready review row (empty today)
  local qstatus, qnames = listDirState(REVIEW_QUEUE_DIR)
  if qstatus == "unknown" then
    return reviews, REVIEW_QUEUE_DIR
  end
  for _, nm in ipairs(qnames) do
    if type(nm) == "string" and nm:find("%.json$") and not nm:find("^%.") then
      local fstatus, txt = readFileState(REVIEW_QUEUE_DIR .. "/" .. nm)
      if fstatus == "unknown" then
        return reviews, REVIEW_QUEUE_DIR .. "/" .. nm
      elseif fstatus == "ok" and txt then
        local okd, obj = pcall(function()
          return tern.json.decode(txt)
        end)
        if okd and type(obj) == "table" and obj.item then
          local item, round = parse.splitRoundSuffix(tostring(obj.item))
          reviews[#reviews + 1] = {
            item = obj.item or item,
            sha = obj.sha or "",
            seat = obj.seat or "",
            round = obj.round or round,
            state = obj.state or "queued",
          }
        end
      end
    end
  end
  return reviews, nil
end

-- Flag states with FC-2 honesty. Returns (status, flags):
--   "unknown", nil  — dispatcher.log is present but UNREADABLE: callers must NOT fall through to env defaults
--                     (that would flip a logged-off flag to on). swarm_flags fails; the snapshot shows (unavailable).
--   "ok", flags     — a runtime "flags:" line was parsed from the log.
--   "env", flags    — the log is absent (or carries no flags line): the DOCUMENTED env fallback is used.
local function collectFlagsState()
  local status, text = readFileState(DISPATCH_LOG)
  if status == "unknown" then
    return "unknown", nil
  end
  local line = parse.lastFlagsLine(text or "")
  if line then
    return "ok", parse.parseFlagsLine(line)
  end
  return "env", parse.flagsFromEnv(tern.getenv)
end

-- ---- A6: snapshot + canvas (double-write, snapshot authoritative) ----------------------------------------------
local function summarizeFlags(flags)
  local on, off, dormant = 0, 0, 0
  for _, st in pairs(flags) do
    if st == "on" then
      on = on + 1
    elseif st == "off" then
      off = off + 1
    elseif st == "dormant" then
      dormant = dormant + 1
    end
  end
  return "**" .. tostring(on) .. "** on / **" .. tostring(off) .. "** off / **" .. tostring(dormant) .. "** dormant"
end

-- 候裁M = UNRESOLVED DecisionBatch cards (decision-batch-v1): a batch dir (one holding a batch.json — enumerated by the
-- STORE's reality, not a `batch-` name prefix; custom `--batch-id` IDs are valid) with NO committed consumed.json. REAL
-- source (coordinator ruling: NOT a total−reviewing proxy — different dimensions, "numbers must not lie"). consumed.json
-- is the terminal sealed marker (decision-batch-store); its absence = still awaiting the user's ruling. `names` is the
-- already-listed dir contents (the caller tracks the listing's unknown status for the context-kv honesty gate).
local function countRulingBatches(names)
  return parse.countUnresolvedBatches(names, function(nm)
    return existsSafe(DECISION_BATCHES .. "/" .. nm .. "/batch.json") == true
  end, function(nm)
    return existsSafe(DECISION_BATCHES .. "/" .. nm .. "/consumed.json") == true
  end)
end

-- A8+context: cache the three counts (在审 reviewing / 候裁 unresolved-decision-batches / 告警 alerts) in the plugin KV so
-- tern.carly.context can read them within its 4 ms budget without live-computing. kv lives in <data>/kv.json
-- (the Tern plugin data dir) -- NOT a new file under ~/.agenthop/carly/, honoring the contract section 0 scope.
-- FC-2: if ANY source is unknown (reviews, the decision-batches listing, or the alerts listing) we SKIP the set and
-- keep the last-good cache, so the context one-liner never flips to false zeros.
local function updateCountsKv(reviews, reviewsUnknown)
  local reviewing = parse.countReviewStates(reviews) -- 在审N
  local dbStatus, dbNames = listDirState(DECISION_BATCHES)
  local ruling = countRulingBatches(dbNames)         -- 候裁M (unresolved DecisionBatch cards)
  local alStatus, alNames = listDirState(ALERTS_DIR)
  local alerts = parse.countJsonFiles(alNames)       -- 告警K
  if reviewsUnknown or dbStatus == "unknown" or alStatus == "unknown" then
    return -- a source is unreadable: keep the last-good kv (never flip the context line to false zeros)
  end
  pcall(function()
    tern.kv.set("counts", { review = reviewing, ruling = ruling, alerts = alerts, ts = nowTs() })
  end)
end

-- Real durable source paths (so every wayfinding link points at what was ACTUALLY read — env overrides like
-- SWARM_REVIEW_REPORTS win — instead of a hardcoded, possibly-nonexistent default). TE-SOURCE-PATH.
local function sourcePaths()
  return {
    snapshot = SNAPSHOT,
    progress = PROGRESS,
    reviewReports = REVIEW_REPORTS,
    reviewQueue = REVIEW_QUEUE_DIR,
    board = BOARD_DIR,
    dispatcherLog = DISPATCH_LOG,
    deadLetters = SWARM_DIR .. "/dead-letters.jsonl",
    inboxTemplate = INBOX_DIR .. "/<session-id>/",
    alerts = ALERTS_DIR,
    carlyReviewBoard = CARLY_DIR .. "/review-board.md",
    herdrCli = "herdr api snapshot",
  }
end

-- Gather the A6 snapshot inputs. FC-2: an unknown source contributes nil (rendered "(unavailable)"), never a false 0.
-- (Explicit if/else, NOT the `cond and nil or X` idiom — that idiom evaluates X when the value is nil and would
-- re-introduce the very false zeros this fixes.)
local function gatherSnapshotData()
  local reviews, reviewsUnknown = collectReviews() -- computed once; reused for the summary counts AND the context kv
  local boardStatus, boardNames = listDirState(BOARD_DIR)
  local open, done = parse.countBoardStates(boardNames)
  updateCountsKv(reviews, reviewsUnknown)
  local progStatus, progText = readFileState(PROGRESS)
  local flagsStatus, flags = collectFlagsState()

  local lastCycle = nil
  if progStatus ~= "unknown" then
    lastCycle = parse.lastProgressCycle(progText or "")
  end
  local activeReviewCount, reviewRowCount = nil, nil
  if not reviewsUnknown then
    activeReviewCount = parse.countActiveReviews(reviews)
    reviewRowCount = #reviews
  end
  local boardOpen, boardDone = nil, nil
  if boardStatus ~= "unknown" then
    boardOpen, boardDone = open, done
  end
  local flagsStr = nil
  if flagsStatus ~= "unknown" then
    flagsStr = summarizeFlags(flags)
  end

  return {
    ts = nowTs(),
    home = HOME,
    sources = sourcePaths(),
    lastCycle = lastCycle,
    activeReviewCount = activeReviewCount,
    reviewRowCount = reviewRowCount,
    boardOpen = boardOpen,
    boardDone = boardDone,
    flagsSummary = flagsStr,
  }
end

local function findCanvas(cx)
  local pane = nil
  pcall(function()
    for _, c in ipairs(cx.canvas:list()) do
      if c.owner == tern.plugin.id and c.title == CANVAS_TITLE then
        pane = c.pane
        break
      end
    end
  end)
  return pane
end

-- Rebuild the snapshot Markdown, write it to the authoritative file, then mirror it into the canvas pane.
-- The snapshot is AUTHORITATIVE and the canvas MIRRORS it, so we only touch the canvas/report success once the
-- authoritative write actually succeeded. On write failure we keep the old canvas + surface an error (never report
-- a failed refresh as done). Returns true iff the authoritative write succeeded.
local function refresh(cx)
  local md = snapshot.buildMarkdown(gatherSnapshotData())
  local wrote = false
  pcall(function()
    if not tern.fs.exists(CARLY_DIR) then
      tern.fs.mkdir(CARLY_DIR)
    end
    tern.fs.write(SNAPSHOT, md) -- authoritative write (contract: the snapshot is authoritative)
    wrote = true
  end)
  if cx == nil then
    return wrote
  end
  if not wrote then
    pcall(function()
      cx:toast("error", "Swarm snapshot write failed (canvas unchanged)", SNAPSHOT)
    end)
    return false -- keep the old canvas mirror; do NOT present a failed write as a refresh
  end
  local pane = findCanvas(cx)
  if pane then
    pcall(function()
      cx.canvas:set(pane, { md = md })
    end)
  else
    pcall(function()
      cx.canvas:open({ title = CANVAS_TITLE, md = md, about = ABOUT, how = "beside", focus = false })
    end)
  end
  return true
end

-- ---- A8 v1: four read-only Carly exports (FROZEN signatures) ---------------------------------------------------
local JENC = function(v)
  return tern.json.encode(v)
end

-- swarm_status() -> { seats:[{id,title,herdrState,inboxDepth,task}], ts } ; live seats from herdr (async).
tern.carly.export("swarm_status", {
  sig = "swarm_status() -> {seats:[{id,title,herdrState,inboxDepth,task}], ts, truncated?}",
  doc = "Live seats across the swarm: each agent pane's session id, terminal title, herdr state, pending inbox depth and current task. Source: `herdr api snapshot` plus the per-session durable inbox. Read-only; capped at 16 KiB JSON (sets truncated:true if it must drop seats).",
}, function(cx, call)
  tern.process.run({ HERDR, "api", "snapshot" }, { timeout_ms = 8000 }, function(res)
    local ok, out = pcall(function()
      if type(res) ~= "table" or res.status ~= 0 then
        error("herdr api snapshot failed (status " .. tostring(res and res.status) .. ")")
      end
      local data = tern.json.decode(res.stdout)
      local snap = data and data.result and data.result.snapshot
      local agents = snap and snap.agents
      if type(agents) ~= "table" then
        -- a snapshot whose shape lacks .result.snapshot.agents is UNKNOWN, not "zero seats": fail, don't fabricate.
        error("herdr snapshot missing .result.snapshot.agents")
      end
      local seats = parse.buildSeats(agents, inboxDepth)
      -- A6+route: cache herdr-pane-id -> title so route.link can resolve swarm://pane/<herdr-id> synchronously
      local pmap = {}
      for _, a in ipairs(agents) do
        if type(a) == "table" and type(a.pane_id) == "string" then
          pmap[a.pane_id] = a.terminal_title_stripped or a.terminal_title or ""
        end
      end
      pcall(function()
        tern.kv.set("paneMap", pmap)
      end)
      local result = { seats = tern.json.array(seats), ts = nowTs() }
      return budget.fitArray(result, "seats", JENC)
    end)
    if ok then
      call:reply(out)
    else
      call:fail("swarm_status: " .. tostring(out))
    end
  end)
  return call:wait(12000)
end)

-- swarm_queue() -> { reviews:[{item,sha,seat,round,state}], ts } ; active review queue (sync fs).
tern.carly.export("swarm_queue", {
  sig = "swarm_queue() -> {reviews:[{item,sha,seat,round,state}], ts, truncated?}",
  doc = "Active review queue: one row per review with item, commit sha, reviewer seat, round and state (queued/reviewing/<status>/done). Source: ~/Work/review-reports/<seat>-active-review-queue.json (and ~/.agenthop/swarm/review-queue/). Read-only; capped at 16 KiB JSON.",
}, function(cx, call)
  local reviews, unknownSource = collectReviews()
  if unknownSource then
    -- a source is unreadable: UNKNOWN, not an empty queue. Fail honestly rather than report false zeros.
    call:fail("swarm_queue: " .. unknownSource .. " unreadable")
    return call:wait()
  end
  local result = { reviews = tern.json.array(reviews), ts = nowTs() }
  return budget.fitArray(result, "reviews", JENC)
end)

-- swarm_progress(n) -> { cycles:[{num,title,lines}], ts } ; last n PROGRESS cycles (sync fs). n clamped to 1..20.
tern.carly.export("swarm_progress", {
  sig = "swarm_progress(n) -> {cycles:[{num,title,lines}], ts, truncated?}  (n<=20)",
  doc = "The last n coordinator cycles from ~/.agenthop/swarm/PROGRESS.md: each cycle's number, title and raw content lines. n is clamped to 1..20. Read-only; capped at 16 KiB JSON (drops the OLDEST cycles first, keeping the newest, and sets truncated:true).",
}, function(n, cx, call)
  local nn = tonumber(n) or 20
  nn = math.floor(nn)
  if nn < 1 then
    nn = 1
  elseif nn > 20 then
    nn = 20
  end
  local status, text = readFileState(PROGRESS)
  if status == "unknown" then
    -- PROGRESS.md present but unreadable: UNKNOWN, not "no cycles". Fail rather than report an empty history.
    call:fail("swarm_progress: PROGRESS.md unreadable")
    return call:wait()
  end
  local cycles = parse.parseProgressCycles(text or "", nn) -- absent => "" => no cycles (a real empty, fine)
  local result = { cycles = tern.json.array(cycles), ts = nowTs() }
  return budget.fitArray(result, "cycles", JENC, nil, true) -- keepTail: shed oldest cycles first
end)

-- swarm_flags() -> { flags:{name:"on"|"off"|"dormant"}, ts } ; SWARM_* flag states (sync fs/env).
tern.carly.export("swarm_flags", {
  sig = "swarm_flags() -> {flags:{<NAME>:\"on\"|\"off\"|\"dormant\"}, ts, truncated?}",
  doc = "SWARM_* feature-flag states. Authoritative runtime source: the last 'flags:' line of ~/.agenthop/swarm/dispatcher.log; falls back to the plugin process env. opt-out flags are on unless killed (off); opt-in flags (TG_ENTRY, FANOUT) report dormant until explicitly enabled. Read-only; capped at 16 KiB JSON.",
}, function(cx, call)
  local status, flags = collectFlagsState()
  if status == "unknown" then
    -- dispatcher.log present but unreadable: UNKNOWN. Do NOT fall through to env defaults (that would flip a
    -- logged-off flag back to its on default). Fail honestly.
    call:fail("swarm_flags: dispatcher.log unreadable")
    return call:wait()
  end
  local result = { flags = flags, ts = nowTs() }
  return budget.fitMap(result, "flags", JENC)
end)

-- ---- explicit refresh command (the non-scheduled half of A6's "update" path) -----------------------------------
tern.command({
  id = "refresh",
  title = "Swarm: refresh cold-start snapshot",
  group = "Swarm Observatory",
  run = function(cx)
    -- Only claim success when the authoritative write actually landed; refresh() surfaces its own error toast on
    -- failure (so we never report a failed refresh as done).
    if refresh(cx) then
      pcall(function()
        cx:toast("success", "Swarm snapshot refreshed", SNAPSHOT)
      end)
    end
  end,
})

-- ---- A8+context: one-line swarm status for Carly (reads the KV cache; 4 ms budget, never live-computes) ---------
tern.carly.context(function(cx)
  local c = nil
  pcall(function()
    c = tern.kv.get("counts")
  end)
  if type(c) ~= "table" then
    return nil -- no cache yet (no refresh has run): contribute nothing
  end
  local line = "在审" .. tostring(c.review or 0) .. "|候裁" .. tostring(c.ruling or 0) .. "|告警" .. tostring(c.alerts or 0)
  if #line > 400 then
    line = line:sub(1, 400)
  end
  return line
end)

-- ---- A6+route: claim swarm:// links (focus a seat / open a durable file); pass everything else to Tern ----------
local function resolvePane(cx, id)
  local n = tonumber(id)
  if n ~= nil then
    return math.floor(n) -- a bare Tern pane number
  end
  local spec = id
  pcall(function()
    local map = tern.kv.get("paneMap") -- herdr-pane-id -> title (cached by swarm_status)
    if type(map) == "table" and type(map[id]) == "string" and map[id] ~= "" then
      spec = map[id]
    end
  end)
  local pane = nil
  pcall(function()
    pane = cx.session:resolve(spec) -- resolves a title / program / @focused / id spec to a Tern pane
  end)
  return pane
end

tern.route.link(function(link, cx)
  local kind, rest = parse.parseSwarmUrl(link.url)
  if kind == nil then
    return nil -- not a swarm:// link: let Tern's built-in handle it (never claim others' links)
  elseif kind == "file" then
    return { path = rest } -- rewrite path -> Tern's built-in open
  elseif kind == "pane" then
    local pane = resolvePane(cx, rest)
    local focused = false
    if pane ~= nil then
      pcall(function()
        cx.layout:focus(pane)
        focused = true
      end)
    end
    if not focused then
      -- either the seat did not resolve, OR focus itself threw: surface it (don't swallow the focus error).
      pcall(function()
        cx:toast("error", "Swarm: cannot focus seat " .. tostring(rest))
      end)
    end
    return { handled = true }
  else -- unknown swarm:// subtype: surface the error, do NOT swallow it
    pcall(function()
      cx:toast("error", "Swarm: unknown link " .. tostring(link.url))
    end)
    return { handled = true }
  end
end)

-- ---- A6 scheduling: arm the 1-minute promptless check once per VM, deduped by title -----------------------------
local armed = false
local function armSchedule()
  local status, src = readFileState("snapshot-check.luau") -- relative to the plugin dir
  if status ~= "ok" or type(src) ~= "string" then
    return false -- not readable yet (absent/unknown): caller retries on the next timer tick
  end
  pcall(function() -- dedup across reloads/windows: drop any prior task with our title, then schedule one
    for _, t in ipairs(tern.carly.tasks()) do
      if t.title == SCHED_TITLE then
        pcall(function()
          tern.carly.cancel(t.id)
        end)
      end
    end
  end)
  local ok = pcall(function()
    return tern.carly.schedule({ title = SCHED_TITLE, when = "every 1m", check = src })
  end)
  return ok
end

local function setup(cx)
  if cx == nil then
    return
  end
  pcall(function()
    refresh(cx) -- cold-start: render the canvas + write the snapshot immediately
  end)
  if not armed then
    if armSchedule() then
      armed = true
    else
      tern.timer(3000, function(nextCx) -- carly not ready yet; retry (dedup-by-title keeps it idempotent)
        if nextCx ~= nil then
          setup(nextCx)
        end
      end)
    end
  end
end

tern.on("window_start", function(cx)
  setup(cx)
end)
