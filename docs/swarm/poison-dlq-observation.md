# SWARM_POISON_DLQ — observation-window audit (FC-2)

Audit of the poison dead-letter facility (FC-2) over its observation window since merge, per coordinator dispatch. Pure observation + recommendation; the default-flip itself is the USER's gate and is NOT touched here.

- **Merged:** `fa4f5ac` (Merge `feat/poison-dlq`, FC-2 poison dead-letter isolation, signed 0 REMAIN, 7 rounds) at **2026-10-10 09:58:09 +0800** (epoch 1791597489000).
- **Audited:** 2026-10-10, live `~/.agenthop/` on this host.

## The facility has two layers (important for reading the evidence)

1. **Always-on F28 schema-quarantine (NOT gated).** In `inbox.ts`, the flush path validates every claimed inbox file; a poison file (unparseable JSON or missing/mistyped required fields) is moved to `inbox/<sid>/quarantine/` (random-suffixed, evidence-preserving) and a line is appended to `~/.agenthop/swarm/dead-letters.jsonl`. This runs unconditionally and predates FC-2 — it is the safety net (a poison file never re-claims, never re-crashes the server).
2. **Opt-in FC-2 strike + S19-notice layer (gated by `SWARM_POISON_DLQ`, default OFF).** This is DISTINCT from (1) and triggers on a DIFFERENT failure: in the drainer, a message whose envelope is VALID (so it passed (1)) but whose host **push THROWS** (a poison-pill that crashes on delivery, not on parse) gets a per-message STRIKE recorded — a `<base>.json.poison` sidecar holding the count (`recordPoisonStrike`, persisted across restarts; `SWARM_POISON_DLQ_THRESHOLD`, default 3). On reaching the threshold the message is quarantined and an S19 coordinator notice is built + enqueued to the DURABLE queue `~/.agenthop/swarm/poison-notices/` (drained + delivered by any later flush, deleted only after a confirmed send; a `needs-migration/` subdir holds prior-version queue files). The sidecar is cleared on a successful ack or after the quarantine. The whole layer is dormant while the flag is off; a schema/parse failure never reaches it — (1) quarantines that first (`core.ts:201`).

> Naming note: the dispatch's `*.json.poison` sidecar and `poison-notices/` dir are BOTH real — `recordPoisonStrike` writes the `<base>.json.poison` strike-counter sidecar, and `poison-notices/` is the FC-2 notice queue. This disk sample found **none present** at the sample moment (checked below) — that is "absent now", NOT "does not exist". The (1)-layer artifacts are additionally the `inbox/<sid>/quarantine/` dirs + `dead-letters.jsonl`.

## Evidence (live filesystem)

| Artifact | Found | Since the FC-2 merge (2026-10-10 09:58) |
|---|---|---|
| `~/.agenthop/swarm/dead-letters.jsonl` | 10 records, ts 2026-10-06 → **2026-10-09** | **0 new** (file untouched since Oct 9 14:29; none after the merge) |
| `inbox/<sid>/quarantine/` | 11 files across 4 inboxes, mtimes 2026-10-05 → **2026-10-09** | **0 new** (all predate the merge) |
| `~/.agenthop/swarm/poison-notices/` (FC-2 opt-in queue) | **absent** | **0 obligation backlog** |
| `~/.agenthop/swarm/poison-notices/needs-migration/` | absent | — |
| `inbox/<sid>/**/<base>.json.poison` (FC-2 strike sidecars) | **none at sample** | no live strike counter present (but see caveat below — ack clears them) |

**What the 10 + 11 pre-merge items are:** real inter-session check-in / handoff / review messages (e.g. `reboot-rollcall`, `herdr-backend-claim`, `herdr-scope-query`, `t3b-r5-fixed`) that failed the inbox schema validator (`quarantined: schema/parse`) — benign envelope mismatches (a couple look like templated placeholders, e.g. `{{PHONE_…}}`, that produced a non-conforming envelope), correctly fenced by the always-on F28 layer. None are malicious poison, and all occurred **before** FC-2 merged.

**Conclusion (sample taken 2026-10-10, ~2h28m / 8856s after the merge — a short window, not a day):** at the sample moment there were **no `.json.poison` strike sidecars, an absent `poison-notices/` queue (no backlog), and no new `dead-letters.jsonl` records or `quarantine/` files since the merge** (the 10 dead-letters + 11 quarantine files are all pre-merge). CAVEATS — do not over-read a point-in-time sample: a successful ack CLEARS a strike sidecar, and `dead-letters.jsonl` records only quarantine RESULTS (not every strike), so absence-now does not by itself PROVE zero strikes occurred in the window; and "source default is OFF" is not a verified audit of every process's runtime `SWARM_POISON_DLQ` history. **Provable:** the pre-merge inventory + no new quarantine/dead-letter records + an empty notice queue + no strike sidecar at the sample moment. **UNVERIFIED (no positive evidence either way):** whether the full strike→quarantine→S19 flow has ever run in production.

## Recommendation (the flip is the USER's gate — this is advisory only)

The sample is clean (no obligations, no backlog, no live strike sidecar). Two honest points shape the call:

- **For flipping default-on:** the always-on schema/parse quarantine (layer 1) demonstrably fires (11 cases Oct 5-9) and shows no runaway — so the inbox stays protected regardless. FC-2 (layer 2) *adds*, for a DIFFERENT failure (a valid envelope that crashes on host push), strike-thresholded quarantine + S19 coordinator visibility; it is 0-REMAIN selftested and its durable queue is empty. Low blast radius (the flip only turns on strike-counting + the notice path; it does not change layer-1 safety).
- **For a short canary first:** there is **no production record** that the strike→quarantine→S19 path has run against a real push-crash — it is UNVERIFIED either way (§Conclusion), dormant since merge with no positive evidence it has or has not fired. A canary would create that missing record under controlled conditions before a default flip.

**Recommended: a brief canary, then flip.** The canary must exercise FC-2's ACTUAL trigger, which is NOT schema/parse (layer 1 quarantines that upstream): enable `SWARM_POISON_DLQ=1` on the **drainer that processes the test message** (not merely the coordinator/notice-recipient), feed a message whose host **push deterministically THROWS**, and confirm that after `SWARM_POISON_DLQ_THRESHOLD` (3) strikes the message is quarantined, one S19 notice is enqueued to `poison-notices/`, and it drains + deletes after a confirmed send. (A schema/parse message cannot test this — layer 1 fences it first; enabling only on the coordinator cannot test it — the coordinator is the recipient, not the crashing drainer.) **Risk to note before the flip:** FC-2 ADDS a new behavior — a valid-but-crashing message is quarantined (out of delivery) after N strikes, where today it would retry head-of-line; that is the intended fix (stop the poison-pill) but it is new runtime behavior, so the canary should confirm it fences only the genuinely-crashing message. If the user prefers, flipping now is defensible given layer-1 safety + selftest coverage — the difference is only that the missing production record (§Conclusion) would then be filled by the first post-default strike→notice rather than by a canary; verification happens after enable instead of before it. Either way the kill-switch is `SWARM_POISON_DLQ=0`.

(If the swarm later adopts the `flag-default.ts` opt-out convention for POISON_DLQ too, note that `poisonDlqEnabled` in `inbox.ts` currently uses the opt-in reader `/^(1|true|yes|on)/`, not `flagDefaultOn` — flipping the default means switching that one predicate, a one-line change for a separate reviewed commit, not this doc.)

## Still-opt-in flags — current status

The 2026-10-10 user ruling flipped the swarm *wiring* flags to default-ON (opt-out) via `flag-default.ts` (`flagDefaultOn`: unset/empty/non-negation ⇒ ON; `0|false|no|off` ⇒ OFF). These remain **opt-in (default OFF, `/^(1|true|yes|on)/`)** on purpose:

| Flag | Default | Gate (reader) | Why still opt-in |
|---|---|---|---|
| `SWARM_TG_ENTRY` | OFF | `scripts/swarm-tg-entry.ts` | Needs a user-seeded bridge token; default-on would spin an errored bridge (the documented `flag-default.ts` exception). |
| `SWARM_POISON_DLQ` | OFF | `inbox.ts:284` `poisonDlqEnabled` | This audit's subject — opt-in pending the flip decision. |
| `SWARM_SPEND_BREAKER` | OFF | `spend-breaker.ts` `breakerEnabled` | A spend/budget admission gate; off until budgets are provisioned (false-trip would block work). |
| `SWARM_GRILL_GATE` | OFF | `grill-gate.ts:251` | A review-grilling gate; opt-in. |
| `SWARM_FANOUT` | OFF | `scripts/swarm-fanout.ts:28` `fanoutEnabled` | Sovereign fan-out backend (phase-1), dormant until explicitly driven. |
| `SWARM_PERM_GATE` | OFF | `perm-inbound-gate.ts:54` | Inbound permission gate; opt-in. |
| `SWARM_POISON_DLQ_THRESHOLD` | 3 | `inbox.ts` `poisonDlqThreshold` | Not a boolean — the strike count before an S19 notice (only in effect when `SWARM_POISON_DLQ` is on). |

For contrast, the now-default-ON (opt-out, kill with `SWARM_<X>=0`) wiring flags are: `SWARM_BOARD_ADMIT`, `SWARM_REVIEW_AUTOSCALE`, `SWARM_SUCCESSION`, `SWARM_COORD_ESCALATE`, `SWARM_GAUGE_SAMPLING` (per `flag-default.ts` + the dispatcher boot log). `SWARM_COORDINATOR` and `AGENTHOP_TEAM`/`SWARM_TEAM` are addresses/config values, not boolean gates.
