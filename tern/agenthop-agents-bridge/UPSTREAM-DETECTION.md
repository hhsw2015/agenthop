# herdr upstream agent-state detection — reference for the Luau port (#1115 T1)

Source: herdr upstream `~/Dev/vendor/herdr-upstream` @ 143bf5f (2026-10-16, Apache-2.0). Paths below are relative to that checkout.
This is the spec the port in `classify.luau` / `screen.luau` follows; every deviation is listed in §7.

## 1. Manifests (`src/detect/manifest.rs`)
- 22 bundled `src/detect/manifests/*.toml`; unknown keys are parse errors (`deny_unknown_fields`).
- Top level: `id`, `version`, `min_engine_version` (u32), `updated_at` (ignored), `aliases`, `rules` (1..128).
- Engine: `MANIFEST_ENGINE_VERSION = 3` (`manifest_update.rs:15`). Upstream enforces `min_engine_version > 3 ⇒ reject` only for
  remote manifests; `top_non_empty_lines(N)` is invalid when `min_engine_version` is present and `< 3` (`manifest.rs:947-956`).
- Rule: `id`, `state` (idle|working|blocked|unknown; missing ⇒ unknown), `priority` (i32, default 0), `region` (default
  `whole_recent`), `visible_idle|visible_blocker|visible_working` (each effective only when `state` is that state),
  `skip_state_update` (only with `state=unknown`), gates `all/any/not/contains/regex/line_regex` (recursive).

## 2. Regions (`region()`, `manifest.rs:1276-1314`)
Lines = `str::lines()`; "non-empty" = not blank after Unicode trim.
- `whole_recent`: the detection text (one screen of rows ending at the cursor / last content; trailing blank rows dropped).
- `osc_title` / `osc_progress`: the retained OSC 0/2 title / OSC 9 payload (never the screen).
- `bottom_lines(N)`: last N lines. `bottom_non_empty_lines(N)`: from the N-th non-empty line counted from the bottom to the end
  (blank lines in between included); fewer than N ⇒ from the first non-empty line; none or N=0 ⇒ "".
- `top_non_empty_lines(N)` (engine 3): from byte 0 through the end of the N-th non-empty line from the top, incl. its newline;
  N canonical (no leading 0, 1..65535).
- Horizontal rule: trimmed line starts with ≥1 `─`; a rule if nothing follows the run, or the run is ≥3 chars.
- `prompt_box_body`: top border = the 2nd rule counted from the bottom; body = lines after it up to the next rule (excl.) or EOF;
  <2 rules ⇒ "". `above_prompt_box`, `last_non_empty_above_prompt_box`, `after_last_horizontal_rule` as named.
- Codex prompt helpers: prompt line = `"›"` or starts with `"› "` (column 0, not trimmed); block marker = line starting with
  `•`/`■`/`✗`/`✓`; current prompt = last prompt line with no block marker after it. Regions `after_last_prompt_marker`,
  `before_current_prompt_marker`, `whole_recent_without_current_prompt_marker`, `current_prompt_block_marker`,
  `after_current_prompt_block_marker`.

## 3. Matching (`compiled_gate_matches`, `:1227-1274`; selection `:431-517`)
- All clauses AND: `contains` (case-INSENSITIVE, Unicode lowercase), `regex` (case-sensitive unless `(?i)`, unanchored, whole
  region), `line_regex` (each regex matches some line), `all`, `any` (empty ⇒ true), `not` (any match ⇒ fail).
- Winner = highest priority; ties ⇒ the rule declared first in the file.
- No match, known agent ⇒ **idle** (`default_known_agent_idle_fallback`); unidentified agent ⇒ unknown.

## 4. Detection state machine (`src/pane/agent_detection.rs`, loops in `src/pane.rs`)
Constants: `AGENT_PENDING_IDLE_RECHECK = 100ms`, `AGENT_PENDING_IDLE_CONFIRMATIONS = 3`, `AGENT_PENDING_IDLE_CAP = 700ms`,
`STABLE_VISIBLE_SIGNAL_REFRESH = 800ms`, `AGENT_STARTUP_GRACE_WINDOW = 3s`, tick 300ms identified / 500ms unidentified.
- Agent appears/changes ⇒ state Unknown, flags cleared, grace until now+3s; no scanning during grace, and the tick on which the grace
  expires is skipped too.
- `skip_state_update` match ⇒ no publish (pending idle cleared).
- Process exited ⇒ publish Idle (visible_idle) immediately.
- Working → plain Idle (no visible_idle/visible_blocker): HOLD; the first reading starts the clock; release (publish Idle) when
  `now - started ≥ 700ms` or after 3 further confirmations (i.e. the 4th consecutive idle reading). Any non-qualifying reading
  (working, visible_idle, skip) clears the pending hold. Working → Idle with visible_idle ⇒ immediate.
- Anything → Working ⇒ immediate. Anything → Blocked ⇒ immediate when state or visible_blocker changed. A continuing visible
  blocker is re-published every ≥800ms.
- **PTY bytes are NOT a working signal at this commit**; they only bump a content counter used to SKIP a screen read when the state
  is Idle (or Unknown for codex) and nothing changed. Working/Blocked are re-read every tick.

## 5. Agent specifics
- Codex (`manifests/codex.toml`): `osc_title_blocked` (title contains "Action Required", 1100, visible_blocker), `osc_title_working`
  (braille spinner token, 1050), `transcript_viewer` (skip, 1000), `trust_directory` (`top_non_empty_lines(20)`, 950),
  `startup_update`, `live_strong_blocker`, `weak_blocker`, `screen_working_fallback` (`before_current_prompt_marker`, 500),
  `osc_title_idle` (any non-blank title not spinner/Action Required, 100, visible_idle). Codex turn hooks were removed upstream.
- Claude (`manifests/claude.toml`): `osc_title_working` (braille or ◐◑◒◓ + space, 1100), `live_prompt_box` (`prompt_box_body`
  line `^\s*❯`, 950, visible_idle), screen working 965-975, blocked dialogs 980/850/840 (visible_blocker), `osc_title_idle` (✳, 250),
  `osc_progress_idle` (`^4;0`, 250), `legacy_no_prompt_blocker` 300.
- Claude/Codex hooks report session identity only, never state.

## 6. Prompt submit and wait (for T2)
- `submit_agent_prompt` (`src/app/api/agents.rs:209-269`): refuse when blocked / not ready; text as bracketed paste
  (`ESC[200~…ESC[201~`) if the pane has bracketed paste on; then **300ms** (`AGENT_PROMPT_SUBMIT_DELAY`) after the text write
  completes; then Enter.
- `agent wait --until <idle|working|blocked|done|unknown>…` (default idle,done,blocked; unknown only if asked), 100ms event polling,
  optional timeout ⇒ one final probe then `timeout`. `prompt --wait`: must see working/blocked within 5000ms
  (`AGENT_PROMPT_EFFECT_TIMEOUT_MS`) else `agent_prompt_stalled`.

## 7. Deviations in the Tern port (and why)
- **Sampling cadence**: herdr re-reads each pane every 100-300ms; the bridge reads ONE pane per `screen` command (every ~5s from
  the sweep, round-robin), so a pane is sampled every several seconds. The hold logic is kept with herdr's own constants on Tern's
  monotonic clock; at this cadence every second reading is already ≥700ms later, so Working→plain Idle publishes on the second
  consecutive idle reading (the 700ms cap), exactly as herdr would for samples that far apart.
- **No content-counter read skip**: the bridge cannot observe PTY bytes from the plugin VM; it always reads (one pane per call keeps
  the cost bounded). Upstream does not use bytes as a working signal either, so the state result is unaffected.
- **Engine gate applied to every manifest** (upstream: remote only); harmless since bundled ≤3.
- **osc_title = Tern's pane title**; osc_progress is not exposed to the plugin and is passed as nil (rules on it never match).
