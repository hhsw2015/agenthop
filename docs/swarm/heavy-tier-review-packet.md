# heavy-tier-binding review packet (narrow review → 01a0ff49)

**needs:** none (ready for review). **unverified surface:** the A1 live-fire is one real CPA run (coordinator ruling: one
pass, no multi-model cross-eval) — reproducible but not re-run by the reviewer without spend; the model-tiers.json AA Intel
scores are a hand-snapshot of CLIProxyAPIPlus/docs/flagship-coverage.md (user-ruling data, drifts only on a new ruling).

**Scope:** heavy-tier-binding (coordinator dispatch 2026-10-05, off `docs/swarm/model-tier-rulings.md`). Branch
`feat/swarm-brain`. Review range `53876d1..c6b5968` — three commits: `6e99e02` (binding + data table), `441566c` (the
§2c-b `renew` event — a separate boundary deliverable for 20cab0a5, listed here for continuity), `c6b5968` (served-model
runtime verify). Builds additively on the signed-off T3b.

## Deliverables → where

| # (dispatch) | Deliverable | Where |
|---|---|---|
| ① | heavy → planning-recommended resolution, **fail-closed** | `model-tier.ts` `resolveRoleModel`/`resolvePlannerModel` (no catalog match ⇒ refuse, never a weak default) |
| ② | recommendation table as **data** (not hardcoded) | `roles/model-tiers.json` (per-role recommended + AA Intel floor + reasoningEffort; benchmarkScores) |
| ③ | A1 live-fire with a **planning-tier** model, evidence | `scripts/t3-draft-live.ts` + `docs/swarm/t3b-a1-evidence/a1-evidence.json` |
| ④ | remove the gpt-4o default | done (resolver replaces it; CPA base is env/config-resolvable, :8787 default, cloud-ready) |
| +user | reasoning_effort = **xhigh** for planning | `model-tiers.json` per-role `reasoningEffort`; Claude via CPA adaptive-thinking shape, others `reasoning_effort` |
| +coord | **served == chosen** runtime fail-closed | `servedMatchesChosen`; the harness reads CPA's response `model` and rejects a silent downgrade; selection is a quadruple {chosen, why, benchmark, served} |
| +coord (§2c-b) | pure `renew` event + `isRenewable` | `task-wait.ts` (additive; for 20cab0a5's sweep) |

## Semantics (ruling-faithful)

- Recommended = baseline, NOT a closed whitelist. A self-selected model must be **same-or-stronger** by AA Intel (>= the
  role floor) AND carry the selection record; a weaker / unbenchmarked / not-in-catalog choice is rejected (fail-closed).
- "strongest available" default honors "推理强度优先" (planning picks the highest AA Intel recommended that is in the catalog).
- Updating the table = a user ruling, not a code change.

## A1 evidence (one real run; coordinator: one pass, no cross-eval)

`a1-evidence.json`: planner model **claude-opus-5.5** (AA Intel 58, planning-recommended) @ **reasoning_effort=xhigh**,
served **claude-opus-5-5** (same model, normalized match — no downgrade). draftPlan ok (6 tasks) → translateDraft
**loadable** → LOAD-ROUNDTRIP stable → F reconciliation I1-I5 + TESTS-DIR **all implemented, pass**. Selection quadruple
recorded. (An intermediate run showed a real strict rejection — a [TESTS] task with empty acceptance ⇒ rejected — i.e.
acceptance C holding on live output.)

## Tests

- `swarm-model-tier.test.ts` (16): table load; name/catalog matching; fail-closed (no catalog match); self-select
  same-or-stronger + triple-required + weaker/unbenchmarked/not-in-catalog rejected; reasoningEffort data-driven;
  servedMatchesChosen (exact/version-suffix ok, downgrade rejected).
- `swarm-task-wait.test.ts` (renew): isRenewable five-state; renew re-arms an open renewable wait (never resolves);
  rejects a semantic-deadline wait / non-open / missing deadline.
- 468 swarm tests green; `tsc --noEmit` clean; 93 T3a regression gates unaffected (additive only).

## Seams to probe

- `servedMatchesChosen` is a normalized includes-match (tolerates version suffixes). A same-family different-version that is
  WEAKER (e.g. a hypothetical "opus-5.5-lite") would pass the name match — the AA Intel floor is the strength guard at
  resolve time, not at served-verify time (served-verify only catches a different-model downgrade). Flagging explicitly.
- CPA Claude reasoning uses `thinking.type=adaptive` + `output_config.effort` (CPA quirk); non-Claude uses `reasoning_effort`.
- `renew`/`isRenewable` are the pure half; the sweep-side wiring (hasFreshSubjectEvidence ⇒ commit renew) is 20cab0a5's.
