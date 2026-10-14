-- agenthop tern-board — line ① A4/A5: the board PROJECTION generator (tern-batch2-contracts.md §1, FROZEN @8ec8b6b).
--
-- Data flow is STRICTLY one-way: durable swarm facts (review-reports dirs / swarm board files / git ancestry) -> this generator
-- (a pure projection) -> two Markdown board files under ~/.agenthop/carly/. The board is a PROJECTION, NEVER a source of truth: a
-- human dragging a card in Tern does NOT write back to the swarm (v1 has no reverse sync — the generator full-rewrites both files
-- from durable every run, so any in-Tern edit is overwritten on the next regen; this is the ownership discipline Carly experiment ④
-- surfaced).
--
-- EXECUTION MODEL (why standalone `lua`, not a tern.carly schedule): the lane/runbook facts need `git merge-base --is-ancestor`
-- (coordinator ruling: structural, not PROGRESS-text parsing) and file mtimes. Tern's sandboxed `tern.fs` has neither exec nor
-- rename/stat (PROTOCOL.md: "tern.fs 没有 rename / O_EXCL"). So the generator runs under the standalone Lua 5.5 interpreter (the SAME
-- one the fixture uses), where io.popen (git/stat), os.rename (atomic write) and io.open exist. Tern/Carly only OPENS the produced md
-- (view). generate.sh is the cron/manual invocation. "A2 哨兵同款模式" is honored as the STYLE — one loadable source whose pure cores
-- a Lua fixture drives directly (no drift) — not the Tern-scheduled host (which cannot run git).
--
-- Everything is DEP-INJECTED (run(deps)): the pure cores (card_id / classify / runbook_steps / render_*) take already-gathered facts
-- and are unit-tested with fakes; only run()'s default deps touch io/os. Written in the Lua 5.1/5.5 subset (no +=, no goto, ipairs/
-- pairs) so the one source loads cleanly under `lua`.

local M = {}

local LANES = { "Queued", "Reviewing", "Needs-human", "Merged" } -- contract §1 swim-lane order
local RUNBOOK_STEPS = { "merge-pool", "regen-presence", "gates", "arch-review", "ff-main-install" } -- contract A5, in order

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: content-addressed card id (contract §1 "卡 id 由生成器按内容哈希稳定派生" — stable across regens, avoids Carly ④'s id-drift).
-- djb2 over the identity tuple; the id depends ONLY on (item, sha, seat), never on list position, so a full-rewrite keeps ids stable.
-- ---------------------------------------------------------------------------------------------------------------------------------
function M.card_id(item, sha, seat)
  item, sha, seat = tostring(item), tostring(sha), tostring(seat)
  -- LENGTH-PREFIXED encoding (not a separator join): the ENCODING is injective even if a field contains the separator (the length fixes
  -- each field boundary — the VL-1/NUL-join lesson). The id is a 64-bit digest of that encoding — TWO independent lanes (djb2 + FNV-1a),
  -- so a single-lane collision like 32-bit djb2's "Ab"/"BA" does NOT collide here (TB-ID). It is collision-RESILIENT, not claimed
  -- provably-injective; the renderer additionally tie-breaks on full identity so output stays byte-stable even under a hypothetical clash.
  local s = string.format("%d:%s%d:%s%d:%s", #item, item, #sha, sha, #seat, seat)
  local h1 = 5381          -- djb2
  local h2 = 2166136261    -- FNV-1a offset basis
  for i = 1, #s do
    local b = string.byte(s, i)
    h1 = (h1 * 33 + b) % 4294967296
    h2 = ((h2 ~ b) * 16777619) % 4294967296
  end
  return string.format("%08x%08x", h1, h2)
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: classify durable facts into the four lanes (coordinator-locked mapping, all structural — zero PROGRESS parsing).
--   facts = {
--     board   = { {item=, seat=, state="granted"|"claimed"|"done"}, ... },   -- from ~/.agenthop/swarm/board/<item>.<state>.<sid>.json
--     reviews = { {item=, sha=, seat=}, ... },                               -- from ~/Work/review-reports/<item>-<sha>-review-<seat>/
--     signoffs= { {item=, sha=, seat=}, ... },                              -- from ~/Work/review-reports/*-dual-signoff-* dirs
--   }
--   is_ancestor(sha) -> bool : git merge-base --is-ancestor <sha> main (injected; io.popen in the real deps).
-- Lane rules:
--   Merged      <- a dual-signoff exists AND its sha IS in main ancestry.
--   Needs-human <- a dual-signoff exists AND its sha is NOT yet in main ancestry (dual-voice cleared, awaiting the human merge gate).
--   Reviewing   <- a review-report dir exists for an item NOT already in signoff (an in-flight round).
--   Queued      <- a board item granted/claimed (NOT done) with NO review-report dir yet (claimed, not yet submitted).
-- Each card carries a stable id; a review/signoff card's title is "<item> @<sha7> [<seat>]" (contract §1).
-- ---------------------------------------------------------------------------------------------------------------------------------
local function sha7(s) return string.sub(tostring(s), 1, 7) end

function M.classify(facts, is_ancestor)
  local lanes = { Queued = {}, Reviewing = {}, ["Needs-human"] = {}, Merged = {} }

  -- facts.rounds: a UNIFIED newest-first stream of EVERY review-reports dir for the fleet, each tagged kind="review"|"signoff" and
  -- carrying recent (dir mtime < 7d). review-reports is an append-only archive, so per item the NEWEST round decides the lane — this is
  -- the correct current-round attribution (TB-ROUND): a NEW review round (new SHA) of an item that was dual-signed on an OLD SHA shows
  -- as Reviewing again; an old signoff can never swallow a newer round, and a newer round can never be hidden by older history.
  local decided = {} -- item -> true once its newest round has set its lane (and marks it out of Queued)
  for _, r in ipairs(facts.rounds or {}) do
    if not decided[r.item] then
      decided[r.item] = true
      local card = { id = M.card_id(r.item, r.sha, r.seat), item = r.item, sha = r.sha, seat = r.seat, tag = "review" }
      if r.kind == "signoff" then
        -- NO recency: a dual-signed-but-unmerged item is DEBT, shown however old (coordinator v2). Merged iff its SHA is on main.
        if is_ancestor(r.sha) == true then
          lanes.Merged[#lanes.Merged + 1] = card
        else
          lanes["Needs-human"][#lanes["Needs-human"] + 1] = card
        end
      else -- review: v2 RECENCY — only a recent (<7d) latest round is "reviewing NOW"; a stale latest round drops from the board (the
        -- item is still `decided`, so it won't fall back to Queued either — it's archived, not pending).
        if r.recent then
          lanes.Reviewing[#lanes.Reviewing + 1] = card
        end
      end
    end
  end

  -- Queued from board granted/claimed with NO review-reports presence at all (claimed, not yet submitted); 'done' is not queued work.
  for _, b in ipairs(facts.board or {}) do
    local active = (b.state == "granted" or b.state == "claimed")
    if active and not decided[b.item] then
      lanes.Queued[#lanes.Queued + 1] = { id = M.card_id(b.item, b.state, b.seat), item = b.item, sha = nil, seat = b.seat, tag = "review" }
    end
  end

  -- Deterministic order: by id, then a FULL-IDENTITY tie-break (TB-ID — the id is collision-resilient, not provably unique, so two cards
  -- that hypothetically share an id still sort stably by (item,sha,seat), keeping the full-rewrite byte-stable regardless of fs order).
  local function keyf(a, c)
    if a.id ~= c.id then return a.id < c.id end
    local ai = (a.item or "") .. "\30" .. (a.sha or "") .. "\30" .. (a.seat or "")
    local ci = (c.item or "") .. "\30" .. (c.sha or "") .. "\30" .. (c.seat or "")
    return ai < ci
  end
  for _, lane in pairs(lanes) do
    table.sort(lane, keyf)
  end
  return lanes
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: render the A4 review board (review-board.md). Four lanes, stable card lines. A card with a sha shows "@<sha7> [<seat>]";
-- a Queued card (no sha yet) shows just "[<seat>]". Format mirrors Carly experiment ③'s sample.
-- ---------------------------------------------------------------------------------------------------------------------------------
local function card_line(c)
  local title = c.item
  if c.sha then title = title .. " @" .. sha7(c.sha) end
  title = title .. " [" .. tostring(c.seat) .. "]"
  return "- [ ] " .. c.id .. " · " .. title .. " #" .. c.tag
end

function M.render_review_board(lanes)
  local out = { "# Review queue", "", "<!-- GENERATED projection — do not edit; the generator full-rewrites this from durable swarm facts every run (v1 no reverse sync). -->", "" }
  for _, name in ipairs(LANES) do
    out[#out + 1] = "## " .. name
    local cards = lanes[name] or {}
    for _, c in ipairs(cards) do
      out[#out + 1] = card_line(c)
    end
    out[#out + 1] = ""
  end
  return table.concat(out, "\n")
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: the A5 runbook step-check (mtime chain). Each step ticks iff its artifact EXISTS and its mtime is strictly later than the
-- previous ticked step's mtime (a monotonic chain — a step cannot be "done" before the step it depends on). A missing artifact ⇒
-- that step and every later step stay UNCHECKED (honest gap, never guessed — e.g. the v1 batch-gates file may be absent).
--   steps_facts = { {name=, exists=bool, mtime=number|nil}, ... } in RUNBOOK_STEPS order.
-- Returns a parallel list of { name=, checked=bool, mtime= , reason= } (reason explains an unchecked step for the card notes).
-- ---------------------------------------------------------------------------------------------------------------------------------
function M.runbook_steps(steps_facts)
  local res = {}
  local prev_mtime = nil -- mtime of the last CHECKED step; nil = no prior constraint (step 1)
  local chain_broken = false
  for _, sf in ipairs(steps_facts) do
    local checked = false
    local reason = nil
    if chain_broken then
      reason = "blocked: a prior step is not done"
    elseif not sf.exists then
      reason = "artifact missing"
      chain_broken = true
    elseif sf.mtime == nil then
      reason = "artifact mtime unknown"
      chain_broken = true
    elseif prev_mtime ~= nil and not (sf.mtime > prev_mtime) then
      reason = "artifact not newer than the previous step"
      chain_broken = true
    else
      checked = true
      prev_mtime = sf.mtime
    end
    res[#res + 1] = { name = sf.name, checked = checked, mtime = sf.mtime, reason = reason }
  end
  return res
end

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PURE: render the A5 runbook board (runbook-board.md). One [RUNBOOK] card per batch branch with the five nested sub-checkboxes, plus
-- an artifact-path table in the card notes (contract §1 "artifact 路径表进卡片备注").
--   batch = { branch=, steps=<result of runbook_steps>, artifacts={name->path} }
-- ---------------------------------------------------------------------------------------------------------------------------------
function M.render_runbook_board(batches)
  local out = { "# Batch runbook", "", "<!-- GENERATED projection — do not edit; regenerated from artifact mtimes every run. -->", "" }
  if #batches == 0 then
    out[#out + 1] = "_(no batch branch in flight)_"
    out[#out + 1] = ""
    return table.concat(out, "\n")
  end
  for _, b in ipairs(batches) do
    out[#out + 1] = "## " .. b.branch
    out[#out + 1] = "- [ ] [RUNBOOK] batch-release " .. b.branch .. " #runbook"
    for _, st in ipairs(b.steps) do
      out[#out + 1] = "  - [" .. (st.checked and "x" or " ") .. "] " .. st.name .. (st.reason and ("  (" .. st.reason .. ")") or "")
    end
    out[#out + 1] = ""
    out[#out + 1] = "  <!-- artifact paths:"
    for _, name in ipairs(RUNBOOK_STEPS) do
      out[#out + 1] = "    " .. name .. " = " .. tostring((b.artifacts or {})[name] or "?")
    end
    out[#out + 1] = "  -->"
    out[#out + 1] = ""
  end
  return table.concat(out, "\n")
end

M.LANES = LANES
M.RUNBOOK_STEPS = RUNBOOK_STEPS
return M
