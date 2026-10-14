#!/usr/bin/env lua
-- Fixture for the pure parsers/shapers. Lua 5.5. Loads the PRODUCTION parse module (../parse.luau) via loadfile --
-- the same file window.luau does require("./parse") on. Covers the real data shapes captured from this machine.
-- Run from the plugin dir:  lua test/parse.test.lua

local here = (arg[0] or ""):match("^(.*/)") or "./"
local parse = assert(loadfile(here .. "../parse.luau"))()

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then
    failures = failures + 1
  end
end

-- countJsonFiles: unclaimed top-level .json only (excludes .claim-, dotfiles, non-.json dirs)
do
  local names = { "0001.json", "0002.json", ".pubcred", "quarantine", "x.json.claim-123", ".hidden.json" }
  ck("countJsonFiles counts only top-level .json", parse.countJsonFiles(names) == 2)
  ck("countJsonFiles on empty list = 0", parse.countJsonFiles({}) == 0)
end

-- splitRoundSuffix
do
  local i1, r1 = parse.splitRoundSuffix("retro-learn-r4")
  ck("splitRoundSuffix retro-learn-r4 -> item", i1 == "retro-learn")
  ck("splitRoundSuffix retro-learn-r4 -> round 4", r1 == 4)
  local i2, r2 = parse.splitRoundSuffix("no-round")
  ck("splitRoundSuffix no suffix -> round 0", i2 == "no-round" and r2 == 0)
end

-- parseReviewQueue over the REAL happycapy shape
do
  local obj = {
    pending = { { task = "retro-learn-r4", sha = "8f7cf62" }, { task = "agentmemory-fact-r2", sha = "3446195" } },
    seat2 = { sha = "81f8894", status = "changes-requested", remain = { "DOS-CORE-P2-1" } },
    completedCurrent = { task = "dialog-officer-item1-r6", sha = "ac4f592" },
    active = { task = "termcp-fact-r2", sha = "f3e2082" },
  }
  local rows = parse.parseReviewQueue(obj, "happycapy")
  ck("parseReviewQueue row count = 5 (2 pending + active + seat2 + completed)", #rows == 5)
  local byState = {}
  for _, r in ipairs(rows) do
    byState[r.state] = (byState[r.state] or 0) + 1
    ck("parseReviewQueue row seat = happycapy", r.seat == "happycapy")
  end
  ck("parseReviewQueue has 2 queued", byState["queued"] == 2)
  ck("parseReviewQueue has 1 reviewing", byState["reviewing"] == 1)
  ck("parseReviewQueue has 1 changes-requested (seat2.status)", byState["changes-requested"] == 1)
  ck("parseReviewQueue has 1 done", byState["done"] == 1)
  -- round parsed off the task suffix
  local found = false
  for _, r in ipairs(rows) do
    if r.item == "retro-learn" and r.round == 4 then
      found = true
    end
  end
  ck("parseReviewQueue parsed round off task name", found)
end

-- parseProgressCycles over a synthetic PROGRESS body
do
  local text = table.concat({
    "preamble line (ignored, before first header)",
    "## 周期 #849(2026-10-14 A)",
    "a1",
    "a2",
    "## 周期 #850(2026-10-14 B)",
    "b1",
    "## 周期 #851(2026-10-14 C)",
    "c1",
    "c2",
    "c3",
  }, "\n")
  local last2 = parse.parseProgressCycles(text, 2)
  ck("parseProgressCycles keeps last 2", #last2 == 2)
  ck("parseProgressCycles newest num = 851", last2[2].num == 851)
  ck("parseProgressCycles older of the two num = 850", last2[1].num == 850)
  ck("parseProgressCycles title stripped of '## '", last2[2].title == "周期 #851(2026-10-14 C)")
  ck("parseProgressCycles cycle #851 has 3 content lines", #last2[2].lines == 3)
  ck("parseProgressCycles ignores preamble before first header", last2[1].num == 850)
  local one = parse.lastProgressCycle(text)
  ck("lastProgressCycle returns newest (#851)", one and one.num == 851)
end

-- parseFlagsLine over the REAL dispatcher.log line
do
  local line = "[dispatch disp-38807] flags: BOARD_ADMIT=on REVIEW_AUTOSCALE=on SUCCESSION=on COORD_ESCALATE=on GAUGE_SAMPLING=on CONSOLE=on IDLE_EXPLAINER=on MODEL_MARKET=on MODEL_STAFFING=on DIGEST=on INBOX_WAKE=on ROUND_DOCTOR=on EXECUTOR_DIGEST=on TG_ENTRY=off (opt-out default-on; kill with SWARM_<X>=0; TG_ENTRY is opt-in)"
  local f = parse.parseFlagsLine(line)
  ck("parseFlagsLine BOARD_ADMIT=on", f.BOARD_ADMIT == "on")
  ck("parseFlagsLine DIGEST=on", f.DIGEST == "on")
  ck("parseFlagsLine TG_ENTRY off -> dormant (opt-in)", f.TG_ENTRY == "dormant")
  ck("parseFlagsLine did NOT leak the trailing '(...)' into a flag", f["opt"] == nil)
end

-- parseFlagsLine: an inert qualifier must NOT truncate the line (TE-FLAGS-INERT) — the old code cut at the first
-- '(', mis-parsing on(inert:...) AND dropping every flag after it.
do
  local line = "[dispatch disp-1] flags: BOARD_ADMIT=on INBOX_WAKE=on(inert:no-herdr) ROUND_DOCTOR=on EXECUTOR_DIGEST=on TG_ENTRY=off (opt-out default-on; kill with SWARM_<X>=0; TG_ENTRY is opt-in)"
  local f = parse.parseFlagsLine(line)
  ck("parseFlagsLine flag BEFORE the inert token still on (BOARD_ADMIT)", f.BOARD_ADMIT == "on")
  ck("parseFlagsLine on(inert:...) -> dormant (enabled-but-inert)", f.INBOX_WAKE == "dormant")
  ck("parseFlagsLine keeps a flag AFTER the inert token (ROUND_DOCTOR)", f.ROUND_DOCTOR == "on")
  ck("parseFlagsLine keeps another flag AFTER the inert token (EXECUTOR_DIGEST)", f.EXECUTOR_DIGEST == "on")
  ck("parseFlagsLine keeps the opt-in TG_ENTRY after inert (off->dormant)", f.TG_ENTRY == "dormant")
  ck("parseFlagsLine did NOT leak the inert qualifier as a flag", f["inert"] == nil)
  -- a plain line with no inert still yields all its flags (no regression)
  local plain = parse.parseFlagsLine("flags: A_FLAG=on B_FLAG=off C_FLAG=on")
  ck("parseFlagsLine plain line yields all flags", plain.A_FLAG == "on" and plain.B_FLAG == "off" and plain.C_FLAG == "on")
  -- an inert flag as the LAST token (no trailing explanation) is still parsed as dormant
  local tail = parse.parseFlagsLine("flags: FANOUT=on(inert:x)")
  ck("parseFlagsLine inert as last token (no trailing paren) -> dormant", tail.FANOUT == "dormant")
end

-- lastFlagsLine picks the LAST flags line
do
  local body = table.concat({
    "[dispatch disp-1] flags: BOARD_ADMIT=off (old)",
    "some other log line",
    "[dispatch disp-2] flags: BOARD_ADMIT=on (new)",
    "trailing",
  }, "\n")
  local line = parse.lastFlagsLine(body)
  local f = parse.parseFlagsLine(line or "")
  ck("lastFlagsLine returns the most recent", f.BOARD_ADMIT == "on")
end

-- flagsFromEnv fallback semantics
do
  local env = { SWARM_BOARD_ADMIT = "0", SWARM_TG_ENTRY = "1" }
  local getenv = function(k)
    return env[k]
  end
  local f = parse.flagsFromEnv(getenv)
  ck("flagsFromEnv opt-out explicitly 0 -> off", f.BOARD_ADMIT == "off")
  ck("flagsFromEnv opt-out unset -> on", f.DIGEST == "on")
  ck("flagsFromEnv opt-in set 1 -> on", f.TG_ENTRY == "on")
  ck("flagsFromEnv opt-in unset -> dormant", f.FANOUT == "dormant")
end

-- countBoardStates over real board file names
do
  local names = {
    "liveness-impl-L2.claimed.20cab0a5.json",
    "projection-impl.done.20cab0a5.json",
    "swarm-resume.done.90b58f9c.json",
    "unrelated.txt",
  }
  local open, done = parse.countBoardStates(names)
  ck("countBoardStates open(claimed) = 1", open == 1)
  ck("countBoardStates done = 2", done == 2)
end

-- buildSeats over a herdr-like agents array
do
  local agents = {
    {
      agent_session = { value = "c5beaa7c" },
      agent_status = "working",
      terminal_title_stripped = "Happycapy Codex review",
    },
    {
      agent_session = "plain-string-sid",
      agent_status = "idle",
      terminal_title = "fallback title",
    },
  }
  local depths = { c5beaa7c = 2 }
  local seats = parse.buildSeats(agents, function(sid)
    return depths[sid] or 0
  end)
  ck("buildSeats count = 2", #seats == 2)
  ck("buildSeats id from agent_session.value", seats[1].id == "c5beaa7c")
  ck("buildSeats title from terminal_title_stripped", seats[1].title == "Happycapy Codex review")
  ck("buildSeats herdrState from agent_status", seats[1].herdrState == "working")
  ck("buildSeats inboxDepth injected", seats[1].inboxDepth == 2)
  ck("buildSeats task mirrors title", seats[1].task == "Happycapy Codex review")
  ck("buildSeats handles string agent_session", seats[2].id == "plain-string-sid")
  ck("buildSeats falls back to terminal_title", seats[2].title == "fallback title")
end

-- countReviewStates (A8+context 在审N; its 2nd return is NOT 候裁 anymore — 候裁 is countUnresolvedBatches below)
do
  local reviews = {
    { state = "reviewing" },
    { state = "queued" },
    { state = "done" },
    { state = "changes-requested" },
  }
  local reviewing, awaiting, total = parse.countReviewStates(reviews)
  ck("countReviewStates reviewing (在审) = 1", reviewing == 1)
  ck("countReviewStates awaiting (候裁) = 3", awaiting == 3)
  ck("countReviewStates total = 4", total == 4)
  local r0, a0, t0 = parse.countReviewStates({})
  ck("countReviewStates empty -> 0/0/0", r0 == 0 and a0 == 0 and t0 == 0)
end

-- countActiveReviews (TE-ACTIVE-LABEL): ACTIVE = state not terminal/done (distinct from 在审 = reviewing).
do
  local reviews = {
    { state = "reviewing" }, { state = "queued" }, { state = "changes-requested" }, { state = "done" },
  }
  ck("countActiveReviews excludes done rows (3 of 4)", parse.countActiveReviews(reviews) == 3)
  ck("countActiveReviews on a done-ONLY queue = 0 (the bug: #rows said 1)", parse.countActiveReviews({ { state = "done" } }) == 0)
  ck("countActiveReviews empty = 0", parse.countActiveReviews({}) == 0)
  ck("countActiveReviews bad arg = 0", parse.countActiveReviews(nil) == 0)
end

-- countUnresolvedBatches (A8+context 候裁M): a batch dir = any dir CONTAINING batch.json (store reality, NOT a
-- `batch-` name prefix); RESOLVED iff consumed.json exists. Both predicates injected (TE-RULING-ID).
do
  -- store reality: {batch=has batch.json, consumed=has consumed.json}
  local store = {
    ["batch-aaa"] = { batch = true, consumed = false },        -- prefixed, unresolved
    ["release_20261014"] = { batch = true, consumed = false },  -- CUSTOM --batch-id (no prefix), unresolved
    ["batch-bbb"] = { batch = true, consumed = true },          -- sealed (consumed.json)
    ["batch-empty"] = { batch = false, consumed = false },      -- NOT a batch (no batch.json) despite the name
    ["stray-dir"] = { batch = false, consumed = false },
  }
  local names = { "batch-aaa", "release_20261014", "batch-bbb", "batch-empty", "stray-dir", ".DS_Store" }
  local hasBatchJson = function(nm)
    return store[nm] ~= nil and store[nm].batch == true
  end
  local consumedExists = function(nm)
    return store[nm] ~= nil and store[nm].consumed == true
  end
  ck("countUnresolvedBatches: unresolved-by-batch.json incl CUSTOM id (batch-aaa, release_20261014) = 2",
    parse.countUnresolvedBatches(names, hasBatchJson, consumedExists) == 2)
  ck("countUnresolvedBatches: a non-prefixed custom id with batch.json counts (release_20261014)",
    parse.countUnresolvedBatches({ "release_20261014" }, hasBatchJson, consumedExists) == 1)
  ck("countUnresolvedBatches: a dir WITHOUT batch.json is ignored even if named batch-*",
    parse.countUnresolvedBatches({ "batch-empty" }, hasBatchJson, consumedExists) == 0)
  ck("countUnresolvedBatches: a sealed batch (consumed.json) is not counted",
    parse.countUnresolvedBatches({ "batch-bbb" }, hasBatchJson, consumedExists) == 0)
  ck("countUnresolvedBatches: skips dotfiles",
    parse.countUnresolvedBatches({ ".DS_Store" }, function() return true end, function() return false end) == 0)
  ck("countUnresolvedBatches bad args -> 0",
    parse.countUnresolvedBatches(nil, nil, nil) == 0
      and parse.countUnresolvedBatches({ "batch-z" }, nil, nil) == 0
      and parse.countUnresolvedBatches({ "batch-z" }, function() return true end, nil) == 0)
end

-- parseSwarmUrl (A6+route)
do
  local k1, r1 = parse.parseSwarmUrl("swarm://file/Users/wowdd1/.agenthop/swarm/PROGRESS.md")
  ck("parseSwarmUrl file -> kind file", k1 == "file")
  ck("parseSwarmUrl file -> keeps leading-slash abspath", r1 == "/Users/wowdd1/.agenthop/swarm/PROGRESS.md")
  local k2, r2 = parse.parseSwarmUrl("swarm://pane/w1:p1")
  ck("parseSwarmUrl pane -> kind pane", k2 == "pane")
  ck("parseSwarmUrl pane -> herdr id w1:p1", r2 == "w1:p1")
  local k2b, r2b = parse.parseSwarmUrl("swarm://pane/42")
  ck("parseSwarmUrl pane numeric", k2b == "pane" and r2b == "42")
  local k3 = parse.parseSwarmUrl("https://example.com")
  ck("parseSwarmUrl non-swarm -> nil (built-in handles it)", k3 == nil)
  local k4, r4 = parse.parseSwarmUrl("swarm://bogus/x")
  ck("parseSwarmUrl unknown subtype -> kind unknown", k4 == "unknown" and r4 == "bogus/x")
  ck("swarmFileUrl builds the scheme", parse.swarmFileUrl("/a/b") == "swarm://file/a/b")
end

-- snapshot.luau emits swarm:// links (A6+route: canvas/snapshot references must be swarm:// links)
do
  local snapshot = assert(loadfile(here .. "../snapshot.luau"))()
  -- home-derived fallback (no sources): the swarm:// link invariants still hold
  local md = snapshot.buildMarkdown({
    ts = 123,
    home = "/Users/wowdd1",
    lastCycle = { num = 877, title = "demo" },
    activeReviewCount = 5,
    reviewRowCount = 6,
    boardOpen = 4,
    boardDone = 17,
    flagsSummary = "13 on",
  })
  ck("snapshot emits a swarm://file link for PROGRESS.md (home fallback)",
    md:find("swarm://file/Users/wowdd1/.agenthop/swarm/PROGRESS.md", 1, true) ~= nil)
  ck("snapshot keeps the plain path visible as the link label",
    md:find("[/Users/wowdd1/.agenthop/swarm/PROGRESS.md]", 1, true) ~= nil)
  ck("snapshot leaves 'herdr api snapshot' as plain code (not a file link)",
    md:find("`herdr api snapshot`", 1, true) ~= nil)
  ck("snapshot does NOT linkify the <session-id> path template",
    md:find("swarm://file/Users/wowdd1/.agenthop/inbox/<session-id>", 1, true) == nil)
  -- TE-ACTIVE-LABEL: "active reviews" = ACTIVE count; raw rows shown separately
  ck("snapshot labels ACTIVE reviews (5) with raw rows (6)",
    md:find("active reviews: **5** (rows: 6)", 1, true) ~= nil)

  -- TE-SOURCE-PATH: wayfinding points at the REAL source read (e.g. SWARM_REVIEW_REPORTS override),
  -- not the hardcoded ~/Work/review-reports default; the nonexistent ACTIVE-REVIEW-QUEUE.md default is gone.
  local over = snapshot.buildMarkdown({
    ts = 1,
    home = "/Users/wowdd1",
    sources = {
      progress = "/Users/wowdd1/.agenthop/swarm/PROGRESS.md",
      reviewReports = "/Users/wowdd1/custom-reports",
    },
    activeReviewCount = 1,
    reviewRowCount = 1,
  })
  ck("snapshot points at the REAL reviewReports source (override)",
    over:find("swarm://file/Users/wowdd1/custom-reports", 1, true) ~= nil)
  ck("snapshot drops the nonexistent ACTIVE-REVIEW-QUEUE.md default",
    over:find("ACTIVE-REVIEW-QUEUE.md", 1, true) == nil)

  -- FC-2: an unknown source renders as (unavailable), never a false 0
  local unk = snapshot.buildMarkdown({ ts = 1, home = "/Users/wowdd1" })
  ck("snapshot renders unknown active reviews as (unavailable)",
    unk:find("active reviews: (unavailable) (rows: (unavailable))", 1, true) ~= nil)
  ck("snapshot renders unknown board as (unavailable)",
    unk:find("board: (unavailable) claimed / (unavailable) done", 1, true) ~= nil)
end

print("")
if failures == 0 then
  print("PASS (0 failures)")
  os.exit(0)
else
  print("FAIL (" .. failures .. " failure(s))")
  os.exit(1)
end
