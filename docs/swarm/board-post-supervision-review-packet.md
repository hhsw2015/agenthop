# Review packet — BA9 board-post supervision (§2d-a, an R14 pre-flight)

- **Branch** `feat/board-post-supervision`  **HEAD** `52533f3`  **Base** `main` (`5da42b5`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/board-post-supervision-design.md` @`93023c6` (coordinator-approved, zero change)

## What this is
A posted-but-unclaimed board item that is STILL ready is never reaped by `planBoardWrites` (reap only fires when the node stops being ready), so without supervision it can sit forever — a silent stall that must be closed before `SWARM_BOARD_ADMIT` can flip (R14). BA9 adds the escalation: REPOST (bounded) -> REPORT (coordinator incident, deduped) -> RECLAIM (dead-letter). DORMANT behind `SWARM_BOARD_ADMIT`.

## Design decisions
- Pure `superviseBoardPost(item, now, policy)` returns one action; `planBoardSupervision(existing, readyItemIds, now, policy, reportedIds)` reduces the board dir to `{reposts, reports, reclaims}`. The dispatcher does only the thin IO.
- RECLAIM is TERMINAL via a new `reclaimed` board state: a `<itemId>.reclaimed.<who>.json` dead-letters the node and `planBoardWrites` never auto-re-posts it — closing the reclaim->repost loop (a coordinator must re-enqueue).
- REPORT uses the S19 form (`buildApprovalDoc`) so it can later feed decision-batch; deduped by a `.report.json` marker.
- Policy is env-tunable (`SWARM_BOARD_CLAIM_TTL_SEC` / `_MAX_REPOSTS` / `_REPORT_GRACE_SEC`).

## Boundaries
1. Dormant: runs only inside the existing `boardAdmitEnabled()` guard; gate off ⇒ nothing.
2. Acts ONLY on a `posted` STILL-ready unclaimed file whose name binds its body (BA4); never touches `claimed`/`granted`/`rejected`/`done`.
3. Reposts/reclaims are atomic; reports dedup per itemId; all idempotent on replay. No CONTROL commit (the board is a projection, not a ledger).

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/task-board.ts` | +60 | 7 | `superviseBoardPost` + `planBoardSupervision` + the terminal `reclaimed` state in `planBoardWrites` + `reclaimedFileName` |
| `scripts/swarm-dispatch.ts` | +25 | live | `runBoardProducer` BA9 block: repost in place / S19 report incident / reclaim-rename + dead-letter |
| `packages/bus/test/swarm-task-board.test.ts` | +45 | 7 | the ladder, the reducer, boundaries, and the reclaim-is-terminal (no re-post loop) |

## Gates
- bus tsc 0; scripts tsc 0; bus vitest 1075/1075 (+7 BA9).

## Counterexamples the tests lock
- within deadline -> ok; past deadline under cap -> REPOST (fresh postedAtSec + repostCount+1); at cap in grace -> REPORT; past cap+grace -> RECLAIM.
- the reducer acts ONLY on still-ready posted files — a not-ready item is left to `planBoardWrites`; a claimed file is never touched; a report is deduped.
- a `reclaimed` file blocks `planBoardWrites` re-post even when the node is READY (no reclaim->repost loop), and is not reaped.

## Open self-flags (reviewer please rule)
- `.report.json` / `.reclaimed.<who>.json` markers persist (inert — `parseBoardItemName` returns null for `.report.json`; `reclaimed` is terminal). Marker GC for a coordinator-cleared node is a follow-up.
- REPORT lands as a board incident file the coordinator's board view surfaces (decision-batch one-screen integration is later, per the design suggestion).
