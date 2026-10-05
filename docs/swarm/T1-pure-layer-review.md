# Brain T1 pure-function layer — review packet (for Codex re-review)

Branch `feat/swarm-brain`, code commits `ebe2a8a..e4a9f76` (excludes the docs commit `bc47cec`). All NEW files; zero
edits to `control.ts` / `dispatch-step.ts` / the launcher (lifecycle track untouched). Verify:
`pnpm --filter @agenthop/bus exec vitest run` → 30 files / 359 tests green (90 new); `tsc -p tsconfig.json --noEmit` → 0.

## Modules (all under `packages/bus/src/swarm/`, tests under `packages/bus/test/`)

| Module | Lines-ish | Tests | Purpose |
|---|---|---|---|
| `digest.ts` | ~55 | 10 | canonical JSON (sorted keys, preserved array order, dropped undefined, rejected non-finite) + sha256 + digestOf — the ONE serializer every brain identity uses |
| `task-plan.ts` | ~230 | 26 | TaskPlan/TaskSpec schema, `loadPlan` (illegal graph → whole reject), `computeSpecDigest`/`computePlanDigest` |
| `task-state.ts` | ~230 | 28 | TaskAttempt/ExecutionBinding, `computeInputBindingDigest`, binding tri-state, `advanceAttempt` (§3.1), `makeSuccessionAttempt` |
| `task-result.ts` | ~300 | 26 | `validateResult` (V1-V8 + scope + outcome), failure classification, `parseTaskResult`, `computeResultClosureDigest` |

## Contract-clause → implementation → test map

### digest.ts
- §2.1/2.2/2.5 "canonical JSON 的 SHA-256" foundation → `canonicalJson`/`digestOf`. Tests: key-order independence, array order significance, undefined drop, non-finite reject. PINNED: `[undefined]===[null]` (JSON.stringify parity) so a future "fix" can't drift all digests.

### task-plan.ts
- §2.1 schema (kinds, outputContract, scopes) → `validateSpecShape`. Tests: unknown kind/output-kind, bad jobBudget, non-array dependsOn, non-object input.
- §4.1 illegal graph rejected WHOLE, no silent edge deletion (prior-art non-port) → `loadPlan` dup/missing-dep/self-loop/cycle. Tests assert `ok:false` AND no partial plan returned.
- §2.2/§2.6 identity split (fe0376cd review #2): specDigest = TASK IDENTITY only; required/runtime/visibility are plan-role annotations → planDigest, NOT specDigest. `computeSpecDigest` omits {specDigest,required,runtime,visibility}. **PINNED**: flip required/runtime ⇒ same specDigest, different planDigest.
- §4.4 required (default true) + team-collab §2 runtime(ephemeral|durable, default ephemeral)/visibility(visible|headless, durable-only). Tests: defaults, visibility-only-when-durable, invalid values.
- V7 fail-fast: patch requiredOutput without baseSourceCommit → load reject (ratified by fe0376cd review #1).

### task-state.ts
- §2.2 TaskAttempt, §2.3 ExecutionBinding + tri-state (open/closing/closed; empty-cutoff) → `bindingState`/`candidateEligibility`. Tests cover all three states + empty + beyond-ancestry peer-late.
- §2.2 inputBindingDigest sorted(depNodeId,acceptedResultId) → `computeInputBindingDigest`. Test: order-independent; changes on acceptedResultId change (stale detectable).
- §3.1 transitions → `advanceAttempt` (observed/accepted/business_fail/transient_infra/stale/inconsistent_snapshot/permanent/revoke/add_binding), illegal source states rejected.
- retriesUsed SINGLE count point (Codex v2-P2-3): +1 only on business_fail→RETRY_WAIT; succession inherits; transient/stale/inconsistent/handoff never charge. **PINNED**: full retryBudget=2 walk asserts attempts a1/a2/a3 ran, FAILED on 3rd business-fail, retriesUsed sequence [1,2,3].
- retry succession → ABANDONED(retry-succession), NEVER FAILED (Codex P1-2) → `makeSuccessionAttempt`. Test asserts old.status ABANDONED + abandonReason.
- §3.2 X2 handoff: attemptId/status/retriesUsed unchanged, chain +1 → add_binding. Test asserts all three invariants + continuationOf.
- F1 / supersede-cascade #2: abandon a RUNNING, never-activated attempt → `revoke` (guarded: RUNNING + no activated binding). Tests: F1 success, activated→reject, RPV→reject.

### task-result.ts
- §4.2 two-layer, V1-V8 + cumulative scope, run in dependency order → `validateResult` returning accept|replay|discard|reject|stale.
- V2/V3 CANDIDATE-LEVEL discard, attempt untouched (Codex P2-1). V3 via binding tri-state (Codex v2-P2-1). Tests: no-binding, peer-late, empty.
- V1 classified by SOURCE (Codex v2-P2-4): milestone=permanent, rescue=inconsistent-snapshot. Tests both.
- V4 = inputBindingDigest match AND each bound result still the dep's CURRENT accepted (single-value map; fe0376cd). **PINNED**: dep has newer current while binding points at old ⇒ stale-input.
- V5 = current revision still has node with attempt.specDigest. Tests: removed, changed. (Note: the T1 validator takes currentSpecDigest/currentDepResults as INPUTS; the recursive `currentAccepted` that computes them is T2 — this is the acceptance.ts "pure decision over observed" split.)
- V6 = resultClosureDigest content closure (Codex P2-2): same=replay, diff=duplicate discard. Tests both + closure helper order-independence + "changed referenced blob, identical result.json ⇒ different closure".
- V7 required outputs + patch-applies-clean; **PINNED** patch-with-base ENTERS V7 (accept on clean, business-fail on dirty).
- V8 acceptance + patch sourceWriteScope two-coordinate (Codex v2-P2-5): patch inside sourceWriteScope passes, outside rejected (permanent).
- scope-violation cumulative over the binding, not single-commit (Codex v2-P2-5); .swarm/manifest.json + out/results/<attemptId>/ always allowed. Tests both.
- outcome=failure ⇒ business-fail, skips V7/V8 (even if contract would also fail). Test.

## Self-check: PINNED tests lock behavior, not implementation
- Digest tests assert equality/inequality RELATIONS (content-addressing behavior) and one byte-literal parity case, never a specific hex — reimplementing the serializer the same way is free to change internals.
- Transition tests assert resulting status / retriesUsed / abandonReason (observable outcome), not call order or internal fields.
- Validation tests assert the verdict decision + rule + failureClass + accepted fields (the contract-visible result), not branch order. Reason-substring assertions (`/peer-late/`, `/artifactScope/`) are deliberately loose category checks.
- The retryBudget=2 walk and the identity/role digest split are behavioral invariants straight from the contract's counterexamples, not from this implementation's shape.

## Explicit boundary (NOT in this layer)
IO half of T1 (assignment delivery, `swarm-task --task`, CPA token, O1 git scan/fetch/apply) touches the launcher →
deferred per handoff discipline. T2 pure modules (readyTasks, recursive currentAccepted, commitControl step-A pure
part, supersede cascade) are next and also touch no lifecycle files.
