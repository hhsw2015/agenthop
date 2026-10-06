# F40 stable inbox addressing + legacy-claim + unclaimed-mail sentinel — review packet → 01a0ff49 (S12 cc coordinator)

**needs:** re-verify at the new SHA `0a9d9ac`. fixOwner f32a0507. Source repo `~/Dev/agenthop-wt/stable-inbox`.

---

## Revision 3 — F40-2 A/B fixed (re-verify `0a9d9ac`)

Round-2 (reviewer 01a0ff49, against `4db1ccb`): **F40-1/3/4/5 CLOSED**; only **F40-2** remained (1 P1, two sub-gates).
Both fixed in `0a9d9ac` (review range `4db1ccb..0a9d9ac`, `core.ts` only). Verify:
`pnpm --filter @agenthop/bus exec vitest run` → **75 files / 963 green**; bus + scripts tsc → **0**.

| sub | Finding (round 2) | Fix | Gate pinned by |
|---|---|---|---|
| F40-2-A | recv refreshed legacy only at ENTRY; its 120ms poll loop kept the entry-time set ⇒ a correction/late-link DURING the wait was ignored (a revoked box still claimed+ack'd; a late link missed) | refresh moved INTO `drain()` — before EVERY claim (entry + each poll); stamp-gated so cheap | `core-legacy-refresh.test` "F40-2-A … during a pending recv" |
| F40-2-B | a read EACCES (stat ok, read fails) was folded to an EMPTY projection AND the stamp committed ⇒ after perms restored, the unchanged mtime/size made the gate skip the re-read forever (stranded mail) | on `readIdentityLog` status `error`/throw: grant NO legacy claim while blind (the log may already carry a revoke — the stale set must not keep authorizing), set a RETRY sentinel so the next flush/recv re-reads despite an unchanged stamp; commit the real stamp ONLY after a successful read | `core-legacy-refresh.test` "F40-2-B … EACCES … recovery after restore" |

Key point on B (per the coordinator/reviewer's "保守授权"): while the log is unreadable, legacy claim authorization is
EMPTY, not the stale set — so a revoke that landed just before the outage cannot be bypassed by an old cached key. The
current id/stableId paths keep working; the legacy set is rebuilt only from a successful read of the CURRENT projection.
A genuine ENOENT ("missing") still folds to empty as before (that IS the correct empty-log semantics).

---

## Revision 2 — round-1 findings fixed (re-verify `4db1ccb`)

Round-1 (reviewer 01a0ff49, against `fd432a4`) = **4 P1 / 1 P2 / 5 REMAIN**, all confirmed and accepted. Fixed per the
coordinator's rulings **R15 / R15-b** in `4db1ccb` (review range `fd432a4..4db1ccb`). Verify:
`pnpm --filter @agenthop/bus exec vitest run` → **75 files / 961 green**; bus + scripts tsc → **0**.

| # | Finding | Fix | Gate pinned by |
|---|---|---|---|
| F40-1 P1 | shared run-id bridged a thread-switch A→B ⇒ B drained A's box | `legacyInboxKeys` rewritten (R15-b): recover only the prior-RUN boxes of entities sharing `self.stableId` as a hard/non-superseded NATIVE; no stableId / collision native ⇒ `[]`; run-id→sibling bridge DELETED | `legacy-inbox-keys.test` "F40-1 counterexample: A→B does not let B drain A" + "restart … NOT a drifted-thread sibling" |
| F40-2 P1 | legacy cache ignored an alias-log correction/late-link until restart | recompute before every claim (flush + recv), stamp-gated via `identityLogStamp` (cheap when unchanged); force on identity change | `core-legacy-refresh.test` "F40-2 … no restart" (revoke ⇒ not claimed; late link ⇒ drained) |
| F40-3 P1 | dead-pid `.claim` invisible ⇒ unowned box never alerts | `scanInboxes` counts a `.claim-<pid>` whose holder is NOT alive as stranded; LIVE-pid claim stays excluded (in-flight, never stolen; sentinel only reports) | `swarm-inbox-sentinel.test` "F40-3 … LIVE in-flight / DEAD stranded" + end-to-end alert |
| F40-4 P1 | whois `candidates` ⇒ empty tool/cwd ⇒ over-credit ownership ⇒ suppress stall | dispatcher: a non-single-entity whois credits ONLY the direct sid (no legacy expansion) — safe under-credit (report, never suppress) | dispatcher runner (tsc + reviewer re-run); mirrors the new `legacyInboxKeys` |
| F40-5 P2 | coordinator-box alert count bypassed dedup ⇒ per-tick self-feedback | per-box dedup keyed by the STABLE box id (`inboxStallAlertedAt`), not the text ⇒ one alert per box per window + bounded reminder; coordinator box NOT wholesale-excluded (would hide real mail) | dispatcher runner (tsc + reviewer re-run) |

**Packet corrections (round-1 required):** the original "incident replay drains all three boxes" guarantee is REMOVED — per
R15-b the drifted-thread box is deliberately NOT drained (left to the sentinel); see the corrected Selftest section below.
The round-1 self-flag "empty tool/cwd is still safe" is WITHDRAWN — it was F40-4, now fixed. The "claims are all in-flight"
assumption behind the original sentinel scan is removed (F40-3: a dead-pid claim is stranded, not in-flight).

The sections below are the original round-1 packet (`fd432a4`), retained for provenance; where they conflict with Revision 2,
Revision 2 governs.

---

**needs (round 1):** none. fixOwner f32a0507.

Branch `feat/stable-inbox-addressing`, review range `b5fde65..fd432a4` (code; this packet is the only docs add, named
separately). stopSet honored: **committed on the branch, NOT merged, NOT pushed.**

Verify (round 1):
`pnpm --filter @agenthop/bus exec vitest run` → **74 files / 956 tests green**;
`pnpm --filter @agenthop/bus run typecheck` → **0**; `pnpm exec tsc -p scripts/tsconfig.json --noEmit` → **0** (double tsc).

## The incident (coordinator S14 dispatch, today)
1. A route confirmation addressed the reviewer by a SHORT-LIVED routing name (`...-a058b168`); author wrote to that box.
2. Codex restarted 17:32, its active thread drifted (`a8fa0581`); the old box became a DEAD box, the pusher died with the
   old run.
3. "written to durable inbox" read as a **false-positive receipt** (landed on disk ≠ claimed) — sender, coordinator,
   author all reassured; reviewer + author idle-waited; the user eyeballed the stall (external activation +1).
Empirical正解 that worked: `codex queue --thread <stableId>` — i.e. a STABLE identity routes.

## Root cause (what I found reading the code)
The durable inbox KEY is `self.stableId ?? self.id`. For Codex the MCP node spawns with a clean env (no
`AGENTHOP_SESSION`) and adopts the **per-turn thread id** as `stableId` (core `learnStableId`), while the presence daemon
keyed off the durable conversation id. When the active thread drifts / the process restarts, the key the SENDER used
(a drifted handle tail) names a box the new incarnation's `inboxKey()` never looks at → mail stranded, no claimer, no
machine-level notice.

## Three defense-in-depth fixes (prevent at write · recover at drain · detect if both miss)

### ① resolveInboxTarget — the single write-side addressing entry (`send-fallback.ts`)
One pure function converts `(to, roster-resolution, offline-presence-sid) → durable | relay | none`. The INVARIANT it
enforces structurally: the durable inbox **key (`sid`) is ALWAYS the recipient's stable identity** (resolved local
`stableId ?? per-run id`, or an offline session's presence-owned native sid) and **NEVER the routing name** (`to` /
`peer.title`), which is display-only (`label`). `core.send()` now computes its inbox key ONLY here, so a routing name can
never become one again. Same spirit as F38 `composeInboxMsg` (one validated write-side entry). `peer` is carried on a
resolved-local durable target so the OpenCode-live-bus special case (C1) survives unchanged.

### ② legacyInboxKeys — restart/drift drains prior-identity boxes (`bus-identity.ts`, folded into core `inboxKeys()`)
A restarted or thread-drifted incarnation DRAINS boxes keyed by a PRIOR identity of the SAME logical session (old per-run
id / a drifted Codex thread id), discovered from the durable alias-log projection. The lineage is the transitive closure
from self's own `id`+`stableId` over entities sharing a **hard, non-superseded run/native** value. **Conservative by
construction** (a wrong key would drain ANOTHER session's mail): an entity is adopted only on a shared **non-collision**
key, a `proj.collisions` native is never crossed, and a different `tool`/`cwd` is excluded. core recomputes it at startup
(before watch/flush) and on each identity change; fail-soft (the two current-identity keys always work alone).

### ③ detectStalledInboxes + runInboxSentinel — silent-stall backstop (`swarm/inbox-sentinel.ts` + `swarm-dispatch.ts`)
If ① and ② both miss, a durable box with unread mail older than `INBOX_STALL_SEC` (600s default) AND **no live session
draining it** is escalated to the coordinator's durable inbox — a stall is machine-discovered, not user-discovered. The
pure decision takes injected stats + an `isOwnedByLive` predicate; the dispatcher builds the owned-set by MIRRORING core's
`inboxKeys()` exactly (each live presence session's own key + its `legacyInboxKeys`, using the session's real `tool`/`cwd`
from `whois`), so a box a live session WILL drain is never a false alarm. Runs on the sweep tick (like `runObserver` /
`runDeadLetterWatch`), unconditional of `SWARM_SWEEP` (a stall detector must fire even with sweep rules off); fail-soft;
`notifyCoordinator` dedups an identical alert within the 60s window (stable text, so no per-tick spam).

## Scope proof (`git diff --name-status b5fde65..fd432a4`)
```
M packages/bus/src/bus-identity.ts        (+ legacyInboxKeys)
M packages/bus/src/core.ts                (resolveInboxTarget in send(); legacyKeys fold)
M packages/bus/src/inbox.ts               (+ inboxDirName export)
M packages/bus/src/send-fallback.ts       (+ resolveInboxTarget)
A packages/bus/src/swarm/inbox-sentinel.ts
A packages/bus/test/legacy-inbox-keys.test.ts
M packages/bus/test/send-fallback.test.ts
A packages/bus/test/swarm-inbox-sentinel.test.ts
M scripts/swarm-dispatch.ts               (import + INBOX_STALL_SEC + runInboxSentinel wiring)
```
Does NOT touch: control-log / task-wait / task-sweep / inbox claim-ack-release semantics (F28 poison defense intact),
relay / seal, the fallback primitives (`fallbackForUnresolved`/`fallbackForMissedDelivery` are kept and composed, their
existing tests unchanged).

## Clause → implementation → test map
| Ask (coordinator) | Implementation | Test(s) | Counterexample pinned |
|---|---|---|---|
| ① unique write-side addressing, routing name display-only | `send-fallback.resolveInboxTarget`; `core.send` | `send-fallback.test` "resolved LOCAL ⇒ durable keyed by STABLE identity…", "AMBIGUOUS/empty ⇒ none…" | the key is never the handle; ambiguous never falls back (B1) |
| ② legacy claim: new term absorbs old run-id + routing-name boxes | `bus-identity.legacyInboxKeys`; `core.inboxKeys`/`refreshLegacyKeys` | `legacy-inbox-keys.test` "incident replay…" | routing-name delivery → restart → new term drains old-run + drifted-thread boxes |
| ② no mail theft | collision-exclusion + tool/cwd guard in `legacyInboxKeys` | `legacy-inbox-keys.test` "a COLLISION native … is NOT crossed", "a DIFFERENT session's box is never adopted" | two concurrent different-cwd sessions sharing a native don't cross |
| ③ unclaimed-mail sentinel → escalate | `inbox-sentinel.detectStalledInboxes`/`scanInboxes`; `swarm-dispatch.runInboxSentinel` | `swarm-inbox-sentinel.test` (7) | old backlog + no live owner ⇒ alert; a live owner / fresh backlog ⇒ none; `.claim-*` not counted |

## Selftest — today's incident replay (CORRECTED per R15-b, Revision 2)
`legacy-inbox-keys.test.ts` "restart end-to-end": RUN1 boots `conv-1`, thread drifts `conv-1→thread-A`; mail written to
`conv-1`, `run-1` (old run), `thread-A` (drifted-thread box); RUN2 restarts (same `conv-1`, new `run-2`); the new term's
`legacyInboxKeys` = {`run-1`} and `claimInbox([conv-1,run-2,...legacy])` drains `conv-1` + `run-1` ONLY. The drifted-thread
box `thread-A` is DELIBERATELY left (a distinct entity — R15-b), to be surfaced by the sentinel, NOT silently drained. The
same-run A→B theft counterexample (`"F40-1 counterexample"`) pins that B never drains A. End-to-end at the pure+inbox layer.
(Supersedes the original "drains all three" claim, which R15-b forbids.)

## Self-flags (reviewer please rule)
- **Scope honesty on ①:** `resolveInboxTarget` is consolidation + a structural guard (no handle-as-key), not a new
  runtime behavior for the resolved-local path (which already preferred `stableId`). The drift ROOT fix is ②+③; ① makes
  the write side a single tested chokepoint. Called out so it is not mistaken for more than it is.
- **Known limitation (deferred to bus-identity proper, mitigated by ③):** the Codex clean-env MCP node is identity-
  isolated from the presence daemon when their stableIds diverge; ② bridges the "same stableId, new run" case the
  coordinator framed (and the thread-drift-within-a-run case), but cannot bridge a divergence where NO shared hard
  native/run links the two — ③ catches any such residue. Re-plumbing `AGENTHOP_SESSION` into the MCP server env is out of
  bus-package scope.
- **Sentinel runs unconditional of `SWARM_SWEEP`** (like `runObserver`): a stall detector must fire even with sweep rules
  off. It only ever WRITES a coordinator escalation (same surface the observer uses), never a control-log action.
- **legacyInboxKeys tool/cwd guard skips when either side is falsy** (unknown tool / no cwd) → permissive; a flaky
  tool-detection across runs could miss a legacy key. Safe direction (no theft; ③ catches the residue).
