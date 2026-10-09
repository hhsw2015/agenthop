---
contract: dual-bandwidth-gauge
version: 1
status: accepted
authority: backend owner f32a0507
last_updated: 2026-10-08
---

# dual-bandwidth gauge v1 — projection + API contract (frozen for the console/front-end)

T5-2 (DHH-eval borrow, grounds in `docs/research/dhh-16thread-eval.md`). The gauge makes the swarm's one invisible imbalance a
reading: agents PRODUCE items needing a human verdict; the user CONSUMES (clears) verdicts. When produce outruns consume the
backlog grows unbounded and the user drowns (DHH 38:21: "the faster the agents run, the fewer threads I can run"). The gauge is a
SENSOR the coordinator reads to compress harder or open fewer threads.

**Design law (DHH 18:51):** the gauge MEASURES so the coordinator can COMPRESS or THROTTLE; it is never itself an approval or
latency hop. RED means "open fewer threads" (R18 two-tier: concurrency bounded by B_cons), never "add an approval gate".

Code: `packages/bus/src/swarm/dual-bandwidth.ts` (pure core) + `dual-bandwidth-store.ts` (IO). Frontend consumer = `3e097dfe`.

## Two bandwidths (coordinator rulings folded 2026-10-08)

- **B_prod** — rate of newly generated items needing a human verdict. Source = **decision-batch items** (each item is a pending
  呈批件 / 并库候选 / 签收确认 / 立项请求 already compressed into a batch — see `decision-batch.ts`). One produce event per item, at
  its batch's `createdAtSec`.
- **B_cons** — rate the user clears **real decisions**: the approve/reject/defer verdicts of a consumed batch (one consume event
  per decision in the consumed claim doc, at `consumed.json`'s `consumedAtMs`). **Ruling (3): chat-room sign-offs are communication,
  NOT decisions — never counted** (folding them in would inflate the apparent consume rate). decision-batch is the SOLE B_cons source.
- Each bandwidth reports **two numbers** (ruling (1), one window logic): a rolling-window **rate per hour** (real-time imbalance)
  and the **session-cumulative count** (daily-report base).

## Derived + zones

- `ratio = B_prod / B_cons` (null when B_cons = 0 in the window — undefined, never a non-serializable Infinity).
- `backlog D` = undecided items of every not-yet-consumed batch (derived READ-ONLY; the gauge never calls the mutating consume).
- `backlogGrowthPerHour` (dD/dt) is in **decision-item units/hour**, consume/backlog-consistent: `itemProduceRate − B_cons`, where
  `itemProduceRate` counts ONE produce event per decision-batch item at open — NOT `B_prod − B_cons`. When submit-tag folds N
  submissions into one item, `B_prod` is submission-unit (B_prod=N, a ruled contract) while backlog/consume are item-unit; so the
  derivative MUST use the item-unit produce stream or it reports phantom growth (B6-2: 5 folded submits, all approved, D 0→1→0 would
  wrongly read `backlogGrowthPerHour=4`). `drainHours = D / B_cons` (0 when D = 0; null when B_cons = 0 and D > 0 — never drains).
- **Zone** (precedence RED > AMBER > GREEN; thresholds are TUNABLE constants, ruling (2), recalibrate after a week):
  - **GREEN**: ratio ≤ 0.8 and backlog below soft cap and not rising → carry on.
  - **AMBER**: ratio ∈ (0.8, 1.2] or backlog rising or backlog ≥ soft cap → coordinator COMPRESSES harder (bigger batches, defer
    low-priority, merge 呈批).
  - **RED**: ratio > 1.2 (or producing with ZERO consumption) or backlog > hard cap or drainHours > horizon (a never-drains backlog
    exceeds any horizon) → coordinator THROTTLES thread-opening (R18). Throttle = open fewer threads, NOT an approval hop.
  - Defaults: window 3600s, amber 0.8, red 1.2, soft cap 20, hard cap 50, drain horizon 8h, future-skew tolerance 300s.
- **Window bounds (T52-P2-4):** the rolling window is `(now - windowSec, now + skewToleranceSec]`. An event dated past
  `now + skewToleranceSec` (a clock bug / bogus data — e.g. a verdict a year out) is IGNORED, in both the window rate AND the
  session total, so it can never lower the current backlog's alert level. `windowSec` must be in `[1, MAX_SAFE_INTEGER]` (a
  sub-second window underflows the per-hour rate; a MAX_VALUE window overflows the drain division — both rejected); `backlog` must
  be a SAFE non-negative integer; `skewToleranceSec` ≥ 0. A derived value that still overflows to non-finite THROWS (T52-P2-5 B) —
  a consume-present overflow is never emitted as the Infinity-to-null that reads as "no consumption".

## Projection (frozen read contract) — `$HOME/.agenthop/console/bandwidth-gauge/gauge.json`

Written atomically (temp + rename): the console never reads a half-written file. Sibling of `decision-batches/` (ruling (4)).

```
{ "schema": "bandwidth-gauge/v1", "generatedAtSec": number,
  "prod": { "ratePerHour": number, "sessionTotal": number },
  "cons": { "ratePerHour": number, "sessionTotal": number },
  "ratio": number|null,              // null = undefined (no consumption in the window)
  "backlog": number,
  "backlogGrowthPerHour": number,    // dD/dt (negative = draining)
  "drainHours": number|null,         // null = never drains (no consumption, backlog>0); 0 = nothing to drain
  "zone": "green"|"amber"|"red",
  "windowSec": number,
  "thresholds": { "amberRatio", "redRatio", "backlogSoftCap", "backlogHardCap", "tDrainHorizonHours" } }
```

`null` (not Infinity) encodes an undefined ratio / never-draining backlog so the JSON is always serializable; the `zone` carries the
severity in those cases.

## API

- pure `computeDualBandwidth({ nowSec, produceAtSec, consumeAtSec, backlog, backlogProduceAtSec?, config? }) → reading` (no fs/clock
  beyond `nowSec`; validates config loudly). Rate normalized to per-hour over `windowSec`. `backlogProduceAtSec` (item-unit produce
  for dD/dt) defaults to `produceAtSec` when absent — identical behavior when B_prod is already item-unit (submit-tag OFF).
- IO `collectBandwidthEvents(home) → { produceAtSec, consumeAtSec, backlog, backlogProduceAtSec }` (read-only scan of decision-batch
  dirs; ENOENT = absent, other read errors THROW; a corrupt/foreign per-batch file is skipped, never fatal). `backlogProduceAtSec` is
  always one event per batch item at open (item-unit), even when `produceAtSec` folds to submission-unit under submit-tag.
- IO `computeGauge(home, nowSec, config?) → reading`.
- IO `writeBandwidthProjection(home, nowSec, config?) → reading` (computes + atomically writes the projection).
- IO `readBandwidthProjection(home) → projection|null` (console/tests). Validates STRUCTURE + NUMERICS, not just the schema string
  (T52-P2-5): required prod/cons pairs with finite rate+total, finite generatedAtSec/backlog/backlogGrowthPerHour/windowSec, a known
  zone, ratio/drainHours that are null or finite (never a serialized NaN), AND a required `thresholds` object carrying all five finite
  numeric fields (amberRatio, redRatio, backlogSoftCap, backlogHardCap, tDrainHorizonHours); anything absent / wrong-schema / invalid ⇒ null.

## Source boundary (v0)

decision-batch is the **canonical in/out event** and the **sole B_cons source**. Its items already ARE the
呈批/并库/签收确认/立项请求 (compressed), so counting items is the non-double-counting produce measure. The design's **secondary
produce sources (raw chat-room / inbox 呈批/立项 before compression) are NOT wired in v0**: a `RoomPost` is plain text and an
`InboxMsg` has no 呈批/立项 `via` convention, so there is no reliable marker to extract them without a new tagging scheme, and they
would double-count the decision-batch items they are later folded into. Left as a documented seam — wiring them needs a coordinator
ruling on a 呈批/立项 tag convention + a de-duplication rule against decision-batch items.

## Integration seam (NOT in this slice)

Who calls `writeBandwidthProjection` and how often (a coordinator tick), and the coordinator ACTING on a zone (compress / throttle
R18 two-tier) is the owner's dispatcher integration — not this backend. Frontend render = `3e097dfe`.

## DEFERRED (not v0)

Per-item priority weighting · predictive (not current-rate) drain · multi-user bandwidth · auto-throttle wiring (coordinator seam)
· historical curves · chat-room/inbox raw-produce augmentation (needs a 呈批/立项 tag convention + de-dup rule).
