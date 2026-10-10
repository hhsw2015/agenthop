# Dual-channel protocol — the durable inbox is the record; a ping is only a ping

owner coordinator (crystallized by aad02248, S31) · 2026-10-09 · ruling: `docs/swarm/rulings/S31.json` · death-cause corpus: `~/.agenthop/swarm/archive-dead-boxes-20261009/`

## Two channels — classified by DELIVERY RESULT, not by the API you called

`agenthop_send` is not inherently ephemeral. It calls `core.send` (packages/bus/src/core.ts), whose addressing decides the actual transport, reported as `delivered`:

| delivery | what happens | persistence |
|---|---|---|
| **durable** | `writeInbox` into the recipient's `~/.agenthop/inbox/<sid>/` — a SAME-MACHINE target (a live local peer, or an offline session that owns the handle via `presence/<sid>.pid`). The recipient's fs-watch surfaces it near-live; it survives a restart. `writeInbox` directly is the same channel. | **persists** — drainable, archivable, replayable |
| **relay** | a CROSS-MACHINE recipient has no shared durable inbox → a live **best-effort** relay send, reported honestly as `delivered:"relay"`. | **ephemeral** — gone if the peer is offline / not listening |
| **pure ping** | a one-line "you have new `<taskRef>`" carrying NO payload. | irrelevant — losing it costs only latency |

So persistence follows the `delivered` RESULT: a same-machine `agenthop_send` is already durable (it writes the inbox); a cross-machine send is best-effort; a bare ping carries nothing.

## The rule (S31)

1. **Full text ALWAYS lands durably** — `writeInbox` (or a same-machine send, which writes the inbox). The durable inbox is the system of record.
2. **The queue/relay and the bare ping only wake the reader** — they must never be the SOLE carrier of content a peer must act on, and the same content must not be injected on a second (ephemeral) channel (that is the duplicate death below).
3. **`send` success ≠ content delivered** for a cross-machine/relay result: the peer may be offline / refusing / expired. Only bytes in the recipient's durable inbox are the fact.

Continues **S14** (seven-field envelope — the full-text structure) and **S29** (一单两信 — durable inbox is the record, bus is the accelerator).

## Why — the death-cause corpus (`archive-dead-boxes-20261009/`)

16 top-level entries: ~11 loose dead-letters + 4 dead session-inbox dirs (UUID-named) + 1 wrongly-scanned `garbage-named-dir`. PROGRESS records the first sentinel pass catching a real stall: **"4 dead boxes, 13 stranded items"** (old codex thread box + retired-sid boxes + a dead `.claim`). The deaths are THREE modes — not one — and all three are what the dual-channel discipline closes:

- **(1) Stale / dead address.** The 4 UUID session-inbox dirs (`20cab0a5-…`, `a058b168-…`, `a3def7c0-…`, `a8fa0581-…`): messages held for a session whose sid retired or whose thread box vanished. The content was durably written; the *address* died. → address the recipient's CURRENT sid; `send`-success can't tell you an address went stale.
- **(2) Dual-channel duplicate.** `flag-wiring-{dup-already-in-review,r3-dup,r4-dup2,r5-dup,r6-dup}.json`, `b8-1-dup.json`, `already-reviewed-da2r6b.json`: the SAME full text existed in both the durable inbox AND a separate queue injection (PROGRESS: "dual-channel queue+box needs收敛"). The box copy was fine; the queue copy was a redundant corpse. → one durable write per fact; the queue only pings, carries no content.
- **(3) Un-scanned durable inbox (reverse variant).** PROGRESS: a consumer stalled waiting for an item that was ALREADY in its durable inbox — it only watched the queue channel and never scanned the box. The content was durably landed; the READ side ignored the record. → drain/scan your durable inbox; do not treat the queue as the only arrival signal.

(Also archived but not message-deaths: a stale `.claim` file, and `garbage-named-dir` — a non-inbox directory the sentinel wrongly scanned, fixed separately as an F44-family sentinel bug.)

## Anti-recurrence checkpoints

Send side:
1. **Full text is written durably** (`writeInbox`/same-machine send, seven fields S14) — not only in an ephemeral/relay message body.
2. **One durable write per fact.** Never also inject the same content on a second channel (that makes duplicate corpses, death mode 2). A re-send targets the same durable record.
3. **A bus ping, if sent, carries NO payload** — a one-line "new `<taskRef>` in your inbox". Losing it costs only latency.
4. **Address the recipient's CURRENT sid** (re-resolve on sid-churn; a handle's short id can change across restart). Treat a `delivered:"relay"` send as "maybe surfaced", not delivered (death mode 1).

Read side:
5. **Drain/scan your DURABLE INBOX, not only the queue.** An item can be durably present while the queue was quiet — do not declare a stall without checking the box (death mode 3).
6. **Offline peer / 0 bus peers is normal** — never block on a bus ack; the durable inbox surfaces on the peer's next flush.
