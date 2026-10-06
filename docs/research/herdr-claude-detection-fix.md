# herdr ③ — claude state not observable: root cause + fix (S14 herdr-args-fix, 90b58f9c, 2026-10-06)

**Symptom (field):** after migrating the swarm onto the Herdr workbench, every claude member shows
`agent_status: unknown` forever and is absent from `agent list`; `agent wait --until blocked` is therefore unusable
for claude members (the stall sentinel's main signal is dead). codex members work normally. The claude integration
hook is installed (SessionStart fires), and `pane get` shows `agent_session` registered — but no state.

**Root cause: process identification, NOT the custom TUI.**

herdr identifies which agent runs in a pane from the **foreground process's argv0 basename**, then classifies state
from the screen. On macOS it reads argv0 via `sysctl(KERN_PROCARGS2)` and takes `basename(argv0)`, matching it in a
hardcoded table (`identify_agent` in `src/detect/mod.rs`: `"claude"|"claude-code" => Claude`, `"codex" => Codex`, …).

The user's claude launches via `claude()` → `~/bin/claude-with-override` → `find_real_binary` which `exec`s the
**version-named** binary directly: `~/.local/share/claude/versions/2.1.283.pristine`. So the live process is:

```
/Users/wowdd1/.local/share/claude/versions/2.1.283.pristine --model fable[1m] --dangerously-skip-permissions …
```

`basename("…/2.1.283.pristine") = "2.1.283.pristine"` → not `"claude"`; the path-token / resolved-path / basename
fallbacks (`argv0_agent_name`, `resolved_agent_name_from_path_token`, `agent_name_from_basename`) all still resolve
to `"2.1.283.pristine"` → `identify_agent` returns `None` → herdr **never promotes the pane to a claude agent** →
not listed, `agent_status` stays `unknown`.

codex works only because its binary is literally named `codex`.

Two corollaries, both confirmed in herdr source (`/Users/wowdd1/Dev/herdr`):
- `report_agent` (the lifecycle-state socket method the integration hook could call) **cannot rescue it**: `agent list`
  membership is gated by the classifier. `report_agent` can override the status of an *already-detected* agent (by its
  `name`), but cannot create a listing for an undetected pane (verified: bare shell + `report_agent_session` +
  `report_agent` → never listed, status never changes; even on the real custom-TUI claude).
- claude/codex are **not** in `full_lifecycle_hook_authority` (only `pi/omp/hermes/opencode/kilo/kimi`), so their
  integration hooks have no authority to assert state independent of the classifier.
- The TUI customizations (tweakcc branding, claude-hud statusline) do **not** break detection: the state rules key on
  the `✳` OSC title and the `❯` prompt box, both intact. Once identified, state classifies fine.

## Fix (minimal, zero functional/visual change): present argv0 as `claude`

In `~/bin/claude-with-override`, change each `exec "$REAL_CLAUDE" …` to `exec -a claude "$REAL_CLAUDE" …`. This sets
`argv[0]="claude"`; herdr reads it via KERN_PROCARGS2 → `basename="claude"` → `identify_agent` → `Claude`. It changes
only the process's presented name — nothing about tweakcc, claude-hud, model selection, the override logic, or the TUI.

**End-to-end confirmation (isolated herdr, dedicated session, real custom-TUI claude, torn down; never touched the
live swarm):**
- Without the fix: real claude → `agent_session` registered but `agent_status: unknown`, absent from `agent list`
  (reproduces ③).
- With `exec -a claude` running the real claude: `agent list` → `('claude','idle',<pane>)`; `agent explain` →
  `rule: live_prompt_box, evidence "❯"`; driving the pane → status flows **idle → working** in real time.
- Cross-check: a dummy `exec -a claude sleep 600` is also identified+listed (`default_known_agent_idle_fallback`),
  isolating argv0 as the sole lever. Raw captures in `docs/research/herdr-claude-state-evidence/`.

## Status: user-applied (2026-10-06 eve)

`claude-with-override` is on the "do not touch" list, so the fix was brought back as an option for the user — who
then **applied it themselves**, slightly better than the original proposal:
- `find_real_binary` now selects the pure-version binary: `ls … | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1`
  (so it no longer picks `2.1.283.pristine`), AND
- every `exec` line uses `exec -a claude "$REAL_CLAUDE" …` (lines 116/122/142/148/151).

**③ status: root-caused + user-fixed; awaiting natural rolling-restart verification.** The change takes effect on
newly-started sessions; the four live claude members were started before it (their processes still show the version
name) and will be recognized by herdr as they naturally restart — the live sessions are deliberately not disturbed.
**Acceptance evidence:** the next real member launched via the new launcher appears in herdr `agent list` with flowing
state (occurs naturally; no isolated repro needed — already proven end-to-end in isolation above).

If the launcher fix were ever reverted, the fallbacks are upstream herdr changes (add `("herdr:claude","claude")` to
`full_lifecycle_hook_authority` + extend the claude integration hook to report state; or teach `identify_agent` to
recognize the versioned claude binary) — both require rebuilding/PRing herdr.

The bus-presence bridge is **not** needed: herdr's observation surface (agent list / wait / blocked / unified panel)
works in full once the process is identified — which is the capability the user wanted to reuse.

## ① `agent start -- <args>` whole-string-as-one-arg — our side is correct

`buildAgentStart` returns an argv **array** (`["agent","start",name,"--kind",k,"--pane",p,"--",...args]`) and
`herdrRun` passes it to `execFile(HERDR_BIN, args)` — each element is a separate argv entry, so word-by-word passing
is already guaranteed on our side (no shell interpolation). `swarm-resume` tokenizes the full command via the
escape-aware `splitCommand` before handing `args` to `herdrLaunch`, and refuses herdr (falls back to Ghostty) on an
unbalanced command. So the only way claude receives `"--flag1 --flag2"` as one token is if herdr's own
`agent start … -- <args>` forwarding re-joins them (upstream) — our argv is clean. The migrated members are
user-launched (not via `agent start`), so this path is not exercised in production today. **Action:** no agenthop
code change; if a concrete `agent start` repro appears, it points upstream. Documented as a known item.

## ② first-char drop on keystroke injection (claude → laude)

Not reproduced in this investigation: `pane send-keys` (trust navigation Up/Enter) and `pane send-text` (driving a
prompt into claude) both landed intact. It is an intermittent herdr keystroke-timing issue (first key sent before the
PTY/app is ready). Our integration does not rely on raw keystrokes for the live paths: `herdrPrompt` uses
`agent prompt` (atomic submit), and `herdrSendKeys` is only the (currently escalate-only, not auto-invoked) sentinel
re-injection. **Mitigation if/when needed (our side, additive):** before `send-keys`, probe pane readiness (read the
pane for the prompt marker) and/or prefix a throwaway key, or prefer `agent prompt` / `pane run` over raw keystrokes.
Documented as a known item + workaround; no code change required for the current integration surface.
