# Review packet — BA9 board-post supervision (§2d-a, an R14 pre-flight), ROUND 3

- **Branch** `feat/board-post-supervision`  **HEAD** `37afbbd`  **Base** `main` (`5da42b5`)  (round-1 `52533f3`, round-2 `68e41e0`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/board-post-supervision-design.md` @`93023c6` (coordinator-approved, zero change)

## What this is
A posted-but-unclaimed board item that is STILL ready is never reaped by `planBoardWrites` (reap only fires when the node stops being ready), so without supervision it can sit forever — a silent stall that must be closed before `SWARM_BOARD_ADMIT` can flip (R14). BA9 adds the escalation: REPOST (bounded) -> REPORT (coordinator incident, deduped) -> RECLAIM (dead-letter). DORMANT behind `SWARM_BOARD_ADMIT`.

## Round 3 — round-2 REMAIN resolved (BP1/BP3; the report-durability + repost-atomicity seams)
- BP1 (P1) the `reportedAtSec` stamp is what starts the reclaim grace, so it must mean "a report was durably saved". The driver now writes the S19 incident (`<itemId>.report.json`) FIRST; ONLY a confirmed save then stamps the posted file (`atomicRepost` of the stamped item). A failed save leaves `reportedAtSec` unset, so the next tick re-emits the report (the obligation is retained) — never stamp-then-grace-then-reclaim with no report file. The incident content is fixed per item, so a re-write before the stamp lands is idempotent.
- BP3 (P1) a repost that fails BETWEEN the rename-acquire (`posted -> .repost.<pid>.tmp`) and the rewrite no longer loses escalation progress. `atomicRepost` now RESTORES the acquired original (`repostCount`/`postedAtSec` preserved) when the rewrite throws, instead of leaving only the tmp (which the next `planBoardWrites` would treat as a vanished item and re-post FRESH — count/deadline reset, cap bypassed). AND the producer ADOPTS an orphaned `.repost.<pid>.tmp` at the top of each tick (a crash can strike before the restore), renaming it back to its posted name so a RESTART recovers the count + deadline. Adoption reclaims a tmp ONLY when its writer pid is gone and the posted slot is free — never steals a live producer's in-flight tmp, never clobbers a racer.
- Gates: bus tsc 0, scripts tsc 0, bus vitest 1078/1078 (board test 37). The pure reducer (`task-board.ts`) is unchanged — BP1/BP3 are driver-IO atomicity, governed by the existing 37-case decision test.

## Round 2 — round-1 REMAIN resolved (BP1-BP6)
- BP1 a REPORT is RECORDED first (persisted `reportedAtSec`), and RECLAIM's grace runs from THAT time — never straight-to-reclaim on a late scan, never a report-write-failure bypass. The report action carries the stamped item; the driver re-posts it + writes one S19 incident.
- BP2 supervision runs on a FRESH board snapshot read AFTER `planBoardWrites`, so it never disposes a just-published new version from a stale pre-write snapshot.
- BP3 repost/report acquire the same posted file by ATOMIC RENAME (skip if a member claimed it first); reclaim is a single atomic rename to the terminal `reclaimed` file — never posted+claimed/reclaimed coexisting, never a half-migration on an unlink failure.
- BP4 `planBoardSupervision` uses the VERIFIED DERIVED itemId (the filename identity) for every output path — a crafted body `itemId` (`../foreign`) can no longer steer the report/reclaim path.
- BP5 the projection (`parseBoardFileName` + `BoardItemStatus`) recognizes `reclaimed` as terminal, so `readBoard` no longer counts a reclaimed item as open.
- BP6 `parsePolicyNum` validates finiteness + non-negativity (+ integer for the repost count), preserves an explicit `0`, and rejects `Infinity` (the cap can never be disabled).

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
- bus tsc 0; scripts tsc 0; board test 37 (+10 BA9); bus vitest 1078/1078.

## Counterexamples the tests lock
- within deadline -> ok; past deadline under cap -> REPOST (fresh postedAtSec + repostCount+1); at cap in grace -> REPORT; past cap+grace -> RECLAIM.
- the reducer acts ONLY on still-ready posted files — a not-ready item is left to `planBoardWrites`; a claimed file is never touched; a report is deduped.
- a `reclaimed` file blocks `planBoardWrites` re-post even when the node is READY (no reclaim->repost loop), and is not reaped.

## Open self-flags (reviewer please rule)
- `.report.json` / `.reclaimed.<who>.json` markers persist (inert — `parseBoardItemName` returns null for `.report.json`; `reclaimed` is terminal). Marker GC for a coordinator-cleared node is a follow-up.
- REPORT lands as a board incident file the coordinator's board view surfaces (decision-batch one-screen integration is later, per the design suggestion).
