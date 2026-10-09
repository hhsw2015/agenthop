# BA9 board-post supervision — design (§2d-a, an R14 pre-flight)

Problem: a posted-but-unclaimed board item that is STILL ready (so `planBoardWrites` never reaps it — reap only fires when the node STOPS being ready) can sit forever if no capable member claims it. Before `SWARM_BOARD_ADMIT` can flip (R14), an unclaimed item must ESCALATE, not stall silently.

## Mechanism
- Each posted item already carries `postedAtSec`; a claim DEADLINE = `postedAtSec + claimTtlSec`. Each board sweep tick classifies every `posted` (unclaimed) item past its deadline.
- Pure `superviseBoardPost(item, nowSec, policy)` returns ONE action; the posted item body gains a `repostCount` (default 0).

## Escalation ladder (the three states)
- REPOST (repostCount under maxReposts): re-post atomically with a fresh `postedAtSec` + `repostCount+1` — a transient 「no free capable worker」 gets another claim window.
- REPORT (at the repost cap, still unclaimed): emit ONE coordinator needs-attention incident for the item (deduped per itemId) — the node cannot find a claimant (a capacity or capability gap).
- RECLAIM (after REPORT + reportGraceSec, still unclaimed): withdraw the item and return the node to the dead-letter lane, so the plan is never silently blocked.

## Invariants
- Acts ONLY on a `posted` item still unclaimed on the CURRENT CONTROL; never touches a `claimed`/`granted`/`rejected`/`done` file (those belong to admission, not supervision).
- Reposts and reclaims are atomic renames; reports dedup per itemId; every action is idempotent on replay.
- Dormant behind `SWARM_BOARD_ADMIT` (BA9 runs only when the board runs); default-off.

## Deliverable
Pure `superviseBoardPost` + a `planBoardSupervision(items, nowSec, policy)` reducer (repost writes / report incidents / reclaim reaps) in `task-board.ts`; wired into the board sweep in `scripts/swarm-dispatch.ts`; selftest covers within-deadline=ok, repost-bounded, report-at-cap + dedup, reclaim-after-grace, and never-touch-claimed/granted. doneLine: design approved → implement + selftest + send-to-review + S26.
