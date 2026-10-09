# TG entry (user-entry layer, v1 notify + collect-approvals) — design

User rulings: (1) "可以接入 Telegram" — the outward-facing surface is authorized (PROGRESS 15:5x). (2) "Telegram 是用户入口,与 OpenDots(console)同级" — Telegram is a USER ENTRY, peer to the console; **entries are added without changing the core**. Charter from `docs/research/nanomuse-eval.md` Q7a. DORMANT; design-first.

## The entry-layer contract (the load-bearing section)
There is ONE core and MANY entries (console :4310, TG, a future PWA). An entry is a thin adapter with EXACTLY two duties and ZERO business logic:
1. READ the core's FROZEN projections and render them for its medium.
2. WRITE the user's decision to the core's SINGLE decision ledger.
Consequences (what "同层异端, 不改核" forces):
- **Same source**: both entries read the SAME frozen contracts — `bandwidth-gauge/v1` (dual-bandwidth-store), `chat-room-v1` (chat-room-store), the decision-batch `DecisionBatch` projection, and the S19 approval doc (`buildApprovalDoc`). An entry NEVER invents its own data plane; what the console shows and what TG shows are the same facts.
- **Single truth, no fork**: every verdict lands as the SAME `DecisionsDoc` (decision-batch) / S19 receipt, whether the user clicks in the console or taps in TG. The decision-batch store is CONSUME-ONCE and keyed by `batchId`+item `id`, so two entries can offer the same batch but the first verdict wins and the second is a no-op — no double-write, no divergence.
- **Generate once, deliver many**: the morning digest is a CORE projection built once; console and TG are both delivery ENDS, not two generators.
- **Add an entry without touching the core**: a PWA or a third entry plugs in by consuming the same projections + writing the same ledger. The core gains nothing entry-specific.
- Any logic beyond render+write (the scope ladder's allowed scopes, the digest composition) lives in the CORE so every entry behaves identically — it is NOT TG-local.

## What this charter delivers
1. **The TG entry adapter** (`scripts/swarm-tg-entry.ts` IO driver + `packages/bus/src/swarm/tg-entry.ts` pure render/parse) — reads the frozen projections, pushes to a bot, collects taps, writes the ledger.
2. **Scope ladder as a CORE decision-contract extension** (in decision-batch / S19, shared by all entries): an approve verdict may carry a remembered scope `once | this-chat | always`; a HARD-gate item (spend / publish / irreversible) offers ONLY `once` (never `always` — R16: no blanket consent to the three gates). Both console and TG render the same allowed set from the core.
3. **Morning digest as a CORE projection** generated once (roll PROGRESS.md tail + control-log deltas + cleared reviews — our north-star "verify in the morning"); console + TG both deliver it.

## Pure core (selftested; the reviewable decisions)
TG-entry pure (`tg-entry.ts`):
- `renderProjection(proj) -> {text, keyboard?}` — render a FROZEN projection (DecisionBatch item / bandwidth gauge / chat-room post / S19 doc / digest) into a TG message; a decision item carries an inline keyboard of the CORE-allowed scopes.
- `parseUpdate(update, allowlist) -> DecisionWrite | Ignore` — allowlist-gate the `chat_id`, shape-validate a `callback_query`/`message`, map it to a `DecisionsDoc` verdict (`approve[/scope] | reject | defer`) addressed to `batchId`+`id`. Untrusted input: anything off-allowlist or malformed -> Ignore (logged, never acted on).
Shared CORE (so every entry matches):
- `allowedScopes(item) -> ("once"|"this-chat"|"always")[]` — the scope ladder; hard-gate item -> `["once"]` only.
- `composeDigest(sources, now) -> text` — the once-generated morning digest.

## Red lines (v1)
- The entry EXECUTES NO command, ever. It only WRITES a verdict to the decision ledger; re-injection into the swarm stays on the EXISTING coordinator R17 chain (the entry is not in that path).
- Every inbound TG update is `chat_id`-ALLOWLISTED (the user, one id) before anything is read; TG text is untrusted input.
- DORMANT behind `SWARM_TG_ENTRY` (default OFF); the user starts the entry process themselves. No auto-spawn, no hook.

## Credential discipline (§creds, same gate as vm-ctl)
The bot token travels on STDIN into a `0600` file (`~/.agenthop/tg/bot.token`), NEVER argv (leaks to `ps`) and NEVER a persistent env var (leaks to children). The `chat_id` allowlist sits beside it (`~/.agenthop/tg/allow.json`, 0600). The driver reads both at startup.

## IO driver (thin)
Long-poll `getUpdates` (offset-committed) + tail the frozen projection stores; `sendMessage` with an inline keyboard for decisions; on a tap/reply, `parseUpdate` -> write the `DecisionsDoc` via the decision-batch store (consume-once) / the S19 receipt path. No new transport or state store — it reuses the existing projection reads + decision writes the console already uses.

## Bot-creation checklist (the USER's one-time step; the entry never does it)
1. Telegram -> `@BotFather` -> `/newbot` -> get the TOKEN.
2. Seed it on stdin to the 0600 file (never argv): `printf %s '<token>' | <entry> --seed-token` (or `… > ~/.agenthop/tg/bot.token && chmod 600`).
3. Message the bot once; put your numeric `chat_id` in `~/.agenthop/tg/allow.json` (0600) (the entry prints it on first contact).
4. `export SWARM_TG_ENTRY=1`, start the entry. Done.

## Acceptance
With the gate on + token/allowlist seeded: a DecisionBatch / S19 approval written by the coordinator appears in TG with the CORE-allowed scope buttons (hard gate -> no "always"); a tap writes the SAME `DecisionsDoc` the console would (consume-once: a console verdict first makes the TG tap a no-op, and vice-versa — no fork); the morning digest (generated once) arrives on schedule; a non-allowlisted `chat_id` is dropped; gate OFF -> inert. Pure core selftested (render / parse / allowedScopes / composeDigest / allowlist).

doneLine: design approved -> implement the TG entry pure core + selftest + thin driver, PLUS the two CORE extensions (scope-ladder field + digest projection) both entries share; review; the bot creation + token seeding stay the USER's one-time step.
