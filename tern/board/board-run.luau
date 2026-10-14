-- agenthop tern-board — IO shell for the board projection (A4/A5). The pure cores live in board.luau; this file holds the durable-name
-- PARSERS (pure, fixture-tested) + run(deps) orchestration + default_deps() (the only place that touches io/os/git). Everything run()
-- needs is injected, so the 3-fixture law (idempotent / half-write-crash / concurrent-single-win) is driven with fake git+dir deps and
-- real temp files for the atomic write. Standalone Lua 5.5 (io.popen, os.rename exist; Tern's sandboxed tern.fs does not — see board.luau).

local board = require("board") -- resolved relative to this dir by the fixture / generate.sh (package.path includes the plugin dir)
local R = {}

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE parsers for the durable names (review-reports dir names + swarm board file names). Item names contain hyphens/dots, so the
-- parsers anchor on the KNOWN middle tokens (-review- / -dual-signoff- / .<state>.) and a 7+ hex sha, non-greedy on the item.
-- ---------------------------------------------------------------------------------------------------------------------------------

-- "<item>-<sha>-review-<seat>"  ->  {item,sha,seat}   (sha = 7+ lowercase hex; item is the greedy-left remainder)
function R.parse_review_dir(name)
  local item, sha, seat = string.match(name, "^(.-)%-([0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)%-review%-(.+)$")
  if item and item ~= "" then return { item = item, sha = sha, seat = seat } end
  return nil
end

-- "<item>-<sha>-dual-signoff-<seat>"  ->  {item,sha,seat}
function R.parse_signoff_dir(name)
  local item, sha, seat = string.match(name, "^(.-)%-([0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)%-dual%-signoff%-(.+)$")
  if item and item ~= "" then return { item = item, sha = sha, seat = seat } end
  return nil
end

-- "<item>.<state>.<sid>.json"  ->  {item,state,seat}   (state in granted|claimed|done)
function R.parse_board_file(name)
  local item, state, seat = string.match(name, "^(.+)%.(granted)%.(.+)%.json$")
  if not item then item, state, seat = string.match(name, "^(.+)%.(claimed)%.(.+)%.json$") end
  if not item then item, state, seat = string.match(name, "^(.+)%.(done)%.(.+)%.json$") end
  if item then return { item = item, state = state, seat = seat } end
  return nil
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: gather the fact tables from the injected directory listings (deps.list_reviews / deps.list_board return name arrays).
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.gather(deps)
  local reviews, signoffs, brd = {}, {}, {}
  for _, name in ipairs(deps.list_reviews() or {}) do
    local s = R.parse_signoff_dir(name)
    if s then
      signoffs[#signoffs + 1] = s
    else
      local rv = R.parse_review_dir(name)
      if rv then reviews[#reviews + 1] = rv end
    end
  end
  for _, name in ipairs(deps.list_board() or {}) do
    local b = R.parse_board_file(name)
    if b then brd[#brd + 1] = b end
  end
  return { board = brd, reviews = reviews, signoffs = signoffs }
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- run(deps): gather -> classify/render -> atomic write of BOTH board files. Returns a summary {review_path, runbook_path, lanes_counts}.
--   deps.list_reviews()            -> {dirname,...}           (names under ~/Work/review-reports)
--   deps.list_board()              -> {filename,...}          (names under ~/.agenthop/swarm/board)
--   deps.is_ancestor(sha)          -> bool                    (git merge-base --is-ancestor <sha> main)
--   deps.batches()                 -> { {branch=, steps_facts={{name,exists,mtime},...}, artifacts={name->path}}, ... }
--   deps.write_atomic(path, text)  -> bool                    (temp + os.rename; half-write-safe)
--   deps.review_path / deps.runbook_path                      (output file paths)
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.run(deps)
  local facts = R.gather(deps)
  local lanes = board.classify(facts, deps.is_ancestor)
  local review_md = board.render_review_board(lanes)

  local batches = {}
  for _, b in ipairs(deps.batches() or {}) do
    batches[#batches + 1] = { branch = b.branch, steps = board.runbook_steps(b.steps_facts), artifacts = b.artifacts }
  end
  local runbook_md = board.render_runbook_board(batches)

  local ok1 = deps.write_atomic(deps.review_path, review_md)
  local ok2 = deps.write_atomic(deps.runbook_path, runbook_md)
  local counts = {}
  for _, name in ipairs(board.LANES) do counts[name] = #(lanes[name] or {}) end
  return { review_path = deps.review_path, runbook_path = deps.runbook_path, wrote_review = ok1, wrote_runbook = ok2, counts = counts, batches = #batches }
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Real IO helpers (standalone lua). write_atomic = temp + os.rename (atomic on the same fs): a crash mid-write leaves the .tmp, the
-- live file is untouched, and the next regen overwrites completely (projection = no incremental state to corrupt). Two concurrent
-- runs each rename their own complete temp ⇒ the live file is ALWAYS one complete valid board, never interleaved (single-win).
-- ---------------------------------------------------------------------------------------------------------------------------------
function R.write_atomic(path, text)
  local tmp = path .. ".tmp." .. tostring(os.time()) .. "." .. tostring(math.random(1, 1e9))
  local fh, err = io.open(tmp, "w")
  if not fh then return false, err end
  fh:write(text)
  fh:close()
  local ok, rerr = os.rename(tmp, path) -- atomic replace
  if not ok then os.remove(tmp); return false, rerr end
  return true
end

local function popen_lines(cmd)
  local out = {}
  local p = io.popen(cmd, "r")
  if not p then return out end
  for line in p:lines() do out[#out + 1] = line end
  p:close()
  return out
end

local function file_mtime(path)
  -- macOS/BSD stat; returns a number or nil if the file is absent
  local lines = popen_lines("stat -f %m " .. string.format("%q", path) .. " 2>/dev/null")
  local n = tonumber(lines[1])
  return n
end

local function exists(path)
  local fh = io.open(path, "r")
  if fh then fh:close() return true end
  -- a directory won't io.open on some platforms; fall back to stat
  return file_mtime(path) ~= nil
end

-- git merge-base --is-ancestor <sha> main : true iff sha is already on main. os.execute returns true/0 on success across lua 5.1/5.5.
local function git_is_ancestor(repo, sha)
  if not sha or sha == "" then return false end
  local code = os.execute("git -C " .. string.format("%q", repo) .. " merge-base --is-ancestor " .. string.format("%q", sha) .. " main >/dev/null 2>&1")
  return code == true or code == 0
end

-- default_deps(home, repo): wire the real durable sources. `repo` is the agenthop checkout (for git ancestry + presence.mjs + branches).
function R.default_deps(home, repo)
  local review_reports = os.getenv("RETRO_REVIEW_REPORTS_DIR") or (home .. "/Work/review-reports")
  local board_dir = home .. "/.agenthop/swarm/board"
  local carly = home .. "/.agenthop/carly"
  local function git(args) return popen_lines("git -C " .. string.format("%q", repo) .. " " .. args .. " 2>/dev/null") end
  return {
    review_path = carly .. "/review-board.md",
    runbook_path = carly .. "/runbook-board.md",
    -- newest-first (`ls -1t`): classify keeps the FIRST round seen per item ⇒ the LATEST round (review-reports is an append-only archive).
    list_reviews = function() return popen_lines("ls -1t " .. string.format("%q", review_reports) .. " 2>/dev/null") end,
    list_board = function() return popen_lines("ls -1 " .. string.format("%q", board_dir) .. " 2>/dev/null") end,
    is_ancestor = function(sha) return git_is_ancestor(repo, sha) end,
    batches = function()
      -- discover the latest rehearse-batch-* branch; build the five-step artifact facts (coordinator-locked paths)
      local branches = git("branch --list 'rehearse-batch-*' --format='%(refname:short)'")
      if #branches == 0 then return {} end
      table.sort(branches) -- lexical; rehearse-batch-NN — good enough for v1 (one in flight)
      local branch = branches[#branches]
      local tip_time = tonumber((git("log -1 --format=%ct " .. string.format("%q", branch))[1]))
      local presence = repo .. "/packages/bus/dist-presence/presence.mjs"
      local gates = home .. "/.agenthop/swarm/batch-gates/" .. branch .. ".json"
      local tip_sha = (git("rev-parse " .. string.format("%q", branch))[1])
      -- arch-review: a batch*-dual-signoff-*.md under review-reports whose body references the tip sha (v1: existence of any such file)
      local arch = nil
      for _, n in ipairs(popen_lines("ls -1 " .. string.format("%q", review_reports) .. " 2>/dev/null")) do
        if string.match(n, "^batch.*dual%-signoff") then arch = review_reports .. "/" .. n end
      end
      local agenthop_bin = (os.getenv("HOME") or home) .. "/.local/bin/agenthop"
      local merged = tip_sha and git_is_ancestor(repo, tip_sha) or false
      return { {
        branch = branch,
        artifacts = { ["merge-pool"] = branch, ["regen-presence"] = presence, ["gates"] = gates, ["arch-review"] = (arch or "?"), ["ff-main-install"] = agenthop_bin },
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
