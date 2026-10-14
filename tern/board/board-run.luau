-- agenthop tern-board — IO shell for the board projection (A4/A5). Pure cores live in board.luau; this file holds the durable-name
-- PARSERS + selection helpers (pure, fixture-tested) + run(deps) orchestration + default_deps() (the only place that touches io/os/git).
-- Standalone Lua 5.5. r4 invariant (TB-FC2): exit status / errno is propagated through the ENTIRE gather chain — a failed read / recency
-- query / git query ABORTS the publish (keeps the last good board); it is never folded into a "legitimate" empty/false value.

local board = require("board")
local R = {}

-- POSIX single-quote shell escaping (TB-QUOTE): inside shell DOUBLE quotes `$()`/backticks/`$var` still expand; single-quoting disables
-- ALL expansion (an embedded single quote is closed/escaped/reopened). Every value that reaches a shell goes through this.
function R.shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local shq = R.shq

-- popen a command; return (stdout_lines, ok, exit_code). lua 5.4/5.5 p:close() -> ok(bool), "exit", code.
local function popen_status(cmd)
  local out = {}
  local p = io.popen(cmd, "r")
  if not p then return out, false, -1 end
  for line in p:lines() do out[#out + 1] = line end
  local ok, _, code = p:close()
  return out, ok == true, code or -1
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE parsers for the durable names.
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.parse_review_dir(name)
  local item, sha, seat = string.match(name, "^(.-)%-([0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)%-review%-(.+)$")
  if item and item ~= "" then return { item = item, sha = sha, seat = seat } end
  return nil
end
function R.parse_signoff_dir(name)
  local item, sha, seat = string.match(name, "^(.-)%-([0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)%-dual%-signoff%-(.+)$")
  if item and item ~= "" then return { item = item, sha = sha, seat = seat } end
  return nil
end
function R.parse_board_file(name)
  local item, state, seat = string.match(name, "^(.+)%.(granted)%.(.+)%.json$")
  if not item then item, state, seat = string.match(name, "^(.+)%.(claimed)%.(.+)%.json$") end
  if not item then item, state, seat = string.match(name, "^(.+)%.(done)%.(.+)%.json$") end
  if item then return { item = item, state = state, seat = seat } end
  return nil
end

-- PURE (TB-BRANCH): highest-NUMBERED batch among in-flight names (lexical max would pick batch-9 over batch-23).
function R.pick_batch(inflight_names)
  local branch, bestnum = nil, -1
  for _, b in ipairs(inflight_names or {}) do
    local n = tonumber(b:match("rehearse%-batch%-(%d+)"))
    if n and n > bestnum then bestnum = n; branch = b end
  end
  return branch
end

-- PURE (TB-ARCH): the arch-review signoff must be THIS batch's own. Parse the FIXED name structure `batch<N>-dual-signoff-<sha>-<...>`
-- and require (a) the batch number equals `batch_num` AND (b) the parsed SHA FIELD is a prefix of the full tip SHA. A tip7 that merely
-- appears in some other field (e.g. a reviewer suffix) does NOT count. Returns the matching name or nil.
function R.match_arch(names, batch_num, tip_sha)
  if not batch_num or not tip_sha or tip_sha == "" then return nil end
  for _, n in ipairs(names or {}) do
    local bn, shafield = string.match(n, "^batch(%d+)%-dual%-signoff%-([0-9a-f]+)%-")
    if bn and shafield and tonumber(bn) == tonumber(batch_num) and tip_sha:sub(1, #shafield) == shafield then
      return n
    end
  end
  return nil
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE gather: UNIFIED newest-first `rounds` stream (review|signoff) + board + FC-2 source statuses + recency ok.
--   deps.list_reviews()/list_board() -> (names, status: "read"|"absent"|"unreadable")
--   deps.recent_set()                -> (set, ok)   (ok=false ⇒ recency query failed ⇒ run must abort)
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.gather(deps)
  local rounds, brd = {}, {}
  local recent, recent_ok = deps.recent_set()
  recent = recent or {}
  if recent_ok == nil then recent_ok = true end
  local rnames, rstatus = deps.list_reviews()
  for _, name in ipairs(rnames or {}) do
    local s = R.parse_signoff_dir(name)
    if s then
      s.kind = "signoff"; s.recent = (recent[name] == true); rounds[#rounds + 1] = s
    else
      local rv = R.parse_review_dir(name)
      if rv then rv.kind = "review"; rv.recent = (recent[name] == true); rounds[#rounds + 1] = rv end
    end
  end
  local bnames, bstatus = deps.list_board()
  for _, name in ipairs(bnames or {}) do
    local b = R.parse_board_file(name); if b then brd[#brd + 1] = b end
  end
  return { rounds = rounds, board = brd, review_status = rstatus or "read", board_status = bstatus or "read", recent_ok = recent_ok }
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- run(deps): gather -> (FC-2 abort guards) -> resolve ancestry (tri-state, abort on fatal) -> classify/render -> atomic write of BOTH.
-- ABORT (keep last good board, write nothing) when ANY necessary query fails: a source dir is unreadable, the recency query failed, a
-- git ancestry check is fatal (exit ≠ 0/1), or the batch discovery git failed. An ABSENT source is legitimately empty (proceed).
-- ---------------------------------------------------------------------------------------------------------------------------------
local function abort(reason, extra)
  local r = { wrote_review = false, wrote_runbook = false, error = reason, counts = {}, batches = 0 }
  if extra then for k, v in pairs(extra) do r[k] = v end end
  return r
end

function R.run(deps)
  local facts = R.gather(deps)
  if facts.review_status == "unreadable" or facts.board_status == "unreadable" then
    return abort("unreadable-source", { review_status = facts.review_status, board_status = facts.board_status })
  end
  if not facts.recent_ok then return abort("recency-query-failed") end

  -- Resolve ancestry for every DISTINCT signoff SHA up front (tri-state). A FATAL (exit 128 / other) aborts the publish — only exit 1
  -- (legitimate non-ancestor) is a value. This keeps classify pure (it receives a resolved yes/no lookup) AND never mislanes on a fatal.
  local ancestry = {}
  for _, r in ipairs(facts.rounds) do
    if r.kind == "signoff" and ancestry[r.sha] == nil then
      local st = deps.ancestry(r.sha)
      if st == "error" then return abort("ancestry-fatal", { sha = r.sha }) end
      ancestry[r.sha] = st
    end
  end
  local lanes = board.classify(facts, function(sha) return ancestry[sha] == "yes" end)
  local review_md = board.render_review_board(lanes)

  local blist, bok = deps.batches()
  if bok == false then return abort("batch-query-failed") end
  local batches = {}
  for _, b in ipairs(blist or {}) do
    batches[#batches + 1] = { branch = b.branch, steps = board.runbook_steps(b.steps_facts), artifacts = b.artifacts }
  end
  local runbook_md = board.render_runbook_board(batches)

  local ok1, e1 = deps.write_atomic(deps.review_path, review_md)
  local ok2, e2 = deps.write_atomic(deps.runbook_path, runbook_md)
  local counts = {}
  for _, name in ipairs(board.LANES) do counts[name] = #(lanes[name] or {}) end
  return { review_path = deps.review_path, runbook_path = deps.runbook_path, wrote_review = ok1, wrote_runbook = ok2,
           write_error = e1 or e2, counts = counts, batches = #batches, review_status = facts.review_status, board_status = facts.board_status }
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- write_atomic (TB-OWN + TB-WRITE): exclusive same-dir temp via mktemp; CHECK write + close returns; os.rename; any failure removes our
-- OWN temp and returns false (live board untouched). (lua 5.5 io.open has no "wx".)
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.write_atomic(path, text)
  local dir = path:match("^(.*)/[^/]+$") or "."
  local base = path:match("([^/]+)$") or "board"
  local tmplines, ok = popen_status("mktemp " .. shq(dir .. "/." .. base .. ".tmp.XXXXXXXX") .. " 2>/dev/null")
  local tmp = ok and tmplines[1]
  if not tmp or tmp == "" then return false, "mktemp failed (dir unwritable?)" end
  local fh, oerr = io.open(tmp, "w")
  if not fh then os.remove(tmp); return false, oerr or "open tmp failed" end
  local wok, werr = fh:write(text)
  local cok, cerr = fh:close()
  if not wok or not cok then os.remove(tmp); return false, werr or cerr or "write/close failed" end
  local rok, rerr = os.rename(tmp, path)
  if not rok then os.remove(tmp); return false, rerr or "rename failed" end
  return true
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- list_dir (TB-FC2): three-state over REAL errno. A trailing slash forces DIRECTORY semantics (a regular file ⇒ ENOTDIR, not a bogus
-- one-name "read"). On ls failure, stderr is captured and classified: only a clear ENOENT ("No such file") ⇒ "absent"; EACCES
-- ("Permission denied"), ENOTDIR ("Not a directory") and ANY other error ⇒ "unreadable" (conservative — never clobber on uncertainty).
-- `test -e` is NOT used (it cannot see past an EACCES ancestor and would mislabel that as absent).
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.list_dir(dir, time_sort)
  local path = dir .. "/" -- force dir semantics: a regular file ⇒ "Not a directory"
  local names, ok = popen_status("ls -1" .. (time_sort and "t" or "") .. " " .. shq(path) .. " 2>/dev/null")
  if ok then return names, "read" end
  local err = popen_status("ls -1 " .. shq(path) .. " 2>&1 1>/dev/null") -- capture stderr to classify the errno
  local msg = table.concat(err, " ")
  if msg:find("No such file", 1, true) then return {}, "absent" end
  return {}, "unreadable"
end

local function file_mtime(path)
  local lines = popen_status("stat -f %m " .. shq(path) .. " 2>/dev/null")
  return tonumber(lines[1])
end
local function exists(path)
  local fh = io.open(path, "r")
  if fh then fh:close(); return true end
  return file_mtime(path) ~= nil
end

-- git merge-base --is-ancestor <sha> main, TRI-STATE (TB-FC2): "yes" (exit 0), "no" (exit 1 = legitimate non-ancestor), "error" (exit
-- 128 / any other = fatal, e.g. bad object or broken repo). The caller ABORTS on "error" — a fatal must never silently read as "no".
function R.git_ancestor_state(repo, sha)
  if not sha or sha == "" then return "no" end
  local _, ok, code = popen_status("git -C " .. shq(repo) .. " merge-base --is-ancestor " .. shq(sha) .. " main >/dev/null 2>&1")
  if ok then return "yes" end
  if code == 1 then return "no" end
  return "error"
end

-- default_deps(home, repo): wire the real durable sources.
function R.default_deps(home, repo)
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local board_dir = home .. "/.agenthop/swarm/board"
  local carly = home .. "/.agenthop/carly"
  -- git wrapper returns (lines, ok): a failed query (exit ≠ 0) is surfaced so the caller can abort rather than publish a false board.
  local function git(args)
    local lines, ok = popen_status("git -C " .. shq(repo) .. " " .. args .. " 2>/dev/null")
    return lines, ok
  end
  return {
    review_path = carly .. "/review-board.md",
    runbook_path = carly .. "/runbook-board.md",
    list_reviews = function() return R.list_dir(review_reports, true) end,  -- newest-first; (names, status)
    list_board = function() return R.list_dir(board_dir, false) end,
    recent_set = function()
      local lines, ok = popen_status("find " .. shq(review_reports) .. " -maxdepth 1 -type d -mtime -7 2>/dev/null")
      if not ok then return {}, false end -- propagate find failure ⇒ run aborts (never "everything is stale")
      local set = {}
      for _, p in ipairs(lines) do local base = p:match("([^/]+)/?$"); if base then set[base] = true end end
      return set, true
    end,
    ancestry = function(sha) return R.git_ancestor_state(repo, sha) end,
    batches = function()
      local inflight, iok = git("branch --no-merged main --list 'rehearse-batch-*' --format='%(refname:short)'")
      if not iok then return nil, false end -- git failure ⇒ abort (do NOT publish batches=0 as if nothing is in flight)
      local branch = R.pick_batch(inflight)
      if not branch then return {}, true end
      local tip_time = tonumber((git("log -1 --format=%ct " .. shq(branch))[1]))
      local tip_sha = git("rev-parse " .. shq(branch))[1]
      local batch_num = tonumber(branch:match("rehearse%-batch%-(%d+)"))
      local presence = repo .. "/packages/bus/dist-presence/presence.mjs"
      local gates = home .. "/.agenthop/swarm/batch-gates/" .. branch .. ".json"
      local arch = nil
      if tip_sha then
        local names = R.list_dir(review_reports, false)
        local m = R.match_arch(names, batch_num, tip_sha)
        if m then arch = review_reports .. "/" .. m end
      end
      local agenthop_bin = (os.getenv("HOME") or home) .. "/.local/bin/agenthop"
      local merged = tip_sha and (R.git_ancestor_state(repo, tip_sha) == "yes") or false
      return { {
        branch = branch,
        artifacts = { ["merge-pool"] = branch, ["regen-presence"] = presence, ["gates"] = gates, ["arch-review"] = (arch or "? (no signoff for this tip)"), ["ff-main-install"] = agenthop_bin },
        steps_facts = {
          { name = "merge-pool", exists = (tip_time ~= nil), mtime = tip_time },
          { name = "regen-presence", exists = exists(presence), mtime = file_mtime(presence) },
          { name = "gates", exists = exists(gates), mtime = file_mtime(gates) },
          { name = "arch-review", exists = (arch ~= nil), mtime = arch and file_mtime(arch) or nil },
          { name = "ff-main-install", exists = (merged and exists(agenthop_bin)), mtime = merged and file_mtime(agenthop_bin) or nil },
        },
      } }, true
    end,
    write_atomic = R.write_atomic,
  }
end

return R
