# F38 inbox schema drift — root fix review packet → 01a0ead5

**needs:** none (ready for review). **unverified surface:** none beyond scope — this is a pure `@agenthop/bus` change, fully
covered by the bus suite (941/941) + tsc.

**Scope** (coordinator dispatch, S14): F38 root-fix for the inbox schema drift that quarantined documented `via:"durable-inbox"`
writes. Branch `feat/inbox-via-tolerance` from `b5fde65`. Fixed code SHA: `c1df9de` (+ this packet). fixOwner f32a0507.
Source repo: `~/Dev/agenthop-wt/inbox-via`.

## Root cause
`packages/bus/src/inbox.ts` `validInboxMsg` accepted `via` only in `{local, relay}`, but the S11 docs sanctioned a
hand-written durable record with `via:"durable-inbox"`. Two sources of truth → 5 documented writes (incl review packets,
mine from 90b58f9c) were F28-quarantined. The fix makes the validator the single source of truth, tolerant of the label,
plus a canonical writer so hand-JSON can never drift again.

## Deliverables → where (dispatch ①-④)
| # | Item | Where |
|---|---|---|
| ① | read side tolerates any non-empty `via` label; `local`/`relay` semantics unchanged; display as-is | `inbox.ts` `validInboxMsg` (`typeof r.via !== "string" || r.via.length === 0` ⇒ reject; else accept). `InboxMsg.via` + `BusMessage.via` widened `"local"\|"relay"` → `string` (both only `===`-compared, never switched) |
| ② | canonical write helper, output always passes the validator | `inbox.ts` `composeInboxMsg(...)` — defaults `ts=now`, `via="durable-inbox"`; keeps known fields; re-validates, throws on invalid. `writeInbox` already validates at the boundary |
| ③ | selftest pins the behavior | `test/inbox.test.ts`: `durable-inbox` passes; empty/missing/mistyped `via` rejected; `composeInboxMsg` write→claim round-trip (the exact shape that was quarantined); write-boundary case swapped `carrier-pigeon`→empty `via` |
| ④ | S11 doc examples → legal form | `docs/swarm/dogfood-notes.md` F38 entry + manual-delivery template now points at `composeInboxMsg`. `docs/swarm/team-collab-design.md` is **frozen** (describes the schema, not a copy-paste example) → left for the user/coordinator gate; see note below |

## Semantics
- `via` is a free-form provenance LABEL. `local`/`relay` still carry transport meaning (set by the bus/relay layers,
  compared with `===`); an unknown label (`durable-inbox`, …) is PRESERVED VERBATIM in the delivered record
  (`InboxMsg` + `BusMessage` from `core.recv`), never a quarantine reason. SCOPE (precision, re F38 review): this is
  field-level pass-through, NOT a new UI rendering of `via` — the existing display paths (`mcp.ts` `agenthop_recv`
  output, the host push adapter) do not surface `via` today and did not for `local`/`relay` either; F38 adds none.
  Making an unknown label user-visible would be a separate, explicitly-agreed change (see the scope note below).
- Empty / missing / non-string `via` is STILL rejected (poison) — the F28 crash-defense is intact.
- `composeInboxMsg` is the one validated constructor; manual JSON routes through it, closing the doc↔validator gap.

## Tests / typecheck
- `test/inbox.test.ts`: 18/18 (F28 cases updated for F38 + new `composeInboxMsg` round-trip + write-rejection on empty via).
- Full bus suite: **941/941** green. `tsc --noEmit`: clean (via widening is `===`-only, no exhaustive switch broke).

## Notes for the reviewer
- `team-collab-design.md` (frozen `team-collab v2-final`) describes the S11 schema abstractly; I did not edit a frozen
  contract doc unilaterally — if the gate wants the frozen schema line to name `composeInboxMsg`/the label tolerance, that
  is a one-line contract amendment for the coordinator/user.
- stopSet honored: committed on the branch, **not merged, not pushed**.
- Pre-merge delivery caveat: until this merges, live buses still run the old validator, so THIS packet was delivered with
  `via:"local"` (not the not-yet-accepted `durable-inbox` label) to avoid re-quarantine — itself a demonstration of the bug.
