# SWARM_POISON_DLQ — observation-window audit (FC-2)

Audit of the poison dead-letter facility (FC-2) over its observation window since merge, per coordinator dispatch. Pure observation + recommendation; the default-flip itself is the USER's gate and is NOT touched here.

- **Merged:** `fa4f5ac` (Merge `feat/poison-dlq`, FC-2 poison dead-letter isolation, signed 0 REMAIN, 7 rounds) at **2026-10-10 09:58:09 +0800** (epoch 1791597489000).
- **Audited:** 2026-10-10, live `~/.agenthop/` on this host.

## The facility has two layers (important for reading the evidence)

1. **Always-on F28 schema-quarantine (NOT gated).** In `inbox.ts`, the flush path validates every claimed inbox file; a poison file (unparseable JSON or missing/mistyped required fields) is moved to `inbox/<sid>/quarantine/` (random-suffixed, evidence-preserving) and a line is appended to `~/.agenthop/swarm/dead-letters.jsonl`. This runs unconditionally and predates FC-2 — it is the safety net (a poison file never re-claims, never re-crashes the server).
2. **Opt-in FC-2 strike + S19-notice layer (gated by `SWARM_POISON_DLQ`, default OFF).** On top of (1): per-file strike counting (`SWARM_POISON_DLQ_THRESHOLD`, default 3), an S19 coordinator notice built + enqueued to the DURABLE queue `~/.agenthop/swarm/poison-notices/` (drained + delivered by any later flush, deleted only after a confirmed send; a `needs-migration/` subdir holds prior-version queue files). This is the part that is dormant.

> Naming note: the dispatch referred to `*.json.poison` sidecars and a `poison-notices/` dir. There is **no `.poison` sidecar** in the implementation — the real quarantine artifacts are the `inbox/<sid>/quarantine/` dirs + `dead-letters.jsonl`. `poison-notices/` **is** the real FC-2 notice-queue path (checked below).

## Evidence (live filesystem)

| Artifact | Found | Since the FC-2 merge (2026-10-10 09:58) |
|---|---|---|
| `~/.agenthop/swarm/dead-letters.jsonl` | 10 records, ts 2026-10-06 → **2026-10-09** | **0 new** (file untouched since Oct 9 14:29; none after the merge) |
| `inbox/<sid>/quarantine/` | 11 files across 4 inboxes, mtimes 2026-10-05 → **2026-10-09** | **0 new** (all predate the merge) |
| `~/.agenthop/swarm/poison-notices/` (FC-2 opt-in queue) | **absent** | **0 obligation backlog** |
| `~/.agenthop/swarm/poison-notices/needs-migration/` | absent | — |

**What the 10 + 11 pre-merge items are:** real inter-session check-in / handoff / review messages (e.g. `reboot-rollcall`, `herdr-backend-claim`, `herdr-scope-query`, `t3b-r5-fixed`) that failed the inbox schema validator (`quarantined: schema/parse`) — benign envelope mismatches (a couple look like templated placeholders, e.g. `{{PHONE_…}}`, that produced a non-conforming envelope), correctly fenced by the always-on F28 layer. None are malicious poison, and all occurred **before** FC-2 merged.

**Conclusion of the window:** since the FC-2 merge there have been **zero poison-hits, zero new quarantines, and zero notice-queue backlog.** The opt-in strike/S19-notice layer has therefore **not been exercised in production** (it has only its 0-REMAIN selftests) — because the flag has been off and no poison has arrived in the ~1-day window.

## Recommendation (the flip is the USER's gate — this is advisory only)

The window is clean (no obligations, no backlog, the always-on safety net shows no runaway). Two honest points shape the call:

- **For flipping default-on:** poison demonstrably occurs in practice (11 real schema/parse cases over Oct 5-9), so FC-2's value is not hypothetical; the always-on quarantine already handles the dangerous part; the opt-in layer only *adds* strike-thresholded S19 visibility for the coordinator, is 0-REMAIN selftested, and its durable queue is empty. Low blast radius.
- **For a short canary first:** the strike→enqueue→drain→S19 path has **never run against a real poison file in production** (dormant since merge). A default-on flip would be its first live exercise.

**Recommended: a brief canary, then flip.** Enable `SWARM_POISON_DLQ=1` in the coordinator session only (it is the notice recipient) for a short window; if a real schema/parse poison arrives, confirm one S19 notice lands + drains cleanly (queue empties after a confirmed send); then the user flips the default on. If the user prefers, flipping now is defensible given the always-on safety net + selftest coverage — the risk is only that the first live notice is observed post-default rather than in a canary. Either way the kill-switch is `SWARM_POISON_DLQ=0`.

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
