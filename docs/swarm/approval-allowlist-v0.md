# approval-allowlist v0 — the delegable closed forms (attached to approval-delegation-brief.md)

owner 90b58f9c · board `approval-delegation` · frozen by coordinator fe0376cd, **r2 ruling** after happycapy's first review
(the name-list v0 was defeated by poisoned options / quote tricks / symlinks — AD-P1-1/2/3). **user can veto or expand at any
time; until then the classifier runs by this v0.** Encoded in `packages/bus/src/swarm/approval-delegation.ts`
(`planDelegation` + the `READ_FORMS` / `GIT_FORMS` / `SCOPE_FREE` tables + the scope gates); this file is the human-readable
contract those must match.

## Principle — a CLOSED-FORM list, not a command-name list

A command NAME means nothing on its own: `cat` can read `.env` via `cat .e''nv`; `find` can delete via `find … -delete`;
`git diff --output=f` writes; a bare `cat alias` can be a symlink to `../outside`. So v0 delegates (auto-ALLOW, no user
dialog) ONLY an **enumerated closed form** — a known command with **no options, or only options from that command's exact
whitelist** — AND, for any path it touches, an **IO-verified fact that the path's realpath (symlinks followed to the end)
stays inside the member cwd**. Three laws:

1. **Un-enumerated form ⇒ user.** Any option not in the command's whitelist, any value-taking flag, any positional where none
   is allowed, any redirect / pipe / chain / `$`-expansion / quote / backslash / command-substitution → `needs-user` (or
   `privilege` for the blacklist backstop). There is no generic flag parser to trick.
2. **No scope inference from spelling.** A path operand is delegated only against a verified realpath-within-cwd fact. A
   missing fact, a failed resolution, or an escape → `needs-user`. The pure core holds no filesystem; the hook supplies the
   facts (`ApprovalScope`) in the IO round. Until then path/git forms fail closed.
3. **Fail-closed + allow-only.** Unknown → user. v1 delegates allow only; a deny always reaches the user (auto-deny is v2).

Narrow is the point: the north star is fewer popups, and the handful of fixed forms below (status / log / ls / cat …) already
covers the bulk of them.

## Gate order (planDelegation, then classifyApproval applies facts)

```
tool != Bash                                  -> needs-user  (v0 inspects Bash only)
command substitution  $( )  or backticks      -> privilege
$ variable expansion                          -> needs-user  (unanalyzable)
' " \  quote / backslash                       -> needs-user  (AD-P1-2 concatenation anomaly)
BLACKLIST backstop (rm/sudo/redirect/…)        -> privilege
; & | < > ( ) { }  other metacharacter         -> needs-user  (redirect / chain / multi-command)
enumerated closed form:
  scope-free form                              -> delegate:allow          (no facts needed)
  git read form   + cwd IS git repo root       -> delegate:allow          (else needs-user)
  path form       + every operand realpath∈cwd -> delegate:allow          (else needs-user)
anything else                                  -> needs-user
```

## The delegable closed forms

**Scope-free (delegate with no facts — no cwd-relative file read):**
`pwd` (no args) · `echo …` (args are literals) · `which …` · `basename …` · `dirname …`

**Path forms (delegate only with verified realpath-within-cwd facts for every operand):**

| command | allowed options (exact, value-less) | operands |
|---|---|---|
| `cat`  | `-n -b` | path(s) |
| `head` | (none) | path(s) |
| `tail` | (none; `-f` excluded) | path(s) |
| `wc`   | `-l -w -c -m -lw -wl` | path(s) |
| `ls`   | `-l -a -la -al -lh -alh -lah -h -1 -R -lR -t -lt -rt -lrt -ltr -r` | optional path(s); none = cwd |
| `file` | (none) | path(s) |
| `stat` | (none) | path(s) |

**git read forms (delegate only when the IO fact says cwd IS the git repo root; NO positional ref/pathspec):**

| subcommand | allowed options (exact) |
|---|---|
| `git status` | `-s --short --porcelain -b --branch -sb --long` |
| `git log`    | `--oneline --stat --graph --decorate --no-color --numstat --shortstat --name-only --name-status --all` and `-<N>` |
| `git diff`   | `--stat --cached --staged --name-only --name-status --numstat --shortstat --summary` |
| `git show`   | `--stat --numstat --name-only --name-status` |
| `git branch` | `-a --all -v -vv -r --list -l` |
| `git remote` | `-v --verbose` |

## The BLACKLIST backstop (→ escalate:"privilege")

The closed-form table already fails closed on everything un-enumerated; the blacklist only sharpens the REASON so a dangerous
command is labelled `privilege` rather than `needs-user`. Matched forms: `sudo doas` · `rm rmdir mv cp dd mkfs chmod chown
chgrp ln truncate shred` · `kill killall pkill reboot shutdown halt launchctl systemctl service` · `curl wget nc telnet ssh
scp sftp rsync ftp` · `npm pnpm yarn npx pip cargo gem apt brew go docker kubectl` · `env printenv export set` · any `>`
redirect · `… | sh|bash|python|node|…` · `$(…)` / backticks · `git push|commit|reset|clean|checkout|…|config` ·
credential/secret paths (`.env id_rsa .pem .key credentials .aws .ssh .npmrc .git-credentials .netrc secret token password
~/.agenthop/identity`).

## Deferred (named in the original freeze, NOT closed forms yet ⇒ escalate for now)

`grep` / `rg` / `find` are deferred: `find` has an open-ended action grammar (`-delete`/`-exec`), `rg` is recursive-by-default
(can't pre-enumerate the files it reads), and `grep`'s pattern+recursion surface needs a sound model. They route to
`needs-user` in v0 and return via a future ruling with a verified model. This narrows v0 below the original example list on
purpose (coordinator r2: "宁可代理集窄到只剩十几个形态").

## How to change this

The user vetoes or expands by ruling; the owner then edits both this file and the tables in `approval-delegation.ts` in the
same change, and the selftest pins the new forms. No silent drift between the doc and the code.
