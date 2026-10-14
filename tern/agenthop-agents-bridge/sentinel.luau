-- agenthop agents-bridge — A2 promptless patrol sentinel (the `check` source for tern.carly.schedule).
--
-- A self-contained source that RETURNS function(ev, cx, state): the scheduler runs it every minute with NO model turn. It reads every
-- agent pane, hashes the TAIL N LINES (length/byte offsets fail under TUI redraw/scroll — Carly V-batch finding, so we compare a hash
-- of the tail, not an offset), and raises three alert classes. Alerts go two ways (PROTOCOL.md §A2): a durable JSON file under
-- ~/.agenthop/carly/alerts/ (the swarm scans it) AND the returned string (shown directly by Carly, still model-free). Returning nil is
-- quiet (no turn). Each run self-times and carries the ms into every alert record.
--
-- Written in the Lua 5.1/5.5 ∩ Luau subset (ipairs/pairs, string.find plain, no += / no generalized-for / no type annotations) so the
-- SAME file is loaded by Tern (Luau) and by test/sentinel.test.lua (Lua 5.5) — one source, no drift. Tuning lives in CONFIG below.

local CONFIG = {
  tail_lines = 40, -- lines from the bottom of each pane to hash/scan
  stall_ms = 3 * 60 * 1000, -- busy + unchanged hash this long => stall alert
  excerpt_chars = 400, -- alert text excerpt cap
  -- lowercased plain substrings; conservative, tune per fleet
  filter_pats = { "content filter", "usage policy", "can't help with that", "cannot assist with", "flagged for" },
  perm_pats = { "allow this", "[y/n]", "do you want to proceed", "needs your permission", "wants to run", "grant access", "approve?" },
}

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

-- Pure scan of one pane's tail text into zero or more alert records. Exposed on the returned function (fn.scan) so the fixture can
-- unit-test detection without a cx; the live path calls it from inside the returned function.
local function scan_pane(p, tail, now, prev)
  local low = string.lower(tail)
  local h = hash(tail)
  local alerts = {}
  local filt = match_any(low, CONFIG.filter_pats)
  if filt then
    alerts[#alerts + 1] = { pane = p.pane, kind = "content_filter", marker = filt, program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now }
  end
  local perm = match_any(low, CONFIG.perm_pats)
  if perm then
    alerts[#alerts + 1] = { pane = p.pane, kind = "permission", marker = perm, program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now }
  end
  -- A3: the OSC 9;4-driven alert flag. A seat wrapper / CC hook emits OSC 9;4;4 when it "needs a human"; Tern sets PaneInfo.alert,
  -- which we fold into this same stream (Carly V6: OSC -> alert=true, focus clears, no OSC leaves it unchanged). This gives non-ACP
  -- seats a "needs attention" signal without the model and without screen-text heuristics.
  if p.alert == true then
    alerts[#alerts + 1] = { pane = p.pane, kind = "osc_alert", program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now }
  end
  -- stall: hash unchanged since a prior run AND still busy for >= stall_ms
  local since = now
  if prev ~= nil and prev.hash == h then
    since = prev.since
    if p.busy == true and (now - since) >= CONFIG.stall_ms then
      alerts[#alerts + 1] = { pane = p.pane, kind = "stall", program = p.program, cwd = p.cwd, text = excerpt(tail), ts = now, stalled_ms = now - since }
    end
  end
  return alerts, { hash = h, since = since }
end

local check = function(ev, cx, state)
  local t0 = tern.now()
  local now = t0
  local home = tern.getenv("HOME") or ""
  local alerts_dir = home .. "/.agenthop/carly/alerts"
  state.seen = state.seen or {} -- pane -> { hash, since } ; persists across runs for stall tracking

  local okP, panes = pcall(function() return cx.session:panes() end)
  if not okP or type(panes) ~= "table" then
    return nil
  end

  local all = {}
  for _, p in ipairs(panes) do
    if is_agent_pane(p) then
      local okR, read = pcall(function()
        return cx.session:read(p.pane, { as = "table", lines = CONFIG.tail_lines, scrollback = true })
      end)
      if okR and type(read) == "table" and type(read.lines) == "table" then
        local tail = tail_join(read.lines, CONFIG.tail_lines)
        local alerts, seen = scan_pane(p, tail, now, state.seen[p.pane])
        state.seen[p.pane] = seen
        for _, a in ipairs(alerts) do
          all[#all + 1] = a
        end
      end
    end
  end

  local check_ms = tern.now() - t0
  -- durable path: one JSON file per alert (swarm scans the dir)
  for _, a in ipairs(all) do
    a.check_ms = check_ms
    pcall(function()
      if not tern.fs.exists(alerts_dir) then
        tern.fs.mkdir(alerts_dir)
      end
      tern.fs.write(alerts_dir .. "/" .. a.kind .. "-" .. tostring(a.pane) .. "-" .. tostring(now) .. ".json", tern.json.encode(a))
    end)
  end

  -- Carly face: a direct (model-free) one-liner, or nil when quiet
  if #all == 0 then
    return nil
  end
  local parts = {}
  for _, a in ipairs(all) do
    parts[#parts + 1] = a.kind .. "@pane" .. tostring(a.pane)
  end
  return "tern-patrol: " .. table.concat(parts, "; ") .. " (" .. string.format("%.1f", check_ms) .. "ms, " .. tostring(#all) .. " alert(s))"
end

-- The source must RETURN the function value (tern.carly.schedule compiles this source and calls the result as function(ev,cx,state)).
-- test/sentinel.test.lua loads this file, mocks the `tern` and `cx` globals, and drives check() directly — same file, no drift.
return check
