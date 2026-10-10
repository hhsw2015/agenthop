# approval-allowlist v0 — the delegable set (attached to approval-delegation-brief.md)

owner 90b58f9c · board `approval-delegation` · **coordinator architecture ruling A(a)+B(a) (2026-10-11), after happycapy's
adversarial review proved the auto-allow approach cannot soundly cover path/git reads.** v1 is **SCOPE-FREE-ONLY**. Encoded in
`packages/bus/src/swarm/approval-delegation.ts` (`planDelegation` + `SCOPE_FREE`); this file is the human-readable contract.

## Principle — v1 delegates ONLY commands that read no filesystem path

A hook decision cannot bind the EXECUTION of the member's own command: the gap between the hook's final check and the actual
read is an irreducible TOCTOU, and the member's env/config drive hidden execution. So v1 auto-allows ONLY commands whose
execution touches no cwd-relative path and no repo — their safety is structural, not fact-dependent:

**Delegable (auto-allow, no facts needed):** `pwd` (no args) · `echo …` (args are literals) · `which …` · `basename …` ·
`dirname …`

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

The user vetoes or expands by ruling; the owner edits both this file and `planDelegation`/`SCOPE_FREE` in the same change, and
the selftest pins the new forms. No silent drift.
