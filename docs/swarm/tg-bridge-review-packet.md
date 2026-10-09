# Review packet — TG user-entry v1 (notify + collect-approvals), ROUND 2

- **Branch** `feat/tg-bridge`  **HEAD** `f34ca77`  **Base** `main` (`bdd93d7`)  (round-1 `7c6dff0`)

## Round 2 — round-1 REMAIN resolved (TG-P1-1..P2-4; P2-5 phased)
- **TG-P1-1 (P1)** `allowedScopes` is ENFORCED on the REAL item via the pure `enforceScope`, at BOTH boundaries that touch the ledger: the write (`recordDecision`) and the resolve (`resolveBatch`). A hard-gate item's approve scope is clamped to `once` — it can never RECORD a `this-chat`/`always` grant, from TG or console. The UI buttons are no longer the permission boundary.
- **TG-P1-2 (P1)** a single-item tap MERGES: the new pure `upsertDecision` + the atomic, per-batch-locked `recordDecision` upsert the one item and PRESERVE every sibling a console already recorded (a re-tap updates one entry; concurrent taps serialize under the consume lock). The driver uses `recordDecision`, never the snapshot-replacing `writeDecisions`.
- **TG-P1-3 (P1)** the bot token is 0600 from the first byte — a 0600 temp + atomic rename over the target (replaces a pre-existing 0644); no post-hoc chmod window.
- **TG-P2-1 (P2)** the `getUpdates` offset advances ONLY on a terminal outcome (recorded / consumed / unknown-item / ignored / expired-ref); a transient IO error or a contended lock STOPS the poll without advancing, so the update is retried — never a false "already decided".
- **TG-P2-2 (P2)** a batch is marked notified ONLY after FULL successful delivery to a non-empty allowlist; a failed send or zero recipients leaves the retry obligation (no zero-delivery completion proof).
- **TG-P2-3 (P2)** `callback_data` is a compact hash-ref `<batchHash10>.<itemIndex>` the driver resolves against live batches — ANY legal batchId/itemId (64-char, CJK, containing `|`) round-trips unambiguously under 64 UTF-8 bytes, no truncation.
- **TG-P2-4 (P2)** `parseUpdate`/`parseCallback` shape-validate and return `ignore` (NEVER throw) on a non-string/object/null/malformed update; off-allowlist still writes nothing. First-contact: an un-allowlisted chat_id is surfaced so the user can add it (the design detail).
- **TG-P2-5 (P2) — phasing proposed.** The decision-notify entry (the v1 core value) + first-contact are fully wired + verified. The remaining approved-case outbound — scheduled morning digest, bandwidth-gauge read, S19-receipt render, `sendDocument` multipart + the gauge-card rasterizer — have their PURE cores ready (`composeDigest`, `renderProjection`) but need driver wiring. **Requesting the coordinator confirm these as an explicit v1.1 phase** (vs blocking v1 on the rasterizer). If not phased, I wire them next.
- Gates: bus tsc 0, scripts tsc 0, tg-entry selftest 37, decision-batch 40 (recordDecision merge/clamp/consumed + the two-entry no-fork), full bus vitest no new failures vs the env baseline.
- **Reviewer** codex `01a0ead5` (cross-family)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/tg-bridge-design.md` @`dc76d57` (coordinator-APPROVED full case). **User gate PASSED**: user authorized Telegram + ruled it an entry-layer peer to the console.

## What this is
The Telegram USER-ENTRY, v1 = notify + collect-approvals, NEVER executes. Per the user's entry-layer ruling: an entry READS the core's frozen projections and WRITES the single decision ledger — zero business logic; console + TG are same-source, no fork; adding an entry does not change the core.

## Deliverables
- **CORE — decision-batch.ts (shared by every entry):** `ApprovalScope` (once/this-chat/always) on `Decision`; `hardGate` on `DecisionItem`; pure `allowedScopes(item)` — a hard-gate (spend/publish/irreversible) item offers ONLY `once`, never `always` (R16). Validators accept the optional fields; `scope` kept only on `approve`.
- **CORE — morning-digest.ts:** pure `composeDigest` (the once-generated morning brief; alerts lead; quiet-night explicit). Entries are delivery ends, not generators.
- **TG pure core — tg-entry.ts:** `renderProjection(proj) -> RenderSpec` (multimodal: `message` / `photo` gauge-card / `document` / pinned RED alert; decision items carry the scope keyboard from `allowedScopes`); `parseUpdate(update, allowlist, nowSec)` (allowlist the `chat_id` FIRST, map a tap to a one-decision `DecisionsDoc`; off-allowlist / typed-reply / malformed -> ignore); `encodeDecisionCb` / `parseCallback`. No IO; never changes a projection (image = entry-side render).
- **Thin driver — scripts/swarm-tg-entry.ts:** DORMANT behind `SWARM_TG_ENTRY`; token on STDIN -> 0600 (never argv/env, vm-ctl §creds); long-poll `getUpdates` -> `parseUpdate` -> `writeDecisions`; notify new batches; `answerCallbackQuery` ack; re-reads the allowlist each loop.

## Red lines (held)
- v1 EXECUTES NOTHING — a verdict is only WRITTEN to the ledger; the coordinator's R17 chain re-injects. The driver has no command path.
- `chat_id` ALLOWLIST gates every inbound before anything is read; TG text is untrusted.
- Single truth / no fork: a sealed batch REFUSES a second entry's write (`writeDecisions` throws `already consumed`) and `consumeDecisions` is terminal — whoever decides first wins, the other entry is a no-op (proven bidirectionally in selftest).

## Gates
- bus tsc 0; scripts tsc 0; `tg-entry.selftest.mts` 24 (allowedScopes hard-vs-soft, render primitives incl. hard-gate-has-no-always, parseUpdate allowlist/ignore/map, callback round-trip, digest); `decision-batch` 36 incl. the two-entry consume-once counterexample (console-first -> TG write refused, and TG-first -> console refused).
- Full bus vitest: +2 passing (the two-entry cases), NO new failures. (The worktree's ~34 other failures are a pre-existing env baseline on `main bdd93d7` in a fresh worktree — live codex daemon / relay / real-git; 35 without this change.)

## Boundaries / self-flags
- Multimodal v1: `renderProjection` emits the photo/document SPEC; the driver sends the caption (no gauge-card rasterizer yet) and notes a document pointer (full `sendDocument` multipart is a follow-up). The projection contract is unchanged (image = entry-side render).
- v1 OUTBOUND is decision-batch notify; wiring the bandwidth gauge + scheduled digest through the driver is a thin follow-up (the pure render/compose already exist).
- Bot creation + token/allowlist seeding = the USER's one-time step (checklist in the design); the entry never does it.
