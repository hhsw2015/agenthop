# Dual-channel protocol — durable inbox carries the text, the queue only pings

owner coordinator (crystallized by aad02248, S31) · 2026-10-09 · ruling: `docs/swarm/rulings/S31.json` · death-cause corpus: `~/.agenthop/swarm/archive-dead-boxes-20261009/`

## The one rule

A swarm message has TWO channels, and they are not interchangeable:

| channel | medium | role | lifetime |
|---|---|---|---|
| **durable inbox** | `writeInbox` → `~/.agenthop/inbox/<sid>/<ts>-<rand>.json` | **carries the full text** (the record) | persists across offline / restart / sid-churn; drainable + archivable + replayable |
| **bus / queue** | `agenthop_send` / peer bus | a **wake-up ping** ("you have new mail") — an accelerator | ephemeral; gone if the peer is offline / vanished / not listening |

- **Full text ALWAYS goes to the durable inbox.** It is the system of record.
- **The bus/queue ONLY pings.** It never carries content. It makes a durably-delivered message *surface sooner*; it is not the delivery.
- **`send` success ≠ content delivered.** A bus send can succeed while the peer session is offline, has refused inbound, changed its sid, or will let the ping expire. Only the bytes on disk in the recipient's durable inbox are the fact.

This continues **S14** (seven-field envelope — the full-text structure) and **S29** (一单两信 — the durable inbox is the record, the bus is the accelerator).

## Why — the death-cause corpus (`archive-dead-boxes-20261009/`)

Every corpse in the archive died the same way: **content that depended on an ephemeral/one-shot delivery, with no durable landing a retry could recover.** 16 entries: 10 loose dead-letters + 5 vanished-session inboxes + a stale `.claim`.

- **Vanished-recipient (5 session-inbox dirs, e.g. `20cab0a5-…/`, `a058b168-…/`):** messages held for a session that then disappeared (crash / sid-churn / new shell). Had the content ridden only the bus, it would be gone; because it was in the *durable* inbox it survived to be archived — proof the durable channel is what saves content when the recipient is not there.
- **Redundant / stale-address (`already-reviewed-da2r6b.json`):** a re-submission to a review seat that had already ruled AND whose sid had changed — delivered to an address that no longer consumed it. The content was safe (durable), but the *address* was dead. Lesson: address by the current durable sid; a send to a churned sid is a no-op the queue cannot tell you about.
- **Duplicate (`b8-1-dup.json`):** the same content sent twice; one copy dead-lettered. Lesson: one durable write per fact; the bus ping is idempotent-safe because it carries nothing.

## Anti-recurrence checkpoints

Before sending anything a peer must act on, confirm:

1. **Full text is in the durable inbox** (`writeInbox`, seven fields S14) — not only in a bus message body.
2. **The bus send, if any, is a PING** — a one-line "new <taskRef> in your inbox", not the payload. Losing it costs only latency, never content.
3. **Addressed to the recipient's CURRENT sid** (re-resolve on sid-churn; a handle's short id can change across restart). A send to a stale sid is silent.
4. **Treat `send` as "maybe surfaced", not "delivered".** The durable write is the delivery; a reply/receipt (or the recipient draining its inbox) is the confirmation.
5. **One durable write per fact.** Re-sends target the same durable record (idempotent), never a second content copy on a second channel.
6. **Offline peer / 0 bus peers is normal** — never block on a bus ack; the durable inbox surfaces on the peer's next flush.
