# T3b review packet (narrow review → 01a0ff49)

**Scope:** T3 planner part B. Design `docs/swarm/t3-planner-design.md` (current sha `1d0a1ffc`; memory's `60c9ffa7` is a
stale earlier freeze — the doc has no `§7`, the T3b content lives in §1/§2/§3/§4; coordinator's 5-point dispatch
corroborated clause-by-clause). Baseline = `feat/swarm-brain` @ `ed2499d` (T3a signed off 0/0/0). **Builds on T3a without
editing any T3a/bus source** — only new files. Branch `feat/swarm-brain`, commit `0cad201` (+ `scripts/t3-draft-live.ts`
update for the Anthropic `/v1/messages` branch).

## What to review

| Module (new) | ~lines | Tests | Purpose |
|---|---|---|---|
| `src/swarm/plan-prompts.ts` | ~95 | swarm-t3-draft | 3 versioned prompt assets (task-master MIT = structural inspiration only, rewritten); `fillPrompt` (missing var throws), `writePromptAssets` |
| `src/swarm/plan-draft.ts` | ~120 | swarm-t3-draft (13) | draftPlan: the ONE impure step. Injected `callModel`; strong-schema parse (one code fence tolerated, else reject); always-heavy tier; optional independent complexity re-score; surfaces request-round `planningRequestId` |
| `src/swarm/plan-bundle.ts` | ~75 | swarm-t3-bundle (6) | content-addressed immutable resume snapshot; `payloadRef=digestOf(bundle)`; idempotent store; load re-verifies digest (tamper) |
| `src/swarm/plan-recompile.ts` | ~150 | swarm-t3-recompile (14), swarm-t3-guards (5) | recompile loop + **sole** plan operationId minter |
| `scripts/t3-draft-live.ts` | ~75 | A1 (manual) | real-LLM live-fire harness (CPA; OpenAI `/chat/completions` + Anthropic `/v1/messages`) |
| test `swarm-t3-acceptance.ts` | — | B (3) + F (3) | R4 gate/coverage; independent requirement-coverage audit + drop-detection negative |

**Totals:** 44 new tests; **414 swarm tests green**; `tsc --noEmit` clean.

## Coordinator's 5 points → where

1. **3 prompt assets + draftPlan (strong schema, structuredChecks/freeTextNotes split).** `plan-prompts.ts` + `plan-draft.ts`. The split is enforced by T3a's `translateDraft` (unchanged); draftPlan only parses+shape-checks, deep validation stays with translateDraft (sole authority).
2. **Bundle store/retrieve (payloadRef CAS, immutable {draft + PRD version + frozenContext version refs}).** `plan-bundle.ts`. `frozenRefs` (version ids), not inline policy. Load re-verifies digest.
3. **Recompile loop: answers → D' (projection), original snapshot immutable, multi-question-incomplete stays needsClarification.** `plan-recompile.ts: projectAnswers` / `recompilePlan`. Originals only spread-copied. `incomplete` → `needsClarification`.
4. **operationId = digest(planningRequestId, entityKey, actionKind, snapshotDigest, canonicalAnswerSetDigest); planningRequestId threaded through frozenContext; translateDraft mints nothing.** `plan-recompile.ts: mintPlanOperationId`. canonical answer set = sorted by questionId, CAS-winning only. draftPlan surfaces `planningRequestId`; translateDraft is unchanged (no mint).
5. **Two guards pinned by implementation tests.** `swarm-t3-guards.test.ts`: (1) `isGranted` admits only a matching granted approval — a query-wait is never admission, even after default-close; (2) a re-submitted recompile commits as a **replay no-op** (same minted operationId + same payload), while a different `planningRequestId` is a new op (not a conflict), and same-op-different-payload is op-conflict.

## Acceptance evidence

- **A1 (real-LLM live-fire)** via CPA `http://127.0.0.1:8318/v1`:
  - `openai/gpt-4o` → draftPlan ok (1 task) → translateDraft **loadable** → 2-node plan → **LOAD-ROUNDTRIP ok, planDigest stable**. PASS.
  - `claude-sonnet-4.5` via `/v1/messages`: the Anthropic branch is **verified** — draftPlan parsed a real Claude response
    and advanced to the (optional) re-score step; the CPA upstream for claude was returning 429 `server_overload` at test
    time, which the harness surfaced as a clean reject (never a crash). A full end-to-end claude pass is backend-availability
    gated; the gpt-4o run is the complete A1 evidence. (set `A1_RESCORE=0` for a single-call run.)
- **B** — cross-two-domain requirement ⇒ prepended design gate covering every impl node (`coveredSpecDigests == impl digests`); a tampered coverage ⇒ whole plan rejected on managed-t3 reload; a dependency cycle ⇒ rejected (not gated).
- **F** — independent requirement-coverage audit over the PLAN (no model "covers" field exists to trust); I1–I7 classified {implemented / constrained-review / deferred}; **negative test**: dropping a requirement's node makes the audit report it UNCOVERED (the audit is real).

## Non-obvious decisions / seams to probe

- **projectAnswers fold (the one judgement call the design delegated — "投影函数" mine to define).** Answers fold into a new
  `C'` (risk policy): an undecidable prefix is dropped only once **every** node path overlapping it is answered (a sibling
  path on an unanswered non-critical node keeps the prefix — no silent widening); answered-irreversible paths are added to
  `irreversiblePrefixes` (⇒ design gate, safe). `D'` fallback: an answered node still overlapping a kept prefix has its
  `criticalPath` cleared so it **gates** instead of re-asking. **ponytail / known ceiling:** under a sibling-conflict the
  reversible answer is under-honored (gated, safe but not maximally efficient); the exact fix is a per-node explicit risk
  marker (design §3 "节点显式标记"), deferred to the CPA-ledger batch. Flagging explicitly — push back if you want it exact now.
- **clarifyTargets replicates translateDraft's question derivation** (not NL-parsed from question text) and is **pinned** by a
  test asserting its questionIds equal translateDraft's emitted ones — a T3a format change breaks that test, not silently.
- **A2 (real dispatch + V8 execution of required-review-pass + the real cost-based R4 threshold) is NOT in this batch** —
  `notImplemented:['r4-threshold']` stays; loadable ≠ A2.
