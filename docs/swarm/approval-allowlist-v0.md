# approval-allowlist v0 — the delegable set (attached to approval-delegation-brief.md)

owner 90b58f9c · board `approval-delegation` · **coordinator architecture ruling A(a)+B(a) (2026-10-11), after happycapy's
adversarial review proved the auto-allow approach cannot soundly cover path/git reads.** v1 is **SCOPE-FREE-ONLY**. Encoded in
`packages/bus/src/swarm/approval-delegation.ts` (`planDelegation` + the `PINNED` Map); this file is the human-readable contract.

## Principle — v1 delegates ONLY commands that read no filesystem path

A hook decision cannot bind the EXECUTION of a member command that READS a member-supplied path: the gap between the hook's
final check and the actual read is an irreducible TOCTOU. So v1 auto-allows ONLY commands whose execution touches no cwd-relative
path and no repo (no path-read TOCTOU); execution is then bound by rewriting to `builtin command <abspath>` + an lstat of the
FIXED pinned binary (see **Execution binding** below):

**Delegable (auto-allow):** `pwd` (no args) · `echo …` (args are literals) · `which …` · `basename …` · `dirname …` — each
case-SENSITIVE (only the exact lowercase name; `ECHO`/`Pwd` escalate) and classified via a `Map` lookup, so a prototype-inherited
name (`constructor`/`toString`/`__proto__`/…) is never delegable and never recorded.

## Execution binding (AD-V1-P1-1)

A command NAME does not bind its implementation: a member shell alias / function / PATH entry — including a slash-named
`BASH_ENV` function that shadows the `/bin/pwd` literal — can make the name run attacker code. So the delegate verdict REWRITES
the command to `builtin command <abspath>` (e.g. `builtin command /bin/pwd`) via the hook's `updatedInput`: `command` skips
function/alias lookup, `builtin` forces the real `command` builtin. The member hook lstat-verifies the pinned binary is a real
regular file in ITS OWN env before emitting (dangling link / symlink-replacement / directory ⇒ escalate), and recomputes the
rewrite locally (it never executes the rewrite string carried in the control-log decision — the log authorizes WHETHER, the
member binds WHAT runs). **Excluded from this review by coordinator scope** (a scope decision, NOT a verified equivalence with
manual approval): a function that replaces `builtin`/`command` themselves; a `BASH_ENV`/`ENV` shell-startup file that runs
arbitrary code at shell init; `/bin` tampering. The builtin-function fixture produced DIFFERENT outputs for the original `pwd`
and its rewrite, so this is a scope ruling, not a behavioral-equivalence claim. Re-opening any of these is a coordinator + user decision.

Everything else escalates to the user:
- **privilege** (escalate:"privilege") — the blacklist backstop: `sudo`/`rm`/`mv`/`chmod`/`curl`/`wget`/pkg-managers/`env`/
  redirects/`$(…)`/pipe-to-shell/git-mutations/credential paths (`.env*`/`id_rsa*`/`*.pem`/`*.key`/`credentials`/`.ssh`/…).
- **needs-user** (escalate:"needs-user") — everything not delegable and not blacklisted: **path reads (cat/ls/head/tail/wc/
  file/stat), git (all subcommands), grep/rg/find, any unknown command**, plus any command with a shell metacharacter / glob /
  brace / tilde / `$`-expansion / quote / backslash / control char / non-ASCII whitespace, or a structured (non-Bash) tool.

## Why path reads and git are OUT of v1 (proven by review)

- **Path reads** (`cat`/`ls`/…): the executed read cannot be bound to the verified target. A symlink repointed between the
  hook's final resolve and Bash's read (even to another "safe" file) reads a different object; re-query and rewrite-to-realpath
  both leave a window (happycapy ADIO-P1-2).
- **git**: a git read run as typed honours repo/global config AND env — external diff, pager, fsmonitor, textconv, and
  `.gitattributes` clean/process filters — un-enumerable exec vectors `-c` cannot close; and `git show` can dump committed
  content (happycapy GR-P1-1/P1-2). `-c` patching is whack-a-mole.

## The path/git bulk is covered elsewhere — the sanitized-read ticket

v1's value is the end-to-end pipeline (prompt → S11 → three-gate → control-log → flowback) running soundly. The delegable
WIDTH (path/git reads, the popup bulk) is a SEPARATE design-first ticket: **the coordinator runs a SANITIZED read in a
controlled environment and injects the output**, instead of auto-allowing the member's command — closing the TOCTOU / env /
filter surfaces at once (realpath+O_NOFOLLOW within cwd; git in a throwaway, env-scrubbed, filter-off environment).

## Accepted residuals (user gate)

If the user is willing to accept the residual risk, path/git read forms may be opted back (coordinator option (3)): the
symlink-swap TOCTOU and a malicious `.gitattributes` filter. These are on the user's risk list; the coordinator does not carry
them on the user's behalf.

## How to change this

The user vetoes or expands by ruling; the owner edits both this file and `planDelegation`/`PINNED` in the same change, and
the selftest pins the new forms. No silent drift.
