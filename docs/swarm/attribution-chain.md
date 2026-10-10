# attribution-chain (filing) — explainable accountable-human waterfall

owner aad02248 · 2026-10-10 · 协调者派单(user approved the multica absorption) · design input `docs/research/multica-eval.md` ④ (the #1 borrow) · 基线 main @8b1892c · 状态:**纯核 + dormant,待复审**

## What

multica's `internal/attribution` (MUL-4302) resolves, for every enqueued run, EXACTLY ONE accountable human AND the LEVEL of the waterfall it resolved at — an *explainable* provenance chain. We already have the cap (C8) to stop forged delegation, but not the "each dispatch traces to one accountable human + how it was resolved" explainability. This borrows multica's 5-level ladder — same principle we already hold (traceability ≠ authorization; delegation never escalates).

## The 5-level waterfall (highest priority first)

`resolveAccountable(input)` returns the FIRST level that resolves exactly one human, by LEVEL PRIORITY (never a clock — FC-6):

1. **`direct`** — a human acted directly on the record.
2. **`delegated`** — resolved via a cross-hop delegation copy carrying the origin human.
3. **`comment-source`** — resolved via a comment / source chain's root human.
4. **`automation-owner`** — the owning human of an automation / cron rule that fired it.
5. **`fallback`** — degraded: no explicit human ⇒ a configured fallback owner.

No level resolves ⇒ `null` (the record is left UNATTRIBUTED; never invent a human).

## Three hard invariants (our C8 / R16 red lines)

1. **Accountable = "on behalf of" — a representative, NOT blame.**
2. **SOURCE tag is TRACEABILITY ONLY.** No permission decision reads `accountableHuman`; authorization stays with the C8 capability (HMAC, `mint.ts`). Traceability ⊥ authorization — this module exports no authz function and is never on the cap path.
3. **Delegation NEVER escalates privilege (R16).** Naming an accountable human grants nothing and issues no credential; it only records whom the chain represents.

## Landing (pure core + ledger seam, dormant)

- `packages/bus/src/swarm/attribution.ts` (pure): `ResolutionLevel` (the 5), `RESOLUTION_LEVELS`, `Attribution`, `AttributionInput`, `attributionEnabled` (SWARM_ATTRIBUTION, default OFF), `resolveAccountable` (deterministic waterfall), `isResolutionLevel`. Reuses existing identity (seat ids / cap originator); builds no new identity or cap system.
- `packages/bus/src/tasklog.ts`: `TaskRecord` gains optional `accountableHuman?` + `resolutionLevel?`; `createTask` carries them through when provided (the seam). Legacy records without them parse unchanged (FC-7).
- `packages/bus/src/swarm/attribution.selftest.mts`: 16 assertions (flag, waterfall priority, null-when-none, trim, FC-6 determinism, tasklog carry-through + round-trip, FC-7 legacy tolerance).

## Dormant (a filing, not a switch)

- Gated behind `SWARM_ATTRIBUTION` (default **OFF**). OFF ⇒ nothing computes or stores attribution; `createTask` omits the fields.
- **Not wired** into any live dispatcher. The seam below is where a future dispatcher would arm it.

## Wiring seam (for whoever enables it later — out of this filing)

At dispatch, when `attributionEnabled()`: gather the per-level candidate humans from the record's existing provenance (direct actor / delegation-copy origin / comment-source root / automation-rule owner / configured fallback), call `resolveAccountable`, and pass `accountableHuman` + `resolutionLevel` into `createTask`. Arm via `SWARM_ATTRIBUTION=1` once wired + validated. The cap path is untouched — authorization keeps reading the C8 token, never this tag.

## Self-check (FC-6 / FC-7)

- **FC-6** (no latest-wins): resolution is by LEVEL PRIORITY only — no timestamp anywhere; same input ⇒ identical output; a higher level always wins regardless of field order.
- **FC-7** (legacy tolerance / no store-format break): the two ledger fields are OPTIONAL; a legacy `TaskRecord` without them parses and reads unchanged; `tasklog` tests 55/55 unchanged.
- bus `tsc --noEmit` = 0; attribution selftest 16/16; shared-budget / decision-batch / FC-4 untouched.
