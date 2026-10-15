-- #1041 classify fixture. Loads the PRODUCTION classify.luau + generated manifests.luau (one source, no mirror copy), and feeds it
-- REAL Claude Code 2.1.293 TUI screens captured from a Tern pane on 2026-10-15 (test/fixtures/tui/*.txt + .title).
-- Covers: idle / working / blocked / unknown on real screens, the two `not` gates of herdr's claude manifest, region functions,
-- the regex subset (incl. a differential corpus), agent selection, priority order. Mutant check: run with MUTANT=no-prompt-box or
-- MUTANT=no-title-working — the corresponding rule is removed from the loaded manifest (production code untouched) and the
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
require = function(name) if name == "./manifests" then return MAN end return real_require(name) end
local C = assert(loadfile(root .. "classify.luau"))()
if mutant == "no-prompt-box" then drop(MAN.claude.rules, "live_prompt_box") end
if mutant == "no-title-working" then
  drop(MAN.claude.rules, "osc_title_working"); C.OVERLAY.claude = {}
end

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
  { "claude-blocked-write", "blocked", "legacy_no_prompt_blocker" },
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

if fails == 0 then print(("\nPASS (%d checks)"):format(n)) else print(("\nFAIL (%d of %d)"):format(fails, n)) end
os.exit(fails == 0 and 0 or 1)
