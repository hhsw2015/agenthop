# approval-delegation — design brief (contract; FREEZE before code)

owner 90b58f9c · board `approval-delegation` (claimed) · off main `@7b8e87c` · reviewer happycapy · **design-first: no code until this is frozen by coordinator + user.**

## Goal / north star

user 2026-10-05: "弹窗等审批该发消息给协调者,可代理的代理掉,需要 user 的才到 user." A member hitting a permission prompt should NOT force a user activation for the routine ones. North-star main line: **external-activation count ↓**. The `PermissionRequest` hook writes a structured S11 approval request to the coordinator's durable inbox; the coordinator three-gate routes it; a delegable request is decided + recorded WITHOUT the user; only the ones needing user judgment reach the user (packaged, plain-language).

## Mechanism basis (VERIFIED against the Claude Code hooks reference, today)

Grounding facts (so the contract is not speculative — re-verify against the pinned Claude Code version at ship):

- `PermissionRequest` fires ONLY for a tool call that needs a permission decision. stdin carries `session_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input` (e.g. `tool_input.command`), `permission_suggestions` (the requested rules/options), `prompt_id`.
- A **SYNC** `PermissionRequest` hook may RETURN a decision: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny", ...}}}`. `behavior` is **allow|deny only** (no "ask"/"defer"). **Returning NOTHING (exit 0, empty) falls through to the normal user dialog.** exit code 2 is NOT honored here — decide via the `decision` object.
- A sync hook **blocks the tool call until it returns or times out** — so it may write the request, poll for a decision for a bounded window, then emit allow/deny. On **timeout** (default, no `onFailure`): the hook renders no decision ⇒ the call falls to the **user dialog** (interactive) or **auto-deny** (a session that cannot prompt — background/`-p`). `onFailure:"block"` would instead fail-closed-deny; v1 does NOT use it (timeout should reach the user, not auto-deny a legit op).
- An `async:true` hook can NEVER influence the decision (its output is discarded). **The current PermissionRequest hook is `async:true` + `report-status blocked`** — so delegation REQUIRES turning it SYNC.
- Only Claude Code has this decision-returning permission hook; Codex/opencode do not (confirmed for Claude; others unconfirmed) → constraint ④.

## End-to-end flow (v1)

1. **Hook (SYNC)** — `PermissionRequest` runs `agenthop permission-gate` (new subcommand), which:
   a. reads the stdin JSON → builds an `ApprovalRequest` {member sid, tool, command, suggestions, promptId, cwd, nowSec};
   b. `writeInbox` an **S11 approval request** to the coordinator's durable inbox (inbox-wake — just shipped — pings the coordinator pane the instant it lands, so no 0-8min cron gap);
   c. keeps the existing `report-status blocked` effect (status visibility);
   d. **polls the control-log** for a decision keyed by `promptId`, up to a bounded `APPROVAL_POLL_SEC` window;
   e. if a delegated decision is found → emit `{hookSpecificOutput:{hookEventName:"PermissionRequest", decision:{behavior}}}` ⇒ the tool auto-allows/denies **with no user dialog**;
   f. else (window elapsed, no delegated decision) → emit nothing ⇒ falls to the **user dialog** (interactive) / auto-deny (non-interactive).
2. **Coordinator** (woken by inbox-wake) runs the pure three-gate `classifyApproval`:
   - **Gate ① escalation (privilege) → NEVER delegate**: write NO delegated decision; package a plain-language user approval (reuse `buildApprovalDoc`). The hook times out → user decides.
   - **Gate ② delegable → decide + record**: write a `permissionDecision` entry to the **control-log** (the 留痕 ② mandates) with `{promptId, member, behavior, by:coordinator, reason, atSec}`. The hook polls it → auto-applies. One write serves BOTH the audit trail AND the flowback.
   - **Gate ③ needs-user (not escalation, not clearly safe) → escalate**: same as ①, package for user; fail-closed.
3. **Sweep supervision** — the pending request opens a sweep-watched `WaitRecord` (an approval = a real gate ⇒ **bare-wait, no auto-proceed default**, per control-log:122). The sweep surfaces/re-escalates a stuck request so it never silently hangs.

## The pure three-gate classifier (testable core)

`classifyApproval(req) → { kind: "delegate"; behavior: "allow" | "deny" } | { kind: "escalate"; reason: "privilege" | "needs-user" }`

- **privilege/escalation set (never delegate → escalate:"privilege")** — anything that widens authority or is destructive/exfiltrating: `sudo`/`doas`, `rm -rf` and bulk deletes, `chmod`/`chown`, writes OUTSIDE the member cwd, credential/secret reads (`~/.ssh`, `~/.aws`, `.env`, `~/.agenthop/identity`…), `git push --force`/history rewrite, piping to a shell from the network (`curl … | sh`), package publish, `kill`/process control outside own tree. Driven by `tool_name` + a conservative command/path inspection.
- **safe-allowlist (delegable → delegate:"allow")** — read-only/idempotent within-cwd ops: file reads, `ls`/`cat`/`grep`/`rg`, `git status`/`diff`/`log`, a typecheck/test/build the project already runs. (A `deny`-delegation list is possible for clearly-refusable non-escalation ops, but v1 may ship allow-only delegation + escalate-the-rest; TBD at freeze.)
- **everything else → escalate:"needs-user"** (fail-closed: an UNKNOWN tool/command is NEVER auto-granted). This is the "不确定不授权" family (SU1/FC-2 lineage).

Pure, no clock for the classification itself (a privilege match is structural). Lives in `packages/bus/src/swarm/approval-delegation.ts` + selftest.

## Timeout semantics — reconciling "带超时默认" with "提权永不代理" + bare-wait

The board asks must-user approvals to carry a "超时默认". An APPROVAL is a real gate (control-log:122: an approval must NOT carry an openQueryWait proceed-default — unlike an R3-b query). Reconciliation: the **timeout default is to the USER, never an auto-grant**:
- The HOOK's poll window elapsing ⇒ **fall to the user dialog** (interactive) — the user is the default decider, not an auto-allow. (Non-interactive member: auto-DENY, the fail-closed fallback — it cannot show a dialog.)
- The user-facing approval itself bare-waits (no auto-grant). "不静默卡死" is met by the bounded poll (always resolves to a decision OR the user dialog) + sweep supervision — NOT by auto-proceeding.
- This is the opposite of `openQueryWait`'s proceed-on-timeout and is deliberate: auto-proceeding a privilege on timeout would break ①.

## Hard-constraint mapping

- **① 提权类选项永不代理,直升 user** — gate ① + fail-closed default (unknown → escalate). No privilege path yields a delegated allow.
- **② 代理决策必须留痕 control-log** — every delegated decision is a `permissionDecision` control-log entry (also the flowback source). No delegation without a record.
- **③ 复用 writeInbox/S11/sweep,不新增持久面** — request = S11 via `writeInbox` (inbox surface); decision = control-log entry (existing store; a new ChangeBody *variant*, not a new surface); supervision = the existing sweep `WaitRecord`. inbox-wake makes the request wake the coordinator in real time.
- **④ Codex 无等价 hook → 先只覆盖 Claude 成员,如实标注** — the sync decision hook installs for Claude members ONLY; Codex/opencode members keep user-handled prompts. The brief + install output + docs state this plainly.

## FC self-check

- **FC-6** PASS — no "latest-wins" by timestamp. The poll window + sweep age are DURATIONS; the classifier is structural; a decision is matched by `promptId`, not by "newest".
- **FC-7** — reuses existing stores. The S11 `ApprovalRequest` payload rides `InboxMsg` (an optional typed field, precedent `intent?`, or a conventional `text`/`taskRef` encoding — TBD at freeze); the `permissionDecision` is an additive control-log `ChangeBody` variant. Both are backward-compatible (old records lack them; validators stay tolerant) — no migration/import of old records required; no on-disk format of an existing record changes.

## Dormancy + scope

- Implementation lands behind `SWARM_APPROVAL_DELEGATE` (default OFF) — the hook stays `report-status blocked` only until flipped; pure core + selftest first (same discipline as every S14 flag).
- v1 = Claude members, allow-delegation + escalate-the-rest, hook-return flowback via control-log. Out of scope: Codex/opencode decision hooks; a voice approval terminal (acn-video-eval notes it rides this later); auto-DENY delegation (optional, TBD).

## Open questions for the freeze (coordinator + user)

1. The **safe-allowlist** contents (which tools/commands may be auto-granted) — start minimal (read-only within-cwd) and grow by ruling? This is the blast-radius knob.
2. **delegate-deny** — v1 allow-only (escalate everything not safe), or also let the coordinator auto-deny clearly-bad non-escalation ops?
3. `APPROVAL_POLL_SEC` window (member is blocked this long before falling to the user) — e.g. 10–20s.
4. S11 payload shape — typed optional `approval?` on `InboxMsg` (cleaner for the coordinator's classifier) vs text/taskRef encoding (zero schema touch). Recommend typed.
5. Confirm the sync-blocking `PermissionRequest` hook is acceptable (it blocks the member's tool call up to the poll window; the member was blocked at the dialog anyway).
