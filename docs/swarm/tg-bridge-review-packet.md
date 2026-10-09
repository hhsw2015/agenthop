# Review packet — TG user-entry v1 (notify + collect-approvals), ROUND 1

- **Branch** `feat/tg-bridge`  **HEAD** `7c6dff0`  **Base** `main` (`bdd93d7`)
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
