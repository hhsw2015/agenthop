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
- With `exec -a claude` running the real claude: `agent list` → claude is **listed**; `agent explain` →
  `rule: live_prompt_box, evidence "❯"`. One archived end-state snapshot (`FINAL-agent-list…`) shows
  `agent_status=done` with `state_change_seq=6 / completion_seq=6 / revision=4` — accurate reading: *that snapshot's*
  end-state is `done` and the agent is listed. The counters are present but their exact semantics/scope are not locked
  here, and there is **no** archived start point or per-tick record, so this snapshot does **not** by itself
  reconstruct a specific task's state history. The per-tick idle→working sequence was a live-terminal **observation**
  (not archived); a `blocked` state was **not** induced.
- Cross-check: a dummy `exec -a claude sleep 600` is also identified+listed (`default_known_agent_idle_fallback`),
  isolating argv0 as the sole identity lever.
- **Production acceptance (read-only, real member) — `docs/research/herdr-claude-state-evidence/LIVE-acceptance/`:**
  the first member to restart via the fixed launcher (the coordinator session) is listed live as `claude` (pre-fix
  always absent), classified from its OSC title (`rule: osc_title_working, evidence "◐ …"`), bound to a process whose
  `ps` shows **argv0=claude**; `agent get` read live shows `state_change_seq` climbing (18→33) and status working→idle
  = **real state flow in production**. This is ③'s coordinator-named scope-B acceptance for identify→list→flow.
  `wait --until` and a `blocked` observation remain **unverified**.
- Raw-vs-observed-vs-not-captured inventory: `docs/research/herdr-claude-state-evidence/FINAL-state-flow-note.txt`.

## Status: user-applied (2026-10-06 eve)

`claude-with-override` is on the "do not touch" list, so the fix was brought back as an option for the user — who
then **applied it themselves**, slightly better than the original proposal:
- `find_real_binary` now selects the pure-version binary: `ls … | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1`
  (so it no longer picks `2.1.283.pristine`), AND
- every `exec` line uses `exec -a claude "$REAL_CLAUDE" …` (lines 116/122/142/148/151).

**③ status: root-caused + user-fixed; production acceptance for identify→list→state-flow OBSERVED live (read-only),
coordinator-named (scope-B).** The change takes effect on newly-started sessions; members started before it still show
the version name and are recognized by herdr as they naturally restart — live sessions are deliberately not disturbed.
The coordinator (the first member to restart) is the named acceptance: see `LIVE-acceptance/` above. **Still
unverified:** `wait --until` for claude, and a `blocked` observation (the claude.toml blocker rules read the same
screen regions that already classify idle/working here, so blocked is *expected* to work once identified — that is an
inference, not captured). Per coordinator scope-B, the end-to-end follow-up remains owned by 90b58f9c until those are
confirmed; this ticket does not claim full ③ closure.

If the launcher fix were ever reverted, the fallbacks are upstream herdr changes (add `("herdr:claude","claude")` to
`full_lifecycle_hook_authority` + extend the claude integration hook to report state; or teach `identify_agent` to
recognize the versioned claude binary) — both require rebuilding/PRing herdr.

The bus-presence bridge is **not** needed for the verified capability: once the process is identified, herdr lists the
agent and its idle/working state flows (shown live). `wait --until` and the blocked path are not yet verified, so no
claim is made about the full panel.

## ① `agent start -- <args>` whole-string-as-one-arg — our side is correct

`buildAgentStart` returns an argv **array** (`["agent","start",name,"--kind",k,"--pane",p,"--",...args]`) and
`herdrRun` passes it to `execFile(HERDR_BIN, args)` — each element is a separate argv entry, so word-by-word passing
is preserved on our side (no shell interpolation). `swarm-resume` tokenizes the full command via the escape-aware
`splitCommand` before handing `args` to `herdrLaunch`, and refuses herdr (falls back to Ghostty) on an unbalanced
command. A regression guard (selftest) + a real `execFile` capture confirm that a standard generated command yields
separate tail argv.

**Scope of that claim (narrowed per review):** this verifies our argv **boundary handling** for standard generated
commands and the tested inputs — it does **not** localize the field "whole string as one arg", and it is **not**
uniquely attributable to upstream. Counterexample: a quoted input `claude "--model opus --resume SID"` goes through
`splitCommand` (balanced) and real `execFile` as a **single** tail arg here, with no upstream join — correct
quote-boundary preservation, but it shows the whole-string can originate in the **input** too. So the input boundary
also needs checking. **Action:** no agenthop code change (boundary handling is correct); the field case is *not
localized* — pinning it needs the field's original command/input plus the per-hop argv (what entered herdr vs what was
delivered to claude). The migrated members are user-launched (not via `agent start`), so this path is not exercised in
production today. Documented as a known, un-localized item.

## ② first-char drop on keystroke injection (claude → laude)

**Not reproduced** in this investigation: `pane send-keys` (trust navigation Up/Enter) and `pane send-text` (driving a
prompt into claude) both landed intact across every attempt. **The cause is therefore not established** — a
first-keystroke/PTY-readiness race is only a *hypothesis*, not something this investigation demonstrated; it could
equally be a one-off from the original field session. No raw capture of the drop exists.

Impact on our integration is low regardless: the live paths do not use raw keystrokes — `herdrPrompt` uses
`agent prompt` (atomic submit), and `herdrSendKeys` is only the (currently escalate-only, not auto-invoked) sentinel
re-injection. **If it is ever reproduced**, candidate mitigations (all untested hypotheses, to be validated against a
real repro before adopting): probe pane readiness before `send-keys`, prefix a throwaway key, or prefer
`agent prompt` / `pane run` over raw keystrokes. Recorded as a known item; **no code change made** (declining to add
speculative code for an unreproduced bug with an unconfirmed cause).
