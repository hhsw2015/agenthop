# approval-allowlist v0 — the delegable closed forms (attached to approval-delegation-brief.md)

owner 90b58f9c · board `approval-delegation` · frozen by coordinator fe0376cd, **r2+r3 rulings** across happycapy's reviews
(the name-list v0 was defeated by poisoned options / quote tricks / symlinks / inherited keys / git config exec —
AD-P1-1/2/3, AD-R2-P1-1/2). **user can veto or expand at any time; until then the classifier runs by this v0.** Encoded in
`packages/bus/src/swarm/approval-delegation.ts` (`planDelegation` + the `READ_FORMS` / `SCOPE_FREE` Map/Set tables + the path
scope gate); this file is the human-readable contract those must match. **git is NOT in v0 — see Deferred (r3 ①).**

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
   missing fact, a failed resolution, an escape, or a resolved credential target → `needs-user`. The pure core holds no
   filesystem; the hook supplies the facts (`ApprovalScope`) in the IO round. Until then path forms fail closed.
3. **Fail-closed + allow-only.** Unknown → user. v1 delegates allow only; a deny always reaches the user (auto-deny is v2).

Narrow is the point: the north star is fewer popups, and the handful of fixed forms below (status / log / ls / cat …) already
covers the bulk of them.

## Gate order (planDelegation, then classifyApproval applies facts)

```
tool != Bash                                  -> needs-user  (v0 inspects Bash only)
command substitution  $( )  or backticks      -> privilege
$ variable expansion                          -> needs-user  (unanalyzable)
' " \  quote / backslash                       -> needs-user  (AD-P1-2 concatenation anomaly)
BLACKLIST backstop (rm/sudo/redirect/secret…)  -> privilege
; & | < > ( ) { }  control metacharacter       -> needs-user  (redirect / chain / multi-command / brace group)
* ? [ ] { } ~  expansion metacharacter         -> needs-user  (glob/brace/tilde widen the operand set past the scoped word; r3 ②)
enumerated closed form:
  scope-free form                              -> delegate:allow          (no facts needed)
  path form  + every operand realpath∈cwd AND not a credential -> delegate:allow  (else needs-user)
anything else (incl. ALL git — r3 ①)           -> needs-user
```

Tables are **Maps**, not plain objects, so an inherited key (`constructor`, `toString`, `__proto__`) can never resolve to a
form (AD-R2-P1-1).

## The delegable closed forms

**Scope-free (delegate with no facts — no cwd-relative file read):**
`pwd` (no args) · `echo …` (args are literals) · `which …` · `basename …` · `dirname …`

**Path forms (delegate only when the IO facts prove EVERY operand's realpath (symlinks followed) stays within cwd AND is NOT a
credential — within-cwd ≠ credential-safe, AD-R2-P1-2):**

| command | allowed options (exact, value-less) | operands |
|---|---|---|
| `cat`  | `-n -b` | path(s) |
| `head` | (none) | path(s) |
| `tail` | (none; `-f` excluded) | path(s) |
| `wc`   | `-l -w -c -m -lw -wl` | path(s) |
| `ls`   | `-l -a -la -al -lh -alh -lah -h -1 -R -lR -t -lt -rt -lrt -ltr -r` | optional path(s); none = cwd |
| `file` | (none) | path(s) |
| `stat` | (none) | path(s) |

No git form is delegable in v0 — see Deferred.

## The BLACKLIST backstop (→ escalate:"privilege")

The closed-form table already fails closed on everything un-enumerated; the blacklist only sharpens the REASON so a dangerous
command is labelled `privilege` rather than `needs-user`. Matched forms: `sudo doas` · `rm rmdir mv cp dd mkfs chmod chown
chgrp ln truncate shred` · `kill killall pkill reboot shutdown halt launchctl systemctl service` · `curl wget nc telnet ssh
scp sftp rsync ftp` · `npm pnpm yarn npx pip cargo gem apt brew go docker kubectl` · `env printenv export set` · any `>`
redirect · `… | sh|bash|python|node|…` · `$(…)` / backticks · `git push|commit|reset|clean|checkout|…|config` ·
credential/secret paths (`.env id_rsa .pem .key credentials .aws .ssh .npmrc .git-credentials .netrc secret token password
~/.agenthop/identity`).

## Deferred (NOT safe closed forms yet ⇒ escalate for now)

- **git — ALL subcommands (coordinator r3 ①).** A git read command run AS THE MEMBER TYPED IT honours repo/global config
  (`diff.external`, `*.textconv`, `core.fsmonitor`, `core.pager`, aliases) and can therefore EXECUTE an external program, and
  `git show`/`git diff` can DUMP committed credential content. Neither is config-immune without rewriting the command with
  `-c` overrides (`git -c diff.external= -c core.pager=cat --no-ext-diff …`), which an allow/deny decision cannot do. So git
  is kicked out of v0 and returns via a future ruling once a command-rewrite mechanism is confirmed for the hook (the IO
  round). (The blacklist still labels git MUTATIONS `privilege`; git reads fall to `needs-user`.)
- **grep / rg / find** — not closed forms: `find` has an open-ended action grammar (`-delete`/`-exec`), `rg` is
  recursive-by-default (can't pre-enumerate the files it reads), `grep`'s pattern+recursion surface needs a sound model.

All route to `needs-user` in v0 and return via a future ruling with a verified model. This narrows v0 below the original
example list on purpose (coordinator: "宁可代理集窄到只剩十几个形态").

## How to change this

The user vetoes or expands by ruling; the owner then edits both this file and the tables in `approval-delegation.ts` in the
same change, and the selftest pins the new forms. No silent drift between the doc and the code.
