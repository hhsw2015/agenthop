# Pure-layer F-coverage self-audit (f32a0507 domain)

Dispatched by the coordinator: map the dogfood F-items in the pure-layer domain (F20 scenario-A / R2 seven / re-arm
erratum / RPV race) to existing tests, fill gaps. Test-only. Full bus suite **440 green**, `tsc` 0.

## F20 scenario A — "reminder delivery = wait satisfied" (the re-arm erratum)
The misconception F20 names: a 催办/bypass delivery wrongly treated as the wait being satisfied. The fix: ANY timeout
action's completion ends only THAT action and re-arms the wait; `resolved` comes only from `close`/`decide`. F20 lesson
① (write the *uncompleted* contrast, not just the already-done instance) is honored — every case asserts the NEGATIVE
(action_done does NOT resolve) AND the real resolver.

| Claim | Test |
|---|---|
| reversible `action_done` RE-ARMS (open + newDeadlineSec + escalatedAt), does NOT resolve; resolve only via `close` | `swarm-task-wait` "reversible wait: action_done RE-ARMS … does NOT resolve" |
| approval escalation-NOTICE completion ≠ approval resolved (back to open, decision still pending) | `swarm-task-wait` "action_done on a still-pending approval goes BACK to open …" |
| `decide` (terminal) is the only approval resolver; escalation never grants | `swarm-task-wait` "only a real terminal decision resolves an approval …" |
| resolved terminal reached via `close`, not `action_done` | `swarm-r2-acceptance` `doneLog` (close→resolved); `swarm-task-rpv` ② |
| RPV: `action_done` re-arms, the MOVE terminal goes through `close` | `swarm-task-rpv` ② |

## R2 minimal-acceptance seven
| # | Claim | Test |
|---|---|---|
| 1 | wait/approval is a durable CONTROL entity (not coordinator memory) | `swarm-control-log` "wait Change …"; `swarm-task-wait` openWait |
| 2 | timeout action survives crashes (intent before IO, recoverable, no multiplication) | `swarm-r2-acceptance` W0/W2/W5/W6 |
| 3 | three-phase decide→execute→confirm, each durable | `swarm-task-wait` three-phase (begin_action→action_pending→…) |
| 4 | approval `resolved != granted`; decision separation | `swarm-task-wait` "resolved != granted … granted records the grant" |
| 5 | single-record independence (pure prereq of "long action doesn't block a shorter wait"; scheduler part = sweep) | `swarm-r2-acceptance` "single-record independence (M3)" |
| 6 | replay dedup / re-submit is a bounded no-op | `swarm-r2-acceptance` W6; `swarm-control-log` replay/decision-order |
| 7 | meta-job: wrote the landing-spot ≠ fixed; self-report ≠ conclusion | `swarm-task-result` "R2 item 7 (catches M4) …" |

## re-arm erratum (team-collab §0b, SHA line) — same as F20; implemented in `task-wait.ts` + rippled. Covered above.

## RPV race (option-b validation-timeout anchor)
| Claim | Test |
|---|---|
| same-batch open ValidationRun + companion wait; anchored by validationRunId | `swarm-task-rpv` ① |
| timeout: begin_action(move-validator) → action_done re-arms; MOVE = close + supersede + new run&wait | `swarm-task-rpv` ② |
| normal completion = resolve run + close companion wait, same batch (P2-1) | `swarm-task-rpv` ③ |
| late reply on a closed wait / superseded run is fenced (move-first order) | `swarm-task-rpv` ④ |
| **GAP FILLED** — P2-1 completion-first order: normal completion committed first ⇒ a later timeout move is rejected | `swarm-task-rpv` "P2-1 race: normal completion committed FIRST …" |
| pinned candidate / monotonic generation / verdictEligible fencing | `swarm-task-validation` moveValidator + verdictEligible suite |

## Gaps found & filled
- RPV P2-1 had only the move-first order (late verdict fenced). Added the completion-first order: once the subject
  completed (committed first), a timeout-driven move no-ops (rejected — close on a resolved wait / move from a closed
  run). The move-first order remains covered by ④.

Everything else was already covered equivalently; no other gaps in this domain.
