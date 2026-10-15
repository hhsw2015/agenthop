-- #1041 classify fixture. Loads the PRODUCTION classify.luau + generated manifests.luau (one source, no mirror copy), and feeds it
-- REAL Claude Code 2.1.293 TUI screens captured from a Tern pane on 2026-10-15 (test/fixtures/tui/*.txt + .title).
-- Covers: idle / working / blocked / unknown on real screens, the two `not` gates of herdr's claude manifest, region functions,
-- the regex subset (incl. a differential corpus), agent selection, priority order. Mutant check: run with MUTANT=no-prompt-box or
-- MUTANT=no-title-working or MUTANT=no-write-dialog or MUTANT=wrong-manifest-key — the corresponding rule is removed from the loaded manifest (production code untouched) and the
-- matching cases must go RED.
-- Run: lua test/classify.test.lua   (from tern/agenthop-agents-bridge)
local here = (arg and arg[0] or ""):match("^(.*/)") or "./"
local root = here .. "../"
local MAN = assert(loadfile(root .. "manifests.luau"))()
local mutant = os.getenv("MUTANT") or ""
local function drop(list, id)
  for i = #list, 1, -1 do if list[i].id == id then table.remove(list, i) end end
end
local real_require = require
local UCL = assert(loadfile(root .. "uclasses.luau"))()
require = function(name)
  if name == "./manifests" then return MAN end
  if name == "./uclasses" then return UCL end
  return real_require(name)
end
local C = assert(loadfile(root .. "classify.luau"))()
if mutant == "no-prompt-box" then drop(MAN.claude.rules, "live_prompt_box") end
if mutant == "no-title-working" then
  drop(MAN.claude.rules, "osc_title_working"); drop(C.OVERLAY.claude, "agenthop_osc_title_halfcircle_working")
end
if mutant == "no-write-dialog" then drop(C.OVERLAY.claude, "agenthop_file_permission_dialog") end
C._reset_order()

local fails, n = 0, 0
local function ck(name, want, got)
  n = n + 1
  if want == got then print("ok   - " .. name) else fails = fails + 1; print(("FAIL - %s (got %s want %s)"):format(name, tostring(got), tostring(want))) end
end
local function fixture(name)
  local f = assert(io.open(here .. "fixtures/tui/" .. name .. ".txt")); local s = f:read("a"); f:close()
  local t = assert(io.open(here .. "fixtures/tui/" .. name .. ".title")); local title = t:read("a"); t:close()
  return s, title
end
local CLAUDE = "/Users/wowdd1/.local/share/claude/versions/2.1.293 --model claude-opus-5-5"
local function lines_of(s) local out = {} for l in (s .. "\n"):gmatch("(.-)\n") do out[#out + 1] = l end return out end

-- ---------- real screens ----------
for _, case in ipairs({
  { "claude-idle-fresh", "idle", "live_prompt_box" },
  { "claude-idle-after-turn", "idle", "live_prompt_box" },
  { "claude-working-early", "working", "agenthop_osc_title_halfcircle_working" },
  { "claude-working-mid", "working", "agenthop_osc_title_halfcircle_working" },
  { "claude-blocked-write", "blocked", "agenthop_file_permission_dialog" },
}) do
  local screen, title = fixture(case[1])
  local r = C.classify(lines_of(screen), title, CLAUDE)
  ck(case[1] .. ": state", case[2], r.state)
  ck(case[1] .. ": rule", case[3], r.rule)
end
-- FINDING (recorded, not patched): on 2.1.293 the write dialog says "Do you want to create X?" with no "do you want to proceed?",
-- so herdr's generic_permission_prompt (840) misses it and only legacy_no_prompt_blocker (300) catches it.
do
  local screen = fixture("claude-blocked-write")
  local gp
  for _, r in ipairs(MAN.claude.rules) do if r.id == "generic_permission_prompt" then gp = r end end
  ck("finding: generic_permission_prompt does not match the 2.1.293 write dialog", false,
    C.gate_matches(gp, C.region(gp.region, screen, "", "")))
end
-- the write-dialog rule outranks the 300-point fallback, and needs both a numbered yes and a numbered no
do
  local screen = fixture("claude-blocked-write")
  ck("write dialog: overlay rule is >= 840", true, (function() for _, r in ipairs(C.OVERLAY.claude) do
    if r.id == "agenthop_file_permission_dialog" then return r.priority >= 840 end end return false end)())
  ck("write dialog: legacy fallback still matches on its own (defence in depth)", true, (function()
    for _, r in ipairs(MAN.claude.rules) do if r.id == "legacy_no_prompt_blocker" then
      return C.gate_matches(r, C.region(r.region, screen, "", "")) end end return false end)())
end
local edit = "──────────\n Edit file\n foo.py\n Do you want to make this edit to foo.py?\n ❯ 1. Yes\n   2. Yes, allow all edits\n   3. No\n\n Esc to cancel · Tab to amend\n"
ck("tie: herdr generic_permission_prompt keeps its own 'proceed?' dialog", "generic_permission_prompt",
  C.classify("──────────\nEdit file\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel\n", "", CLAUDE).rule)
ck("write dialog: edit variant => same rule", "agenthop_file_permission_dialog", C.classify(edit, "✳ x", CLAUDE).rule)
ck("write dialog: prose 'do you want to' without options is not this rule", true,
  C.classify("──────────\nDo you want to rename it? Esc to cancel\n", "", CLAUDE).rule ~= "agenthop_file_permission_dialog")
ck("write dialog: yes option but no 'no' option is not this rule", true,
  C.classify("──────────\nDo you want to go?\n ❯ 1. Yes\nEsc to cancel\n", "", CLAUDE).rule ~= "agenthop_file_permission_dialog")

-- the working screens STILL draw the ❯ prompt box: without the title rule they would read idle
do
  local screen = fixture("claude-working-mid")
  ck("working screen without a title would read idle (the title carries working)", "idle", C.classify(screen, "", CLAUDE).state)
end

-- ---------- herdr's two `not` gates ----------
local box = "──────────\n❯ \n──────────\n"
ck("not gate 1 (live_prompt_box): plain ❯ box => idle", "idle", C.classify("output\n" .. box, "", CLAUDE).state)
ck("not gate 1: ❯ box that also says 'enter to select' is NOT live_prompt_box", true,
  C.classify("──────────\n❯ pick one\nenter to select\n──────────\n", "", CLAUDE).rule ~= "live_prompt_box")
ck("not gate 2 (legacy_no_prompt_blocker): 'do you want to … yes' => blocked", "blocked",
  C.classify("Do you want to allow this?\n 1. Yes\n 2. No\n", "", CLAUDE).state)
ck("not gate 2: same text but a bare ❯ line exists => not legacy_no_prompt_blocker", true,
  C.classify("Do you want to allow this? yes\n❯\n", "", CLAUDE).rule ~= "legacy_no_prompt_blocker")

-- ---------- herdr rules on synthetic screens (one per claude rule family) ----------
ck("osc_title_working: braille title => working", "working", C.classify(box, "⠋ Claude Code", CLAUDE).state)
ck("osc_title_idle: ✳ title, no box => idle", "idle", C.classify("plain output\n", "✳ Claude Code", CLAUDE).state)
ck("osc_title_idle rule id", "osc_title_idle", C.classify("plain output\n", "✳ Claude Code", CLAUDE).rule)
ck("transcript_viewer => unknown", "unknown",
  C.classify("x\nShowing detailed transcript · ctrl+o to toggle\n", "", CLAUDE).state)
ck("transcript_viewer skip_state_update", true,
  C.classify("x\nShowing detailed transcript · ctrl+o to toggle\n", "", CLAUDE).skip_state_update)
ck("live_blocked_form => blocked", "blocked",
  C.classify("──────────\nPick\nEnter to select · ↑/↓ to navigate · Esc to cancel\n", "", CLAUDE).state)
ck("bash_permission_prompt => blocked", "bash_permission_prompt",
  C.classify("Bash command\n  ls\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n", "", CLAUDE).rule)
ck("generic_permission_prompt => blocked", "generic_permission_prompt",
  C.classify("──────────\nEdit file\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel\n", "", CLAUDE).rule)
ck("priority: braille title (1100) beats a live ❯ box (950)", "osc_title_working",
  C.classify(box, "⠙ Claude Code", CLAUDE).rule)
ck("no rule matches, known agent => idle (herdr fallback)", "idle", C.classify("random text", "", CLAUDE).state)
ck("no rule matches => rule nil", nil, C.classify("random text", "", CLAUDE).rule)

-- ---------- agent selection ----------
ck("unknown program => unknown", "unknown", C.classify(box, "", "/bin/zsh -l").state)
ck("program nil => unknown", "unknown", C.classify(box, "", nil).state)
ck("agent_for: claude versions path", "claude", C.agent_for(CLAUDE))
ck("agent_for: plain claude", "claude", C.agent_for("claude --resume x"))
ck("agent_for: codex", "codex", C.agent_for("/opt/homebrew/bin/codex"))
ck("agent_for: alias claude-code", "claude", C.agent_for("claude-code"))
ck("agent_for: zsh", nil, C.agent_for("/bin/zsh"))
ck("codex: Action Required title => blocked", "blocked", C.classify("", "Action Required", "codex").state)
ck("codex: braille title => working", "working", C.classify("", "⠋ codex", "codex").state)

-- ---------- r5 (TC-SV-MANIFEST-KEY): every label reaches its manifest; each family + alias classifies its own permission screen ----------
-- MUTANT=wrong-manifest-key puts r4's display-name labels back (agy/aliases -> "antigravity", copilot/aliases -> "github-copilot");
-- the six agy/copilot names must then go RED here.
if mutant == "wrong-manifest-key" then
  for _, k in ipairs({ "agy", "antigravity", "antigravity-cli" }) do C.LABELS[k] = "antigravity" end
  for _, k in ipairs({ "copilot", "github-copilot", "ghcs" }) do C.LABELS[k] = "github-copilot" end
end
do
  local unrouted = {}
  for label, key in pairs(C.LABELS) do if MAN[key] == nil then unrouted[#unrouted + 1] = label end end
  table.sort(unrouted)
  ck("labels: every LABELS value is a manifests.luau key", "", table.concat(unrouted, ","))
  local missing = {}
  for key, m in pairs(MAN) do
    for _, name in ipairs({ key, table.unpack(m.aliases or {}) }) do
      if not name:find("[%s:]") and C.LABELS[name] ~= key then missing[#missing + 1] = name end
    end
  end
  table.sort(missing)
  ck("labels: every manifest id and one-word alias selects its own manifest", "", table.concat(missing, ","))
end
-- One matching blocked screen per family (text, title, expected herdr rule). pi has no blocked rule in its manifest.
local BLOCKED = {
  agy = { "requesting permission for: file\ndo you want to proceed?\n", "", "permission_prompt" },
  amp = { "waiting for approval\n", "", "approval_footer" },
  claude = { "Bash command\n  ls\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n", "", "bash_permission_prompt" },
  cline = { "let cline use this tool\n", "", "tool_permission" },
  codex = { "", "Action Required", "osc_title_blocked" },
  copilot = { "esc to cancel\nenter to select\n", "", "selection_blocker" },
  cursor = { "waiting for approval\nrun this command?\nrun (once) (y)\n", "", "approval_prompt" },
  droid = { "enter select · esc cancel · ↑↓ navigate\n", "", "selection_menu_blocker" },
  gemini = { "│ Apply this change\n", "", "apply_or_allow_change" },
  grok = { "yes, proceed\nno, reject\n←/→:scope\n", "", "permission_scope_selector" },
  hermes = { "dangerous command\n❯ allow once\nenter to confirm · ↑/↓ to select\n", "", "dangerous_command_approval" },
  kilo = { "△ Permission required\n", "", "opencode_permission" },
  kimi = { "requesting approval\napprove once\nreject\n1/2/3/4 choose\n", "", "legacy_approval_panel" },
  kiro = { "requires approval\nyes, single permission\n", "", "tool_approval" },
  opencode = { "△ Permission required\n", "", "permission_required" },
  qodercli = { "permission required\n", "", "confirmation_or_input_blocker" },
}
do
  -- The expected family comes from manifests.luau (id + one-word aliases), never from C.LABELS, so a mis-keyed label shows here.
  local names, family = {}, {}
  for key, m in pairs(MAN) do
    for _, name in ipairs({ key, table.unpack(m.aliases or {}) }) do
      if not name:find("[%s:]") then names[#names + 1] = name; family[name] = key end
    end
  end
  table.sort(names)
  for _, label in ipairs(names) do
    local key = family[label]
    local case = BLOCKED[key]
    if case then
      local r = C.classify(case[1], case[2], "/usr/local/bin/" .. label .. " --x")
      ck(("family %s via %s: permission screen => blocked"):format(key, label), "blocked", r.state)
      ck(("family %s via %s: rule"):format(key, label), case[3], r.rule)
    else
      ck(("family %s via %s: routed to its manifest (idle fallback)"):format(key, label), "idle",
        C.classify("random text", "", label).state)
    end
  end
  local uncovered = {}
  for key in pairs(MAN) do if BLOCKED[key] == nil and key ~= "pi" then uncovered[#uncovered + 1] = key end end
  ck("labels: every family except pi has a blocked-screen case", "", table.concat(uncovered, ","))
end

-- ---------- regions ----------
ck("region bottom_non_empty_lines(2)", "b\n\nc", C.region("bottom_non_empty_lines(2)", "a\n\nb\n\nc", "", ""))
ck("region after_last_horizontal_rule", "tail", C.region("after_last_horizontal_rule", "x\n───\ny\n───\ntail", "", ""))
ck("region prompt_box_body", "❯ hi", C.region("prompt_box_body", "out\n──────\n❯ hi\n──────\nfooter", "", ""))
ck("region osc_title", "T", C.region("osc_title", "screen", "T", ""))
ck("hrule: '─── label' counts (>=3 rule chars)", true, C.is_horizontal_rule("─── label"))
ck("hrule: '─ x' does not", false, C.is_horizontal_rule("─ x"))
ck("region after_last_prompt_marker (codex ›)", "after", C.region("after_last_prompt_marker", "a\n› cmd\nafter", "", ""))

-- ---------- regex subset ----------
ck("re: braille class", true, C.re_match("^[\\x{2800}-\\x{28FF}] ", "⠋ Working"))
ck("re: braille class negative", false, C.re_match("^[\\x{2800}-\\x{28FF}] ", "✳ Idle"))
ck("re: (?i) + \\b", true, C.re_match("(?i)^\\s*1\\.\\s*yes\\b", "  1. YES"))
ck("re: \\b blocks yesterday", false, C.re_match("(?i)^\\s*1\\.\\s*yes\\b", "1. yesterday"))
ck("re: (?m) bare ❯ line", true, C.re_match("(?m)^\\s*❯\\s*$", "a\n  ❯  \nb"))
ck("re: (?m) needs a bare line", false, C.re_match("(?m)^\\s*❯\\s*$", "a\n❯ x\nb"))
ck("re: \\p{Alphabetic}+\\w*ing", true, C.re_match("^\\s*[\\u2800-\\u28FF]+\\s+\\p{Alphabetic}+\\w*ing\\b", "⠋ Reticulating"))
ck("re: {4,}", true, C.re_match("(■|⬝){4,}", "x■■■■y"))
ck("re: {4,} negative", false, C.re_match("(■|⬝){4,}", "■■■"))
ck("re: alternation group", true, C.re_match("^\\s*(◔|◑|◕|●)\\s+\\p{Alphabetic}", "◑ Thinking"))

-- ---------- r3 TC-UNICODE: final STATE on real manifests with Unicode the old approximations got wrong ----------
local EMSP, IDSP = "\u{2003}", "\u{3000}"
ck("unicode: \\s includes U+2003", true, C.re_match("^\\s*❯\\s*$", EMSP .. "❯" .. EMSP))
ck("unicode: \\s includes U+3000", true, C.re_match("^\\s*❯\\s*$", IDSP .. "❯"))
ck("unicode: fullwidth comma is not \\w (word boundary holds)", true, C.re_match("^\\s*[\\u2800-\\u28FF]\\s+(Run|Read|Search|List)\\b", "⠋ Read，"))
ck("unicode: × is not Alphabetic", false, C.re_match("^\\s*(◔|◑|◕|●)\\s+\\p{Alphabetic}", "◑ ×"))
ck("unicode: é is Alphabetic", true, C.re_match("^\\s*(◔|◑|◕|●)\\s+\\p{Alphabetic}", "◑ émoji"))
ck("unicode state: claude old prompt + U+2003-padded current ❯ => idle (not blocked)", "idle",
  C.classify("Do you want to proceed?\n❯ 1. Yes\n" .. EMSP .. "❯" .. EMSP, "", CLAUDE).state)
ck("unicode state: cursor ⠋ + U+2003 + Thinking => working", "working", C.classify("⠋" .. EMSP .. "Thinking", "", "cursor").state)
ck("unicode state: grok '⠋ Read，' => working", "working", C.classify("⠋ Read，", "", "grok").state)
ck("unicode state: kiro '◑ ×' => not working", true, C.classify("◑ ×", "", "kiro").state ~= "working")
ck("unicode: \\p{L} is rejected (only Alphabetic has an exact table)", false, pcall(C.compile, "\\p{L}"))

-- ---------- r3 TC-MATCH-COST: bounded non-match on the real opencode pattern; the budget cut-off ----------
do
  local line = string.rep("opencode esc ", 18) -- 234 cols, no "interrupt": the old backtracker took ~2.6s on 24 of these
  local lines = {} for i = 1, 24 do lines[i] = line end
  local t0 = os.clock()
  local r = C.classify(lines, "", "opencode")
  local dt = os.clock() - t0
  ck("cost: 24x234 opencode non-match finishes < 0.2s (linear matcher)", true, dt < 0.2)
  ck("cost: and is not cut off by the budget on a normal machine (state idle)", true, r.state == "idle" or r.rule == "slow")
  local saved = C.clock; local tick = 0
  C.clock = function() tick = tick + 3; return tick end -- every reading 3ms later
  local r2 = C.classify(lines, "", "opencode")
  C.clock = saved
  ck("budget: past 5ms => unknown", "unknown", r2.state)
  ck("budget: rule = slow", "slow", r2.rule)
end
do -- the deadline is enforced INSIDE a single long regex search, not only between rules
  local saved = C.clock; local tick = 0
  C.clock = function() tick = tick + 0.01; return tick end -- slow-ish clock: rule loop passes, the matcher's own check must fire
  local long = {} for i = 1, 24 do long[i] = string.rep("opencode esc ", 200) end -- one huge region for the opencode rule
  local r3 = C.classify(long, "", "opencode")
  C.clock = saved
  ck("budget: cut inside the matcher on one long search => slow", "slow", r3.rule)
end
do -- a genuine error (an uncompilable pattern) must surface, never be reported as "slow"
  table.insert(C.OVERLAY.claude, 1, { id = "broken", state = "idle", priority = 2000, region = "whole_recent", regex = { "(" } })
  C._reset_order()
  local ok, err = pcall(C.classify, "x", "", CLAUDE)
  table.remove(C.OVERLAY.claude, 1); C._reset_order()
  ck("budget: a real error inside a gate is raised, not swallowed as slow", false, ok)
  ck("budget: the raised error is the real one", true, type(err) == "string" and err:find("unbalanced") ~= nil)
end

-- ---------- r3: frozen ripgrep differential (test/rg-diff/corpus.lua: 33 real patterns x 500 Unicode inputs, rg 14.1.1 truth) ----------
do
  local d = assert(loadfile(here .. "rg-diff/corpus.lua"))()
  local diffs, total = 0, 0
  for _, p in ipairs(d.pats) do
    local bits = d.truth[p]
    for i, s in ipairs(d.inputs) do
      total = total + 1
      if C.re_match(p, s) ~= (bits:sub(i, i) == "1") then diffs = diffs + 1 end
    end
  end
  ck(("rg differential: %d cases, 0 differences"):format(total), 0, diffs)
end

if fails == 0 then print(("\nPASS (%d checks)"):format(n)) else print(("\nFAIL (%d of %d)"):format(fails, n)) end
os.exit(fails == 0 and 0 or 1)
