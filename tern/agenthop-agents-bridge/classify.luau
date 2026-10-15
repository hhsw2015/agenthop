-- agenthop agents-bridge — #1041 screen classifier for bare TUI blocks (Claude / Codex / … running in a plain terminal pane).
-- A translation of herdr's manifest engine (herdr commit 31c77f3, src/detect/manifest.rs: rule matching + region functions;
-- rules in manifests.luau, generated from src/detect/manifests/*.toml). herdr is AGPL-3.0-or-later (see its LICENSE). User
-- ruling 2026-10-15: translate the originals directly; this header is the attribution.
--
-- PURE: classify(lines, title, program) -> { state = idle|working|blocked|unknown, rule = <id|nil>, agent = <id|nil> }.
-- It never reads the screen itself (cx.session:read costs ~23ms; the sentinel reads one pane per round and passes lines + title in).
-- Same source in Tern (Luau) and in test/classify.test.lua (Lua 5.5): only the Lua 5.1 ∩ Luau subset is used.
--
-- Semantics (as herdr): every rule is evaluated on its region; the highest priority match wins (ties: first in file order);
-- no match => idle for a known agent (herdr fallback_explain), unknown for an unknown program. `contains` is case-insensitive
-- substring (ASCII lowercase); regex/line_regex use the small matcher below; line_regex = some line matches; all/any/not nest.

local M = {}
local manifests = require("./manifests")

-- agenthop OVERLAY (not from herdr; authored here, kept separate from the generated manifests.luau). Observed live 2026-10-15 on
-- Claude Code 2.1.293 in a Tern pane: while a turn runs the OSC title spinner is ◐/◑ (U+25D0..U+25D3), not the braille block
-- herdr's osc_title_working expects; idle is ✳ (U+2733) as herdr expects. Without this, a working turn falls through to herdr's
-- live_prompt_box (the ❯ box stays drawn while working) and reads idle. Same priority/region shape as herdr's rule.
M.OVERLAY = {
  claude = {
    { id = "agenthop_osc_title_halfcircle_working", state = "working", priority = 1100, region = "osc_title", visible_working = true,
      regex = { "^[\\x{25D0}-\\x{25D3}] " } },
  },
}

-- ---------------- UTF-8 helpers ----------------
local function utf8_decode(s, i)
  local c = string.byte(s, i)
  if not c then return nil, i end
  if c < 0x80 then return c, i + 1 end
  local n, cp
  if c >= 0xF0 then n, cp = 3, c - 0xF0 elseif c >= 0xE0 then n, cp = 2, c - 0xE0 elseif c >= 0xC0 then n, cp = 1, c - 0xC0
  else return c, i + 1 end
  for k = 1, n do
    local b = string.byte(s, i + k)
    if not b then return c, i + 1 end
    cp = cp * 64 + (b - 0x80)
  end
  return cp, i + n + 1
end

local function decode_all(s)
  local out, i = {}, 1
  while i <= #s do
    local cp, j = utf8_decode(s, i)
    out[#out + 1] = cp
    i = j
  end
  return out
end

local function is_space(cp) return cp == 32 or (cp >= 9 and cp <= 13) or cp == 0xA0 end
local function is_alpha(cp) -- ASCII letters + any non-ASCII codepoint counted as letter-ish except known symbol blocks
  if (cp >= 65 and cp <= 90) or (cp >= 97 and cp <= 122) then return true end
  if cp < 0xC0 then return false end
  -- symbol / box / braille / geometric / dingbat / emoji blocks are NOT alphabetic
  if (cp >= 0x2000 and cp <= 0x2BFF) or (cp >= 0x2E00 and cp <= 0x2E7F) or (cp >= 0x3000 and cp <= 0x303F)
    or (cp >= 0x1F000 and cp <= 0x1FFFF) or (cp >= 0xFE00 and cp <= 0xFE0F) then return false end
  return true
end
local function is_digit(cp) return cp >= 48 and cp <= 57 end
local function is_word(cp) return is_alpha(cp) or is_digit(cp) or cp == 95 end
local function lower_cp(cp) if cp >= 65 and cp <= 90 then return cp + 32 end return cp end

-- ---------------- a tiny backtracking regex (the subset herdr's manifests use) ----------------
-- Supported: literals, ., ^, $, \s \S \w \d \b, \x{HHHH} \uHHHH, \p{Alphabetic}, escapes, [...] classes with ranges and the
-- escapes above, groups (...) with | alternation, quantifiers * + ? {n,} {n} {n,m} (greedy), flags (?i) (?m) (?s) at the start.
-- Unsupported syntax raises (a manifest that does not compile is an error, as in herdr).

local function parse(pat)
  local cps = decode_all(pat)
  local pos = 1
  local flags = { i = false, m = false, s = false }
  local function peek(o) return cps[pos + (o or 0)] end
  local function eat() local c = cps[pos]; pos = pos + 1; return c end
  local function hex(n)
    local v = 0
    for _ = 1, n do
      local c = eat()
      local d = (c >= 48 and c <= 57) and c - 48 or ((c >= 97 and c <= 102) and c - 87 or ((c >= 65 and c <= 70) and c - 55 or nil))
      if d == nil then error("bad hex in regex") end
      v = v * 16 + d
    end
    return v
  end
  local function escape_atom(inclass)
    local c = eat()
    if c == nil then error("trailing backslash") end
    local ch = string.char(c < 128 and c or 63)
    if ch == "s" then return { t = "pred", f = is_space } end
    if ch == "S" then return { t = "pred", f = function(x) return not is_space(x) end } end
    if ch == "w" then return { t = "pred", f = is_word } end
    if ch == "d" then return { t = "pred", f = is_digit } end
    if ch == "b" and not inclass then return { t = "wordb" } end
    if ch == "x" then
      if peek() == 123 then
        eat(); local v = 0
        while peek() ~= 125 do v = v * 16 + hex(1) end
        eat(); return { t = "cp", v = v }
      end
      return { t = "cp", v = hex(2) }
    end
    if ch == "u" then return { t = "cp", v = hex(4) } end
    if ch == "p" then
      if eat() ~= 123 then error("bad \\p") end
      local name = {}
      while peek() ~= 125 do name[#name + 1] = string.char(eat()) end
      eat()
      name = table.concat(name)
      if name == "Alphabetic" or name == "L" or name == "Letter" then return { t = "pred", f = is_alpha } end
      error("unsupported \\p{" .. name .. "}")
    end
    if ch == "n" then return { t = "cp", v = 10 } end
    if ch == "t" then return { t = "cp", v = 9 } end
    return { t = "cp", v = c } -- escaped literal
  end
  local function class()
    local neg = false
    if peek() == 94 then neg = true; eat() end
    local items = {}
    local first = true
    while true do
      local c = peek()
      if c == nil then error("unterminated class") end
      if c == 93 and not first then eat(); break end
      first = false
      local lo
      if c == 92 then eat(); lo = escape_atom(true) else eat(); lo = { t = "cp", v = c } end
      if lo.t == "cp" and peek() == 45 and peek(1) ~= 93 and peek(1) ~= nil then
        eat()
        local hc = eat()
        local hi = hc == 92 and escape_atom(true) or { t = "cp", v = hc }
        items[#items + 1] = { t = "range", lo = lo.v, hi = hi.v }
      else
        items[#items + 1] = lo
      end
    end
    return { t = "class", neg = neg, items = items }
  end
  local alt
  local function atom()
    local c = eat()
    if c == 40 then -- (
      if peek() == 63 and peek(1) == 58 then eat(); eat() end -- (?:
      local node = alt()
      if eat() ~= 41 then error("unbalanced (") end
      return { t = "group", node = node }
    end
    if c == 91 then return class() end
    if c == 46 then return { t = "any" } end
    if c == 94 then return { t = "bol" } end
    if c == 36 then return { t = "eol" } end
    if c == 92 then return escape_atom(false) end
    return { t = "cp", v = c }
  end
  local function quant(node)
    local c = peek()
    local lo, hi
    if c == 42 then eat(); lo, hi = 0, math.huge
    elseif c == 43 then eat(); lo, hi = 1, math.huge
    elseif c == 63 then eat(); lo, hi = 0, 1
    elseif c == 123 and peek(1) and peek(1) >= 48 and peek(1) <= 57 then
      eat(); local n = 0
      while peek() >= 48 and peek() <= 57 do n = n * 10 + (eat() - 48) end
      lo = n; hi = n
      if peek() == 44 then
        eat()
        if peek() == 125 then hi = math.huge else hi = 0; while peek() >= 48 and peek() <= 57 do hi = hi * 10 + (eat() - 48) end end
      end
      if eat() ~= 125 then error("bad {}") end
    else return node end
    if peek() == 63 then eat() end -- lazy suffix: treated as greedy (no manifest depends on laziness)
    return { t = "rep", node = node, lo = lo, hi = hi }
  end
  local function seq()
    local items = {}
    while peek() ~= nil and peek() ~= 124 and peek() ~= 41 do items[#items + 1] = quant(atom()) end
    return { t = "seq", items = items }
  end
  alt = function()
    local branches = { seq() }
    while peek() == 124 do eat(); branches[#branches + 1] = seq() end
    return #branches == 1 and branches[1] or { t = "alt", branches = branches }
  end
  -- leading flag group(s): (?i) (?m) (?s) (?im) …
  while peek() == 40 and peek(1) == 63 and peek(2) ~= 58 do
    eat(); eat()
    while peek() ~= 41 do
      local f = string.char(eat())
      if flags[f] == nil then error("unsupported flag " .. f) end
      flags[f] = true
    end
    eat()
  end
  local node = alt()
  if pos <= #cps then error("unexpected ) in regex") end
  return { node = node, flags = flags }
end

local function class_match(node, cp, ci)
  local hit = false
  for _, it in ipairs(node.items) do
    if it.t == "range" then
      if cp >= it.lo and cp <= it.hi then hit = true
      elseif ci and lower_cp(cp) >= lower_cp(it.lo) and lower_cp(cp) <= lower_cp(it.hi) then hit = true end
    elseif it.t == "cp" then
      if cp == it.v or (ci and lower_cp(cp) == lower_cp(it.v)) then hit = true end
    elseif it.t == "pred" then
      if it.f(cp) then hit = true end
    end
    if hit then break end
  end
  if node.neg then return not hit end
  return hit
end

-- m(node, s, i, k): match node at index i of codepoint array s, then continuation k(j). Returns true on success.
local function m(rx, node, s, i, k)
  local t = node.t
  local f = rx.flags
  if t == "seq" then
    local items = node.items
    local function step(idx, j)
      if idx > #items then return k(j) end
      return m(rx, items[idx], s, j, function(j2) return step(idx + 1, j2) end)
    end
    return step(1, i)
  elseif t == "alt" then
    for _, b in ipairs(node.branches) do if m(rx, b, s, i, k) then return true end end
    return false
  elseif t == "group" then
    return m(rx, node.node, s, i, k)
  elseif t == "rep" then
    -- greedy: collect positions reachable by 0..hi repetitions, try the longest first
    local positions = { i }
    local cur = i
    local count = 0
    while count < node.hi do
      local nextp
      m(rx, node.node, s, cur, function(j) if j ~= cur then nextp = j; return true end return false end)
      if nextp == nil then break end
      count = count + 1
      positions[#positions + 1] = nextp
      cur = nextp
    end
    for idx = #positions, node.lo + 1, -1 do
      if k(positions[idx]) then return true end
    end
    return false
  elseif t == "cp" then
    local c = s[i]
    if c == nil then return false end
    if c == node.v or (f.i and lower_cp(c) == lower_cp(node.v)) then return k(i + 1) end
    return false
  elseif t == "any" then
    local c = s[i]
    if c == nil or (c == 10 and not f.s) then return false end
    return k(i + 1)
  elseif t == "pred" then
    local c = s[i]
    if c == nil or not node.f(c) then return false end
    return k(i + 1)
  elseif t == "class" then
    local c = s[i]
    if c == nil or not class_match(node, c, f.i) then return false end
    return k(i + 1)
  elseif t == "bol" then
    if i == 1 or (f.m and s[i - 1] == 10) then return k(i) end
    return false
  elseif t == "eol" then
    if s[i] == nil or (f.m and s[i] == 10) then return k(i) end
    return false
  elseif t == "wordb" then
    local a = s[i - 1] ~= nil and is_word(s[i - 1])
    local b = s[i] ~= nil and is_word(s[i])
    if a ~= b then return k(i) end
    return false
  end
  error("bad node " .. tostring(t))
end

local cache = {}
function M.compile(pat)
  local rx = cache[pat]
  if rx == nil then rx = parse(pat); cache[pat] = rx end
  return rx
end
-- unanchored search (like Rust Regex::is_match)
function M.re_match(pat, text)
  local rx = M.compile(pat)
  local s = decode_all(text)
  for start = 1, #s + 1 do
    if m(rx, rx.node, s, start, function() return true end) then return true end
  end
  return false
end

-- ---------------- regions (manifest.rs region functions) ----------------
local function split_lines(content)
  local lines = {}
  for line in (content .. "\n"):gmatch("(.-)\n") do lines[#lines + 1] = line end
  if content:sub(-1) == "\n" then lines[#lines] = nil end -- Rust .lines() drops the final empty piece
  if content == "" then lines = {} end
  return lines
end
local function join_from(lines, from) -- slice_from_line_index
  local out = {}
  for idx = from, #lines do out[#out + 1] = lines[idx] end
  return table.concat(out, "\n")
end
local function join_range(lines, a, b) -- lines[a..b-1]
  local out = {}
  for idx = a, b - 1 do out[#out + 1] = lines[idx] end
  return table.concat(out, "\n")
end
local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
local RULE = "\226\148\128" -- U+2500 '─'

function M.is_horizontal_rule(line)
  local t = trim(line)
  if t == "" then return false end
  local n, p = 0, 1
  while t:sub(p, p + 2) == RULE do n = n + 1; p = p + 3 end
  if n == 0 then return false end
  local suffix = t:sub(p):gsub("^%s+", "")
  return suffix == "" or n >= 3
end
local function codex_prompt_line(line) return line == "\226\128\186" or line:sub(1, 4) == "\226\128\186 " end -- '›'
local function codex_block_marker_line(line)
  return line:sub(1, 3) == "\226\128\162" or line:sub(1, 3) == "\226\150\160" or line:sub(1, 3) == "\226\156\151"
    or line:sub(1, 3) == "\226\156\147" -- • ■ ✗ ✓
end
local function rposition(lines, pred) for idx = #lines, 1, -1 do if pred(lines[idx]) then return idx end end return nil end
local function current_codex_prompt_index(lines)
  local p = rposition(lines, codex_prompt_line)
  if not p then return nil end
  for idx = p + 1, #lines do if codex_block_marker_line(lines[idx]) then return nil end end
  return p
end
local function prompt_box_top(lines)
  local count = 0
  for idx = #lines, 1, -1 do
    if M.is_horizontal_rule(lines[idx]) then count = count + 1; if count == 2 then return idx end end
  end
  return nil
end

function M.region(spec, content, title, progress)
  spec = trim(spec or "whole_recent")
  if spec == "osc_title" then return title or "" end
  if spec == "osc_progress" then return progress or "" end
  local lines = split_lines(content)
  if spec == "whole_recent" then return content end
  if spec == "after_last_prompt_marker" then
    local p = rposition(lines, codex_prompt_line)
    if not p then return content end
    return join_from(lines, p + 1)
  end
  if spec == "before_current_prompt_marker" then
    local p = current_codex_prompt_index(lines)
    if not p then return content end
    return join_range(lines, 1, p)
  end
  if spec == "whole_recent_without_current_prompt_marker" then
    if current_codex_prompt_index(lines) then return "" end
    return content
  end
  if spec == "current_prompt_block_marker" or spec == "after_current_prompt_block_marker" then
    local p = current_codex_prompt_index(lines)
    if not p then return "" end
    for idx = p - 1, 1, -1 do
      if codex_block_marker_line(lines[idx]) then
        if spec == "current_prompt_block_marker" then return lines[idx] end
        return join_from(lines, idx)
      end
    end
    return ""
  end
  if spec == "prompt_box_body" then
    local top = prompt_box_top(lines)
    if not top then return "" end
    local finish = #lines + 1
    for idx = top + 1, #lines do if M.is_horizontal_rule(lines[idx]) then finish = idx; break end end
    return join_range(lines, top + 1, finish)
  end
  if spec == "above_prompt_box" or spec == "last_non_empty_above_prompt_box" then
    local top = prompt_box_top(lines)
    local above = top and join_range(lines, 1, top) or content
    if spec == "above_prompt_box" then return above end
    local al = split_lines(above)
    for idx = #al, 1, -1 do if trim(al[idx]) ~= "" then return al[idx] end end
    return ""
  end
  if spec == "after_last_horizontal_rule" then
    local last = nil
    for idx = 1, #lines do if M.is_horizontal_rule(lines[idx]) then last = idx end end
    if not last then return content end
    return join_from(lines, last + 1)
  end
  local n = spec:match("^bottom_lines%((%d+)%)$")
  if n then return join_from(lines, math.max(1, #lines - tonumber(n) + 1)) end
  n = spec:match("^bottom_non_empty_lines%((%d+)%)$")
  if n then
    local want, start = tonumber(n), nil
    for idx = #lines, 1, -1 do
      if trim(lines[idx]) ~= "" then want = want - 1; start = idx; if want == 0 then break end end
    end
    if not start then return "" end
    return join_from(lines, start)
  end
  return ""
end

-- ---------------- gates ----------------
local function gate_matches(g, text, lower)
  for _, needle in ipairs(g.contains or {}) do
    if not string.find(lower, string.lower(needle), 1, true) then return false end
  end
  for _, pat in ipairs(g.regex or {}) do if not M.re_match(pat, text) then return false end end
  for _, pat in ipairs(g.line_regex or {}) do
    local any = false
    for _, line in ipairs(split_lines(text)) do if M.re_match(pat, line) then any = true; break end end
    if not any then return false end
  end
  for _, sub in ipairs(g.all or {}) do if not gate_matches(sub, text, lower) then return false end end
  if g.any and #g.any > 0 then
    local hit = false
    for _, sub in ipairs(g.any) do if gate_matches(sub, text, lower) then hit = true; break end end
    if not hit then return false end
  end
  for _, sub in ipairs(g["not"] or {}) do if gate_matches(sub, text, lower) then return false end end
  return true
end
M.gate_matches = function(g, text) return gate_matches(g, text, string.lower(text)) end

-- ---------------- agent selection (detect/mod.rs parse_agent_label, by program basename) ----------------
local LABELS = {
  pi = "pi", claude = "claude", ["claude-code"] = "claude", codex = "codex", gemini = "gemini", cursor = "cursor",
  ["cursor-agent"] = "cursor", agy = "antigravity", antigravity = "antigravity", ["antigravity-cli"] = "antigravity",
  cline = "cline", opencode = "opencode", ["open-code"] = "opencode", copilot = "github-copilot",
  ["github-copilot"] = "github-copilot", ghcs = "github-copilot", kimi = "kimi", ["kimi-code"] = "kimi", kiro = "kiro",
  ["kiro-cli"] = "kiro", droid = "droid", amp = "amp", ["amp-local"] = "amp", grok = "grok", ["grok-build"] = "grok",
  hermes = "hermes", ["hermes-agent"] = "hermes", kilo = "kilo", ["kilo-code"] = "kilo", qodercli = "qodercli",
  qoderclicn = "qodercli", qoder = "qodercli", qodercn = "qodercli",
}
function M.agent_for(program)
  if type(program) ~= "string" or program == "" then return nil end
  for word in program:gmatch("[^%s]+") do
    local base = string.lower((word:match("([^/]+)$") or word))
    if LABELS[base] then return LABELS[base] end
    -- Claude Code's native binary lives at …/claude/versions/<semver>
    if word:match("/claude/versions/[%d%.]+$") then return "claude" end
  end
  return nil
end

-- ---------------- classify ----------------
-- lines: array of strings (cx.session:read(...).lines) or a single string; title: OSC title; program: command line / program.
function M.classify(lines, title, program, progress)
  local agent = M.agent_for(program)
  if agent == nil or manifests[agent] == nil then return { state = "unknown", rule = nil, agent = agent } end
  local content = type(lines) == "table" and table.concat(lines, "\n") or (lines or "")
  local best = nil
  local rules = {}
  for _, r in ipairs(manifests[agent].rules) do rules[#rules + 1] = r end
  for _, r in ipairs(M.OVERLAY[agent] or {}) do rules[#rules + 1] = r end
  for _, rule in ipairs(rules) do
    local text = M.region(rule.region, content, title, progress)
    if gate_matches(rule, text, string.lower(text)) then
      if best == nil or rule.priority > best.priority then best = rule end
    end
  end
  if best == nil then return { state = "idle", rule = nil, agent = agent } end -- herdr fallback for a known agent
  return { state = best.state or "unknown", rule = best.id, agent = agent, skip_state_update = best.skip_state_update == true }
end

return M
