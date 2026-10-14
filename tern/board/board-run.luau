-- agenthop tern-board — IO shell for the board projection (A4/A5). Pure cores live in board.luau; this file holds the durable-name
-- PARSERS (pure, fixture-tested) + run(deps) orchestration + default_deps() (the only place that touches io/os/git). Everything run()
-- needs is injected, so the 3-fixture law is driven with fake deps + real temp files. Standalone Lua 5.5.

local board = require("board")
local R = {}

-- POSIX single-quote shell escaping (TB-QUOTE): Lua string.format("%q") escapes for LUA, and inside shell DOUBLE quotes `$()`/backticks/
-- `$var` STILL expand — a review-reports name or repo path containing `$(...)` would execute. Single-quoting disables ALL expansion; an
-- embedded single quote is closed, escaped, reopened ('\''). Every value that reaches a shell goes through this.
function R.shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local shq = R.shq

local function popen_status(cmd)
  local out = {}
  local p = io.popen(cmd, "r")
  if not p then return out, false, -1 end
  for line in p:lines() do out[#out + 1] = line end
  local ok, _, code = p:close() -- lua 5.4/5.5: ok(bool), "exit", code
  return out, ok == true, code or -1
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE parsers for the durable names. Item names contain hyphens/dots; anchor on the KNOWN middle tokens + a 7+ hex sha, non-greedy item.
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

-- PURE (TB-BRANCH): pick the highest-NUMBERED batch from a list of IN-FLIGHT branch names. A lexical max would pick "rehearse-batch-9"
-- over "rehearse-batch-23"; numeric parse fixes it. (The caller passes only `--no-merged main` branches, so a merged old batch is already
-- excluded — this helper owns the ordering, the git flag owns the in-flight filter.)
function R.pick_batch(inflight_names)
  local branch, bestnum = nil, -1
  for _, b in ipairs(inflight_names or {}) do
    local n = tonumber(b:match("rehearse%-batch%-(%d+)"))
    if n and n > bestnum then bestnum = n; branch = b end
  end
  return branch
end

-- PURE (TB-ARCH): the arch-review signoff must reference THIS batch's tip SHA — a `batch*-dual-signoff-*` name CONTAINING tip7. Any other
-- batch's/old tip's signoff does NOT tick arch-review (mtime-late ≠ correct attribution). Returns the matching name or nil.
function R.match_arch(names, tip7)
  if not tip7 or tip7 == "" then return nil end
  for _, n in ipairs(names or {}) do
    if n:match("^batch.*dual%-signoff") and n:find(tip7, 1, true) then return n end
  end
  return nil
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE gather: build the UNIFIED newest-first `rounds` stream (review|signoff interleaved, as listed) + board + the FC-2 source statuses.
-- deps.list_reviews()/list_board() each return (names, status) where status = "read"|"absent"|"unreadable" (status nil ⇒ "read", for
-- simple fakes). recency is folded per round from deps.recent_set().
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.gather(deps)
  local rounds, brd = {}, {}
  local recent = (deps.recent_set and deps.recent_set()) or {}
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
  return { rounds = rounds, board = brd, review_status = rstatus or "read", board_status = bstatus or "read" }
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- run(deps): gather -> (FC-2 guard) -> classify/render -> atomic write of BOTH files. TB-FC2: an UNREADABLE critical source must NOT
-- overwrite a good board with a clean-empty projection — abort and keep the last good board. An ABSENT source is legitimately empty.
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.run(deps)
  local facts = R.gather(deps)
  if facts.review_status == "unreadable" or facts.board_status == "unreadable" then
    return { wrote_review = false, wrote_runbook = false, error = "unreadable-source",
             review_status = facts.review_status, board_status = facts.board_status, counts = {}, batches = 0 }
  end
  local lanes = board.classify(facts, deps.is_ancestor)
  local review_md = board.render_review_board(lanes)

  local batches = {}
  for _, b in ipairs(deps.batches() or {}) do
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
-- write_atomic (TB-OWN + TB-WRITE): an EXCLUSIVE same-dir temp via `mktemp` (the host primitive with verified exclusive-create — lua 5.5
-- io.open has no "wx", and a random io.open name could truncate/move a foreign object or follow a planted symlink), then WRITE + CLOSE
-- with their returns CHECKED (a mid-write/flush failure must NOT publish a half board), then os.rename (atomic). Any failure removes our
-- OWN temp and returns false — the live board is left untouched (the caller keeps the last good board).
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

-- three-state directory listing (TB-FC2): "read" (names, maybe empty), "absent" (dir doesn't exist — legitimately empty), "unreadable"
-- (exists but ls failed, e.g. EACCES — caller must NOT treat as empty). time_sort = newest-first (`ls -1t`).
local function list_dir(dir, time_sort)
  local lines, ok = popen_status("ls " .. (time_sort and "-1t " or "-1 ") .. shq(dir) .. " 2>/dev/null")
  if ok then return lines, "read" end
  local present = os.execute("test -e " .. shq(dir) .. " >/dev/null 2>&1")
  if present == true or present == 0 then return {}, "unreadable" end
  return {}, "absent"
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

-- git merge-base --is-ancestor <sha> main : true iff sha is on main. NON-ancestor is a legitimate exit 1 (false), NOT a read fault
-- (TB-FC2: the ancestry check never aborts the run — only the dir reads do). os.execute returns true on exit 0, nil on non-zero.
local function git_is_ancestor(repo, sha)
  if not sha or sha == "" then return false end
  local code = os.execute("git -C " .. shq(repo) .. " merge-base --is-ancestor " .. shq(sha) .. " main >/dev/null 2>&1")
  return code == true or code == 0
end

-- default_deps(home, repo): wire the real durable sources. `repo` = the agenthop checkout (git ancestry + presence.mjs + branches).
function R.default_deps(home, repo)
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local board_dir = home .. "/.agenthop/swarm/board"
  local carly = home .. "/.agenthop/carly"
  local function git(args) return (popen_status("git -C " .. shq(repo) .. " " .. args .. " 2>/dev/null")) end
  return {
    review_path = carly .. "/review-board.md",
    runbook_path = carly .. "/runbook-board.md",
    list_reviews = function() return list_dir(review_reports, true) end,  -- newest-first; (names, status)
    list_board = function() return list_dir(board_dir, false) end,
    recent_set = function()
      local set = {}
      local lines = popen_status("find " .. shq(review_reports) .. " -maxdepth 1 -type d -mtime -7 2>/dev/null")
      for _, p in ipairs(lines) do local base = p:match("([^/]+)/?$"); if base then set[base] = true end end
      return set
    end,
    is_ancestor = function(sha) return git_is_ancestor(repo, sha) end,
    batches = function()
      -- TB-BRANCH: only IN-FLIGHT branches (`--no-merged main`) + NUMERIC batch sort — a lexical sort would pick a merged "batch-9" over
      -- the one unmerged "batch-23" (9 > 2 lexically). Pick the highest-numbered in-flight batch.
      local inflight = git("branch --no-merged main --list 'rehearse-batch-*' --format='%(refname:short)'")
      local branch = R.pick_batch(inflight)
      if not branch then return {} end
      local tip_time = tonumber((git("log -1 --format=%ct " .. shq(branch))[1]))
      local tip_sha = git("rev-parse " .. shq(branch))[1]
      local tip7 = tip_sha and tip_sha:sub(1, 7) or nil
      local presence = repo .. "/packages/bus/dist-presence/presence.mjs"
      local gates = home .. "/.agenthop/swarm/batch-gates/" .. branch .. ".json"
      -- TB-ARCH: the arch-review signoff must reference THIS batch's TIP SHA (name contains tip7) — not any batch's signoff. mtime-late
      -- does not prove attribution; a re-rehearse (new tip) correctly un-ticks arch-review until a signoff of the new tip exists.
      local arch = nil
      if tip7 then
        local names = list_dir(review_reports, false)
        local m = R.match_arch(names, tip7)
        if m then arch = review_reports .. "/" .. m end
      end
      local agenthop_bin = (os.getenv("HOME") or home) .. "/.local/bin/agenthop"
      local merged = tip_sha and git_is_ancestor(repo, tip_sha) or false
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
      } }
    end,
    write_atomic = R.write_atomic,
  }
end

return R
