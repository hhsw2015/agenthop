-- agenthop tern-board — IO shell for the board projection (A4/A5). Pure cores live in board.luau; this file holds the durable-name
-- PARSERS + selection helpers (pure, fixture-tested) + run(deps) orchestration + default_deps() (the only place that touches io/os/git).
-- Standalone Lua 5.5. Invariant (TB-FC2): exit status / errno is propagated through the ENTIRE gather chain — a failed read / recency /
-- git query ABORTS the publish (keeps the last good board); a LEGITIMATE absence is NOT blocked by an unrelated query, and errno is read
-- from the FILESYSTEM (traversability), never inferred from a path-bearing diagnostic string.

local board = require("board")
local R = {}

-- POSIX single-quote shell escaping (TB-QUOTE).
function R.shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local shq = R.shq

local function popen_status(cmd)
  local out = {}
  local p = io.popen(cmd, "r")
  if not p then return out, false, -1 end
  for line in p:lines() do out[#out + 1] = line end
  local ok, _, code = p:close()
  return out, ok == true, code or -1
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE parsers.
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

function R.pick_batch(inflight_names)
  local branch, bestnum = nil, -1
  for _, b in ipairs(inflight_names or {}) do
    local n = tonumber(b:match("rehearse%-batch%-(%d+)"))
    if n and n > bestnum then bestnum = n; branch = b end
  end
  return branch
end

-- PURE (TB-ARCH, r5): parse the FIXED signoff-name structure. The SHA field is MIN 7 hex (a 1-char "5" must not match a tip); the full
-- comparison (resolve both to a unique commit) happens in match_arch via the injected resolver.
function R.parse_signoff_name(name)
  local bn, sha = string.match(name, "^batch(%d+)%-dual%-signoff%-([0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)%-")
  if bn then return { batch = tonumber(bn), sha = sha } end
  return nil
end

-- PURE (TB-ARCH): match the arch-review signoff to THIS batch. Requires the batch NUMBER to equal batch_num AND the signoff's SHA field,
-- RESOLVED to a full commit via `resolve`, to equal the full tip SHA. A tip7 appearing in another field, a too-short field, or a field
-- that resolves to a DIFFERENT commit does NOT match.
--   resolve(sha) -> (full_sha|nil, ok). ok==false is a FAULT (git/rev-parse failed to RUN) — NOT "this sha names no commit". A fault
--   must ABORT the publish: silently leaving arch-review UNCHECKED because a transient git error returned nil is a lie (r6 seam ①).
--   So match_arch returns (name|nil, ok) and the caller aborts on ok==false. (Equality tests read only the first return, unaffected.)
function R.match_arch(names, batch_num, tip_full, resolve)
  if not batch_num or not tip_full or tip_full == "" or not resolve then return nil, true end
  for _, n in ipairs(names or {}) do
    local p = R.parse_signoff_name(n)
    if p and p.batch == tonumber(batch_num) then
      local full, ok = resolve(p.sha)
      if ok == false then return nil, false end -- resolver FAULT ⇒ propagate; caller keeps the last good board
      if full and full ~= "" and full == tip_full then return n, true end
    end
  end
  return nil, true
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE gather: UNIFIED newest-first `rounds` + board + FC-2 statuses. r5 (seam ①): source status is settled FIRST; recency runs ONLY when
-- the review source is actually readable — a legitimate ABSENCE must not be blocked by a recency query that fails on the missing dir.
--   deps.list_reviews()/list_board() -> (names, status: "read"|"absent"|"unreadable")
--   deps.recent_set()                -> (set, ok)   (only consulted when review_status == "read")
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.gather(deps)
  local rounds, brd = {}, {}
  local rnames, rstatus = deps.list_reviews()
  rstatus = rstatus or "read"
  local recent, recent_ok = {}, true
  if rstatus == "read" then
    recent, recent_ok = deps.recent_set()
    recent = recent or {}
    if recent_ok == nil then recent_ok = true end
  end
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
  return { rounds = rounds, board = brd, review_status = rstatus, board_status = bstatus or "read", recent_ok = recent_ok }
end

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

-- write_atomic (TB-OWN + TB-WRITE): exclusive mktemp temp; checked write/close; os.rename; failure removes own temp + keeps old board.
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

-- dir_status (TB-FC2, r6): the REAL errno of a directory-open is the SOLE classifier — no shell `test` predicates (a `test` boolean is
-- not an errno: `test -x` passes a 755 regular FILE, `test -e` only follows a symlink and reports false for an EACCES target, and ls's
-- stderr carries the path). `io.open(dir .. "/", "r")` performs one open() syscall: the TRAILING SLASH forces directory semantics (a
-- regular file — at the leaf OR anywhere in the ancestor chain — raises ENOTDIR), the open() traverses the whole path (so a non-traversable
-- ancestor raises EACCES, a symlink target's inaccessible parent raises EACCES), and Lua returns the C errno as the THIRD value (a NUMBER,
-- never a path-bearing string — a dir NAMED "No such file or directory" cannot fake ENOENT). ENOENT(2) ⇒ genuine absence; EVERYTHING else
-- (ENOTDIR/EACCES/ELOOP/no-read-bit/…) ⇒ unreadable, never folded to a clean-empty "absent". A successful open needs read permission on
-- the dir, so "read" guarantees the subsequent ls can list it.
function R.dir_status(dir)
  local fh, _, errno = io.open(dir .. "/", "r")
  if fh then fh:close(); return "read" end
  if errno == 2 then return "absent" end -- ENOENT: the path genuinely does not exist
  return "unreadable"                     -- ENOTDIR / EACCES / ELOOP / any other fault ⇒ a fault, not a legitimate absence
end

-- list_dir: dir_status (errno-accurate) then, only for a readable dir, the contents (newest-first optional).
function R.list_dir(dir, time_sort)
  local st = R.dir_status(dir)
  if st ~= "read" then return {}, st end
  local names, ok = popen_status("ls -1" .. (time_sort and "t" or "") .. " " .. shq(dir) .. " 2>/dev/null")
  if not ok then return {}, "unreadable" end
  return names, "read"
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

-- git merge-base --is-ancestor, TRI-STATE: "yes"(0)/"no"(1)/"error"(≥128). Caller aborts on "error".
function R.git_ancestor_state(repo, sha)
  if not sha or sha == "" then return "no" end
  local _, ok, code = popen_status("git -C " .. shq(repo) .. " merge-base --is-ancestor " .. shq(sha) .. " main >/dev/null 2>&1")
  if ok then return "yes" end
  if code == 1 then return "no" end
  return "error"
end

-- default_deps(home, repo): wire real durable sources. r5 (seam ②): every necessary git query propagates status; a fatal aborts batches.
function R.default_deps(home, repo)
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local board_dir = home .. "/.agenthop/swarm/board"
  local carly = home .. "/.agenthop/carly"
  local function git(args) return popen_status("git -C " .. shq(repo) .. " " .. args .. " 2>/dev/null") end -- (lines, ok, code)
  return {
    review_path = carly .. "/review-board.md",
    runbook_path = carly .. "/runbook-board.md",
    list_reviews = function() return R.list_dir(review_reports, true) end,
    list_board = function() return R.list_dir(board_dir, false) end,
    recent_set = function()
      local lines, ok = popen_status("find " .. shq(review_reports) .. " -maxdepth 1 -type d -mtime -7 2>/dev/null")
      if not ok then return {}, false end
      local set = {}
      for _, p in ipairs(lines) do local base = p:match("([^/]+)/?$"); if base then set[base] = true end end
      return set, true
    end,
    ancestry = function(sha) return R.git_ancestor_state(repo, sha) end,
    batches = function()
      local inflight, iok = git("branch --no-merged main --list 'rehearse-batch-*' --format='%(refname:short)'")
      if not iok then return nil, false end
      local branch = R.pick_batch(inflight)
      if not branch then return {}, true end
      local tlines, tok = git("log -1 --format=%ct " .. shq(branch)); if not tok then return nil, false end
      local slines, sok = git("rev-parse " .. shq(branch) .. "^{commit}"); if not sok then return nil, false end
      local tip_time, tip_full = tonumber(tlines[1]), slines[1]
      local batch_num = tonumber(branch:match("rehearse%-batch%-(%d+)"))
      local presence = repo .. "/packages/bus/dist-presence/presence.mjs"
      local gates = home .. "/.agenthop/swarm/batch-gates/" .. branch .. ".json"
      local names, nstatus = R.list_dir(review_reports, false)
      if nstatus == "unreadable" then return nil, false end -- a readable-then-unreadable review dir ⇒ abort (don't half-compute arch)
      local arch = nil
      if tip_full then
        local m, mok = R.match_arch(names, batch_num, tip_full, function(s)
          local rl, rok = git("rev-parse " .. shq(s) .. "^{commit}")
          return (rok and rl[1] or nil), rok -- (full|nil, ok): rok==false ⇒ rev-parse FAULTED, a signal to abort (not "no signoff")
        end)
        if mok == false then return nil, false end -- resolver fault ⇒ abort (don't silently uncheck a real arch-review)
        if m then arch = review_reports .. "/" .. m end
      end
      local agenthop_bin = (os.getenv("HOME") or home) .. "/.local/bin/agenthop"
      local mstate = tip_full and R.git_ancestor_state(repo, tip_full) or "no"
      if mstate == "error" then return nil, false end -- fatal tip ancestry ⇒ abort (don't guess merged/not)
      local merged = (mstate == "yes")
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
