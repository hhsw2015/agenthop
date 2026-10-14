#!/usr/bin/env lua
-- Fixture for the tern-board A4/A5 projection (contract tern-batch2-contracts.md §1). Lua 5.5. Loads the REAL board.luau (pure cores) +
-- board-run.luau (durable-name parsers + run orchestration), injects FAKE git/dir deps, and uses REAL temp files for the atomic-write
-- fixtures — so the 3-fixture law (idempotent byte-same / half-write-crash / concurrent-single-win) is exercised against the real
-- write_atomic. Run from the plugin dir: `lua test/board.test.lua`. Has teeth: a non-monotonic runbook mtime, a stale/mismatched
-- git-ancestor, and a garbage pre-write each flip the asserted result.

local here = (arg[0] or ""):match("^(.*/)") or "./"
package.path = here .. "../?.luau;" .. package.path
local board = require("board")
local R = require("board-run")

local failures = 0
local function ok(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then failures = failures + 1 end
end
local function read_file(p) local f = io.open(p, "r"); if not f then return nil end local c = f:read("*a"); f:close(); return c end
local function write_file(p, s) local f = assert(io.open(p, "w")); f:write(s); f:close() end
local function mktemp_dir() local d = os.tmpname(); os.remove(d); assert(os.execute("mkdir -p " .. string.format("%q", d))); return d end

-- ============================ PURE: content-addressed card id ============================
ok("card_id: stable for identical (item,sha,seat)", board.card_id("fleet-recovery", "5227c6a", "work") == board.card_id("fleet-recovery", "5227c6a", "work"))
ok("card_id: changes when content changes", board.card_id("fleet-recovery", "5227c6a", "work") ~= board.card_id("fleet-recovery", "aaaaaaa", "work"))
ok("card_id: injective over the tuple boundary (no separator collision)", board.card_id("a\30b", "c", "d") ~= board.card_id("a", "b\30c", "d"))
ok("card_id: 8 lowercase hex", board.card_id("x", "y", "z"):match("^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$") ~= nil)

-- ============================ PURE: durable-name parsers ============================
do
  local rv = R.parse_review_dir("fleet-recovery-5227c6a-review-01a13284")
  ok("parse_review_dir: hyphenated item + sha + seat", rv ~= nil and rv.item == "fleet-recovery" and rv.sha == "5227c6a" and rv.seat == "01a13284")
  local so = R.parse_signoff_dir("verification-ledger-fb65753-dual-signoff-01a13284")
  ok("parse_signoff_dir: hyphenated item + sha + seat", so ~= nil and so.item == "verification-ledger" and so.sha == "fb65753")
  ok("parse_review_dir: a dual-signoff name is NOT a review (so it isn't double-counted)", R.parse_review_dir("verification-ledger-fb65753-dual-signoff-01a13284") == nil)
  ok("parse_review_dir: a fact-evidence dir is not a review", R.parse_review_dir("agentic-economics-2580855-fact-evidence") == nil)
  local bf = R.parse_board_file("approval-delegation.claimed.90b58f9c.json")
  ok("parse_board_file: item.state.sid", bf ~= nil and bf.item == "approval-delegation" and bf.state == "claimed" and bf.seat == "90b58f9c")
  ok("parse_board_file: done state", (R.parse_board_file("x.done.y.json") or {}).state == "done")
  ok("parse_board_file: granted state", (R.parse_board_file("x.granted.y.json") or {}).state == "granted")
  ok("parse_board_file: ignores non-board names", R.parse_board_file("foo.txt") == nil)
end

-- ============================ PURE: lane classification (coordinator-locked mapping) ============================
do
  local facts = {
    board = { { item = "alpha", state = "claimed", seat = "s1" }, { item = "beta", state = "done", seat = "s2" } },
    reviews = { { item = "gamma", sha = "aaaaaaa", seat = "rev" } },
    signoffs = { { item = "delta", sha = "bbbbbbb", seat = "rev" }, { item = "eps", sha = "ccccccc", seat = "rev" } },
  }
  local is_anc = function(sha) return sha == "bbbbbbb" end -- delta merged; eps dual-signed but not merged
  local lanes = board.classify(facts, is_anc)
  ok("classify: Merged = the dual-signed + in-main-ancestry card (delta)", #lanes.Merged == 1 and lanes.Merged[1].item == "delta")
  ok("classify: Needs-human = dual-signed but NOT merged (eps)", #lanes["Needs-human"] == 1 and lanes["Needs-human"][1].item == "eps")
  ok("classify: Reviewing = in-flight review dir (gamma)", #lanes.Reviewing == 1 and lanes.Reviewing[1].item == "gamma")
  ok("classify: Queued = claimed, no review (alpha); done (beta) excluded", #lanes.Queued == 1 and lanes.Queued[1].item == "alpha")
  ok("classify: a Needs-human card title carries @sha7 [seat]", lanes["Needs-human"][1].sha == "ccccccc" and lanes["Needs-human"][1].seat == "rev")

  -- teeth: flip is_ancestor ⇒ delta moves Merged->Needs-human (so the git check actually drives the lane)
  local flipped = board.classify(facts, function() return false end)
  ok("classify teeth: is_ancestor=false ⇒ nothing Merged, both signoffs Needs-human", #flipped.Merged == 0 and #flipped["Needs-human"] == 2)

  -- an item under review is NOT also Queued; an item dual-signed is NOT also Reviewing
  local f2 = { board = { { item = "gamma", state = "claimed", seat = "s" } }, reviews = { { item = "gamma", sha = "a123456", seat = "r" } }, signoffs = {} }
  local l2 = board.classify(f2, function() return false end)
  ok("classify: an item in review is not double-listed in Queued", #l2.Queued == 0 and #l2.Reviewing == 1)
  local f3 = { board = {}, reviews = { { item = "zed", sha = "d123456", seat = "r" } }, signoffs = { { item = "zed", sha = "d123456", seat = "r" } } }
  local l3 = board.classify(f3, function() return false end)
  ok("classify: a dual-signed item is not also in Reviewing", #l3.Reviewing == 0 and #l3["Needs-human"] == 1)
end

-- ============================ PURE: runbook mtime chain ============================
do
  local all = board.runbook_steps({
    { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 },
    { name = "gates", exists = true, mtime = 300 }, { name = "arch-review", exists = true, mtime = 400 },
    { name = "ff-main-install", exists = true, mtime = 500 },
  })
  ok("runbook: monotonic chain ⇒ all five checked", all[1].checked and all[2].checked and all[3].checked and all[4].checked and all[5].checked)
  local gap = board.runbook_steps({
    { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 },
    { name = "gates", exists = false, mtime = nil }, { name = "arch-review", exists = true, mtime = 400 },
    { name = "ff-main-install", exists = true, mtime = 500 },
  })
  ok("runbook: a MISSING artifact (v1 batch-gates) ⇒ that step + all later UNCHECKED (honest gap, not guessed)", gap[2].checked and not gap[3].checked and not gap[4].checked and not gap[5].checked)
  ok("runbook: the missing step carries a reason", gap[3].reason == "artifact missing" and gap[4].reason ~= nil)
  local nonmono = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 300 }, { name = "regen-presence", exists = true, mtime = 200 } })
  ok("runbook: non-monotonic mtime (step2 older than step1) ⇒ step2 UNCHECKED", nonmono[1].checked and not nonmono[2].checked)
end

-- ============================ PURE: render determinism + shape ============================
do
  local lanes = board.classify({ board = {}, reviews = { { item = "x", sha = "1234567", seat = "s" } }, signoffs = {} }, function() return false end)
  local md = board.render_review_board(lanes)
  ok("render_review_board: four '## ' lanes", select(2, md:gsub("## ", "")) == 4)
  ok("render_review_board: lane order Queued<Reviewing<Needs-human<Merged", md:find("## Queued", 1, true) < md:find("## Reviewing", 1, true) and md:find("## Reviewing", 1, true) < md:find("## Needs%-human") and md:find("## Needs%-human") < md:find("## Merged", 1, true))
  ok("render_review_board: card line format '<id> · <item> @<sha7> [<seat>] #review'", md:find("· x @1234567 %[s%] #review") ~= nil)
  ok("render_review_board: deterministic", md == board.render_review_board(lanes))
  local rbmd = board.render_runbook_board({ { branch = "rehearse-batch-21", steps = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 1 } }), artifacts = { ["merge-pool"] = "rehearse-batch-21" } } })
  ok("render_runbook_board: [RUNBOOK] card + a checked sub + artifact note", rbmd:find("[RUNBOOK] batch-release rehearse-batch-21", 1, true) ~= nil and rbmd:find("- [x] merge-pool", 1, true) ~= nil and rbmd:find("artifact paths", 1, true) ~= nil)
  ok("render_runbook_board: empty ⇒ honest '(no batch branch in flight)'", board.render_runbook_board({}):find("no batch branch in flight", 1, true) ~= nil)
end

-- ============================ fake deps for run() ============================
local function fakeDeps(tmp, review_names, board_names, anc_set, batches)
  return {
    review_path = tmp .. "/review-board.md", runbook_path = tmp .. "/runbook-board.md",
    list_reviews = function() return review_names end,
    list_board = function() return board_names end,
    is_ancestor = function(sha) return anc_set[sha] == true end,
    batches = function() return batches end,
    write_atomic = R.write_atomic, -- the REAL atomic write (temp + os.rename)
  }
end
local RNAMES = { "fleet-recovery-5227c6a-review-01a13284", "verification-ledger-fb65753-dual-signoff-01a13284" }
local BNAMES = { "alpha.claimed.s1.json", "beta.done.s2.json" }
local BATCHES = { { branch = "rehearse-batch-21", artifacts = { ["merge-pool"] = "rehearse-batch-21" }, steps_facts = {
  { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 },
  { name = "gates", exists = false, mtime = nil }, { name = "arch-review", exists = true, mtime = 400 },
  { name = "ff-main-install", exists = false, mtime = nil } } } }

-- ============================ 3-FIXTURE: idempotent / half-write / concurrent (real temp + atomic write) ============================
do
  -- fixture 1 — idempotent rerun byte-same
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local rev1, run1 = read_file(tmp .. "/review-board.md"), read_file(tmp .. "/runbook-board.md")
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local rev2, run2 = read_file(tmp .. "/review-board.md"), read_file(tmp .. "/runbook-board.md")
  ok("fixture[idempotent]: review-board byte-identical on rerun", rev1 ~= nil and rev1 == rev2)
  ok("fixture[idempotent]: runbook-board byte-identical on rerun", run1 ~= nil and run1 == run2)
  do
    local nh, mg = rev1:find("## Needs-human", 1, true), rev1:find("## Merged", 1, true)
    local vl = rev1:find("verification-ledger @fb65753", 1, true)
    ok("fixture[idempotent]: ledger (signed, not merged) landed BETWEEN Needs-human and Merged", nh ~= nil and mg ~= nil and vl ~= nil and vl > nh and vl < mg)
  end

  -- fixture 2 — half-write crash: a garbage partial file is fully replaced by the next run (projection = no incremental state)
  write_file(tmp .. "/review-board.md", "GARBAGE {{{ half-written partial board")
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local recovered = read_file(tmp .. "/review-board.md")
  ok("fixture[half-write]: a garbage pre-write is fully overwritten (no corruption, no append)", recovered == rev1 and recovered:find("GARBAGE", 1, true) == nil)

  -- fixture 3 — concurrent single-win: two runs with DIFFERENT facts; atomic rename ⇒ the live file is EXACTLY one complete board, never interleaved
  local depsA = fakeDeps(tmp, { "aaa-1111111-review-s" }, {}, {}, {})
  local depsB = fakeDeps(tmp, { "bbb-2222222-review-s" }, {}, {}, {})
  R.run(depsA); R.run(depsB) -- B last
  local final = read_file(tmp .. "/review-board.md")
  local expectB = board.render_review_board(board.classify(R.gather(depsB), depsB.is_ancestor))
  ok("fixture[concurrent]: final file is EXACTLY one complete board (B, last writer), never an A/B byte-mix", final == expectB and final:find("aaa", 1, true) == nil and final:find("bbb", 1, true) ~= nil)
  ok("fixture[concurrent]: the winning file is a complete valid board (4 lanes, header)", final:find("^# Review queue") ~= nil and select(2, final:gsub("## ", "")) == 4)
end

-- ============================ acceptance: snapshot cross-check against REAL ~/Work/review-reports ============================
do
  local home = os.getenv("HOME") or ""
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local names = {}
  local p = io.popen("ls -1 " .. string.format("%q", review_reports) .. " 2>/dev/null", "r")
  if p then for line in p:lines() do names[#names + 1] = line end p:close() end
  if #names == 0 then
    print("skip - acceptance: no real ~/Work/review-reports (nothing to cross-check)")
  else
    local reviews, signoffs = 0, 0
    for _, n in ipairs(names) do
      if R.parse_signoff_dir(n) then signoffs = signoffs + 1 elseif R.parse_review_dir(n) then reviews = reviews + 1 end
    end
    ok("acceptance: real review-reports parse into review/signoff cards (>=1 of either; fact-evidence/other dirs ignored)", (reviews + signoffs) >= 1)
    -- render the real projection end-to-end (fake is_ancestor to avoid a hard git dep in the unit run) and assert it's a valid board
    local deps = fakeDeps(mktemp_dir(), names, {}, {}, {})
    local real_md = board.render_review_board(board.classify(R.gather(deps), deps.is_ancestor))
    ok("acceptance: real-data projection renders a valid 4-lane board", real_md:find("^# Review queue") ~= nil and select(2, real_md:gsub("## ", "")) == 4)
  end
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
