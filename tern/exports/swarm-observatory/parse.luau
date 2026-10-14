-- parse — pure parsers/shapers for the A8 exports and the A6 summary. No `tern`/`cx` dependency (fs reads and
-- getenv are done by the caller and passed in), so this single file is loaded by BOTH window.luau (Luau, require)
-- AND test/parse.test.lua (Lua 5.5, loadfile) with no mirror copy.
--
-- Subset: ipairs/pairs only, string.find plain where literal, no += , no generalized-for, no type annotations.

local M = {}

-- Opt-in feature flags (the two that stay default-OFF per packages/bus/src/swarm/flag-default.ts and
-- scripts/swarm-tg-entry.ts / scripts/swarm-fanout.ts). When OFF they report "dormant", not "off": the feature
-- exists but is inactive by design until explicitly enabled.
M.OPT_IN = { TG_ENTRY = true, FANOUT = true }

-- Canonical opt-OUT feature flags (live-by-default; killed only by SWARM_<X>=0|false|no|off), used by the
-- env-derived fallback in swarm_flags when no dispatcher.log runtime line is available. Mirrors the flagDefaultOn()
-- call sites in packages/bus/src/swarm.
M.OPT_OUT = {
  "BOARD_ADMIT", "REVIEW_AUTOSCALE", "SUCCESSION", "COORD_ESCALATE", "GAUGE_SAMPLING", "CONSOLE",
  "IDLE_EXPLAINER", "MODEL_MARKET", "MODEL_STAFFING", "DIGEST", "INBOX_WAKE", "ROUND_DOCTOR",
  "EXECUTOR_DIGEST", "APPROVAL_DELEGATE", "ATTRIBUTION", "CONDITIONAL_ROUTING", "FLEET_RECOVERY",
  "OUTPUT_CONTRACT", "POISON_DLQ", "RETRO", "SANITIZED_READ", "SPEND_BREAKER",
}
M.OPT_IN_LIST = { "TG_ENTRY", "FANOUT" }

local function trim(s)
  if type(s) ~= "string" then
    return ""
  end
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Count UNCLAIMED top-level inbox messages given a directory entry-name list. Matches the bus semantics
-- (packages/bus/src/inbox.ts: the `.json` set claimInbox would claim — excludes `.claim-<pid>`, and the
-- quarantine/ .pubcred/ .published/ sidecar DIRS, which are not `.json`). Dotfiles are skipped.
function M.countJsonFiles(names)
  if type(names) ~= "table" then
    return 0
  end
  local c = 0
  for _, nm in ipairs(names) do
    if type(nm) == "string" and nm:find("%.json$") and not nm:find("^%.") then
      c = c + 1
    end
  end
  return c
end

-- "foo-r4" -> ("foo", 4) ; "foo" -> ("foo", 0). Rounds encoded as a trailing -rN suffix on the task name.
function M.splitRoundSuffix(task)
  if type(task) ~= "string" then
    return tostring(task), 0
  end
  local item, r = task:match("^(.-)%-r(%d+)$")
  if item then
    return item, tonumber(r)
  end
  return task, 0
end

-- Flatten one reviewer's active-review-queue JSON object (e.g. happycapy-active-review-queue.json) into review rows
-- {item, sha, seat, round, state}. `seat` is the reviewer seat (derived from the file name by the caller).
-- Returns (rows, malformed). FC-2 — validate to the leaf, not the container. malformed=true (⇒ the caller treats the
-- whole query as UNKNOWN: fail / keep last-good, never an empty list) when: the root is not a table; a known field
-- (pending/active/seat2/completedCurrent) is present-but-not-a-table; a present pending bucket is not a clean array
-- (a map masquerading as an array), or holds a non-table element; or any record's known leaf (task/sha/status) is
-- present-but-wrong-type. A simply-absent field, a legal empty object/array, a missing optional field, and unknown
-- extension fields are all fine. Never tostring/default over a present wrong-type value, nor silently drop a bad
-- element and claim a complete queue.
function M.parseReviewQueue(obj, seat)
  local out = {}
  if type(obj) ~= "table" then
    return out, true -- root is not a table (e.g. decoded `123`) ⇒ corrupt ⇒ unknown
  end
  seat = seat or ""
  local malformed = false
  local function badField(v)
    return v ~= nil and type(v) ~= "table" -- PRESENT but not a table ⇒ corrupt known field
  end
  -- A review record: a table whose known string leaves (task/sha/status), when present, are strings.
  -- FC-2 "validate to the leaf, not the container": a present-but-wrong-leaf-type field is corrupt (never
  -- tostring/default over it); a non-table element is corrupt. Missing optional and unknown extension fields are fine.
  local function validRecord(e)
    if type(e) ~= "table" then
      return false
    end
    if e.task ~= nil and type(e.task) ~= "string" then
      return false
    end
    if e.sha ~= nil and type(e.sha) ~= "string" then
      return false
    end
    if e.status ~= nil and type(e.status) ~= "string" then
      return false
    end
    return true
  end
  -- A clean 1..n sequence: a non-empty object with map/holey keys is NOT a legal empty array (it is corrupt).
  local function isCleanArray(t)
    local n = 0
    for _ in pairs(t) do
      n = n + 1
    end
    return n == #t
  end
  local function add(task, sha, state)
    local item, round = M.splitRoundSuffix(task or "")
    out[#out + 1] = { item = item, sha = sha or "", seat = seat, round = round, state = state }
  end
  if badField(obj.pending) then
    malformed = true
  elseif type(obj.pending) == "table" then
    if not isCleanArray(obj.pending) then
      malformed = true -- map masquerading as array ⇒ not a legal empty list ⇒ unknown
    else
      for _, e in ipairs(obj.pending) do
        if validRecord(e) then
          add(e.task, e.sha, "queued")
        else
          malformed = true -- a bad record inside a present bucket ⇒ whole query unknown
        end
      end
    end
  end
  if badField(obj.active) then
    malformed = true
  elseif type(obj.active) == "table" then
    if validRecord(obj.active) then
      add(obj.active.task, obj.active.sha, "reviewing")
    else
      malformed = true
    end
  end
  if badField(obj.seat2) then
    malformed = true
  elseif type(obj.seat2) == "table" then
    if validRecord(obj.seat2) then
      -- seat2 carries sha + status + remain but no task name
      out[#out + 1] = {
        item = "seat2",
        sha = obj.seat2.sha or "",
        seat = seat,
        round = 0,
        state = obj.seat2.status or "in-review",
      }
    else
      malformed = true
    end
  end
  if badField(obj.completedCurrent) then
    malformed = true
  elseif type(obj.completedCurrent) == "table" then
    if validRecord(obj.completedCurrent) then
      add(obj.completedCurrent.task, obj.completedCurrent.sha, "done")
    else
      malformed = true
    end
  end
  return out, malformed
end

-- Map a herdr `api snapshot` agents[] array into seats {id, title, herdrState, inboxDepth, task}.
-- inboxDepthFn(sid) -> number is injected (production counts the session's inbox dir; the fixture mocks it).
function M.buildSeats(agents, inboxDepthFn)
  local seats = {}
  if type(agents) ~= "table" then
    return seats
  end
  for _, a in ipairs(agents) do
    if type(a) == "table" then
      local sid = ""
      local sess = a.agent_session
      if type(sess) == "table" then
        sid = sess.value or ""
      elseif type(sess) == "string" then
        sid = sess
      end
      local title = a.terminal_title_stripped or a.terminal_title or ""
      seats[#seats + 1] = {
        id = sid,
        title = title,
        herdrState = a.agent_status or "",
        inboxDepth = (inboxDepthFn and inboxDepthFn(sid)) or 0,
        task = title,
      }
    end
  end
  return seats
end

-- Parse the LAST n PROGRESS.md cycles into {num, title, lines}. A cycle starts at a header line
-- "## ... #<digits>" (the "## 周期 #NNN(...)" markers); `lines` is the raw content between headers. Keeps only the
-- last n cycles in memory (bounded), so this is safe to run over the ~600 KB PROGRESS.md.
function M.parseProgressCycles(text, n)
  if type(text) ~= "string" then
    return {}
  end
  n = tonumber(n) or 20
  if n < 1 then
    n = 1
  end
  local cycles = {}
  local cur = nil
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    local num = line:match("^##%s+.-#(%d+)")
    if num then
      cur = { num = tonumber(num), title = (line:gsub("^##%s+", "")), lines = {} }
      cycles[#cycles + 1] = cur
      if #cycles > n then
        table.remove(cycles, 1) -- ring: retain only the last n
      end
    elseif cur then
      cur.lines[#cur.lines + 1] = line
    end
  end
  return cycles
end

-- The newest cycle only (for the A6 summary line), or nil.
function M.lastProgressCycle(text)
  local cycles = M.parseProgressCycles(text, 1)
  return cycles[1]
end

-- The LAST "flags:" line in a dispatcher.log body (the authoritative runtime projection of the flag states), or nil.
function M.lastFlagsLine(text)
  if type(text) ~= "string" then
    return nil
  end
  local last = nil
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if line:find("flags:", 1, true) and line:find("=", 1, true) then
      last = line
    end
  end
  return last
end

-- Parse a dispatcher "flags: NAME=on NAME=off NAME=on(inert:...) ... (trailing explanation)" line into
-- { NAME = "on"|"off"|"dormant" }. We parse the FULL runtime tokens: the old code cut the line at the first "(",
-- which both mis-parsed an inert-qualified value (e.g. INBOX_WAKE=on(inert:no-herdr)) AND dropped every flag after
-- it. A flag value may carry an ATTACHED "(inert:...)" qualifier (no space before the paren), whereas the trailing
-- human explanation is a SPACE-separated parenthetical at the end of the line (stripped below).
--   on/off come straight from the log.
--   an opt-in flag (TG_ENTRY/FANOUT) logged as off -> "dormant".
--   an explicitly inert flag ("on(inert:...)") -> "dormant": enabled-but-not-functioning is not-active, which is
--     distinct from a live "on" (this satisfies "distinguish actual-inert from on" within the FROZEN 3-state map).
--     NOTE: a dedicated "inert" state would be a contract change (the on|off|dormant triplet is frozen).
function M.parseFlagsLine(line)
  local flags = {}
  if type(line) ~= "string" then
    return flags
  end
  local seg = line:match("flags:%s*(.*)$") or line
  seg = seg:gsub("%s+%b()%s*$", "") -- drop the trailing " (explanation)" group; keeps attached (inert:...) qualifiers
  for name, rawval in seg:gmatch("(%u[%u%d_]*)=(%S+)") do
    local base = rawval:match("^(%a+)") or rawval -- "on" from "on(inert:no-herdr)"; the bare word otherwise
    local qual = rawval:match("%((.-)%)")         -- "inert:no-herdr" (attached qualifier) or nil
    local lv = base:lower()
    local state
    if lv == "on" then
      state = "on"
    elseif lv == "off" then
      state = "off"
    else
      state = lv
    end
    if state == "on" and qual and qual:lower():find("inert", 1, true) then
      state = "dormant" -- enabled-but-inert => not-active
    end
    if M.OPT_IN[name] and state == "off" then
      state = "dormant"
    end
    flags[name] = state
  end
  return flags
end

-- Fallback when no dispatcher.log flags line exists: derive states from the process env via getenv("SWARM_<NAME>").
-- opt-out => on unless explicitly 0|false|no|off; opt-in => dormant unless explicitly 1|true|yes|on.
function M.flagsFromEnv(getenv)
  local flags = {}
  local function isOff(v)
    if v == nil then
      return false
    end
    local t = trim(v):lower()
    return t == "0" or t == "false" or t == "no" or t == "off"
  end
  local function isOn(v)
    if v == nil then
      return false
    end
    local t = trim(v):lower()
    return t == "1" or t == "true" or t == "yes" or t == "on"
  end
  for _, name in ipairs(M.OPT_OUT) do
    local v = getenv("SWARM_" .. name)
    flags[name] = isOff(v) and "off" or "on"
  end
  for _, name in ipairs(M.OPT_IN_LIST) do
    local v = getenv("SWARM_" .. name)
    flags[name] = isOn(v) and "on" or "dormant"
  end
  return flags
end

-- Count review states for the A8+context one-liner: reviewing (在审) vs awaiting a ruling/merge (候裁 = everything
-- in the queue not actively under review). Returns (reviewing, awaiting, total).
function M.countReviewStates(reviews)
  local reviewing, total = 0, 0
  if type(reviews) == "table" then
    for _, r in ipairs(reviews) do
      total = total + 1
      if type(r) == "table" and r.state == "reviewing" then
        reviewing = reviewing + 1
      end
    end
  end
  return reviewing, total - reviewing, total
end

-- Terminal review states: a review row that has reached a sealed/done end. Everything else is "active".
M.TERMINAL_REVIEW_STATES = { done = true }

-- Count ACTIVE reviews (state not a terminal/done state) for the A6 snapshot's "active reviews" label
-- (TE-ACTIVE-LABEL: #rows included done rows, so a done-only queue falsely read as 1 active). This is DISTINCT from
-- countReviewStates' 在审 (specifically state=="reviewing"); the raw row count is reported separately by the caller.
function M.countActiveReviews(reviews)
  local n = 0
  if type(reviews) == "table" then
    for _, r in ipairs(reviews) do
      if type(r) == "table" and not M.TERMINAL_REVIEW_STATES[r.state] then
        n = n + 1
      end
    end
  end
  return n
end

-- 候裁M (A8+context): count UNRESOLVED DecisionBatch cards. `names` = entries of ~/.agenthop/console/decision-batches.
-- A batch dir is enumerated by the STORE's reality, NOT a name prefix: any dir that CONTAINS a `batch.json`
-- (decision-batch-v1). Valid custom IDs created via `decide --batch-id` (e.g. release_20261014) have no `batch-`
-- prefix, so the old `^batch-` match dropped them (TE-RULING-ID). A batch is RESOLVED iff it has a committed
-- consumed.json (the terminal sealed marker); unresolved = has batch.json AND no consumed.json.
-- Both predicates are INJECTED (real fs.exists in window.luau; fakes in fixtures) so this stays pure+testable. Per the
-- coordinator ruling this counts REAL awaiting-ruling batches (not a total−reviewing proxy — different dimensions).
-- Returns (count, unknown). The predicates are THREE-STATE: hasBatchJson(nm)/consumedExists(nm) return true | false |
-- nil (= the existence probe itself faulted). FC-2: any necessary probe returning nil ⇒ the whole count is UNKNOWN
-- (unknown=true) — never fold a probe fault to false, which would hide an awaiting-ruling batch (undercount) or invent a
-- resolved one (overcount). The caller must keep the last-good count when unknown, never overwrite with this value.
function M.countUnresolvedBatches(names, hasBatchJson, consumedExists)
  if type(names) ~= "table" or type(hasBatchJson) ~= "function" or type(consumedExists) ~= "function" then
    return 0, false
  end
  local n = 0
  for _, nm in ipairs(names) do
    if type(nm) == "string" and not nm:find("^%.") then
      local hb = hasBatchJson(nm)
      if hb == nil then
        return 0, true -- cannot tell whether this dir is a batch ⇒ unknown
      elseif hb then
        local cj = consumedExists(nm)
        if cj == nil then
          return 0, true -- cannot tell whether this batch is resolved ⇒ unknown
        elseif not cj then
          n = n + 1
        end
      end
    end
  end
  return n, false
end

-- Parse a swarm:// link (A6+route). Returns:
--   ("pane", "<herdr-pane-id or spec>")  for swarm://pane/<id>
--   ("file", "/abs/path")                for swarm://file/<abspath>  (leading slash preserved)
--   ("unknown", "<rest>")                for any other swarm:// subtype
--   (nil, nil)                           for a non-swarm:// url (caller returns nil => Tern's built-in handles it)
function M.parseSwarmUrl(url)
  if type(url) ~= "string" then
    return nil, nil
  end
  if not url:find("^swarm://") then
    return nil, nil
  end
  local paneId = url:match("^swarm://pane/(.+)$")
  if paneId then
    return "pane", paneId
  end
  local filePath = url:match("^swarm://file(/.+)$")
  if filePath then
    return "file", filePath
  end
  return "unknown", (url:match("^swarm://(.*)$") or "")
end

-- Build a swarm://file/<abspath> url from an absolute path (abspath keeps its leading slash).
function M.swarmFileUrl(abspath)
  return "swarm://file" .. tostring(abspath)
end

-- Board summary counts from a board dir entry-name list: "<item>.claimed.<seat>.json" vs "<item>.done.<seat>.json".
function M.countBoardStates(names)
  local open, done = 0, 0
  if type(names) ~= "table" then
    return open, done
  end
  for _, nm in ipairs(names) do
    if type(nm) == "string" then
      if nm:find(".done.", 1, true) then
        done = done + 1
      elseif nm:find(".claimed.", 1, true) then
        open = open + 1
      end
    end
  end
  return open, done
end

return M
