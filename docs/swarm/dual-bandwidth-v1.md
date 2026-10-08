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
- `backlogGrowthPerHour = B_prod - B_cons` (dD/dt). `drainHours = D / B_cons` (0 when D = 0; null when B_cons = 0 and D > 0 — never drains).
- **Zone** (precedence RED > AMBER > GREEN; thresholds are TUNABLE constants, ruling (2), recalibrate after a week):
  - **GREEN**: ratio ≤ 0.8 and backlog below soft cap and not rising → carry on.
  - **AMBER**: ratio ∈ (0.8, 1.2] or backlog rising or backlog ≥ soft cap → coordinator COMPRESSES harder (bigger batches, defer
    low-priority, merge 呈批).
  - **RED**: ratio > 1.2 (or producing with ZERO consumption) or backlog > hard cap or drainHours > horizon (a never-drains backlog
    exceeds any horizon) → coordinator THROTTLES thread-opening (R18). Throttle = open fewer threads, NOT an approval hop.
  - Defaults: window 3600s, amber 0.8, red 1.2, soft cap 20, hard cap 50, drain horizon 8h.

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

- pure `computeDualBandwidth({ nowSec, produceAtSec, consumeAtSec, backlog, config? }) → reading` (no fs/clock beyond `nowSec`;
  validates config loudly). Rate normalized to per-hour over `windowSec`.
- IO `collectBandwidthEvents(home) → { produceAtSec, consumeAtSec, backlog }` (read-only scan of decision-batch dirs; ENOENT =
  absent, other read errors THROW; a corrupt/foreign per-batch file is skipped, never fatal).
- IO `computeGauge(home, nowSec, config?) → reading`.
- IO `writeBandwidthProjection(home, nowSec, config?) → reading` (computes + atomically writes the projection).
- IO `readBandwidthProjection(home) → projection|null` (console/tests; wrong-schema or absent ⇒ null).

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
