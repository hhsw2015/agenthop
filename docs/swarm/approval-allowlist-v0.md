# approval-allowlist v0 — the delegable set (attached to approval-delegation-brief.md)

owner 90b58f9c · board `approval-delegation` · frozen by coordinator fe0376cd (five-question ruling ①) · **user can veto or
expand at any time; until then the classifier runs by this v0.** Encoded in `packages/bus/src/swarm/approval-delegation.ts`
(`isBlacklisted` / `isReadOnlyWithinCwd`); this file is the human-readable contract those two functions must match.

## Principle — most-conservative start

v0 delegates (auto-ALLOW, no user dialog) ONLY a request that is **read-only AND within the member's cwd**. Everything else
reaches the user. This is the blast-radius knob at its tightest; it grows by explicit ruling, never by drift. Two laws:

1. **The blacklist precedes the allowlist.** A command that matches any blacklist form is NEVER delegated, even if its
   entrypoint looks read-only (`cat .env` reads, but `.env` is a secret → blacklist wins → user).
2. **Fail-closed.** Anything neither clearly blacklisted nor clearly on the allowlist → the user decides (`needs-user`). An
   unknown tool, a structured tool, a shell pipe, a redirect — none are auto-granted in v0.

## Gate order (classifyApproval)

```
BLACKLIST  → escalate:"privilege"   (never delegate; the hard never-delegable set)
ALLOWLIST  → delegate:"allow"       (read-only within cwd; the only auto-grant)
otherwise  → escalate:"needs-user"  (fail-closed to the user)
```

v1 delegates **allow only**. A deny is never delegated — it always reaches the user (auto-deny is a v2 question).

## The ALLOWLIST (delegable → auto-allow)

A request is delegable iff ALL of:

- `tool === "Bash"` (v0 inspects Bash only; a structured tool — Read / Write / Edit / `mcp__…` — is `needs-user`).
- The command contains **no shell metacharacter**: none of `; & | < > \` $ ( ) { }`, no newline, no backslash. A single
  simple command only — a pipe or chain (`cat x | grep y`) degrades to `needs-user` in v0 (safe, not delegated).
- The entrypoint (first token) is a read-only tool:
  `cat ls head tail wc grep rg egrep fgrep find file stat tree pwd echo which basename dirname`,
  or `git` with a read subcommand: `status diff log show branch remote rev-parse describe`.
- Every argument stays within cwd: **no absolute path** (`/…`), **no parent escape** (`..`), **no home expansion** (`~`).

Examples delegated: `cat src/foo.ts` · `ls -la packages` · `grep -rn TODO src` · `git status` · `git diff HEAD` ·
`rg classifyApproval` · `wc -l README.md`.

## The BLACKLIST (never delegate → escalate:"privilege")

Any Bash command matching a form below is never delegated (over-matching is safe — it only loses a delegation, never grants
one wrongly):

- **privilege:** `sudo`, `doas`
- **destructive / perms:** `rm rmdir mv cp dd mkfs chmod chown chgrp ln truncate shred`
- **process / host control:** `kill killall pkill reboot shutdown halt launchctl systemctl service`
- **network:** `curl wget nc ncat netcat telnet ssh scp sftp rsync ftp`
- **package / fetch / deploy:** `npm pnpm yarn npx pip pip3 cargo gem bundle apt apt-get yum dnf brew go docker kubectl`
- **env dump / leak:** `env printenv export set`
- **any redirect-write:** a `>` of any kind (non-read-only)
- **pipe to an interpreter:** `… | sh|bash|zsh|python|node|ruby|perl|eval`
- **command substitution:** `$(…)` or backticks
- **git mutation:** `git push|commit|reset|clean|checkout|switch|restore|rebase|merge|stash|rm|mv|apply|am|cherry-pick|tag|branch -d|config` (non-`--get`)
- **credential / secret paths:** `.env id_rsa id_ed25519 id_dsa id_ecdsa .pem .key credentials .aws .ssh .npmrc .git-credentials .netrc secret token password passwd ~/.agenthop/identity`

## Out of scope for v0 (→ user, by design)

- Structured tools (Read / Glob / Grep / Write / Edit / `mcp__…`) — a write is non-read-only; a read tool rarely prompts
  anyway. v0 does not delegate any structured tool.
- A safe pipe or chain of read-only commands (`cat x | grep y`) — the metacharacter rule routes it to the user. A future
  ruling may delegate a validated read-only pipeline.
- A read of a within-cwd file that happens to match a secret name — the blacklist wins (user decides).

## How to change this

The user vetoes or expands by ruling; the owner then edits both this file and the two functions in
`approval-delegation.ts` in the same change, and the selftest pins the new cases. No silent drift between the doc and the code.
