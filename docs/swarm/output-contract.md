# output-contract (filing) — a delivery claim must attach verifiable evidence

owner aad02248 · 2026-10-10 · 协调者派单(user ruling, dual-mirror absorption ③ — my own engine-mirror's secondary borrow) · design input `docs/research/langchain-crewai-eval.md` (CrewAI task.expected_output + guardrail) · 基线 main @7b8e87c · 状态:**纯核 + dormant,待复审**

## What

CrewAI tasks declare an `expected_output` (acceptance contract) + a `guardrail` (validation). We review downstream (grill-gate / 审查席) but have no task-level declared evidence. This adds it as the DISTRIBUTED reinforcement of AgentGate's EXIT-fingerprint principle: **a CLAIM of delivery must attach VERIFIABLE physical evidence.** A dispatch may declare an expected output; at delivery-receipt the seam probes the filesystem and classifies it — `met` / `unmet` / `unknown`.

## The contract + verdict

`TaskRecord.expectedOutput?: { kind, ref?, check? }` — four kinds of evidence:

| kind | evidence | probe |
|---|---|---|
| `file` | a file was written | `existsSync` + non-empty (`statSync().size > 0`) |
| `branch` | a branch exists | `git rev-parse --verify --quiet <ref>` (exit 0 = met, exit 1 = unmet, git missing = unknown) |
| `report` | a review report cites a commit | report file present + contains a SHA token line |
| `inbox-delivery` | a durable message landed | target `inbox/<ref>/processed/` has a file whose `taskRef` matches |

`verifyExpectedOutput(expected, facts)` is PURE and three-state: probe `true ⇒ met`, `false ⇒ unmet`, `null`/absent `⇒ unknown`. A read failure is **never** asserted as `unmet` (FC-2 r3) — it degrades to `unknown`. No clock anywhere (FC-6).

## Split (pure layer + thin IO shell)

- `packages/bus/src/swarm/output-contract.ts`:
  - **pure**: `ExpectedOutputKind` (4), `EXPECTED_OUTPUT_KINDS`, `ExpectedOutput`, `OutputVerdict`, `OutputFacts`, `outputContractEnabled` (SWARM_OUTPUT_CONTRACT default OFF), `isExpectedOutputKind`, `validateExpectedOutput` (shape guard → clean copy or null), `verifyExpectedOutput` (classify).
  - **IO shell (best-effort)**: `probeExpectedOutput` (fs/git/inbox probes; every read error ⇒ null ⇒ unknown), `presentUnmetToCoordinator` (S19 durable card, via the existing inbox transport).
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
- Gates: output-contract selftest (all) ; tasklog tests 55/55 UNCHANGED; attribution selftest 24/24 UNCHANGED; bus `tsc --noEmit` = 0. shared-budget / decision-batch / attribution untouched. DORMANT (SWARM_OUTPUT_CONTRACT off; not wired into a live delivery path). Base main @7b8e87c.
