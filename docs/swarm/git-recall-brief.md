# git-recall — design brief (contract; FROZEN 2026-10-11)

owner 90b58f9c · focused ticket off the approval-delegation IO-round stack (`feat/approval-delegation` @e5a40c2) ·
reviewer happycapy (queued after the IO-round verdict) · **FROZEN by coordinator fe0376cd (three rulings folded in: §Hole 2
GIT_ prefix rule + §Hole 1 `--no-pager`, + `git log` messages allowed); code may proceed.**

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

Repo/global config can make an innocent read exec a program: `diff.external`, `core.pager`, `pager.<subcommand>`,
`core.fsmonitor`, `diff.*.textconv`, a custom `diff.<driver>.command`. The delegate decision rewrites the command to a
config-immune form. Global options go right after `git`; `--no-ext-diff` is a diff-family option and is appended after the
subcommand for `diff`/`log`/`show` only (the other subcommands reject it):

```
git --no-pager -c diff.external= -c core.fsmonitor= <subcommand> [--no-ext-diff for diff|log|show] <safe-flags…>
```

- `--no-pager` (FROZEN addition) — kills ALL pager exec in one flag. `core.pager=cat` is INSUFFICIENT: `pager.<subcommand>`
  (e.g. `pager.status=evil`) is a SEPARATE config key that `core.pager` does not cover; `--no-pager` disables every pager path.
  So we drop `-c core.pager=cat` in favour of `--no-pager`.
- `-c diff.external=` + `--no-ext-diff` (diff-family) — no external diff driver.
- `-c core.fsmonitor=` — no fsmonitor hook exec (relevant to `status`).
- textconv (`diff.*.textconv`) and a custom `diff.<driver>.command` (referenced via `.gitattributes`) run a program only to
  render CONTENT; the non-content restriction (Hole 3) means they NEVER fire — recorded as an explicit DEPENDENCY: **if a future
  version allows content forms, this `-c` set is NOT sufficient and Hole 1 must be re-reviewed** (no `-c` glob clears all
  textconv/custom drivers).
- Aliases cannot shadow a builtin read subcommand (git ignores an alias that names an existing command), so the rewrite's
  builtin subcommand cannot be hijacked.

`updatedInput` replaces the whole Bash input object — the rewrite MUST carry over every original field (`description`,
`timeout`, …), changing only `command`. The rewritten command is re-checked against deny/ask rules (it must not trip one).

### Hole 2 — ENV-injected execution + scope redirect (closed by the `gitEnvClean` IO fact) — FROZEN RULE: GIT_ PREFIX

`updatedInput` rewrites the COMMAND, but the command runs in the MEMBER'S ENVIRONMENT, and env vars OVERRIDE `-c` / are
env-only — so `-c` CANNOT close these. Per-variable enumeration WILL miss one (the coordinator's freeze found at least five the
first pass missed: `GIT_EXEC_PATH` = redirects the git-subcommand executable search path = a direct exec hole; `GIT_CONFIG_PARAMETERS`
= the env transport channel for `-c` = direct config injection; the `GIT_TRACE`/`GIT_TRACE_*` family = can point at an arbitrary
file path = a file-WRITE vector; `GIT_INDEX_FILE` = scope redirect; `XDG_CONFIG_HOME` = a NON-`GIT_` config-injection point, since
git reads `$XDG_CONFIG_HOME/git/config`). So the FROZEN rule is a PREFIX rule, not a list:

> **`gitEnvClean` = (no environment variable whose name starts with `GIT_` is present, for ANY value) AND (none of the explicit
> non-`GIT_` vectors `PAGER`, `EDITOR`, `SSH_ASKPASS`, `XDG_CONFIG_HOME` is present).**

Any such variable present (any value) ⇒ `gitEnvClean = false` ⇒ escalate. The prefix rule is complete by construction — a future
`GIT_<anything>` vector is caught without a brief edit. Over-rejection only loses a delegation, never grants one (a member with a
`GIT_` var set simply falls to the user for git; the common member shell has none). Hardening vars (`GIT_CONFIG_NOSYSTEM`, …) are
also `GIT_`-prefixed and thus escalate — fail-closed is fine (we do not reason about which `GIT_` is safe).

**Known residual — `HOME`:** `HOME` cannot be required absent (it is always set), and `$HOME/.gitconfig` can carry
`diff.external` / `pager.*` / `core.fsmonitor` / a custom diff driver. This residual is MITIGATED, not closed, by Hole 1's `-c`
overrides + `--no-pager` (which beat `$HOME/.gitconfig` for exec/pager) and by Hole 3's non-content restriction (no content ⇒ no
textconv/content-diff driver fires). It is NOT fully closed: a `$HOME/.gitconfig` `core.fsmonitor` is overridden by our
`-c core.fsmonitor=`, external diff by `-c diff.external=` + `--no-ext-diff`, pagers by `--no-pager` — so the known exec paths ARE
covered; what remains unmodelled is any FUTURE git config knob that execs and is not in our `-c` set and is not a content path.
Recorded here as an explicit accepted residual (re-review if content forms are ever allowed — see Hole 3 dependency).

The hook reports `gitEnvClean` as an IO fact in `ApprovalScope`; the pure classifier fails closed without it. The resolver
computes `gitEnvClean` FIRST and only runs `git rev-parse` (for `cwdIsGitRoot`) when the env is clean (so a dirty env can never
influence the root probe).

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

## Frozen rulings (coordinator 2026-10-11)

1. **env (§Hole 2) — FROZEN: the GIT_ PREFIX rule** (any `GIT_`-prefixed var ⇒ escalate) + explicit non-`GIT_` list
   (`PAGER`, `EDITOR`, `SSH_ASKPASS`, `XDG_CONFIG_HOME`); `HOME` is a recorded accepted residual mitigated by Holes 1+3. The
   coordinator's five additional finds (`GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS`, `GIT_TRACE*`, `GIT_INDEX_FILE`,
   `XDG_CONFIG_HOME`) motivated the prefix rule — per-var enumeration is abandoned as incomplete-by-nature.
2. **`git log` with commit MESSAGES (no `-p`) — FROZEN: allowed** (messages are repo metadata, not file content, and the member
   can already read them; `sanitizeForTransport` still escapes on the wire).
3. **`-c` set (§Hole 1) — FROZEN: add `--no-pager`** (supersedes `core.pager=cat`; `pager.<subcommand>` is a separate key
   `core.pager` cannot cover). Keep `-c diff.external=` + `-c core.fsmonitor=` + `--no-ext-diff` (diff-family). A custom
   `diff.<driver>.command`/textconv is handled by the non-content restriction (Hole 3), recorded as a dependency to re-review if
   content forms are ever allowed.
