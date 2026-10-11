# sanitized-read — design brief (FROZEN 2026-10-11; Phase 1 = `cat`, shipped & reviewed)

owner 90b58f9c · reviewer happycapy (01a127b6) · branch `feat/sanitized-read` off main `@20b662d` · the follow-up to the
approval architecture ruling **B** (coordinator runs a hardened read, injects the output; never allows the member's command).
**Design-first: this brief freezes before any code** (the approval-brief judgement). Nothing here is implemented yet.

## Why / goal

approval v1 proved that auto-allowing the MEMBER's own path/git read command is unsound: a resolved path can be symlink-swapped
between the hook's final check and the member's actual read (TOCTOU, irreducible); the member's env/config drive hidden execution
(BASH_ENV, git `diff.external`/pager/fsmonitor/`.gitattributes` filters); `git show` can run filter drivers. So v1 shipped
**scope-free-only** (pwd/echo/which/basename/dirname, impl-pinned) and deferred the real popup BULK — path reads and git reads.

**sanitized-read is ruling B's sound path for that bulk:** the COORDINATOR (via the dispatcher) runs a HARDENED equivalent of the
read in a controlled environment it owns, captures the output, and INJECTS that output back to the member — it NEVER executes the
member's original command. Because the read happens in the coordinator's controlled context (not the member's shell/env/repo
config), the three surfaces close at once: **TOCTOU** (the coordinator does one atomic resolve+read; the member only reads the
captured result), **env** (the coordinator reads with a scrubbed env, no member shell), **filter** (git runs with filters off).

North star (same as approval): **external-activation count ↓** — a path/git read the coordinator can safely serve no longer
reaches the user.

## Non-goals

- NOT a replacement for approval v1's scope-free auto-allow (pwd/echo/… stay delegated — cheaper, no proxy-run).
- READS only. Any write/mutation/privilege always → user (unchanged).
- NOT a general RPC: a FIXED, enumerated set of read forms the coordinator knows how to run hardened. Anything else → user.

## ① Controlled-environment forms (what the coordinator runs, hardened)

The coordinator never execs the member's command string. It performs the EQUIVALENT read in its own controlled process.

### Path reads — `cat` / `head` / `tail` / `wc` / `ls` / `file` / `stat`

- **Resolve** the target hardened: realpath the PARENT dir, open the FINAL component with `O_NOFOLLOW` (reject a symlinked final
  component), confine the resolved realpath to the member's cwd subtree (reject escapes). The member's `cwd` is a verified
  absolute path (carried in the S11 request, as in approval v1).
- **Read** in the coordinator's process: file content (cat/head/tail/wc, applying the form's bounds), dir entries (ls), or
  metadata (stat/file). No member env, no shell, no interpreter. **Phase-1b output semantics (frozen):** bare `head`/`tail` =
  first/last 10 lines; bare `ls` omits dotfiles (matches bare `ls`, not `-a`/`-A`) AFTER the SECRET_RE sweep over every entry; `wc`
  word boundaries use the **C/ASCII** isspace set (C/POSIX-locale `wc` — a multibyte space like U+3000 is not a boundary; a
  UTF-8-locale word count is a separate future contract, not claimed equivalent); `stat` is a defined "sanitized stat format"
  (faithful info, not byte-exact to native `stat`). `file` DEFERRED (fd-read can't reproduce libmagic).
- **TOCTOU closed:** the coordinator does ONE resolve+open+read; the member never execs a path-read whose target can be swapped.
  The member later reads the CAPTURED RESULT (a coordinator-owned tmpfile) whose content is already the sanitized output.

### Git reads — `status` / `log` / `diff` / `show` / `branch` / `remote`

The hardened invocation base: `env -i PATH=<trusted>` (scrub BASH_ENV/GIT_*/all member env) + `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null` + the `-c` full-family (`diff.external=` `core.fsmonitor=` …) + `--no-pager`, with NO
`filter.<x>.clean|process` drivers defined. Split by working-tree dependence:

- **SHIPPED (committed-history reads): `log` / `show` / `diff`** — run in a THROWAWAY `--mirror` clone of the member's repo (clean
  config ⇒ a `.gitattributes` filter names an UNDEFINED driver ⇒ no filter program runs). Implementation `sanitized-read-git.ts`: clone
  source bound to the real git-dir (`rev-parse --absolute-git-dir`, NOT the `core.worktree`-redirectable `--show-toplevel`); the source
  HEAD is REPLICATED into the clone (FULL `symbolic-ref HEAD`, branch/detached/error distinguished by exit code, escalate on
  probe/writeback failure) so an operand-less `log`/`show` reads the member's actual current history; rev operands validated by a
  clone-side `rev-parse --verify ^{commit}`. `diff` requires committed-to-committed revs (two revs OR one `a..b`/`a...b` range) — a
  0-rev or 1-non-range-rev `diff` is a WORKING-TREE diff (member live state) and escalates at the CLASSIFIER, before any clone (F53
  spirit: don't spend budget cloning for an op known to fail-then-escalate).
- **DEFERRED as a FAMILY (coordinator ruling — see ⑤): `branch` / `remote` / `status`** read member-repo LIVE STATE (current branch,
  upstream, worktree occupancy, symref aliases, remotes, working tree) that a clone does NOT reproduce. `branch` was attempted over 5
  review rounds; each surfaced a new live-state facet — the symptom of a tool mismatch, closed by one family ruling, not an endless
  per-form chase. These escalate to the user.
- **Content forms** (show/diff WITH full patch content, `-p`): deferred for now — the current closed flag table is NON-content only
  (`--stat`/`--name-only`/...). Credential content → see ⑤ / open-Q 4.

The git env/exec threat list from the (superseded) `git-recall-brief.md` is the audit INPUT for the scrub set — reuse it.

## ② Output-injection channel

The member issued a read (e.g. Bash `cat foo`) and expects the content on stdout. The coordinator holds the sanitized output.

- **PRIMARY (recommended): allow + `updatedInput` rewrite to read the captured result.** The coordinator writes the sanitized
  output to a result tmpfile (0600, coordinator-owned dir) and records a decision carrying the result-ref. The member hook emits
  `allow` + `updatedInput` rewriting the command to **`builtin command /bin/cat <result-tmpfile>`** — reusing approval v1's
  AD-V1-P1-1 execution binding verbatim. The member runs it → gets the exact sanitized output on stdout, transparently (identical
  to having run the original). Handles any output size. The rewrite is SINGLE-QUOTED and the hook validates a strict `<hex>.out` path under the 0600 result dir; a same-uid member can still swap the result file (the accepted same-uid active-race residual, ⑤).
- **ALTERNATIVE (fallback): deny + a reason carrying the output** — only where a rewrite is not viable (a non-Bash structured
  tool, or a policy forbidding the member running anything). Size-limited (reason field) and framed as a denial; worse UX.
- **Hook contract to re-verify at ship** (as v1 did): a sync PermissionRequest hook returning `allow` MAY set
  `decision.updatedInput` (replaces the whole tool_input, re-evaluated against deny/ask). Confirmed in v1; re-verify. Also verify
  the member-visible shape of the deny+message fallback.

## ③ Seam with the approval stack

Reuse the ENTIRE approval pipeline (S11 request → dispatcher drains the dedicated key → classify → control-log decision → hook
polls back by requestId → emits). Add a FOURTH verdict class:

- **SHIPPED as a 4th `CoordinatorAction` act `sanitize`** (NOT a 4th `ApprovalVerdict` class — coordinator-accepted: `sanitize`
  requires IO = a coordinator action, and it avoids a `sanitized-read`↔`approval-delegation` import cycle; `classifyApproval` stays
  v1-pure, the sanitize fork lives in `planCoordinatorAction`). Conceptually: `sanitize` = a path/git read matching the enumerated forms
  AND passing the structural guards (the same control-char/metachar/glob/quote/`$`/blacklist guards as v1). privilege/unknown stay
  `escalate`; scope-free stays `delegate`.
- `classifyApproval`: the path/git forms that today → `escalate("needs-user")` move to → `sanitize` (gated on the new flag).
- Coordinator side (a dispatcher sweep sub-step, sibling of `runApprovalDelegation`): for a `sanitize` verdict, RUN the hardened
  read (①) under the budget (④), write the result tmpfile, and commit a control-log decision reusing the **`permissionDecision`**
  kind with `behavior:"allow"` + `rewrite: "builtin command /bin/cat <result>"`. The member-side hook flowback is then IDENTICAL
  to a `delegate` (emit allow + updatedInput) — the member side barely changes; the rewrite just points at the coordinator's
  result. (FC-7: `rewrite` already exists on the decision; a `sanitizedResultRef`/audit field is additive.)
- **Dormancy:** a NEW opt-in flag `SWARM_SANITIZED_READ` (default OFF), independent of `SWARM_APPROVAL_DELEGATE` — enable separately.

## ④ Budget & latency bounds

The coordinator's hardened read has COST (esp. a git worktree) + LATENCY (the member blocks on the hook poll, ≤ `APPROVAL_POLL_SEC`).

- **Per-read budget** `SANITIZED_READ_BUDGET_SEC`: exceeding it ⇒ the coordinator records NO decision ⇒ the hook times out ⇒
  **fail-to-USER** (never hang; never auto-allow the member's original command). Same fail-safe direction as approval.
- **Cost control:** cache/reuse a hardened worktree per repo (do not clone per read); **output-size cap** (a huge file ⇒
  truncate-with-marker OR escalate — open-Q 6).
- The read runs in the dispatcher sweep ASYNC + single-flight per request, so it never blocks the dispatcher loop.

## ⑤ Threat-model residual (explicit)

**Same-uid attacker model (coordinator ruling — ONE unified non-differential class).** The coordinator and the member run as the
SAME uid (the user's machine). A member that wants a file the user has not approved can read it DIRECTLY (`cat /etc/foo` itself —
the popup only asks the user to *look*). So the residuals below — the shell-init startup code, the macOS lstat-walk race window,
and the result-tmpfile swap — are ONE class: a member that ACTIVELY races the coordinator can bypass the user's look, but NEVER
gains privilege or new reachability. Per the coordinator ruling (the approval shell-init precedent) this class is a **scope
exclusion** — documented here, excluded from the review gate, NOT a claim of verified equivalence with manual approval, and no
per-item user sign-off (differential ≈ zero). Each bullet records its specific mechanism.

- **Same-machine only:** the coordinator needs filesystem access to the member's cwd/repo. REMOTE members (vm-ctl/placement boxes)
  ⇒ the coordinator cannot read their files ⇒ those reads fall to the user (ship-the-file is out of scope). Stated loudly.
- **Shell-init residual (inherited from v1):** the member runs the rewrite in its OWN shell ⇒ a BASH_ENV/startup-file residual —
  part of the same-uid non-differential class above (a scope exclusion, not asserted equivalent to manual approval).
- **Result-tmpfile TOCTOU (same-uid):** a same-uid member can swap the result tmpfile between the hook's lstat and `/bin/cat`, so
  `cat` reads a DIFFERENT file than the sanitized result. That different file is nonetheless something the member can read
  DIRECTLY (same uid) — part of the accepted same-uid active-race class above (no new reachability; the swap is not claimed
  harmless, it is scope-excluded). The hook still validates shape + strict `<hex>.out` under the 0600 coordinator-owned dir.
- **Returned content is entitled:** sanitized-read returns content the member may already read (its own cwd files / committed
  history). The `SECRET_RE` credential guard is a CONSERVATIVE POLICY choice (the user may want to know when the agent reads
  `.env`), NOT a confidentiality boundary — the member could read them anyway (open-Q 4).
- **git in-place residual:** if open-Q 3 picks in-place hardening for working-tree forms, the repo's OWN `.git/config` filter
  drivers are a non-enumerable exec residual (run by the COORDINATOR, in a scrubbed-but-repo-configured env — lower blast than the
  member's, but it IS the coordinator). Throwaway-worktree (copy) or defer avoids it.
- **Coordinator blast radius:** a missed scrub vector exec's in the COORDINATOR's controlled process. The env-scrub + filter-disable
  set must be audited against the git-recall env/exec threat list.
- **FAMILY RULING (coordinator 2026-10-11) — member-repo LIVE-STATE forms are OUTSIDE the clone-model domain; the sanitize Phase
  does not handle them.** A clone faithfully reproduces committed-history CONTENT, but NOT live repo state (current branch, upstream,
  worktree occupancy, symref aliases, configured remotes, the working tree). So `branch` / `remote` / `status` (and any future form
  that reads live repo state) are DEFERRED to the user as a FAMILY — one ruling, not a per-form chase (the repeated "next facet"
  rounds on `branch` were the symptom of a tool mismatch, not a fixable gap). Sanitize git scope = committed-history reads only.

## Scope / phasing (recommendation)

- **Phase 1 — `cat <file>` ONLY (SHIPPED)**: the canonical path read (byte-exact via an O_NOFOLLOW fd), proving the whole pipeline;
  head/tail/wc/ls/stat are a `readKind`→producer table extension (Phase 1b — SHIPPED); `file` is DEFERRED (coordinator 2026-10-11:
  the fd-read model can't reproduce libmagic, and a hardened `/usr/bin/file` subprocess would open a new exec surface beyond the
  sound cat path — not worth it for one low-frequency form). Cleanest, no git complexity. Delivers the
  `sanitize` verdict + the output-injection channel + the budget/fail-to-user + the dormant flag.
- **Phase 2 — git committed-history CONTENT reads (SHIPPED): `log`/`show`/`diff`, NON-content**, via a throwaway `--mirror` clone +
  scrubbed env (`env -i`-equivalent) + `-c diff.external=`/`-c core.fsmonitor=` + `--no-pager`/`--no-ext-diff`. A `--mirror` clone
  does NO checkout and uses git's LOCAL transport (no upload-pack) ⇒ no filter/fsmonitor/packObjectsHook exec (verified against four
  planted vectors). Closed flag table REUSED from the frozen git-recall brief; rev operands validated by a clone-side
  `rev-parse --verify ^{commit}` (no pathspec/content); the source HEAD is replicated (full symbolic ref + exit-code checks) so an
  operand-less `log`/`show` reads the member's actual current history. Patch-content forms (`show`/`diff` -p) stay escalated.
  **r2-r5 review fixes (happycapy SR2-P2-1..5 + SR2-R2-P2-1):** `--absolute-git-dir` clone source (not the `core.worktree`-redirectable
  toplevel) + full-path-char preserve; HEAD via the FULL symbolic ref with branch/detached/error exit-code distinction (escalate on
  probe/writeback failure); `truncated` on ANY over-cap byte (exact-cap-complete stays unmarked); GC cleans ONLY result files (the
  scratch-cleanup ledger + scratch dir survive); ALL scratch FS is ASYNC (a slow delete never blocks the sweep).
  **FAMILY DEFERRAL (coordinator ruling 2026-10-11): `branch`/`remote`/`status` are OUT of the sanitize Phase domain** — see the
  residual section's family-ruling line (member-repo LIVE-STATE is outside the clone model). `branch` was attempted then deferred
  after 5 rounds proved its output (current `*`, upstream, worktree `+`, symref `->` arrows) is live state a clone can't reproduce.
- **Phase 3 (open) — git working-tree-dependent** (status, unstaged diff): subsumed by the family deferral above (member-repo live state).

Each phase is a separate reviewable unit; Phase 1 is the pipeline proof (mirrors how v1 shipped scope-free first).

## FC / constraint self-check

- ① privilege/mutation never sanitized (→ escalate, unchanged). ② the sanitize decision is recorded (control-log, reuse
  `permissionDecision`). ③ reuse the approval pipeline + control-log; the only new surface is the result-tmpfile dir (minimal,
  GC'd; or inline small results — open-Q 5). ④ Claude members only (same hook). **FC-6:** decisions keyed by requestId, no
  latest-wins. **FC-7:** the `sanitize` verdict + `sanitizedResultRef` are additive; legacy decisions unaffected.
- cli must NOT import bus (the hook CLI duplicates helpers, as in v1).

## Open questions — ALL FROZEN 2026-10-11 (coordinator ruled; recorded here for history)

1. **② injection:** PRIMARY = `updatedInput` rewrite to `builtin command /bin/cat <result-tmpfile>` (recommended) vs the
   deny+message fallback. (Re-verify the hook contract at ship.)
2. **③ verdict:** add a 4th `sanitize` class to `ApprovalVerdict` (recommended) vs overloading `delegate`.
3. **git working-tree forms (status/unstaged diff):** in-place-hardened-with-residual (a) / copy-the-tree throwaway (b) / defer to
   Phase 3 (c)? (Recommend c: ship committed-history first, decide working-tree later.)
4. **credential paths (`SECRET_RE`):** keep the escalate-to-user guard (conservative — the user learns when the agent reads
   `.env`) or drop it (the member owns them)? (Recommend KEEP: cheap, matches v1's conservatism.)
5. **result channel:** a coordinator-owned tmpfile dir (0600, GC'd) vs inlining small results in the decision + rewrite to
   `echo`? (Recommend tmpfile for size-independence; inline only as an optimization.)
6. **budget:** `SANITIZED_READ_BUDGET_SEC` default (propose 10s) + output-size cap (propose 1 MiB → truncate-with-marker) +
   fail-to-user confirmed.

Freeze answers (coordinator 2026-10-11): ① updatedInput rewrite + lstat the result path; ② the `sanitize` verdict (shipped as a
`CoordinatorAction` act, above); ③ git working-tree → Phase 3; ④ keep `SECRET_RE` (case-insensitive; reuse, no new regex); ⑤
tmpfile 0600 coordinator-owned; ⑥ budget 10s / cap 1 MiB / explicit `[truncated at 1MiB]` marker / fail-to-user. The two TOCTOU
walls (SR-P1-1 fd-binding, SR-P1-3 result-swap) → /proc-on-Linux + lstat-walk-on-macOS + strict validation + the unified same-uid
non-differential residual class (⑤). **Phase 1 (`cat`) + Phase 1b (head/tail/wc/ls/stat; `file` deferred) + Phase 2 (git `log`/`show`/`diff` via `--mirror` clone) shipped. FINAL git scope = committed-history reads only; `branch`/`remote`/`status` DEFERRED as a family (member-repo live-state, outside the clone model — ⑤). No further sanitize phases planned.**
