# T3b review packet (narrow review → 01a0ff49)

**Scope:** T3 planner part B. Design `docs/swarm/t3-planner-design.md` (current sha `1d0a1ffc`; memory's `60c9ffa7` is a
stale earlier freeze — the doc has no `§7`, the T3b content lives in §1/§2/§3/§4; coordinator's 5-point dispatch
corroborated clause-by-clause). Baseline = `feat/swarm-brain` @ `ed2499d` (T3a signed off 0/0/0). Branch `feat/swarm-brain`.

**T3a surface (round 3+):** T3b began as new files only; from round 3 it ADDITIVELY extends the signed-off T3a shared layer
(`evaluateR4`/`R4NodeInput`, `TaskSpec.resolvedRisk`, managed loader, `translateDraft` trusted opts) to implement design §3
"节点显式标记" — see "T3a-surface change declaration" below. All extensions are optional/additive: absent `resolvedRisk`,
behavior is byte-identical to T3a (all 93 T3a regression gates + the full suite stay green). The earlier "zero T3a edits"
framing and the round-2 prefix-surgery projectAnswers description are superseded by the per-node-risk design documented here.

## What to review (round 2 — HEAD after the bccf629 fix round)

| Module (new) | Tests | Purpose |
|---|---|---|
| `src/swarm/plan-prompts.ts` | swarm-t3-draft | 3 versioned prompt assets (task-master MIT = structural inspiration only, rewritten); `fillPrompt`, `writePromptAssets` |
| `src/swarm/plan-draft.ts` | swarm-t3-draft (16) | draftPlan: the ONE impure step. Injected `callModel`; strong-schema parse; always-heavy tier; **null/non-object task → reject (no throw)**; **rescore must cover every task once (no omit/unknown/dup/non-numeric → no silent downgrade)**; surfaces request-round `planningRequestId` |
| `src/swarm/plan-bundle.ts` | swarm-t3-bundle (10) | content-addressed resume snapshot + **policy-version store** (`storeFrozenContext`/`loadFrozenContext`, line 20); **atomic write (temp+rename)**; `frozenRefsOf`; load re-verifies digest |
| `src/swarm/plan-recompile.ts` | swarm-t3-recompile (21), swarm-t3-guards (5) | recompile loop + **sole** operationId minter; conservative path-exact fold; CAS-conflict reject; content-addressed C' version |
| `src/swarm/plan-resume.ts` | swarm-t3-resume (5) | **the verified recompile orchestration** (payloadRef → resolve+verify policy → recompile → persist C') |
| `scripts/coverage-audit.ts` | swarm-t3-acceptance (F) | independent, omission-aware, structured-evidence coverage auditor |
| `scripts/t3-draft-live.ts` | A1 (manual) | real-LLM live-fire + real F reconciliation + evidence dump (CPA; OpenAI + Anthropic `/v1/messages`) |

**Totals:** 64 new T3b tests; **434 swarm tests green**; `tsc --noEmit` clean.

## Coordinator's 5 points → where

1. **3 prompt assets + draftPlan (strong schema, structuredChecks/freeTextNotes split).** `plan-prompts.ts` + `plan-draft.ts`. The split is enforced by T3a's `translateDraft` (unchanged); draftPlan only parses+shape-checks, deep validation stays with translateDraft (sole authority).
2. **Bundle store/retrieve (payloadRef CAS, immutable {draft + PRD version + frozenContext version refs}).** `plan-bundle.ts`. `frozenRefs` (version ids), not inline policy. Load re-verifies digest.
3. **Recompile loop: answers → D' (projection), original snapshot immutable, multi-question-incomplete stays needsClarification.** `plan-recompile.ts: projectAnswers` / `recompilePlan`. Originals only spread-copied. `incomplete` → `needsClarification`.
4. **operationId = digest(planningRequestId, entityKey, actionKind, snapshotDigest, canonicalAnswerSetDigest); planningRequestId threaded through frozenContext; translateDraft mints nothing.** `plan-recompile.ts: mintPlanOperationId`. canonical answer set = sorted by questionId, CAS-winning only. draftPlan surfaces `planningRequestId`; translateDraft is unchanged (no mint).
5. **Two guards pinned by implementation tests.** `swarm-t3-guards.test.ts`: (1) `isGranted` admits only a matching granted approval — a query-wait is never admission, even after default-close; (2) a re-submitted recompile commits as a **replay no-op** (same minted operationId + same payload), while a different `planningRequestId` is a new op (not a conflict), and same-op-different-payload is op-conflict.

## Acceptance evidence

- **A1 (real-LLM live-fire)** via CPA `http://127.0.0.1:8318/v1`, `openai/gpt-4o`: draftPlan ok (6 real tasks) → translateDraft
  **loadable** → 7-node plan → **LOAD-ROUNDTRIP ok, planDigest stable** → **F reconciliation matched the hand-made baseline**
  (I1–I5 all independently verified implemented). Committed artifact: `docs/swarm/t3b-a1-evidence/a1-evidence.json` (PRD + raw
  model draft + produced plan + baseline + audit). The Anthropic `/v1/messages` branch is verified too (draftPlan parsed a real
  claude-sonnet-4.5 response; CPA upstream was intermittently 429/403, surfaced as clean rejects — never a crash). A real
  degraded-output rejection was also observed (a `patch` output lacking `baseSourceCommit` ⇒ rejected — acceptance C on live output).
- **B** — cross-two-domain ⇒ prepended design gate covering every impl node; tampered coverage ⇒ rejected on managed reload; cycle ⇒ rejected.
- **F** — independent, **omission-aware, structured-evidence** audit (`scripts/coverage-audit.ts`): "implemented" requires the
  baseline's required acceptance check; a marker in a "do NOT implement [I1]" clause is NOT implemented; three negatives
  (dropped node, dropped obligation with marker kept, explicit omission) all surface as not-implemented. Plus the real A1 reconciliation above.

## T3a-surface change declaration (round 3 — reviewer ④)

R2-P1-1 required per-node risk resolution (design §3 "节点显式标记"), which T3a had stubbed (policy/path-only). This round
**additively extends the frozen T3a surface** (coordinator notified via R3-b veto window):
- `task-r4.ts` `evaluateR4` + `R4NodeInput`: optional per-node `resolvedRisk` governing ONLY the unknown dimension; a
  policy-irreversible path ALWAYS still applies (the override cannot mask a known-irreversible write).
- `task-plan.ts` `TaskSpec.resolvedRisk` (annotation class — **EXCLUDED from specDigest**, in planDigest, same family as
  modelTier/roleProfile/criticalPath); `ManagedT3Opts.resolvedRisk` = TRUSTED evidence map; `validateManagedT3` honors a
  node's serialized `resolvedRisk` ONLY when it matches the evidence (else ignored → the gate stands).
- `task-translate.ts` `translateDraft(draft, fc, opts?)`: optional trusted `resolvedRisk` map (only the recompile passes it;
  an LLM draft cannot self-declare), stamped on nodes and forwarded to the self-check loadPlan.
All changes are **additive and optional**: absent `resolvedRisk`, behavior is byte-identical to T3a — the existing managed
de-gate counterexample, digest, and replay controls are unchanged (442 swarm tests green, incl. all T3a tests).

**Trust model (reviewer ①, asymmetric-forgery boundary):** `resolvedRisk:"reversible"` can REMOVE a design gate, so it is
NEVER trusted from the serialized plan. The managed loader ignores it unless the caller supplies a matching trusted evidence
map derived from the closed clarification waits (bound to the payloadRef). A forged field alone cannot delete a gate.

## Round-2 disposition — reviewer bccf629 (3 P1 / 5 P2), all addressed

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| P1-1 | same-path opposing answers last-write-wins → risk downgrade | conservative per-path AND (any irreversible wins), order-independent | swarm-t3-recompile "P1-1" (AB & BA both gate) + control |
| P1-2 | C' version keyed only on answer digest → content aliasing / managed-reload bypass | C' version content-addressed over the resulting policy; resume adds a frozenRefs drift/swap guard | swarm-t3-recompile "P1-2"; swarm-t3-resume "drift/swap" |
| P1-3 | invalid `reversible` (null/"false"/0) counted as answered; CAS tie order-picked | strict-boolean validation (else unanswered → needsClarification); CAS winner = top-casSeq group, a disagreement **rejects** | swarm-t3-recompile canonicalAnswerSet + "conflicting answer set → rejected" |
| P2-1 | sibling fallback rewrote `criticalPath` (forged requester fact) | **never touch criticalPath**; path-exact resolution re-adds unanswered sibling paths so they keep the gate | swarm-t3-recompile "P2-1" (criticalPath preserved) |
| P2-2 | rescore omit/empty/unknown/dup silent downgrade; null task throws | full-coverage check (reject omit/empty/unknown/dup/non-numeric); null/non-object task → readable reject | swarm-t3-draft "P2-2" (4 cases) |
| P2-3 | half-written bundle falsely reports success | atomic write (temp + rename); a partial file is repaired by re-store, never a false unreadable ref | swarm-t3-bundle "P2-3" |
| P2-4 | durable version resolution + verified resume entry not delivered | `plan-resume.ts` orchestration + `storeFrozenContext`/`loadFrozenContext`; resume reads only payloadRef+answers, verifies refs, persists C' | swarm-t3-resume (5: restart, C' reloadable, incomplete, drift, replay no-op) |
| P2-5 | F trusted model markers (MARKER-WITH-EXPLICIT-OMISSION) | structured-evidence + omission-aware audit; real A1 reconciliation artifact | swarm-t3-acceptance F (3 negatives) + a1-evidence.json |

## Round-3 disposition — reviewer d6cf85d re-review (1 P1 / 3 P2), all addressed

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| R2-P1-1 | global path-set can't bind per-node answers (same/parent/child scope → downgrade or re-ask loop) | per-node `resolvedRisk` (design §3); projectAnswers aggregates per node; unanswered nodes keep policy risk + gate; criticalPath untouched | swarm-t3-recompile "R2-P1-1 same-path / parent-child" + "① not trusted without evidence" |
| R2-P2-1 | non-numeric casSeq → Math.max NaN → TypeError | canonicalAnswerSet drops a non-finite casSeq as invalid (→ unanswered, safe) | swarm-t3-recompile "R2-P2-1" |
| R2-P2-2 | resume trusted caller casSeq, not the real close winner | `answersFromClosedWaits` (winner = the resolved wait's close fact; advanceWait first-close-wins) + `resumeFromClosedWaits` (payloadRef-bound) | swarm-t3-recompile "R2-P2-2" + swarm-t3-resume (closed-wait resume + cross-snapshot reject) |
| R2-P2-3 | F baseline missed the PRD's untagged test-dir obligation | coverage-audit `requiredScopePrefix` (untagged, scope-verified); baseline + A1 include the test-dir obligation | swarm-t3-acceptance "R2-P2-3" + regenerated a1-evidence.json |

## Round-4 disposition — reviewer 3dabc23 re-review (2 P1 / 1 P2), all addressed

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| R3-P1-1 | one real close re-pasted onto multiple questions (payloadRef binding alone insufficient) | `questionWaitRef(payloadRef, questionId)` — each wait bound to its specific question of its snapshot; `resumeFromClosedWaits` re-derives + checks, rejects duplicates | swarm-t3-resume "R3-P1-1 ONE real close cannot be re-pasted" |
| R3-P1-2 | trusted evidence bound to nodeId scalar only → stale evidence passes a new/added task path | evidence is `{risk, specDigest}`; the loader recomputes specDigest from the candidate content and honors only on a match (tamper → gate stands) | swarm-t3-recompile "R2-② scope tamper" + "① not trusted" |
| R3-P2-1 | a legit timeout-default clarification close was always rejected | `answersFromClosedWaits` recovers `default-applied` when `defaultOnTimeout` was a clarification; isGranted stays false | swarm-t3-recompile "R2-③" + swarm-t3-resume "R3-P2-1" |

## Non-obvious decisions / seams to probe

- **projectAnswers → per-node risk (round-3, design §3).** An answer resolves the ANSWERED node only (irreversible if any of
  its own answers is irreversible, else reversible), as a `resolvedRisk` on that node — NOT a global path-set edit. An
  unanswered node (even one sharing or overlapping the path) keeps its policy unknown-risk and its gate. `criticalPath` is
  never rewritten. A policy-known-irreversible path always still gates (the override governs only the unknown dimension).
- **resolvedRisk trust (reviewer ①②, asymmetric forgery).** `reversible` can remove a gate, so the managed loader never
  trusts the serialized field: it honors a node's `resolvedRisk` only when the caller's trusted evidence matches BOTH the
  value AND the node's recomputed `specDigest` (task identity). A tampered scope (new/added path) changes specDigest →
  evidence no longer matches → gate stands. Evidence comes from `resumeFromClosedWaits` (closed clarification facts).
- **Wait→question binding (reviewer ①).** Each query-wait carries `questionWaitRef(payloadRef, questionId)` as its payloadRef,
  so one closed wait cannot be re-pasted onto another question; `resumeFromClosedWaits` re-derives and checks it.
- **Timeout-default recovery (reviewer ③).** `answersFromClosedWaits` recovers an `outcome="default-applied"` close only when
  the pre-stored `defaultOnTimeout` was itself a clarification resolution; cancel/supersede/open are not answers. `isGranted`
  stays false throughout (a query close never grants execution).
- **clarifyTargets replicates translateDraft's question derivation** (not NL-parsed) and is **pinned** by a test asserting its
  questionIds equal translateDraft's emitted ones — a T3a format change breaks that test, not silently.
- **A2 (real dispatch + V8 execution of required-review-pass + the real cost-based R4 threshold) is NOT in this batch** —
  `notImplemented:['r4-threshold']` stays; loadable ≠ A2. The resume orchestration produces a loadable plan + minted
  operationId only; it does not dispatch.
