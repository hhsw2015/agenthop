# sanitized-read â design brief (FROZEN 2026-10-11; Phase 1 = `cat`, shipped & reviewed)

owner 90b58f9c Â· reviewer happycapy (01a127b6) Â· branch `feat/sanitized-read` off main `@20b662d` Â· the follow-up to the
approval architecture ruling **B** (coordinator runs a hardened read, injects the output; never allows the member's command).
**Design-first: this brief freezes before any code** (the approval-brief judgement). Nothing here is implemented yet.

## Why / goal

approval v1 proved that auto-allowing the MEMBER's own path/git read command is unsound: a resolved path can be symlink-swapped
between the hook's final check and the member's actual read (TOCTOU, irreducible); the member's env/config drive hidden execution
(BASH_ENV, git `diff.external`/pager/fsmonitor/`.gitattributes` filters); `git show` can run filter drivers. So v1 shipped
**scope-free-only** (pwd/echo/which/basename/dirname, impl-pinned) and deferred the real popup BULK â path reads and git reads.

**sanitized-read is ruling B's sound path for that bulk:** the COORDINATOR (via the dispatcher) runs a HARDENED equivalent of the
read in a controlled environment it owns, captures the output, and INJECTS that output back to the member â it NEVER executes the
member's original command. Because the read happens in the coordinator's controlled context (not the member's shell/env/repo
config), the three surfaces close at once: **TOCTOU** (the coordinator does one atomic resolve+read; the member only reads the
captured result), **env** (the coordinator reads with a scrubbed env, no member shell), **filter** (git runs with filters off).

North star (same as approval): **external-activation count â** â a path/git read the coordinator can safely serve no longer
reaches the user.

## Non-goals

- NOT a replacement for approval v1's scope-free auto-allow (pwd/echo/â¦ stay delegated â cheaper, no proxy-run).
- READS only. Any write/mutation/privilege always â user (unchanged).
- NOT a general RPC: a FIXED, enumerated set of read forms the coordinator knows how to run hardened. Anything else â user.

## â  Controlled-environment forms (what the coordinator runs, hardened)

The coordinator never execs the member's command string. It performs the EQUIVALENT read in its own controlled process.

### Path reads â `cat` / `head` / `tail` / `wc` / `ls` / `file` / `stat`

- **Resolve** the target hardened: realpath the PARENT dir, open the FINAL component with `O_NOFOLLOW` (reject a symlinked final
  component), confine the resolved realpath to the member's cwd subtree (reject escapes). The member's `cwd` is a verified
  absolute path (carried in the S11 request, as in approval v1).
- **Read** in the coordinator's process: file content (cat/head/tail/wc, applying the form's bounds), dir entries (ls), or
  metadata (stat/file). No member env, no shell, no interpreter.
- **TOCTOU closed:** the coordinator does ONE resolve+open+read; the member never execs a path-read whose target can be swapped.
  The member later reads the CAPTURED RESULT (a coordinator-owned tmpfile) whose content is already the sanitized output.

### Git reads â `status` / `log` / `diff` / `show` / `branch` / `remote`

The hardened invocation base: `env -i PATH=<trusted>` (scrub BASH_ENV/GIT_*/all member env) + `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null` + the `-c` full-family (`diff.external=` `core.fsmonitor=` â¦) + `--no-pager`, with NO
`filter.<x>.clean|process` drivers defined. Split by working-tree dependence:

- **Working-tree-INDEPENDENT** (log/show/branch/remote + committed history): run in a THROWAWAY worktree/clone of the member's
  repo. A clean config means a `.gitattributes` filter names an UNDEFINED driver â git runs no filter program. Reuse the existing
  scratch-dir git-read pattern (`observeResultOnBranch`/`scratchPath`, `task-observe.ts`) as the building block.
- **Working-tree-DEPENDENT** (status, unstaged diff): needs the member's ACTUAL working tree (a throwaway clone loses uncommitted
  state) â see **open-Q 3** (in-place-hardened-with-residual vs copy-the-tree vs defer).
- **Content forms** (show/diff WITH content): SAFE under sanitized-read â the exec surface is closed by the hardened env, and the
  returned content is the member's OWN repo content (it is already entitled to read it; not a new leak). This is strictly MORE
  coverage than v1 (which deferred all git). Credential content â see â¤ / open-Q 4.

The git env/exec threat list from the (superseded) `git-recall-brief.md` is the audit INPUT for the scrub set â reuse it.

## â¡ Output-injection channel

The member issued a read (e.g. Bash `cat foo`) and expects the content on stdout. The coordinator holds the sanitized output.

- **PRIMARY (recommended): allow + `updatedInput` rewrite to read the captured result.** The coordinator writes the sanitized
  output to a result tmpfile (0600, coordinator-owned dir) and records a decision carrying the result-ref. The member hook emits
  `allow` + `updatedInput` rewriting the command to **`builtin command /bin/cat <result-tmpfile>`** â reusing approval v1's
  AD-V1-P1-1 execution binding verbatim. The member runs it â gets the exact sanitized output on stdout, transparently (identical
  to having run the original). Handles any output size. The rewrite is SINGLE-QUOTED and the hook validates a strict `<hex>.out` path under the 0600 result dir; a same-uid member can still swap the result file (the accepted same-uid active-race residual, ⑤).
- **ALTERNATIVE (fallback): deny + a reason carrying the output** â only where a rewrite is not viable (a non-Bash structured
  tool, or a policy forbidding the member running anything). Size-limited (reason field) and framed as a denial; worse UX.
- **Hook contract to re-verify at ship** (as v1 did): a sync PermissionRequest hook returning `allow` MAY set
  `decision.updatedInput` (replaces the whole tool_input, re-evaluated against deny/ask). Confirmed in v1; re-verify. Also verify
  the member-visible shape of the deny+message fallback.

## â¢ Seam with the approval stack

Reuse the ENTIRE approval pipeline (S11 request â dispatcher drains the dedicated key â classify â control-log decision â hook
polls back by requestId â emits). Add a FOURTH verdict class:

- **SHIPPED as a 4th `CoordinatorAction` act `sanitize`** (NOT a 4th `ApprovalVerdict` class â coordinator-accepted: `sanitize`
  requires IO = a coordinator action, and it avoids a `sanitized-read`â`approval-delegation` import cycle; `classifyApproval` stays
  v1-pure, the sanitize fork lives in `planCoordinatorAction`). Conceptually: `sanitize` = a path/git read matching the enumerated forms
  AND passing the structural guards (the same control-char/metachar/glob/quote/`$`/blacklist guards as v1). privilege/unknown stay
  `escalate`; scope-free stays `delegate`.
- `classifyApproval`: the path/git forms that today â `escalate("needs-user")` move to â `sanitize` (gated on the new flag).
- Coordinator side (a dispatcher sweep sub-step, sibling of `runApprovalDelegation`): for a `sanitize` verdict, RUN the hardened
  read (â ) under the budget (â£), write the result tmpfile, and commit a control-log decision reusing the **`permissionDecision`**
  kind with `behavior:"allow"` + `rewrite: "builtin command /bin/cat <result>"`. The member-side hook flowback is then IDENTICAL
  to a `delegate` (emit allow + updatedInput) â the member side barely changes; the rewrite just points at the coordinator's
  result. (FC-7: `rewrite` already exists on the decision; a `sanitizedResultRef`/audit field is additive.)
- **Dormancy:** a NEW opt-in flag `SWARM_SANITIZED_READ` (default OFF), independent of `SWARM_APPROVAL_DELEGATE` â enable separately.

## â£ Budget & latency bounds

The coordinator's hardened read has COST (esp. a git worktree) + LATENCY (the member blocks on the hook poll, â¤ `APPROVAL_POLL_SEC`).

- **Per-read budget** `SANITIZED_READ_BUDGET_SEC`: exceeding it â the coordinator records NO decision â the hook times out â
  **fail-to-USER** (never hang; never auto-allow the member's original command). Same fail-safe direction as approval.
- **Cost control:** cache/reuse a hardened worktree per repo (do not clone per read); **output-size cap** (a huge file â
  truncate-with-marker OR escalate â open-Q 6).
- The read runs in the dispatcher sweep ASYNC + single-flight per request, so it never blocks the dispatcher loop.

## â¤ Threat-model residual (explicit)

**Same-uid attacker model (coordinator ruling â ONE unified non-differential class).** The coordinator and the member run as the
SAME uid (the user's machine). A member that wants a file the user has not approved can read it DIRECTLY (`cat /etc/foo` itself â
the popup only asks the user to *look*). So the residuals below â the shell-init startup code, the macOS lstat-walk race window,
and the result-tmpfile swap â are ONE class: a member that ACTIVELY races the coordinator can bypass the user's look, but NEVER
gains privilege or new reachability. Per the coordinator ruling (the approval shell-init precedent) this class is a **scope
exclusion** â documented here, excluded from the review gate, NOT a claim of verified equivalence with manual approval, and no
per-item user sign-off (differential â zero). Each bullet records its specific mechanism.

- **Same-machine only:** the coordinator needs filesystem access to the member's cwd/repo. REMOTE members (vm-ctl/placement boxes)
  â the coordinator cannot read their files â those reads fall to the user (ship-the-file is out of scope). Stated loudly.
- **Shell-init residual (inherited from v1):** the member runs the rewrite in its OWN shell â a BASH_ENV/startup-file residual â
  part of the same-uid non-differential class above (a scope exclusion, not asserted equivalent to manual approval).
- **Result-tmpfile TOCTOU (same-uid):** a same-uid member can swap the result tmpfile between the hook's lstat and `/bin/cat`, so
  `cat` reads a DIFFERENT file than the sanitized result. That different file is nonetheless something the member can read
  DIRECTLY (same uid) â part of the accepted same-uid active-race class above (no new reachability; the swap is not claimed
  harmless, it is scope-excluded). The hook still validates shape + strict `<hex>.out` under the 0600 coordinator-owned dir.
- **Returned content is entitled:** sanitized-read returns content the member may already read (its own cwd files / committed
  history). The `SECRET_RE` credential guard is a CONSERVATIVE POLICY choice (the user may want to know when the agent reads
  `.env`), NOT a confidentiality boundary â the member could read them anyway (open-Q 4).
- **git in-place residual:** if open-Q 3 picks in-place hardening for working-tree forms, the repo's OWN `.git/config` filter
  drivers are a non-enumerable exec residual (run by the COORDINATOR, in a scrubbed-but-repo-configured env â lower blast than the
  member's, but it IS the coordinator). Throwaway-worktree (copy) or defer avoids it.
- **Coordinator blast radius:** a missed scrub vector exec's in the COORDINATOR's controlled process. The env-scrub + filter-disable
  set must be audited against the git-recall env/exec threat list.

## Scope / phasing (recommendation)

- **Phase 1 â `cat <file>` ONLY (SHIPPED)**: the canonical path read (byte-exact via an O_NOFOLLOW fd), proving the whole pipeline;
  head/tail/wc/ls/stat/file are a `readKind`âproducer table extension (Phase 1b). Cleanest, no git complexity. Delivers the
  `sanitize` verdict + the output-injection channel + the budget/fail-to-user + the dormant flag.
- **Phase 2 â git committed-history** (log/show/diff/branch/remote, incl. content) via throwaway-worktree hardening.
- **Phase 3 (open) â git working-tree-dependent** (status, unstaged diff): pending open-Q 3.

Each phase is a separate reviewable unit; Phase 1 is the pipeline proof (mirrors how v1 shipped scope-free first).

## FC / constraint self-check

- â  privilege/mutation never sanitized (â escalate, unchanged). â¡ the sanitize decision is recorded (control-log, reuse
  `permissionDecision`). â¢ reuse the approval pipeline + control-log; the only new surface is the result-tmpfile dir (minimal,
  GC'd; or inline small results â open-Q 5). â£ Claude members only (same hook). **FC-6:** decisions keyed by requestId, no
  latest-wins. **FC-7:** the `sanitize` verdict + `sanitizedResultRef` are additive; legacy decisions unaffected.
- cli must NOT import bus (the hook CLI duplicates helpers, as in v1).

## Open questions â ALL FROZEN 2026-10-11 (coordinator ruled; recorded here for history)

1. **â¡ injection:** PRIMARY = `updatedInput` rewrite to `builtin command /bin/cat <result-tmpfile>` (recommended) vs the
   deny+message fallback. (Re-verify the hook contract at ship.)
2. **â¢ verdict:** add a 4th `sanitize` class to `ApprovalVerdict` (recommended) vs overloading `delegate`.
3. **git working-tree forms (status/unstaged diff):** in-place-hardened-with-residual (a) / copy-the-tree throwaway (b) / defer to
   Phase 3 (c)? (Recommend c: ship committed-history first, decide working-tree later.)
4. **credential paths (`SECRET_RE`):** keep the escalate-to-user guard (conservative â the user learns when the agent reads
   `.env`) or drop it (the member owns them)? (Recommend KEEP: cheap, matches v1's conservatism.)
5. **result channel:** a coordinator-owned tmpfile dir (0600, GC'd) vs inlining small results in the decision + rewrite to
   `echo`? (Recommend tmpfile for size-independence; inline only as an optimization.)
6. **budget:** `SANITIZED_READ_BUDGET_SEC` default (propose 10s) + output-size cap (propose 1 MiB â truncate-with-marker) +
   fail-to-user confirmed.

Freeze answers (coordinator 2026-10-11): â  updatedInput rewrite + lstat the result path; â¡ the `sanitize` verdict (shipped as a
`CoordinatorAction` act, above); â¢ git working-tree â Phase 3; â£ keep `SECRET_RE` (case-insensitive; reuse, no new regex); â¤
tmpfile 0600 coordinator-owned; â¥ budget 10s / cap 1 MiB / explicit `[truncated at 1MiB]` marker / fail-to-user. The two TOCTOU
walls (SR-P1-1 fd-binding, SR-P1-3 result-swap) â /proc-on-Linux + lstat-walk-on-macOS + strict validation + the unified same-uid
non-differential residual class (â¤). **Phase 1 (`cat`) shipped & reviewed; Phase 1b (head/tail/wc/ls/stat/file) + Phase 2 (git) next.**
