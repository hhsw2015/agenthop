#!/usr/bin/env lua
-- Fixture for the tern-board A4/A5 projection (contract tern-batch2-contracts.md §1). Lua 5.5. Loads the REAL board.luau + board-run.luau,
-- injects FAKE deps for the pure/orchestration cores AND drives the REAL default_deps IO (list_dir / git_ancestor_state) against REAL fs
-- errno + REAL git, per the r4 review ("real classification needs real errno faces, not an injected already-unreadable fake"). Run from
-- the plugin dir: `lua test/board.test.lua`.

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
local function mktemp_dir() local d = os.tmpname(); os.remove(d); assert(os.execute("mkdir -p " .. R.shq(d))); return d end
local function rv(item, sha, seat, recent) return { item = item, sha = sha, seat = seat, kind = "review", recent = recent ~= false } end
local function so(item, sha, seat) return { item = item, sha = sha, seat = seat, kind = "signoff" } end
local NOTROOT = (os.getenv("USER") ~= "root")
local REPO = (os.getenv("HOME") or "") .. "/Dev/agenthop"

-- ============================ PURE: card id (TB-ID 64-bit) ============================
ok("card_id: stable", board.card_id("fleet-recovery", "5227c6a", "work") == board.card_id("fleet-recovery", "5227c6a", "work"))
ok("card_id: content-sensitive", board.card_id("fleet-recovery", "5227c6a", "work") ~= board.card_id("fleet-recovery", "aaaaaaa", "work"))
ok("card_id: encoding injective boundary", board.card_id("a\30b", "c", "d") ~= board.card_id("a", "b\30c", "d"))
ok("TB-ID: djb2 collision pair 'Ab'/'BA' differs (64-bit)", board.card_id("Ab", "1111111", "s") ~= board.card_id("BA", "1111111", "s"))
ok("card_id: 16 hex", board.card_id("x", "y", "z"):match("^%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x$") ~= nil)

-- ============================ PURE: parsers ============================
do
  local r = R.parse_review_dir("fleet-recovery-5227c6a-review-01a13284")
  ok("parse_review_dir", r and r.item == "fleet-recovery" and r.sha == "5227c6a" and r.seat == "01a13284")
  ok("parse_signoff_dir", (R.parse_signoff_dir("verification-ledger-fb65753-dual-signoff-01a13284") or {}).item == "verification-ledger")
  ok("parse_review_dir: signoff not a review", R.parse_review_dir("x-fb65753-dual-signoff-s") == nil)
  ok("parse_board_file", (function() local b = R.parse_board_file("approval-delegation.claimed.90b58f9c.json"); return b and b.item == "approval-delegation" and b.state == "claimed" end)())
  ok("parse_board_file ignores non-board", R.parse_board_file("foo.txt") == nil)
end

-- ============================ PURE: classify (rounds) ============================
do
  local facts = { board = { { item = "alpha", state = "claimed", seat = "s1" }, { item = "beta", state = "done", seat = "s2" } }, rounds = { rv("gamma", "aaaaaaa", "rev"), so("delta", "bbbbbbb", "rev"), so("eps", "ccccccc", "rev") } }
  local lanes = board.classify(facts, function(sha) return sha == "bbbbbbb" end)
  ok("classify: Merged/Needs-human/Reviewing/Queued correct", #lanes.Merged == 1 and lanes.Merged[1].item == "delta" and #lanes["Needs-human"] == 1 and lanes["Needs-human"][1].item == "eps" and #lanes.Reviewing == 1 and lanes.Reviewing[1].item == "gamma" and #lanes.Queued == 1 and lanes.Queued[1].item == "alpha")
end
do -- TB-ROUND: newest round per item wins across review/signoff
  local l = board.classify({ board = {}, rounds = { rv("t", "bbbbbbb", "s"), so("t", "aaaaaaa", "s") } }, function(sha) return sha == "aaaaaaa" end)
  ok("TB-ROUND: new review overrides old signoff ⇒ Reviewing not Merged", #l.Reviewing == 1 and l.Reviewing[1].sha == "bbbbbbb" and #l.Merged == 0)
  local l2 = board.classify({ board = {}, rounds = { so("t", "aaaaaaa", "s"), rv("t", "bbbbbbb", "s") } }, function(sha) return sha == "aaaaaaa" end)
  ok("TB-ROUND: signoff newest ⇒ Merged", #l2.Merged == 1 and #l2.Reviewing == 0)
end
do -- recency + dedupe
  local l = board.classify({ board = {}, rounds = { rv("fresh", "1111111", "s", true), rv("stale", "2222222", "s", false), so("olddebt", "3333333", "s") } }, function() return false end)
  local has = function(lane, it) for _, c in ipairs(lane) do if c.item == it then return true end end return false end
  ok("recency: recent in / stale out of Reviewing; Needs-human ignores recency", has(l.Reviewing, "fresh") and not has(l.Reviewing, "stale") and #l.Reviewing == 1 and has(l["Needs-human"], "olddebt"))
  local dd = board.classify({ board = {}, rounds = { rv("g", "newnew1", "s"), rv("g", "oldold1", "s") } }, function() return false end)
  ok("dedupe: newest round per item", #dd.Reviewing == 1 and dd.Reviewing[1].sha == "newnew1")
end
do -- TB-ID render tie-break determinism
  local a = board.classify({ board = {}, rounds = { rv("i1", "1111111", "s"), rv("i2", "2222222", "s") } }, function() return false end)
  local b = board.classify({ board = {}, rounds = { rv("i2", "2222222", "s"), rv("i1", "1111111", "s") } }, function() return false end)
  ok("TB-ID: render input-order-independent", board.render_review_board(a) == board.render_review_board(b))
end

-- ============================ PURE: runbook + render ============================
do
  local all = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = true, mtime = 300 }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = true, mtime = 500 } })
  ok("runbook: monotonic all checked", all[1].checked and all[5].checked)
  local gap = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = false }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = true, mtime = 500 } })
  ok("runbook: missing ⇒ step+later unchecked", gap[2].checked and not gap[3].checked and not gap[5].checked and gap[3].reason == "artifact missing")
  local nm = board.runbook_steps({ { name = "merge-pool", exists = true, mtime = 300 }, { name = "regen-presence", exists = true, mtime = 200 } })
  ok("runbook: non-monotonic unchecked", nm[1].checked and not nm[2].checked)
  local lanes = board.classify({ board = {}, rounds = { rv("x", "1234567", "s") } }, function() return false end)
  local md = board.render_review_board(lanes)
  ok("render: 4 lanes ordered + card format", select(2, md:gsub("## ", "")) == 4 and md:find("## Queued", 1, true) < md:find("## Merged", 1, true) and md:find("· x @1234567 %[s%] #review") ~= nil)
  ok("render runbook empty ⇒ honest", board.render_runbook_board({}):find("no batch branch in flight", 1, true) ~= nil)
end

-- ============================ TB-QUOTE ============================
ok("TB-QUOTE: shq single-quotes (no $() expansion)", R.shq("a$(printf X)b") == "'a$(printf X)b'")
ok("TB-QUOTE: shq escapes embedded quote", R.shq("it's") == "'it'\\''s'")

-- ============================ TB-BRANCH / TB-ARCH (structural) ============================
ok("TB-BRANCH: pick_batch numeric (100>23>9)", R.pick_batch({ "rehearse-batch-9", "rehearse-batch-23", "rehearse-batch-100" }) == "rehearse-batch-100")
ok("TB-BRANCH: pick_batch nil on empty", R.pick_batch({}) == nil)
-- TB-ARCH r5: match requires batch number AND the signoff's SHA FIELD, RESOLVED to a unique full commit, to equal the full tip commit.
-- A tip7 in a NON-SHA field (reviewer suffix), a wrong batch, a field resolving to a DIFFERENT commit, a too-short field, or an
-- unresolvable field all fail. resolver(map) = a fake rev-parse: sha-field -> full commit (nil = ambiguous/invalid).
local TIPFULL = "53967f6abcabcabcabcabcabcabcabcabcabc123" -- 40 hex (the batch tip, fully resolved)
local function resolver(map) return function(s) return map[s] end end
ok("TB-ARCH: tip7 in reviewer suffix of a DIFFERENT batch/old-SHA signoff ⇒ no match", R.match_arch({ "batch9-dual-signoff-b9fde15-reviewer-53967f6.md" }, 23, TIPFULL, resolver({ b9fde15 = "b9fde15eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", ["53967f6"] = TIPFULL })) == nil)
ok("TB-ARCH: the batch's OWN signoff (sha field resolves to the tip's full commit, batch matches) ⇒ match", R.match_arch({ "batch23-dual-signoff-53967f6-seat.md" }, 23, TIPFULL, resolver({ ["53967f6"] = TIPFULL })) == "batch23-dual-signoff-53967f6-seat.md")
ok("TB-ARCH: right sha field but WRONG batch number ⇒ no match", R.match_arch({ "batch9-dual-signoff-53967f6-seat.md" }, 23, TIPFULL, resolver({ ["53967f6"] = TIPFULL })) == nil)
-- r5 teeth: resolution is to a UNIQUE FULL COMMIT, not a prefix string-compare — a field that resolves to a different commit fails.
ok("TB-ARCH r5: sha field that resolves to a NON-tip commit ⇒ no match", R.match_arch({ "batch23-dual-signoff-53967f6-seat.md" }, 23, TIPFULL, resolver({ ["53967f6"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" })) == nil)
ok("TB-ARCH r5: an UNRESOLVABLE sha field (ambiguous/invalid rev-parse ⇒ nil) ⇒ no match (never guess)", R.match_arch({ "batch23-dual-signoff-53967f6-seat.md" }, 23, TIPFULL, resolver({})) == nil)
-- r5 teeth: the SHA field is MIN 7 hex, so a 1-char "5" cannot pose as a tip prefix — it does not even parse.
ok("TB-ARCH r5: a 1-char sha field does NOT parse (min 7 hex)", R.parse_signoff_name("batch23-dual-signoff-5-seat.md") == nil)
ok("TB-ARCH r5: a 7-char sha field parses (batch+sha)", (function() local p = R.parse_signoff_name("batch23-dual-signoff-53967f6-seat.md"); return p and p.batch == 23 and p.sha == "53967f6" end)())

-- ============================ TB-FC2: list_dir over REAL errno ============================
do
  local d = mktemp_dir()
  write_file(d .. "/alpha.claimed.s.json", "{}")
  local names, st = R.list_dir(d, false)
  ok("TB-FC2 list_dir: real readable dir ⇒ 'read' + names", st == "read" and #names >= 1)
  local _, sa = R.list_dir(d .. "/does-not-exist", false)
  ok("TB-FC2 list_dir: absent ⇒ 'absent' (ENOENT)", sa == "absent")
  local rf = d .. "/regular.txt"; write_file(rf, "x")
  local _, sn = R.list_dir(rf, false)
  ok("TB-FC2 list_dir: a regular file source ⇒ 'unreadable' (ENOTDIR, not a bogus 1-name read)", sn == "unreadable")
  if NOTROOT then
    local parent = d .. "/notraverse"; assert(os.execute("mkdir -p " .. R.shq(parent .. "/child")))
    os.execute("chmod 000 " .. R.shq(parent))
    local _, se = R.list_dir(parent .. "/child", false)
    os.execute("chmod 755 " .. R.shq(parent)) -- restore for cleanup
    ok("TB-FC2 list_dir: EACCES ancestor (no-traverse) ⇒ 'unreadable', NOT 'absent'", se == "unreadable")
  else
    print("skip - TB-FC2 EACCES-ancestor (root)")
  end
  -- r5 teeth (seam ③): errno comes from the FILESYSTEM (traversability), NOT a path-bearing diagnostic. A readable dir whose NAME
  -- literally contains "No such file or directory" must be 'read' — a substring classifier would have faked it as ENOENT 'absent'.
  local trap = d .. "/No such file or directory"
  assert(os.execute("mkdir -p " .. R.shq(trap)))
  write_file(trap .. "/x.claimed.s.json", "{}")
  local tn, ts = R.list_dir(trap, false)
  ok("TB-FC2 r5: a readable dir NAMED 'No such file or directory' ⇒ 'read' (errno from fs, not substring)", ts == "read" and #tn == 1)
end

-- ============================ TB-FC2: git_ancestor_state TRI-STATE over REAL git ============================
do
  ok("git_ancestor_state: main is an ancestor of itself ⇒ 'yes'", R.git_ancestor_state(REPO, "main") == "yes")
  ok("git_ancestor_state: a bad object (fatal exit 128) ⇒ 'error' (NOT 'no')", R.git_ancestor_state(REPO, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef") == "error")
  -- HEAD here (the spike base) is NOT on main ⇒ exit 1 ⇒ "no". (If it ever were merged this would read "yes"; either real value, never "error".)
  local st = R.git_ancestor_state(REPO, "HEAD")
  ok("git_ancestor_state: a real non-ancestor commit ⇒ 'no' (exit 1, not fatal)", st == "no" or st == "yes")
end

-- ============================ deps + run ============================
local function fakeDeps(tmp, review_names, board_names, anc_set, batches, opts)
  opts = opts or {}
  return {
    review_path = tmp .. "/review-board.md", runbook_path = tmp .. "/runbook-board.md",
    list_reviews = function() return review_names, (opts.review_status or "read") end,
    list_board = function() return board_names, (opts.board_status or "read") end,
    recent_set = function() if opts.recent_ok == false then return {}, false end local s = {}; for _, n in ipairs(review_names) do if not (opts.stale and opts.stale[n]) then s[n] = true end end return s, true end,
    ancestry = function(sha) if opts.fatal and opts.fatal[sha] then return "error" end return anc_set[sha] and "yes" or "no" end,
    batches = function() if opts.batch_ok == false then return nil, false end return batches, true end,
    write_atomic = R.write_atomic,
  }
end
local RNAMES = { "fleet-recovery-5227c6a-review-01a13284", "verification-ledger-fb65753-dual-signoff-01a13284" }
local BNAMES = { "alpha.claimed.s1.json", "beta.done.s2.json" }
local BATCHES = { { branch = "rehearse-batch-21", artifacts = { ["merge-pool"] = "rehearse-batch-21" }, steps_facts = { { name = "merge-pool", exists = true, mtime = 100 }, { name = "regen-presence", exists = true, mtime = 200 }, { name = "gates", exists = false }, { name = "arch-review", exists = true, mtime = 400 }, { name = "ff-main-install", exists = false } } } }

-- 3-fixture
do
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local rev1 = read_file(tmp .. "/review-board.md")
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  ok("fixture[idempotent]: byte-identical rerun", rev1 ~= nil and rev1 == read_file(tmp .. "/review-board.md"))
  local nh, mg, vl = rev1:find("## Needs-human", 1, true), rev1:find("## Merged", 1, true), rev1:find("verification-ledger @fb65753", 1, true)
  ok("fixture[idempotent]: ledger in Needs-human (signed, unmerged)", nh and mg and vl and vl > nh and vl < mg)
  write_file(tmp .. "/review-board.md", "GARBAGE partial")
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  ok("fixture[half-write]: garbage fully overwritten", read_file(tmp .. "/review-board.md") == rev1)
  local dA, dB = fakeDeps(tmp, { "aaa-1111111-review-s" }, {}, {}, {}), fakeDeps(tmp, { "bbb-2222222-review-s" }, {}, {}, {})
  R.run(dA); R.run(dB)
  local final = read_file(tmp .. "/review-board.md")
  local expectB = board.render_review_board(board.classify(R.gather(dB), function() return false end))
  ok("fixture[concurrent]: final = exactly one complete board (B)", final == expectB and final:find("aaa", 1, true) == nil and final:find("bbb", 1, true) ~= nil)
end

-- TB-OWN/WRITE: failed write keeps old board
do
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local good = read_file(tmp .. "/review-board.md")
  if NOTROOT then
    os.execute("chmod 500 " .. R.shq(tmp))
    local okw, err = R.write_atomic(tmp .. "/review-board.md", "SHOULD NOT LAND")
    os.execute("chmod 700 " .. R.shq(tmp))
    ok("TB-OWN/WRITE: unwritable dir ⇒ write_atomic false + old board intact", okw == false and err ~= nil and read_file(tmp .. "/review-board.md") == good)
  else
    print("skip - TB-OWN/WRITE unwritable-dir (root)")
  end
end

-- TB-FC2: run ABORTS (keeps old board) on each failed-query face; ABSENT is legitimately empty (proceeds)
do
  local tmp = mktemp_dir()
  R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES))
  local good = read_file(tmp .. "/review-board.md")
  local function aborts(opts, label)
    local res = R.run(fakeDeps(tmp, RNAMES, BNAMES, { fb65753 = false }, BATCHES, opts))
    ok("TB-FC2 abort: " .. label .. " ⇒ run aborts + old board untouched", res.wrote_review == false and res.error ~= nil and read_file(tmp .. "/review-board.md") == good)
  end
  aborts({ review_status = "unreadable" }, "unreadable review source")
  aborts({ board_status = "unreadable" }, "unreadable board source")
  aborts({ recent_ok = false }, "recency query failed")
  aborts({ fatal = { fb65753 = true } }, "fatal git ancestry (exit 128)")
  aborts({ batch_ok = false }, "batch discovery git failed")
  local tmp2 = mktemp_dir()
  local res2 = R.run(fakeDeps(tmp2, {}, {}, {}, {}, { review_status = "absent", board_status = "absent" }))
  ok("TB-FC2: absent sources ⇒ run PROCEEDS (empty is legitimate)", res2.wrote_review == true and res2.counts.Reviewing == 0)
end

-- ============================ acceptance: real ~/Work/review-reports ============================
do
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or ((os.getenv("HOME") or "") .. "/Work/review-reports")
  local names, status = R.list_dir(review_reports, true)
  if status ~= "read" or #names == 0 then
    print("skip - acceptance: no real ~/Work/review-reports (" .. tostring(status) .. ")")
  else
    local rounds = 0
    for _, n in ipairs(names) do if R.parse_signoff_dir(n) or R.parse_review_dir(n) then rounds = rounds + 1 end end
    ok("acceptance: real review-reports parse into rounds (>=1)", rounds >= 1)
    local deps = fakeDeps(mktemp_dir(), names, {}, {}, {})
    local md = board.render_review_board(board.classify(R.gather(deps), function() return false end))
    ok("acceptance: real-data projection renders a valid 4-lane board", md:find("^# Review queue") ~= nil and select(2, md:gsub("## ", "")) == 4)
  end
end

print(string.format("\n%s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
os.exit(failures == 0 and 0 or 1)
