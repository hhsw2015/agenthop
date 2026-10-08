# P1③ cross-cutting architecture-integrity review — design (R22)

Problem (DHH): each increment PR is locally reasonable, yet the merged architecture fragments. A per-PR correctness review cannot see drift that only appears ACROSS merges.

## Checkpoint (when)
- Primary: at the BATCH MERGE GATE, before a batch lands on main. Catches the batch's internal coherence while the diff is fresh.
- Secondary: a periodic CROSS-BATCH sweep every ~5 merges or at milestone close. Catches slow drift that no single merge-gate sees.
- Not per-PR: too frequent, and cross-PR patterns are invisible from one diff.

## What to review (axes)
- Module boundary drift: code crossing an established line (IO in a pure module; a script reaching into bus internals; pure→IO import).
- Duplicate implementation: one concern solved twice (precedent: two board parsers; two liveness paths). Flag convergence candidates.
- Contract conflict: two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec).
- Dependency direction: import cycles or wrong-direction edges (bus→scripts, pure→IO); the key graph invariant.
- Gate/invariant consistency: each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments.

## Who reviews
- Add an ARCHITECTURE AXIS to the codex seat (01a0ead5) at the merge gate: it already runs per-batch adversarial review and holds the diff, so the axis reuses that pipeline with a cross-cutting lens.
- The periodic cross-batch sweep is a STANDALONE item spanning multiple SHAs (beyond one diff): the author with the broadest view, or a two-seat committee.

## Input
- The diff set: the batch's commits vs the pre-batch base.
- The contract surface: SPEC docs (cluster-liveness-design.md, projection-schema, team-collab §0b) + the shared-entity type definitions + CLAUDE.md/memory invariants.
- A module import map (who-imports-whom) to diff dependency direction, plus the prior architecture verdict to measure drift over time.

## Output
An architecture-integrity verdict per axis (boundary / duplicate / contract / dependency / gate), feeding the merge gate; CONFIRMED findings block the merge, drift findings open convergence follow-ups.
