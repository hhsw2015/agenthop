#!/usr/bin/env lua
-- Fixture for the tern-board A4/A5 projection (contract tern-batch2-contracts.md §1). Lua 5.5. Loads the REAL board.luau (pure cores) +
-- board-run.luau (parsers/helpers/run), injects FAKE deps, uses REAL temp files for the atomic-write fixtures. Run from the plugin dir:
-- `lua test/board.test.lua`. r3 adds the eight review findings' regressions (TB-OWN/WRITE/FC2/QUOTE/ID/ROUND/ARCH/BRANCH), each with teeth.

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
local function rv(item, sha, seat, recent) return { item = item, sha = sha, seat = seat, kind = "review", recent = recent ~= false } end
local function so(item, sha, seat) return { item = item, sha = sha, seat = seat, kind = "signoff" } end

-- ============================ PURE: content-addressed card id (TB-ID: 64-bit, no djb2 collision) ============================
ok("card_id: stable for identical (item,sha,seat)", board.card_id("fleet-recovery", "5227c6a", "work") == board.card_id("fleet-recovery", "5227c6a", "work"))
ok("card_id: changes when content changes", board.card_id("fleet-recovery", "5227c6a", "work") ~= board.card_id("fleet-recovery", "aaaaaaa", "work"))
ok("card_id: encoding injective over the tuple boundary", board.card_id("a\30b", "c", "d") ~= board.card_id("a", "b\30c", "d"))
ok("TB-ID: the 32-bit djb2 collision pair 'Ab'/'BA' now DIFFERS (64-bit)", board.card_id("Ab", "1111111", "s") ~= board.card_id("BA", "1111111", "s"))
ok("card_id: 16 lowercase hex (64-bit)", board.card_id("x", "y", "z"):match("^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$") ~= nil)

-- ============================ PURE: durable-name parsers ============================
do
  local r = R.parse_review_dir("fleet-recovery-5227c6a-review-01a13284")
  ok("parse_review_dir", r ~= nil and r.item == "fleet-recovery" and r.sha == "5227c6a" and r.seat == "01a13284")
  local s = R.parse_signoff_dir("verification-ledger-fb65753-dual-signoff-01a13284")
  ok("parse_signoff_dir", s ~= nil and s.item == "verification-ledger" and s.sha == "fb65753")
  ok("parse_review_dir: a dual-signoff is NOT a review", R.parse_review_dir("verification-ledger-fb65753-dual-signoff-01a13284") == nil)
  ok("parse_review_dir: a fact-evidence dir is not a review", R.parse_review_dir("agentic-economics-2580855-fact-evidence") == nil)
  local b = R.parse_board_file("approval-delegation.claimed.90b58f9c.json")
  ok("parse_board_file", b ~= nil and b.item == "approval-delegation" and b.state == "claimed" and b.seat == "90b58f9c")
  ok("parse_board_file: done/granted", (R.parse_board_file("x.done.y.json") or {}).state == "done" and (R.parse_board_file("x.granted.y.json") or {}).state == "granted")
  ok("parse_board_file: ignores non-board", R.parse_board_file("foo.txt") == nil)
end

-- ============================ PURE: lane classification (unified newest-first rounds) ============================
do
  local facts = {
    board = { { item = "alpha", state = "claimed", seat = "s1" }, { item = "beta", state = "done", seat = "s2" } },
    rounds = { rv("gamma", "aaaaaaa", "rev"), so("delta", "bbbbbbb", "rev"), so("eps", "ccccccc", "rev") },
  }
  local lanes = board.classify(facts, function(sha) return sha == "bbbbbbb" end)
  ok("classify: Merged = dual-signed + in-main (delta)", #lanes.Merged == 1 and lanes.Merged[1].item == "delta")
  ok("classify: Needs-human = dual-signed not-merged (eps)", #lanes["Needs-human"] == 1 and lanes["Needs-human"][1].item == "eps")
  ok("classify: Reviewing = review round (gamma)", #lanes.Reviewing == 1 and lanes.Reviewing[1].item == "gamma")
  ok("classify: Queued = claimed no-round (alpha); done (beta) excluded", #lanes.Queued == 1 and lanes.Queued[1].item == "alpha")
  local flipped = board.classify(facts, function() return false end)
  ok("classify teeth: is_ancestor=false ⇒ 0 Merged, both signoffs Needs-human", #flipped.Merged == 0 and #flipped["Needs-human"] == 2)
end

-- TB-ROUND: a NEW review round (new SHA) must win over an OLD signoff of the same item (newest-first wins; old signoff can't swallow it)
do
  local facts = { board = {}, rounds = { rv("ticket", "bbbbbbb", "seat"), so("ticket", "aaaaaaa", "seat") } } -- review newest, signoff older
  local lanes = board.classify(facts, function(sha) return sha == "aaaaaaa" end) -- only the OLD sha is on main
  ok("TB-ROUND: new review round overrides old signoff ⇒ item in Reviewing, NOT Merged", #lanes.Reviewing == 1 and lanes.Reviewing[1].sha == "bbbbbbb" and #lanes.Merged == 0)
  -- symmetric: signoff newest ⇒ item is Merged/NH (newest wins the other way)
  local f2 = { board = {}, rounds = { so("ticket", "aaaaaaa", "seat"), rv("ticket", "bbbbbbb", "seat") } }
  local l2 = board.classify(f2, function(sha) return sha == "aaaaaaa" end)
  ok("TB-ROUND: signoff newest ⇒ Merged (newest wins either direction)", #l2.Merged == 1 and #l2.Reviewing == 0)
end

-- v2 recency: Reviewing keeps only a recent latest round; Needs-human ignores recency; dedupe keeps the newest round per item
do
  local facts = { board = {}, rounds = { rv("fresh", "1111111", "s", true), rv("stale", "2222222", "s", false), so("olddebt", "3333333", "s") } }
  local lanes = board.classify(facts, function() return false end)
  local has = function(lane, it) for _, c in ipairs(lane) do if c.item == it then return true end end return false end
  ok("recency: recent latest round ⇒ Reviewing", has(lanes.Reviewing, "fresh"))
  ok("recency teeth: stale latest round ⇒ dropped from Reviewing (and not fallen back to Queued)", not has(lanes.Reviewing, "stale") and #lanes.Reviewing == 1 and #lanes.Queued == 0)
  ok("recency: Needs-human ignores recency (old debt shown)", has(lanes["Needs-human"], "olddebt"))
  local dd = board.classify({ board = {}, rounds = { rv("g", "newnew1", "s"), rv("g", "oldold1", "s") } }, function() return false end)
  ok("dedupe: newest round per item only", #dd.Reviewing == 1 and dd.Reviewing[1].sha == "newnew1")
end

-- TB-ID tie-break: output order is deterministic even if two cards shared an id (sort falls back to full identity)
do
  local a = board.classify({ board = {}, rounds = { rv("i1", "1111111", "s"), rv("i2", "2222222", "s") } }, function() return false end)
  local b = board.classify({ board = {}, rounds = { rv("i2", "2222222", "s"), rv("i1", "1111111", "s") } }, function() return false end) -- reversed input
  ok("TB-ID: lane order is input-order-independent (full-identity tie-break)", board.render_review_board(a) == board.render_review_board(b))
end

-- ============================ PURE: runbook mtime chain ============================
do
  local all = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = true, mtime = 300 }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = true, mtime = 500 } })
  ok("runbook: monotonic ⇒ all five checked", all[1].checked and all[5].checked)
  local gap = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = false, mtime = nil }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = true, mtime = 500 } })
  ok("runbook: missing artifact ⇒ that step + later UNCHECKED (honest gap)", gap[2].checked and not gap[3].checked and not gap[4].checked and not gap[5].checked and gap[3].reason == "artifact missing")
  local nm = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 300 }, { name = "regen-presence", exists = true, mtime = 200 } })
  ok("runbook: non-monotonic mtime ⇒ unchecked", nm[1].checked and not nm[2].checked)
end

-- ============================ PURE: render ============================
do
  local lanes = board.classify({ board = {}, rounds = { rv("x", "1234567", "s") } }, function() return false end)
  local md = board.render_review_board(lanes)
  ok("render: four lanes, correct order", select(2, md:gsub("## ", "")) == 4 and md:find("## Queued", 1, true) < md:find("## Reviewing", 1, true) and md:find("## Reviewing", 1, true) < md:find("## Needs%-human") and md:find("## Needs%-human") < md:find("## Merged", 1, true))
  ok("render: card format '<id> · <item> @<sha7> [<seat>] #review'", md:find("· x @1234567 %[s%] #review") ~= nil)
  ok("render: deterministic", md == board.render_review_board(lanes))
  local rb = board.render_runbook_board({ { branch = "rehearse-batch-21", steps = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 1 } }), artifacts = { ["merge-pool"] = "rehearse-batch-21" } } })
  ok("render runbook: [RUNBOOK] card + checked sub + artifact note", rb:find("[RUNBOOK] batch-release rehearse-batch-21", 1, true) and rb:find("- [x] merge-pool", 1, true) and rb:find("artifact paths", 1, true))
  ok("render runbook: empty ⇒ honest note", board.render_runbook_board({}):find("no batch branch in flight", 1, true) ~= nil)
end

-- ============================ TB-QUOTE: shq POSIX single-quote escaping ============================
do
  ok("TB-QUOTE: shq wraps in single quotes (no $() expansion)", R.shq("a$(printf X)b") == "'a$(printf X)b'")
  ok("TB-QUOTE: shq escapes an embedded single quote", R.shq("it's") == "'it'\\''s'")
  -- functional: a path with $() survives verbatim through the shell (mktemp in a dir whose name has $() would otherwise expand)
  local d = mktemp_dir() .. "/x$(printf INJECT)y"
  os.execute("mkdir -p " .. R.shq(d))
  local present = os.execute("test -d " .. R.shq(d) .. " >/dev/null 2>&1")
  ok("TB-QUOTE: a $()-containing dir name is treated literally (dir created, no INJECT expansion)", (present == true or present == 0))
end

-- ============================ TB-BRANCH / TB-ARCH: pure selection helpers ============================
do
  ok("TB-BRANCH: pick_batch is NUMERIC not lexical (batch-23 > batch-9)", R.pick_batch({ "rehearse-batch-9", "rehearse-batch-23" }) == "rehearse-batch-23")
  ok("TB-BRANCH: pick_batch nil when no in-flight batch", R.pick_batch({}) == nil)
  ok("TB-ARCH: match_arch requires the tip SHA in the signoff name", R.match_arch({ "batch1-dual-signoff-aaaaaaa-seat.md" }, "bbbbbbb") == nil)
  ok("TB-ARCH: match_arch returns the signoff for THIS tip", R.match_arch({ "batch23-dual-signoff-bbbbbbb-seat.md" }, "bbbbbbb") == "batch23-dual-signoff-bbbbbbb-seat.md")
end

-- ============================ deps + run ============================
local function fakeDeps(tmp, review_names, board_names, anc_set, batches, opts)
  opts = opts or {}
  return {
    review_path = tmp .. "/review-board.md", runbook_path = tmp .. "/runbook-board.md",
    list_reviews = function() return review_names, (opts.review_status or "read") end,
    list_board = function() return board_names, (opts.board_status or "read") end,
    recent_set = function() local s = {}; for _, n in ipairs(review_names) do if not (opts.stale and opts.stale[n]) then s[n] = true end end return s end,
    is_ancestor = function(sha) return anc_set[sha] == true end,
    batches = function() return batches end,
    write_atomic = R.write_atomic,
  }
end
local RNAMES = { "fleet-recovery-5227c6a-review-01a13284", "verification-ledger-fb65753-dual-signoff-01a13284" }
local BNAMES = { "alpha.claimed.s1.json", "beta.done.s2.json" }
local BATCHES = { { branch = "rehearse-batch-21", artifacts = { ["merge-pool"] = "rehearse-batch-21" }, steps_facts = { { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = false, mtime = nil }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = false, mtime = nil } } } }

-- ============================ 3-FIXTURE: idempotent / half-write / concurrent ============================
do
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
    ok("fixture[idempotent]: ledger (signed, not merged) BETWEEN Needs-human and Merged", nh and mg and vl and vl > nh and vl < mg)
  end
  write_file(tmp .. "/review-board.md", "GARBAGE {{{ half-written partial board")
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  ok("fixture[half-write]: garbage pre-write fully overwritten (no corruption/append)", read_file(tmp .. "/review-board.md") == rev1)
  local depsA = fakeDeps(tmp, { "aaa-1111111-review-s" }, {}, {}, {})
  local depsB = fakeDeps(tmp, { "bbb-2222222-review-s" }, {}, {}, {})
  R.run(depsA); R.run(depsB)
  local final = read_file(tmp .. "/review-board.md")
  local expectB = board.render_review_board(board.classify(R.gather(depsB), depsB.is_ancestor))
  ok("fixture[concurrent]: final is EXACTLY one complete board (B, last writer), no A/B mix", final == expectB and final:find("aaa", 1, true) == nil and final:find("bbb", 1, true) ~= nil)
  ok("fixture[concurrent]: no leftover predictable .tmp file", read_file(tmp .. "/review-board.md.tmp") == nil)
end

-- ============================ TB-OWN + TB-WRITE: a write failure keeps the OLD board (never a half/empty publish) ============================
do
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local good = read_file(tmp .. "/review-board.md")
  -- make the dir unwritable ⇒ mktemp fails ⇒ write_atomic returns false and the old board is untouched (TB-OWN/TB-WRITE invariant)
  if (os.getenv("USER") ~= "root") then
    os.execute("chmod 500 " .. R.shq(tmp))
    local okw, err = R.write_atomic(tmp .. "/review-board.md", "NEW CONTENT SHOULD NOT LAND")
    os.execute("chmod 700 " .. R.shq(tmp)) -- restore so read works
    ok("TB-OWN/WRITE: write_atomic to an unwritable dir returns false", okw == false and err ~= nil)
    ok("TB-OWN/WRITE: the old board is UNCHANGED after a failed write (no half/empty publish)", read_file(tmp .. "/review-board.md") == good)
  else
    print("skip - TB-OWN/WRITE unwritable-dir (running as root)")
  end
  -- mktemp uniqueness: two temps in a row differ (TB-OWN: no predictable colliding name)
  local d = mktemp_dir()
  local t1 = io.popen("mktemp " .. R.shq(d .. "/.x.tmp.XXXXXXXX")); local n1 = t1:read("*l"); t1:close()
  local t2 = io.popen("mktemp " .. R.shq(d .. "/.x.tmp.XXXXXXXX")); local n2 = t2:read("*l"); t2:close()
  ok("TB-OWN: mktemp yields distinct exclusive temp names", n1 ~= nil and n2 ~= nil and n1 ~= n2)
end

-- ============================ TB-FC2: an UNREADABLE source aborts the run and keeps the old board ============================
do
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local good = read_file(tmp .. "/review-board.md")
  local res = R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES, { review_status = "unreadable" }))
  ok("TB-FC2: unreadable review source ⇒ run aborts (wrote_review=false, error set)", res.wrote_review == false and res.error == "unreadable-source")
  ok("TB-FC2: the old board is NOT overwritten by a clean-empty projection", read_file(tmp .. "/review-board.md") == good)
  -- absent (not unreadable) is legitimately empty ⇒ run proceeds and writes
  local tmp2 = mktemp_dir()
  local res2 = R.run(fakeDeps(tmp2, {}, {}, {}, {}, { review_status = "absent", board_status = "absent" }))
  ok("TB-FC2: absent sources ⇒ run proceeds (empty is legitimate)", res2.wrote_review == true and res2.counts.Reviewing == 0)
end

-- ============================ acceptance: cross-check against REAL ~/Work/review-reports ============================
do
  local home = os.getenv("HOME") or ""
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local names, p = {}, io.popen("ls -1 " .. R.shq(review_reports) .. " 2>/dev/null", "r")
  if p then for line in p:lines() do names[#names + 1] = line end p:close() end
  if #names == 0 then
    print("skip - acceptance: no real ~/Work/review-reports")
  else
    local rounds = 0
    for _, n in ipairs(names) do if R.parse_signoff_dir(n) or R.parse_review_dir(n) then rounds = rounds + 1 end end
    ok("acceptance: real review-reports parse into rounds (>=1)", rounds >= 1)
    local deps = fakeDeps(mktemp_dir(), names, {}, {}, {})
    local md = board.render_review_board(board.classify(R.gather(deps), deps.is_ancestor))
    ok("acceptance: real-data projection renders a valid 4-lane board", md:find("^# Review queue") ~= nil and select(2, md:gsub("## ", "")) == 4)
  end
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
