# output-contract (filing) — a delivery claim must attach verifiable evidence

owner aad02248 · 2026-10-10 · 协调者派单(user ruling, dual-mirror absorption ③ — my own engine-mirror's secondary borrow) · design input `docs/research/langchain-crewai-eval.md` (CrewAI task.expected_output + guardrail) · 基线 main @7b8e87c · 状态:**纯核 + dormant,r2 IO 证据层硬化(OC-1..OC-5)后待复审**

## What

CrewAI tasks declare an `expected_output` (acceptance contract) + a `guardrail` (validation). We review downstream (grill-gate / 审查席) but have no task-level declared evidence. This adds it as the DISTRIBUTED reinforcement of AgentGate's EXIT-fingerprint principle: **a CLAIM of delivery must attach VERIFIABLE physical evidence.** A dispatch may declare an expected output; at delivery-receipt the seam probes the filesystem and classifies it — `met` / `unmet` / `unknown`.

## The contract + verdict

`TaskRecord.expectedOutput?: { kind, ref?, check? }` — four kinds of evidence:

| kind | evidence | probe (r2, hardened — each discriminator passes our own FC judgment) |
|---|---|---|
| `file` | a regular file was written | errno-aware `statSync` + **`isFile()`** + non-empty. A directory or empty file ⇒ `unmet`; a confirmed ENOENT ⇒ `unmet`; any other stat error ⇒ `unknown` (OC-1/OC-2). |
| `branch` | a branch exists | **`git show-ref --verify --quiet refs/heads/<ref>`** (exit 0 = met, exit 1 = unmet, not-a-repo/git-missing (128/ENOENT) ⇒ unknown). A tag or bare commit no longer passes — the branch namespace is enforced (OC-3). |
| `report` | a review report cites a commit | report file present (a dir ⇒ unmet) + a **context-anchored** commit citation: a label (`固定`/`sha`/`sha256`/`commit`/`@`) immediately before a 7-64 hex token at word boundaries. A bare date (`20261011`) or session UUID does **not** pass (OC-4). A read fault ⇒ unknown. |
| `inbox-delivery` | a durable message landed | a `taskRef` match in the box **top level** (a published `.json`, or an in-flight `.claim-<pid>` rename) **OR** `processed/`. A match ⇒ `met`. **Absence ⇒ unknown, never `unmet`**: ack DELETES the claimed file, so a normally delivered+consumed message leaves no trace — absence is not proof of non-delivery (OC-5). A read fault ⇒ unknown. |

`verifyExpectedOutput(expected, facts)` is PURE and three-state: probe `true ⇒ met`, `false ⇒ unmet`, `null`/absent `⇒ unknown`. A read failure is **never** asserted as `unmet` (FC-2 r3) — it degrades to `unknown`. No clock anywhere (FC-6). For `inbox-delivery` the probe only ever emits `true`/`null` (met-or-unknown): absence after ack is ambiguous, so it is never a negative verdict.

## Split (pure layer + thin IO shell)

- `packages/bus/src/swarm/output-contract.ts`:
  - **pure**: `ExpectedOutputKind` (4), `EXPECTED_OUTPUT_KINDS`, `ExpectedOutput`, `OutputVerdict`, `OutputFacts`, `outputContractEnabled` (SWARM_OUTPUT_CONTRACT default OFF), `isExpectedOutputKind`, `validateExpectedOutput` (shape guard → clean copy or null), `verifyExpectedOutput` (classify).
  - **IO shell (best-effort; r2-hardened)**: `statProbe` (errno-aware: ENOENT ⇒ absent, any other error ⇒ unknown — never false-unmet), `reportCitesCommit` (context-anchored `COMMIT_REF`), `inboxSid` (matches writeInbox's path sanitize), `probeExpectedOutput` (fs/git/inbox probes — `isFile()` for file, `show-ref refs/heads/` for branch, landing-credential scan of top-level `.json`/`.claim-*` + `processed/` for inbox; every read fault ⇒ null ⇒ unknown), `presentUnmetToCoordinator` (S19 durable card, via the existing inbox transport).
- `packages/bus/src/tasklog.ts`: `TaskRecord` gains optional `expectedOutput?`; `createTask` stores only a validated one; `parseTask` validates on READ (a malformed kind / non-string ref/check ⇒ DROP the field, base task stays readable — the AC-1 read-side discipline).
- `output-contract.selftest.mts`: pure three-state per kind + validation + FC-6, real-fs/git/inbox probes for all four kinds, S19 present, tasklog carry-through + read-side drop + FC-7.

## Seam (delivery-receipt; dormant)

When `outputContractEnabled()`, at the delivery-receipt handler (where an assignee claims a result): `probeExpectedOutput` → `verifyExpectedOutput`; on **`unmet`** call `presentUnmetToCoordinator` ("claimed delivered but output verification failed"). An `unknown` is never asserted (FC-2 r3). Not auto-wired — the handler opts in via the flag.

## Not authorization

This is a VERIFICATION tag, like attribution is a SOURCE tag: it informs the coordinator/human; it reads no cap and gates no permission. It does not change C8/R16.

## Self-check (FC-6 / FC-7 / FC-2 r3)

- **FC-6**: the verdict is purely the probe value — no timestamp / latest-wins.
- **FC-7**: `expectedOutput` is OPTIONAL; a legacy `TaskRecord` without it parses and reads unchanged; a corrupt field on disk degrades (dropped) rather than rejecting the record.
- **FC-2 r3**: a read error on any probe ⇒ `unknown`, never a false `unmet`.
- Gates (r2, all re-run after the IO-layer hardening): output-contract selftest ALL pass (40 assertions incl. the new OC-1..OC-5 regressions: dir-not-file, tag-not-branch, date/UUID-not-commit-ref, real writeInbox→claim→ack lifecycle, EACCES/not-a-repo ⇒ unknown, unknown-presents-no-card); full bus vitest **1424/1424**; attribution selftest ALL pass; bus `tsc --noEmit` = 0. Only `output-contract.ts` + its selftest changed — the pure core (`verifyExpectedOutput`/`validateExpectedOutput`/3-state) and every boundary file (tasklog / shared-budget / decision-batch / attribution) are byte-unchanged. DORMANT (SWARM_OUTPUT_CONTRACT off; not wired into a live delivery path). Base main @7b8e87c.

## r2 review fixes (OC-1..OC-5, codex:Work首审 @3125ccc)

All five were in the IO evidence layer (the pure core passed) — "核验器自身要过我们自己的判例门":
- **OC-1 (FC-2 r3)**: read faults (EACCES, not-a-repo) were folded to `unmet`. Now errno-aware: ENOENT ⇒ `unmet`, any other error ⇒ `unknown`. The inbox scan never derives `unmet` from absence.
- **OC-2**: a non-empty directory passed `file`. Now `statSync().isFile()` is required.
- **OC-3**: a tag passed `branch` (`rev-parse` accepts any revision). Now `show-ref --verify refs/heads/<ref>` locks the branch namespace.
- **OC-4**: `/\b[0-9a-f]{7,64}\b/` matched a date/UUID. Now a context-anchored label (`固定`/`sha`/`sha256`/`commit`/`@`) must precede the hex token.
- **OC-5**: the probe only checked `processed/`, judging a normal delivery `unmet`. Now it reads the real landing credential (top-level `.json`/`.claim-*` or `processed/`); a match ⇒ `met`, absence ⇒ `unknown` (ack deletes the file — absence is not proof of non-delivery).
