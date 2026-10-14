-- agenthop agents-bridge — A2 promptless patrol sentinel (the `check` source for tern.carly.schedule).
--
-- A self-contained source that RETURNS function(ev, cx, state): the scheduler runs it every minute with NO model turn. It raises
-- alert classes and writes them to L0 files the swarm scans (PROTOCOL.md §7/§9). Returning nil is quiet (no model turn). Each run
-- self-times. r2 augmentations (dormant, atop the frozen tern batch):
--   ① mutual-watch beats: write carly-patrol.beat (my liveness; the swarm's 8-min loop reads it, >20min stale => take over + TG) and
--      read coordinator.beat (stale => coordinator_stale alert). #924: liveness is L0 FILES, mutual-read files not processes.
--   ② budget split: body-scan only batch_size (3-4) panes per round on a rotating offset; a cheap metadata sweep still covers EVERY
--      pane every round (osc_alert + the proven-idle stall reset) so neither is delayed by batching.
--   ③ L0 alert path: a placeholder L0 constant + TODO(M2-a projection contract); TG reads the files directly, not via Carly.
--   (④ W3 CPA probe is a swarm-side bash companion, cpa-probe.sh — a down CPA can't post to the inbox, so the probe stays off Carly.)
--
-- Lua 5.1/5.5 ∩ Luau subset (ipairs/pairs, string.find plain, no += / no generalized-for / no type annotations): the SAME file loads in
-- Tern (Luau) and in test/sentinel.test.lua (Lua 5.5) — one source, no drift. Tuning lives in CONFIG.

local CONFIG = {
  tail_lines = 40, -- lines from the bottom of each pane to hash/scan
  stall_ms = 3 * 60 * 1000, -- busy + unchanged hash this long => stall alert
  excerpt_chars = 400, -- alert text excerpt cap
  batch_size = 4, -- ② panes body-scanned per round (metadata is swept for all panes every round)
  coordinator_stale_ms = 20 * 60 * 1000, -- ① coordinator.beat older than this => coordinator_stale alert
  filter_pats = { "content filter", "usage policy", "can't help with that", "cannot assist with", "flagged for" },
  perm_pats = { "allow this", "[y/n]", "do you want to proceed", "needs your permission", "wants to run", "grant access", "approve?" },
}

-- ③ L0 paths. TODO(M2-a projection contract): replace this placeholder L0 root with the contract's projection path once frozen.
local function l0_root(home) return home .. "/.agenthop/carly" end
local function alerts_dir(home) return l0_root(home) .. "/alerts" end -- TG reads these files directly
local function my_beat_path(home) return l0_root(home) .. "/carly-patrol.beat" end -- ① my liveness (swarm reads)
local function coordinator_beat_path(home) return l0_root(home) .. "/coordinator.beat" end -- ① the beat I watch

local function hash(s)
  local h = 5381
  for i = 1, #s do
    h = (h * 33 + string.byte(s, i)) % 2147483647
  end
  return h
end

local function tail_join(lines, n)
  local start = #lines - n + 1
  if start < 1 then start = 1 end
  local parts = {}
  for i = start, #lines do
    parts[#parts + 1] = lines[i]
  end
  return table.concat(parts, "\n")
end

local function match_any(low, pats)
  for _, p in ipairs(pats) do
    if string.find(low, p, 1, true) then
      return p
    end
  end
  return nil
end

local function excerpt(text)
  if #text > CONFIG.excerpt_chars then
    return string.sub(text, #text - CONFIG.excerpt_chars + 1)
  end
  return text
end

local function is_agent_pane(p)
  return p.pane ~= nil and (p.kind == "agent" or p.program == "omp" or p.kind == "terminal")
end

-- scan_meta: metadata-only (NO body read). osc_alert (A3) + the metadata-authoritative stall-clock reset (TA-A2-STALL). Runs for EVERY
-- agent pane every round, even outside the body-scan batch, so a needs-human signal and a proven-idle reset are never delayed by ②.
-- Returns (alerts, newSeen). newSeen keeps the prior hash (hash only updates from a real body read) and the metadata-adjusted clock.
local function scan_meta(p, now, prev)
  local alerts = {}
  if p.alert == true then
    alerts[#alerts + 1] = { pane = p.pane, kind = "osc_alert", program = p.program, cwd = p.cwd, ts = now }
  end
  local busy_since = nil
  if p.busy == true and prev ~= nil then
    busy_since = prev.busy_since -- still busy: carry the clock; idle (or no prev) => nil resets it
  end
  return alerts, { hash = prev ~= nil and prev.hash or nil, busy_since = busy_since }
end

-- scan_body: text detection (content_filter / permission) + stall. Needs the tail; called only for the batch slice on a successful read.
local function scan_body(p, tail, now, prev)
  local alerts = {}
  local low = string.lower(tail)
  local h = hash(tail)
  local filt = match_any(low, CONFIG.filter_pats)
  if filt then
    alerts[#alerts + 1] = { pane = p.pane, kind = "content_filter", marker = filt, program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now }
  end
  local perm = match_any(low, CONFIG.perm_pats)
  if perm then
    alerts[#alerts + 1] = { pane = p.pane, kind = "permission", marker = perm, program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now }
  end
  local busy_since = nil
  if p.busy == true then
    if prev ~= nil and prev.hash == h and prev.busy_since ~= nil then
      busy_since = prev.busy_since
    else
      busy_since = now
    end
    if (now - busy_since) >= CONFIG.stall_ms then
      alerts[#alerts + 1] = { pane = p.pane, kind = "stall", program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now, stalled_ms = now - busy_since }
    end
  end
  return alerts, { hash = h, busy_since = busy_since }
end

local function write_alert(home, a, now)
  pcall(function()
    local dir = alerts_dir(home)
    if not tern.fs.exists(dir) then
      tern.fs.mkdir(dir)
    end
    tern.fs.write(dir .. "/" .. a.kind .. "-" .. tostring(a.pane or "x") .. "-" .. tostring(now) .. ".json", tern.json.encode(a))
  end)
end

local check = function(ev, cx, state)
  local t0 = tern.now()
  local now = t0
  local home = tern.getenv("HOME") or ""
  state.seen = state.seen or {} -- pane -> { hash, busy_since }
  state.scan_offset = state.scan_offset or 0

  -- ① write my liveness beat every round (the swarm's 8-min loop reads carly-patrol.beat; >20min stale => I'm stopped/Tern closed)
  pcall(function()
    local dir = l0_root(home)
    if not tern.fs.exists(dir) then
      tern.fs.mkdir(dir)
    end
    tern.fs.write(my_beat_path(home), tern.json.encode({ ts = now, by = "tern-a2-sentinel" }))
  end)

  local all = {}

  -- ① mutual-watch: read coordinator.beat; a stale beat => coordinator_stale (I watch it; it watches me via my beat). Files, not processes.
  do
    local okB, txt = pcall(function() return tern.fs.read(coordinator_beat_path(home)) end)
    if okB and type(txt) == "string" and txt ~= "" then
      local okD, bt = pcall(function() return tern.json.decode(txt) end)
      if okD and type(bt) == "table" and type(bt.ts) == "number" and (now - bt.ts) > CONFIG.coordinator_stale_ms then
        all[#all + 1] = { kind = "coordinator_stale", beat_age_ms = now - bt.ts, ts = now }
      end
    end
  end

  -- collect agent panes
  local okP, panes = pcall(function() return cx.session:panes() end)
  if not okP or type(panes) ~= "table" then
    panes = {}
  end
  local agents = {}
  for _, p in ipairs(panes) do
    if is_agent_pane(p) then
      agents[#agents + 1] = p
    end
  end

  -- cheap metadata sweep for ALL agent panes (no body read): osc_alert + proven-idle stall reset, never delayed by batching
  for _, p in ipairs(agents) do
    local a, seen = scan_meta(p, now, state.seen[p.pane])
    state.seen[p.pane] = seen
    for _, x in ipairs(a) do
      all[#all + 1] = x
    end
  end

  -- ② budget split: body-scan only batch_size panes this round, on a rotating offset, so no single round reads every pane
  local n = #agents
  if n > 0 then
    local size = CONFIG.batch_size
    if size > n then
      size = n
    end
    for i = 0, size - 1 do
      local p = agents[((state.scan_offset + i) % n) + 1]
      local tail = nil
      local okR, read = pcall(function()
        return cx.session:read(p.pane, { as = "table", lines = CONFIG.tail_lines, scrollback = true })
      end)
      if okR and type(read) == "table" and type(read.lines) == "table" then
        tail = tail_join(read.lines, CONFIG.tail_lines)
      end
      if tail ~= nil then
        local a, seen = scan_body(p, tail, now, state.seen[p.pane])
        state.seen[p.pane] = seen
        for _, x in ipairs(a) do
          all[#all + 1] = x
        end
      end
    end
    state.scan_offset = (state.scan_offset + CONFIG.batch_size) % n
  end

  local check_ms = tern.now() - t0

  -- ③ durable path: one L0 JSON file per alert (TG reads the files directly, not via Carly)
  for _, a in ipairs(all) do
    a.check_ms = check_ms
    write_alert(home, a, now)
  end

  if #all == 0 then
    return nil
  end
  local parts = {}
  for _, a in ipairs(all) do
    parts[#parts + 1] = a.kind .. (a.pane and ("@pane" .. tostring(a.pane)) or "")
  end
  return "tern-patrol: " .. table.concat(parts, "; ") .. " (" .. string.format("%.1f", check_ms) .. "ms, " .. tostring(#all) .. " alert(s))"
end

-- The source must RETURN the function value (tern.carly.schedule compiles this source and calls the result as function(ev,cx,state)).
-- test/sentinel.test.lua loads this file, mocks the `tern` and `cx` globals, and drives check() directly — same file, no drift.
return check
