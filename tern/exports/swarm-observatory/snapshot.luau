-- snapshot — pure builder for the A6 cold-start snapshot Markdown (contract section 2: "canvas content = summary +
-- wayfinding, EACH line carries a durable file path; the fact is always in the file").
--
-- Per the §2 addendum (A6+route): every durable file/seat reference is emitted as a `swarm://` link
-- ([visible path](swarm://file/<abspath>)) so the route.link handler can open it; the visible label is still the
-- plain path, so `cat`-ing the snapshot still shows the fact. Non-path references (a CLI, a path template) stay plain.
--
-- Pure: takes a plain data table of already-read inputs, returns the Markdown string. window.luau writes this string
-- to BOTH ~/.agenthop/carly/canvas-snapshot.md (authoritative) AND the canvas pane (double-write), so they cannot
-- drift. Subset-clean (loaded by Luau and, in test, by Lua 5.5).

local M = {}

-- A markdown link whose visible label is the absolute path and whose target is the swarm://file url.
local function flink(abspath)
  return "[" .. abspath .. "](swarm://file" .. abspath .. ")"
end

-- data = {
--   ts = <epoch seconds>, home = "/Users/...",
--   lastCycle = { num, title } | nil,
--   activeReviewCount = <number> | nil,   -- ACTIVE reviews (state not terminal/done); nil => source unknown
--   reviewRowCount    = <number> | nil,   -- raw review rows (incl. done); nil => source unknown
--   boardOpen = <number> | nil, boardDone = <number> | nil,   -- nil => source unknown
--   flagsSummary = "<string>" | nil,
--   sources = {                           -- ACTUAL durable paths read (env overrides win); home-derived if absent
--     snapshot, progress, reviewReports, board, dispatcherLog, deadLetters, inboxTemplate, alerts,
--     carlyReviewBoard, herdrCli,
--   },
-- }
-- An unknown source MUST render as "(unavailable)", never a false 0 (FC-2): the count fields above are nil for an
-- unreadable source, and `num()` maps nil -> "(unavailable)".
function M.buildMarkdown(data)
  data = data or {}
  local home = data.home or "~"
  local src = data.sources or {}
  -- Every wayfinding link points at the REAL source actually read. Fall back to the canonical home-derived default
  -- only when the caller did not supply a path (keeps the builder usable standalone / in unit tests).
  local pSnapshot = src.snapshot or (home .. "/.agenthop/carly/canvas-snapshot.md")
  local pProgress = src.progress or (home .. "/.agenthop/swarm/PROGRESS.md")
  local pReports = src.reviewReports or (home .. "/Work/review-reports")
  local pBoard = src.board or (home .. "/.agenthop/swarm/board/")
  local pLog = src.dispatcherLog or (home .. "/.agenthop/swarm/dispatcher.log")
  local pDead = src.deadLetters or (home .. "/.agenthop/swarm/dead-letters.jsonl")
  local pInboxTpl = src.inboxTemplate or (home .. "/.agenthop/inbox/<session-id>/")
  local pAlerts = src.alerts or (home .. "/.agenthop/carly/alerts/")
  local pReviewBoard = src.carlyReviewBoard or (home .. "/.agenthop/carly/review-board.md")
  local pHerdr = src.herdrCli or "herdr api snapshot"

  local L = {}
  local function w(s)
    L[#L + 1] = s
  end
  -- a count or "(unavailable)" when nil (an unknown source must never render as a false 0)
  local function num(v)
    if v == nil then
      return "(unavailable)"
    end
    return "**" .. tostring(v) .. "**"
  end

  w("# Swarm cold-start canvas")
  w("")
  w("_Wayfinding only - the fact is always in the file. Authoritative snapshot:_ " .. flink(pSnapshot))
  w("")
  w("## Summary")
  w("")
  w("- generated_ts: `" .. tostring(data.ts or 0) .. "` (epoch seconds)")
  if data.lastCycle then
    w("- latest cycle: **#" .. tostring(data.lastCycle.num) .. "** " .. tostring(data.lastCycle.title)
      .. " -> " .. flink(pProgress))
  else
    w("- latest cycle: (unavailable) -> " .. flink(pProgress))
  end
  -- active reviews = ACTIVE rows only (state not terminal/done); raw row count shown separately (TE-ACTIVE-LABEL).
  local rowStr = (data.reviewRowCount == nil) and "(unavailable)" or tostring(data.reviewRowCount)
  w("- active reviews: " .. num(data.activeReviewCount) .. " (rows: " .. rowStr .. ") -> " .. flink(pReports))
  w("- board: " .. num(data.boardOpen) .. " claimed / " .. num(data.boardDone) .. " done -> " .. flink(pBoard))
  w("- flags: " .. (data.flagsSummary or "(unavailable)") .. " -> " .. flink(pLog))
  w("")
  w("## Wayfinding (durable sources)")
  w("")
  -- { label, target, linkable } ; linkable=false stays plain (a path template or a CLI, not an openable file)
  local rows = {
    { "Cycle log / progress", pProgress, true },
    { "Active review queue", pReports, true },
    { "Review evidence", pReports, true },
    { "Work-item board (claimed/done)", pBoard, true },
    { "Dispatcher log + flag states", pLog, true },
    { "Dead letters", pDead, true },
    { "Agent inboxes (depth)", pInboxTpl, false },
    { "Carly alerts (A2 sentinel)", pAlerts, true },
    { "Carly review/runbook boards (line 1)", pReviewBoard, true },
    { "Live seats (herdr)", pHerdr, false },
  }
  for _, r in ipairs(rows) do
    if r[3] then
      w("- **" .. r[1] .. "** -> " .. flink(r[2]))
    else
      w("- **" .. r[1] .. "** -> `" .. r[2] .. "`")
    end
  end
  w("")
  w("## Carly exports (A8 v1 - read-only observation)")
  w("")
  w("- `swarm_status()` - live seats (herdr) + inbox depth (also registers a one-line status via tern.carly.context)")
  w("- `swarm_queue()` - active review queue (item / sha / seat / round / state)")
  w("- `swarm_progress(n)` - last n PROGRESS cycles (n <= 20)")
  w("- `swarm_flags()` - SWARM_* flag states (on / off / dormant)")
  w("")
  w("_Each export is read-only and capped at 16 KiB JSON; it sets `truncated: true` when it must drop data._")
  w("_Links use the `swarm://` scheme (handled by this plugin's route): `swarm://file/<path>`, `swarm://pane/<id>`._")

  return table.concat(L, "\n") .. "\n"
end

return M
