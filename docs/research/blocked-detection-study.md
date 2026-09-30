# blocked-detection study — reliable "needs user input" for agenthop

Design research for **agenthop** (decentralized cross-tool session bus; spawns agent
CLIs into native Ghostty windows arranged by OmniWM; does **NOT** own PTYs). Question:
how to reliably detect `blocked` (needs user input) vs `working` vs `idle` without
owning the PTY. Companion to `herdr-study.md` in this dir.

Evidence tiers: **[verified-local]** = tested on this machine (macOS 27.0 / build 26A428,
Ghostty `f9e827093`, Claude Code 2.1.283, codex-cli 0.159.2, opencode 1.18.33);
**[web]** = cited issue/PR/doc.

---

## TL;DR / recommendation

**The landscape changed since herdr.** Two independent facts, both now confirmed:

1. **All three target CLIs can now self-report `blocked` via first-party hooks/events.**
   herdr's core conclusion ("Claude Code has NO reliable per-turn state hook, so we
   scrape") is **outdated**. Claude Code 2.1.283 has `Notification` (matcher
   `permission_prompt`) + `PermissionRequest` hooks; Codex 0.159.2 has a `hooks.json`
   `PermissionRequest` hook; OpenCode 1.18.33 emits `permission.asked` on its SSE
   stream. Each fires exactly when the agent pauses for approval.

2. **Ghostty DOES expose its live terminal text cross-process via macOS Accessibility.**
   Confirmed by a verified upstream bug report AND by a local probe I ran here: every
   Ghostty surface is an `AXTextArea` whose `AXValue` returns the live screen+scrollback
   to any AX-trusted process. So the herdr-style "read the screen and regex the
   approval-UI shape" is achievable **without owning the PTY** — as a pure sidecar.

**Recommendation: self-report first, AX-sidecar as the safety net, skip pty-tee.**

- **Primary (`blocked`/`working`/`idle` state machine): self-report via hooks/events.**
  Reliable, event-driven, zero regex treadmill. Build the hook adapters for CC / Codex /
  OpenCode first (agenthop already ships a hook/report path — extend it to carry
  `blocked`).
- **Safety net + fallback: Path (A), the macOS-AX sidecar.** Reuse agenthop's existing
  AX/OmniWM permission. Read the spawned window's `AXTextArea` `AXValue`, regex the tail
  for the approval shape. Two jobs: (i) cover any CLI with no usable hook; (ii) herdr's
  "**visible blocker overrides a hook-reported `working`**" safety override — a
  screen-visible "needs you" always wins. This is far cheaper than Path (B) and needs no
  new process per window.
- **Skip Path (B) (pty-tee + headless VT).** It is viable but strictly more moving parts
  (a `script` wrapper per launch + fifo + a headless VT + the *same* regex) than (A), and
  buys nothing on Ghostty since (A) already yields the screen text. Keep (B) in the back
  pocket only for a future non-Ghostty terminal that exposes no AX text.

What to build first: (1) a `blocked`-capable hook adapter per CLI; (2) a small AX poller
sidecar (Swift/ObjC or JS-via-FFI) that maps `pid/window -> AXTextArea -> tail(AXValue)`
and applies one approval-shape regex, used only as override/fallback.

---

## Q1. Does Ghostty expose terminal text via macOS Accessibility? — YES (highest value)

**Answer: Yes, upstream Ghostty on macOS presents each terminal surface as an
`AXTextArea` and returns its text to another (AX-trusted) process via `AXValue`,
`AXStringForRange`, `AXNumberOfCharacters`. Path (A) is viable.**

### [verified-local] Direct probe on this machine
I compiled a tiny Swift AX client (`/tmp/axprobe.swift`) that attaches to the running
Ghostty (`com.mitchellh.ghostty`, pid 2518) via `AXUIElementCreateApplication` and walks
the window tree. Result:

```
AXIsProcessTrusted: true
windows: 3
  AXTextArea: AXValue.len=1828  AXNumberOfChars=1828  AXVisibleCharacterRange=loc=0 len=1828
    tail120: ... 3m 35s · ↓ 89.7k tokens
  AXTextArea: AXValue.len=1176  ...  tail120: ... 828K window · 01a0ead5-… ⚠ 2 warnings · f2 to view
  AXTextArea: AXValue.len=52    ...  tail120: Last login: Wed Sep 30 ... ~/work ❯
AXTextArea count found: 3
```

Every Ghostty surface exposes an `AXTextArea`; `AXValue` returned the **live** visible
text of my own sessions, read from a separate process. This is exactly the signal a
blocked-detector needs. (Any AX-based approach requires the sidecar process to be
Accessibility-trusted — it was here, because this environment already grants AX for
OmniWM/omniwmctl window management.)

### [web] Upstream confirmation, and the one real limitation
- Discussion **#9930** (grishy, 2025-12-16, tested Ghostty 1.2.3 / macOS 26.1;
  mitchellh replied same day, promoted to issue **#9932**):
  `AXRole -> AXTextArea`; `AXValue` readable cross-process ("709778 chars in 4.33ms");
  `AXNumberOfCharacters` and `AXStringForRange` work.
  **Broken:** `AXVisibleCharacterRange` returns the *full buffer* (loc=0, whole length)
  instead of only the visible viewport. **Unimplemented:** `AXRangeForPosition`,
  `AXBoundsForRange`.
  https://github.com/ghostty-org/ghostty/discussions/9930
- Open PRs improving this (not merged as of Apr 2026): **#11196** adds
  `AccessibilityContext` (full text + byte offsets delimiting the visible viewport) and
  `accessibilityRange(forLine:)`, and fixes `accessibilityVisibleCharacterRange()` to
  return the viewport; **#10992** adds more AX methods + a probe helper tool.
  https://github.com/ghostty-org/ghostty/pull/11196
- Background: Discussion **#2351** — historically "accessibility support is basically
  nonexistent" (GPU rendering, no native widget tree), macOS chosen as the primary AX
  target; work now active.
  https://github.com/ghostty-org/ghostty/discussions/2351

### Practical implication for agenthop
- **`AXValue` gives the whole buffer (scrollback + screen), not just the viewport**
  (because `AXVisibleCharacterRange` is unreliable). For blocked detection this is fine:
  the approval UI is always at the **bottom of the viewport**, so read `AXValue` and
  regex the **tail** (last ~40 non-empty lines). Do not depend on
  `AXVisibleCharacterRange` until #11196 lands.
- **No reliable cursor/coords** via AX (`AXRangeForPosition`/`AXBoundsForRange` absent) —
  irrelevant for blocked detection, which matches the *shape* of the prompt, not caret
  position.
- **Watch out for the fork trap.** The two "Ghostty has no AXTextArea" hits are about
  **cmux**, a *libghostty-embedding fork*, not the real app: cmux **#4953** ("no text
  role, no AXValue") and **#9563** (data present as `AXTextArea` but focus never descends
  — and it explicitly notes selection-capture tools *work* against real
  iTerm2/Terminal/**Ghostty**/kitty/WezTerm). These describe cmux's own AX glue, not
  ghostty.org's app.
  https://github.com/manaflow-ai/cmux/issues/4953 ·
  https://github.com/manaflow-ai/cmux/issues/9563

---

## Q2. The 4 terminal-control projects — attach vs spawn, VT query, sidecar fit

**None of the four attaches to an existing terminal; all four spawn their own PTY.** So
none can "read Ghostty's screen" as-is. They are only relevant to Path (B) as the
VT-emulation building block fed a tee'd byte stream — and for that, only
`terminal-control` cleanly renders a standalone ANSI stream, at heavy cost. [all web]

| project | attach or spawn | VT / screen-query (grid+cursor) | lang / runtime | license | usable as Path-(B) sidecar? |
|---|---|---|---|---|---|
| **open-mcp-ai/termcp** | spawns own PTY (local or SSH); no attach | No structured grid — exposes **raw output slices** (`shell_output` tail/offset); web UI renders client-side | Go, single binary (no CGO); ~37★ | MIT | Weak. Long-running HTTP service, no stdio; gives bytes not a screen. You'd still bolt on your own VT. |
| **kitlangton/terminal-control** | spawns own PTY; **can render piped/existing ANSI streams with no process** | **Yes** — statically-linked **Ghostty core** VT; `show --format json/svg/png/ansi`, `wait`-for-text, `logs`, `status`; TS wrapper `@kitlangton/terminal-control` ships prebuilt binaries | Rust (+TS wrapper); build needs Zig 0.15.2; macOS/Linux; ~425★ | MIT (check THIRD_PARTY) | **Best of the four, but heavy.** The "render existing ANSI stream, no process" mode = exactly a VT for a tee. Cost: Ghostty core + Zig toolchain, macOS/Linux only. Overkill vs `@xterm/headless`. |
| **onesuper/tui-use** | spawns own PTY (daemon) | **Yes** — headless **xterm** emulator; `snapshot` (text + `highlights` inverse-video spans, `title`, `is_fullscreen`); cursor not documented | TS / Node (native PTY binding); ~260★ | MIT | Possible, but it wraps the same xterm.js you'd use directly, plus a daemon + PTY you don't want. Take `@xterm/headless` instead. |
| **yanggggjie/terminal-tool-for-agents** | spawns own PTY (`node-pty`) | Screen reads (`obs screen now/stable/scroll`); grid+cursor unconfirmed | TS / Node 22–26; fork of tui-use; ~7★ | MIT | No. Young single-maintainer fork of tui-use; no advantage. |

**Verdict:** for Path (B), skip all four and use `@xterm/headless` directly (Q3). The
projects confirm the design space but each bundles PTY-spawn + process mgmt that
conflicts with agenthop's "Ghostty owns the PTY" rule.

---

## Q3. Headless VT for Path (B) in Node/Bun — `@xterm/headless` is the lean choice

- **`@xterm/headless` v6.0.0**, MIT, published 2026-08-30, **unpacked ~1.96 MB, pure JS,
  no native deps** — runs under Node and Bun (agenthop's runtime). [verified-local: npm
  metadata] https://www.npmjs.com/package/@xterm/headless
- API turns a raw ANSI byte stream into a queryable grid:
  `term.write(bytesOrString)` → `term.buffer.active.getLine(y).translateToString()`,
  `term.buffer.active.cursorX/cursorY`, `term.cols/term.rows`; pair with the serialize
  addon to snapshot/restore. It parses VT/ANSI (incl. alt-screen) and maintains buffer
  state with no DOM.
- Weight verdict: acceptable for a lean bus (single JS dep, no compiler). Contrast with
  `node-pty` (native build) — **not needed for a tee sidecar**, because `script` (Q4)
  already provides the PTY; agenthop only needs the *parser*.

**But note:** this only matters if you do Path (B). Given Q1, Path (A) already yields the
screen text without any VT emulator at all, so `@xterm/headless` is a fallback dependency,
not a day-one one.

---

## Q4. `script` on macOS for a pty-tee (Path B)

- [verified-local] `/usr/bin/script` is **BSD script** (not util-linux). Man page
  confirms flags:
  - `-q` quiet (omit start/stop/status banners),
  - `-F` **flush after each write** (lets another process `cat`/tail a fifo live),
  - `-k` also log keystrokes, `-a` append, `-e` child exit status is script's exit.
- **Invocation to run a command in a PTY, log all output, stay interactive:**
  ```
  script -q -F <logfile> <cmd> [args...]
  ```
  Inside a Ghostty window agenthop would launch the agent as
  `script -q -F /path/live.log <agent-cli> …`. `script` creates an **inner** PTY for the
  child (so the agent stays interactive + colored) and tees everything to the log while
  Ghostty renders the passthrough. Use a **named pipe** (`mkfifo`) as the logfile +
  `-F` for a live stream instead of an ever-growing file.
- **Gotchas:**
  1. **Raw ANSI in the log** — it contains cursor moves, alt-screen enter/leave, redraws.
     You **cannot** grep it directly; you must reconstruct the screen with a VT
     (`@xterm/headless`) and match on the rendered grid. This is the whole reason (B) is
     heavier than (A).
  2. **Window size / SIGWINCH:** the child sees `script`'s inner-PTY size; verify resize
     propagation when the Ghostty window is resized (BSD `script` forwards size, but
     test — a wrong size makes a TUI re-wrap and can break tail-regex assumptions).
  3. **Unbounded growth** if you use a real file; prefer fifo + reader, or rotate.
  4. **Double PTY layer** can subtly change how some TUIs render vs. running directly in
     Ghostty; validate each CLI.

---

## Q5. Self-report baseline — what each CLI exposes (this UPDATES herdr)

herdr concluded Claude Code had no per-turn state hook and scraped it. **On current
versions that is no longer true — all three can self-report `blocked`.** [versions
verified-local]

### Claude Code 2.1.283 [web: code.claude.com/docs/en/hooks-guide]
- **`Notification` hook** — fires when Claude needs attention. Matchers include
  **`permission_prompt`** (needs approval = **blocked**), **`idle_prompt`** (waiting =
  **idle**), plus **`agent_needs_input`** and **`agent_completed`** (≥ v2.1.198) and
  `quota_auto_resume_*` (≥ v2.1.234). Installed 2.1.283 has all of them. Caveat:
  Notification is **side-effects-only** (can't block, `systemMessage` discarded) — which
  is perfect for a *reporter* that just posts state to the bus.
- **`PermissionRequest` hook** — fires exactly when a permission dialog would show
  (**blocked** signal) and can additionally auto-approve/deny (control, if ever wanted).
- **`Stop` / `SubagentStop`** → turn end (**idle/done**). **`UserPromptSubmit`** → turn
  start (**working**). **`SessionStart`** → session id (for resume, as herdr already uses).
- Net: map `UserPromptSubmit→working`, `Notification[permission_prompt]` /
  `PermissionRequest→blocked`, `Stop→idle/done`. **No scraping required for the state
  machine.**

### Codex 0.159.2 [web: openai/codex issues #11808, #3052; hooks docs]
- **External `notify` program:** fires on **`agent-turn-complete` only** (→ idle/done).
  It does **NOT** fire on approval (issue #11808 open). Gotcha: payload arrives as the
  **last argv arg**, `stdin` is null (opposite of Claude Code).
- **`~/.codex/hooks.json` hooks engine (newer):** **`PermissionRequest`** fires *only*
  when Codex is about to ask for approval (= **blocked**), **`Stop`** at turn end. This
  is the reliable blocked path for Codex. Gotcha: without `"async": true`, Codex **waits
  for the hook** (approval UI is delayed until the hook returns) — set async.
- `[tui].notifications = ["approval-requested", ...]` exists but that's a TUI banner/OSC9,
  not an external hook — not usable as a programmatic signal.

### OpenCode 1.18.33 [web: opencode.ai/docs/plugins]
- **Richest surface.** `opencode serve` exposes an SSE stream at `/event` (and
  `/global/event`) with 32+ event types, same vocabulary as plugin hooks.
- Map: **`session.idle`** → idle/done; **`permission.asked`** → **blocked**;
  **`permission.replied`** / **`tool.execute.before|after`** / `message.part.updated` →
  working. Plugins can also `permission.ask` to auto allow/deny (one report notes it
  isn't always invoked — treat SSE `permission.asked` as the source of truth).

### Self-report verdict
`blocked` is now first-class on **all three** via first-party hooks/events. The
regex-manifest scraping treadmill herdr maintains is no longer the primary mechanism —
demote it to Path (A) fallback + safety-override.

---

## Recommended staging for agenthop (no PTY ownership, low maintenance)

1. **Stage 1 — self-report adapters (do first).** Extend agenthop's existing hook/report
   channel to carry a `blocked` state, and ship per-CLI adapters:
   - Claude Code: `UserPromptSubmit→working`, `Notification[permission_prompt]` +
     `PermissionRequest→blocked`, `Stop→idle`.
   - Codex: `hooks.json` `PermissionRequest→blocked` (async), `Stop→idle`, `notify`
     turn-complete→idle as backup.
   - OpenCode: subscribe to `/event` SSE; `permission.asked→blocked`,
     `session.idle→idle`, tool/message events→working.
   Adopt herdr's portable primitives regardless: **monotonic `--seq` per source**,
   `idle` vs `done` (seen-bit), and an event-driven `wait --until <state>`.
2. **Stage 2 — AX sidecar (Path A) as safety net.** One lightweight process
   (Swift/ObjC, or JS via an AX FFI): for each agenthop-spawned Ghostty surface, resolve
   `pid → AXTextArea`, poll `tail(AXValue)` (~250–500 ms only for surfaces reported
   `working`), apply a **single** approval-shape regex. Use it for (a) CLIs without a
   usable hook and (b) the **"visible blocker overrides hook `working`"** override. Reuse
   the existing AX/OmniWM trust — no new permission. Borrow herdr's reliability guards
   (idle debounce ~3× within 700 ms; startup grace).
3. **Stage 3 — Path (B) only if forced.** If agenthop ever targets a terminal that
   exposes no AX text, wrap the launch in `script -q -F <fifo> …` and feed the fifo to
   `@xterm/headless`, then reuse the same regex. Do not build this for Ghostty.

**Maintenance stance:** keep exactly ONE approval-shape regex per CLI (the only brittle
bit), fed by whichever of (A)/(B) is active; treat self-report as authoritative and the
screen-read purely as override/fallback. This avoids herdr's full per-region manifest
engine while keeping the one safety property that matters — a screen-visible "needs you"
can never be masked by a stale `working`.

---

### Sources
- Ghostty AX: discussions [#9930](https://github.com/ghostty-org/ghostty/discussions/9930),
  [#2351](https://github.com/ghostty-org/ghostty/discussions/2351);
  PRs [#11196](https://github.com/ghostty-org/ghostty/pull/11196), #10992; issue #9932.
- Local probe: `/tmp/axprobe.swift` (this machine, Ghostty `f9e827093`, macOS 27.0).
- cmux (fork, contrast): [#4953](https://github.com/manaflow-ai/cmux/issues/4953),
  [#9563](https://github.com/manaflow-ai/cmux/issues/9563).
- Projects: [termcp](https://github.com/open-mcp-ai/termcp),
  [terminal-control](https://github.com/kitlangton/terminal-control),
  [tui-use](https://github.com/onesuper/tui-use),
  [terminal-tool-for-agents](https://github.com/yanggggjie/terminal-tool-for-agents).
- VT: [@xterm/headless](https://www.npmjs.com/package/@xterm/headless) v6.0.0.
- `script(1)` BSD (macOS `/usr/bin/script`, verified man page).
- Hooks/events: [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide);
  Codex [#11808](https://github.com/openai/codex/issues/11808),
  [#3052](https://github.com/openai/codex/issues/3052);
  [OpenCode plugins](https://opencode.ai/docs/plugins/).
