# git-recall — design brief (contract; FREEZE before code)

owner 90b58f9c · focused ticket off the approval-delegation IO-round stack (`feat/approval-delegation` @e5a40c2) ·
reviewer happycapy (queued after the IO-round verdict) · **contract-first: no code until this is frozen.**

## Why this is a separate ticket

The IO round (①②③ + install) delivered the self-contained delegation main line (prompt → S11 → three-gate → control-log →
flowback). `git` read forms were kicked OUT of the v0 allowlist across the pure-core rounds (r3 ①) because a git command run
AS THE MEMBER TYPED IT can EXECUTE external programs via config/env and can DUMP committed secrets. This ticket recalls the
SAFE git read forms as an **allowlist-expansion optimization** — fewer `status`/`log` popups — WITHOUT reopening any of the
three holes. It is isolated on purpose (coordinator ruling): each new security surface merged super-linearly grows the review,
and the four pure-core rounds taught us to keep surfaces small.

## Mechanism basis (verified)

A SYNC Claude `PermissionRequest` hook returning `behavior:"allow"` MAY also rewrite the tool input via
`hookSpecificOutput.decision.updatedInput` (allow-only; **replaces the ENTIRE input object** — must carry every unchanged
field; the rewritten command is **re-evaluated against deny/ask rules**). So we can delegate a git read by auto-allowing a
**config-immune rewrite** of it. (Verified against the hooks reference; re-verify at ship.)

## The THREE holes and how each is closed

A git read form is delegated ONLY when ALL THREE are closed; **miss one ⇒ escalate** (fail-closed, the "不确定不授权" family).

### Hole 1 — config-driven execution (closed by the `-c` rewrite)

Repo/global config can make an innocent read exec a program: `diff.external`, `core.pager`, `core.fsmonitor`, `diff.*.textconv`.
The delegate decision rewrites the command to a config-immune form, injected right after `git`:

```
git -c diff.external= -c core.pager=cat -c core.fsmonitor= --no-ext-diff <subcommand> <safe-flags…>
```

- `-c diff.external=` + `--no-ext-diff` — no external diff driver.
- `-c core.pager=cat` — no pager exec (also `--no-pager` is implied by non-TTY, belt-and-suspenders).
- `-c core.fsmonitor=` — no fsmonitor hook exec (relevant to `status`).
- textconv (`diff.*.textconv`) runs a program only to render CONTENT; the non-content restriction (Hole 3) sidesteps it
  entirely (no `-c` glob exists to clear all textconv drivers, so we do NOT rely on `-c` for it).
- Aliases cannot shadow a builtin read subcommand (git ignores an alias that names an existing command), so the rewrite's
  builtin subcommand cannot be hijacked.

`updatedInput` replaces the whole Bash input object — the rewrite MUST carry over every original field (`description`,
`timeout`, …), changing only `command`. The rewritten command is re-checked against deny/ask rules (it must not trip one).

### Hole 2 — ENV-injected execution + scope redirect (closed by the `gitEnvClean` IO fact)

`updatedInput` rewrites the COMMAND, but the command runs in the MEMBER'S ENVIRONMENT, and env vars OVERRIDE `-c` / are
env-only — so `-c` CANNOT close these. The hook (in the member env) must verify NONE of the following is set, else escalate.
This is the security core of the ticket; the list must be exhaustive. **gitEnvClean = none of these present:**

- **Exec vectors:** `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `PAGER`, `GIT_SEQUENCE_EDITOR`, `GIT_EDITOR`, `EDITOR`,
  `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_MERGE_DRIVER`?(n/a to reads but listed),
  `GIT_TEXTCONV_*`? (textconv driven by attributes+config), `GIT_HOOKS_PATH`/`GIT_HOOKSPATH`? (hooks don't run on these reads,
  but cleared defensively).
- **Config-injection vectors (re-open Hole 1 via env):** `GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
  `GIT_CONFIG_COUNT` (+ the `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` family it enables).
- **Scope-redirect vectors (defeat `cwdIsGitRoot`):** `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_NAMESPACE`.
- **Prompt/terminal:** `GIT_TERMINAL_PROMPT` (set to anything ⇒ escalate, conservative).

Conservative: ANY of the above present (any value) ⇒ `gitEnvClean = false` ⇒ escalate. Over-rejection only loses a delegation,
never grants one. The hook reports `gitEnvClean` as an IO fact in `ApprovalScope`; the pure classifier fails closed without it.
(`GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL=/dev/null` are hardening, not threats — but presence of `GIT_CONFIG_GLOBAL` with a
non-`/dev/null` value IS a threat, so the simplest rule is: its mere presence ⇒ escalate. The list errs toward escalation.)

### Hole 3 — committed-content leak (closed by the NON-CONTENT form restriction)

Even config+env immune, `git show` / `git diff` default to printing FILE CONTENT from the repo — including a committed
credential (`.env`, a key). So v1 recall allows ONLY forms that emit NO file content. The closed non-content forms:

| subcommand | allowed flags (exact, value-less; the enumerated closed form) | notes |
|---|---|---|
| `git status` | `-s --short --porcelain -b --branch -sb --long` | no content |
| `git log`    | `--oneline --stat --graph --decorate --no-color --numstat --shortstat --name-only --name-status --all` and `-<N>` | NO `-p`/`--patch`/`-U` (content). Commit MESSAGES are shown — allowed (metadata, not file content). |
| `git diff`   | `--stat --name-only --name-status --numstat --shortstat --summary` | REQUIRE ≥1 flag — bare `git diff` is content ⇒ escalate. No `--output` (writes). |
| `git show`   | `--stat --numstat --name-only --name-status` | REQUIRE ≥1 flag — bare `git show` is content ⇒ escalate. |
| `git branch` | `-a --all -v -vv -r --list -l` | list; no content |
| `git remote` | `-v --verbose` | list; no content |

NO positional ref/pathspec operand (a ref like `HEAD` widens scope / a pathspec needs realpath — out of v1; escalate). The
closed-form table + proto-safe Map lookup (AD-R2-P1-1), the whitespace/metachar bans (AD-P1-2), and the blacklist backstop all
apply exactly as in the pure core — git recall is a strictly ADDITIVE branch inside the existing `planDelegation`.

### `cwdIsGitRoot` IO fact (scope)

A git read is repo-wide; "within cwd" holds only when cwd IS the repo root. The hook reports `cwdIsGitRoot` (cwd ==
`git rev-parse --show-toplevel`, realpath-compared); absent/false ⇒ escalate. (Combined with gitEnvClean rejecting
`GIT_DIR`/`GIT_WORK_TREE`, the repo cannot be relocated out from under this check.)

## The delegate verdict carries a rewrite

For a git form that passes all three gates, the verdict is a DELEGATE whose `PermissionDecision` carries the config-immune
rewritten command (an additive optional field). The member hook emits `allowDecisionOutput({ command: rewritten })` →
`decision.updatedInput.command`. A non-git delegate (the IO round's path forms) carries no rewrite (plain allow), unchanged.

## Pure vs IO split

- **Pure (approval-delegation.ts / approval-gate.ts):** the git closed-form table + flag sets, the `-c` rewrite BUILDER
  (`gitImmuneRewrite(command)` — pure string transform), the gate that requires `cwdIsGitRoot===true && gitEnvClean===true`,
  and the rewrite carried in the verdict/PermissionDecision. Selftested.
- **IO (approval-scope.ts / permission-gate-cli.ts):** resolving `cwdIsGitRoot` (`git rev-parse --show-toplevel`) and
  `gitEnvClean` (scan `process.env`) into `ApprovalScope`; the member hook emitting the rewrite. Integration-tested with temp
  git fixtures (config exec, env exec, content form, non-root subdir — all must escalate; a clean non-content form at the root
  with a clean env must delegate + rewrite).

## Constraint / FC self-check

- **① privilege never delegated** — git recall adds ONLY non-content, config+env-immune, repo-root-confined reads; every
  un-met condition escalates. No mutation form is reachable (the blacklist backstop still labels `git push|commit|…` privilege).
- **② 留痕** — the delegated decision (with its rewrite) is the same control-log `permissionDecision` record as the IO round.
- **③ reuse** — no new surface; same closed-form table, same `ApprovalScope`, same dispatcher loop. `cwdIsGitRoot`/`gitEnvClean`
  are additive optional `ApprovalScope` fields; the rewrite is an additive optional `PermissionDecision` field.
- **④ Claude only** — unchanged (the hook is Claude-only).
- **FC-6** — no timestamp latest-wins; the decision is keyed by `promptId`; the gates are structural; env/root are booleans.
- **FC-7** — additive optional fields on `ApprovalScope` + `PermissionDecision`; old records lack them (backward-compatible, no
  migration); the git branch of `planDelegation` is new code, no existing record format changes.

## Dormancy + scope

- Same flag: `SWARM_APPROVAL_DELEGATE` (default OFF). git recall is live only when the whole feature is on.
- v1 in scope: the six non-content read subcommands above, no positional operands. OUT: content forms (`git show`/`diff`
  with content), pathspec/ref operands, `grep`/`rg`/`find` (still deferred), any mutation.

## Open questions for the freeze

1. **The env threat list (§Hole 2) — is it complete?** This is the security crux. Confirm the set, or add any missing GIT_*
   exec/config/scope vector. Err toward escalation (presence ⇒ escalate).
2. `git log` with commit MESSAGES (no `-p`) — allow (metadata), or restrict to `--oneline` (subject only) to avoid a secret
   pasted into a commit message? Recommend: allow (messages are not file content; the north star is fewer popups).
3. The `-c` rewrite set (§Hole 1) — confirm `diff.external=` + `core.pager=cat` + `core.fsmonitor=` + `--no-ext-diff` is the
   right minimal config-immune set for non-content reads (textconv handled by the non-content restriction, not `-c`).
