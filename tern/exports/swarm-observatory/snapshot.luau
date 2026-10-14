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
--   reviewCount = <number>, boardOpen = <number>, boardDone = <number>,
--   flagsSummary = "<string>" | nil,
-- }
function M.buildMarkdown(data)
  data = data or {}
  local home = data.home or "~"
  local L = {}
  local function w(s)
    L[#L + 1] = s
  end

  w("# Swarm cold-start canvas")
  w("")
  w("_Wayfinding only - the fact is always in the file. Authoritative snapshot:_ "
    .. flink(home .. "/.agenthop/carly/canvas-snapshot.md"))
  w("")
  w("## Summary")
  w("")
  w("- generated_ts: `" .. tostring(data.ts or 0) .. "` (epoch seconds)")
  if data.lastCycle then
    w("- latest cycle: **#" .. tostring(data.lastCycle.num) .. "** " .. tostring(data.lastCycle.title)
      .. " -> " .. flink(home .. "/.agenthop/swarm/PROGRESS.md"))
  else
    w("- latest cycle: (unavailable) -> " .. flink(home .. "/.agenthop/swarm/PROGRESS.md"))
  end
  w("- active reviews: **" .. tostring(data.reviewCount or 0) .. "** -> "
    .. flink(home .. "/Work/review-reports/ACTIVE-REVIEW-QUEUE.md"))
  w("- board: **" .. tostring(data.boardOpen or 0) .. "** claimed / **" .. tostring(data.boardDone or 0)
    .. "** done -> " .. flink(home .. "/.agenthop/swarm/board/"))
  w("- flags: " .. (data.flagsSummary or "(unavailable)") .. " -> "
    .. flink(home .. "/.agenthop/swarm/dispatcher.log"))
  w("")
  w("## Wayfinding (durable sources)")
  w("")
  -- { label, target, linkable } ; linkable=false stays plain (a path template or a CLI, not an openable file)
  local rows = {
    { "Cycle log / progress", home .. "/.agenthop/swarm/PROGRESS.md", true },
    { "Active review queue", home .. "/Work/review-reports/ACTIVE-REVIEW-QUEUE.md", true },
    { "Review evidence", home .. "/Work/review-reports/", true },
    { "Work-item board (claimed/done)", home .. "/.agenthop/swarm/board/", true },
    { "Dispatcher log + flag states", home .. "/.agenthop/swarm/dispatcher.log", true },
    { "Dead letters", home .. "/.agenthop/swarm/dead-letters.jsonl", true },
    { "Agent inboxes (depth)", home .. "/.agenthop/inbox/<session-id>/", false },
    { "Carly alerts (A2 sentinel)", home .. "/.agenthop/carly/alerts/", true },
    { "Carly review/runbook boards (line 1)", home .. "/.agenthop/carly/review-board.md", true },
    { "Live seats (herdr)", "herdr api snapshot", false },
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
