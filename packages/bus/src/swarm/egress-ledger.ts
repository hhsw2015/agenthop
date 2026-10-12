/**
 * egress-ledger (pure core) — gstack borrow ② ([[gstack-eval]], docs/research/gstack-eval.md). A user-auditable, hash-chained,
 * RECORD-ONLY accountability ledger for the swarm's outbound calls. Honesty is the first requirement (the brief's §"诚实边界"):
 *  - **registered-call-sites only**: it records only what a call site hands to `recordEgress*`; an unregistered fetch / a
 *    hostile binary bypasses it. It is NOT an exfiltration control.
 *  - **dest-HOST + byte-MAGNITUDE only**: never payload, keys, message body, URL/path/query, or recipient beyond the host —
 *    so the ledger itself is not a payload side-channel.
 *  - **fail-OPEN**: a recording fault never blocks the send (the IO layer swallows + leaves a gap); nothing here gates egress.
 *  - **tamper-EVIDENT, not tamper-proof**: `verifyEgressChain` detects edit/delete/reorder via the hash chain, but a writer
 *    with disk access can rebuild the whole chain (no signing in v1).
 *
 * Two-line audit (bridge r8 ruling / coordinator): an egress EVENT is an INTENT entry (recorded before/around the call —
 * time/dest-host/call-face/initiator-sid) then a RESULT entry (filled after — byte-magnitude/outcome), sharing an eventId.
 * A crash between them leaves a dangling intent, surfaced honestly as `pending` (not a chain break); recording after the
 * response is acceptable and never claims to bound the egress. Both lines are hash-chained.
 *
 * This module is PURE (no IO/clock/random): the record model, the chain append (given the previous entry), the walk/verify,
 * byte-magnitude bucketing, and the trust-boundary parse. The IO seam (locked append, read) lives in egress-ledger-store.ts.
 */
import { sha256Hex, canonicalJson } from "./digest.js";

export const GENESIS_PREV = "0".repeat(64);
export type ByteMagnitude = "0" | "<1K" | "<64K" | "<1M" | "<16M" | ">=16M" | "unknown";
export type EgressOutcome = "ok" | "failed";

export type EgressIntent = { kind: "intent"; eventId: string; tsSec: number; destHost: string; callFace: string; initiatorSid: string };
export type EgressResult = { kind: "result"; eventId: string; tsSec: number; byteMagnitude: ByteMagnitude; outcome: EgressOutcome };
export type EgressBody = EgressIntent | EgressResult;
export type EgressEntry = EgressBody & { seq: number; prevHash: string; hash: string };

const HOST_RE = /^[a-zA-Z0-9._-]+$/; // BARE host only (EL-2): letters/digits/dot/dash/underscore — NO port(:)/scheme/path/query/userinfo/whitespace
const MAG: ReadonlySet<string> = new Set<ByteMagnitude>(["0", "<1K", "<64K", "<1M", "<16M", ">=16M", "unknown"]);

/** The SINGLE dest-host rule (EL-2), enforced identically at WRITE (recordEgressIntent) and READ (parseEgressEntry) so the
 *  persistence contract is never written one way and parsed another. A bare host only — no port, scheme, path, query, or
 *  userinfo (the brief's narrow "仅主机名" contract; not a payload side-channel). */
export function validHost(h: unknown): h is string {
  return typeof h === "string" && h.length > 0 && h.length <= 253 && HOST_RE.test(h);
}

/** Is the ledger seam armed? DORMANT opt-in in v1 (OFF unless explicitly enabled) — no call sites are wired yet, so the default
 *  must be no-op; `SWARM_EGRESS_LEDGER=1|true|yes|on`. */
export function egressLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SWARM_EGRESS_LEDGER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Deterministic order-of-magnitude bucket — NEVER the exact byte count (the ledger must not be a payload side-channel). */
export function byteMagnitude(bytes: number): ByteMagnitude {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes === 0) return "0";
  if (bytes < 1024) return "<1K";
  if (bytes < 64 * 1024) return "<64K";
  if (bytes < 1024 * 1024) return "<1M";
  if (bytes < 16 * 1024 * 1024) return "<16M";
  return ">=16M";
}

/** Canonical hash input for an entry: seq + prevHash + body (the body already fixes field order via canonicalJson). */
function entryHash(seq: number, prevHash: string, body: EgressBody): string {
  return sha256Hex(canonicalJson({ seq, prevHash, body }));
}

function bodyOf(e: EgressEntry): EgressBody {
  const { seq: _s, prevHash: _p, hash: _h, ...body } = e;
  return body as EgressBody;
}

/** Append one body to the chain given the previous entry (pure; genesis prevHash when none). Deterministic (FC-6). */
export function chainEntry(prev: EgressEntry | null, body: EgressBody): EgressEntry {
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_PREV;
  return { ...body, seq, prevHash, hash: entryHash(seq, prevHash, body) };
}

/** Trust-boundary parse of one persisted entry (own-data reads only; any missing/typed-wrong field ⇒ null, never a half body). */
export function parseEgressEntry(input: unknown): EgressEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const { seq, prevHash, hash, kind, eventId, tsSec } = o;
  if (!Number.isInteger(seq) || (seq as number) < 0) return null;
  if (typeof prevHash !== "string" || typeof hash !== "string") return null;
  if (typeof eventId !== "string" || eventId === "") return null;
  if (typeof tsSec !== "number" || !Number.isFinite(tsSec) || tsSec < 0) return null;
  if (kind === "intent") {
    const { destHost, callFace, initiatorSid } = o;
    if (!validHost(destHost)) return null;
    if (typeof callFace !== "string" || callFace === "") return null;
    if (typeof initiatorSid !== "string" || initiatorSid === "") return null;
    return { kind, eventId, tsSec, destHost, callFace, initiatorSid, seq: seq as number, prevHash, hash };
  }
  if (kind === "result") {
    const { byteMagnitude: bm, outcome } = o;
    if (typeof bm !== "string" || !MAG.has(bm)) return null;
    if (outcome !== "ok" && outcome !== "failed") return null;
    return { kind, eventId, tsSec, byteMagnitude: bm as ByteMagnitude, outcome, seq: seq as number, prevHash, hash };
  }
  return null;
}

export type VerifyResult =
  | { ok: true; count: number; pending: string[] }  // pending = eventIds with an intent but no result (dangling, honest)
  | { ok: false; kind: "chain-break" | "gap" | "incomplete-tail" | "parse"; seq: number; reason: string };

/**
 * Walk the chain in seq order and verify integrity. Distinguishes:
 *  - `chain-break` / `gap` / `parse` (not the tail): TAMPERING — an edited/deleted/reordered entry (tamper-EVIDENT), exit non-0.
 *  - `incomplete-tail`: ONLY the last entry is unparseable — a crash mid-append, RECOVERABLE (not tampering).
 *  - ok with `pending`: intents without a matching result (crash between the two lines, or result not yet recorded) — reported,
 *    NOT a break.
 */
export function verifyEgressChain(entries: readonly unknown[]): VerifyResult {
  let prev: EgressEntry | null = null;
  const intents = new Set<string>(), results = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = parseEgressEntry(entries[i]);
    if (e === null) {
      if (i === entries.length - 1) return { ok: false, kind: "incomplete-tail", seq: i, reason: "last entry unparseable (crash mid-append)" };
      return { ok: false, kind: "parse", seq: i, reason: "unparseable entry (not the tail)" };
    }
    const expectedSeq = prev ? prev.seq + 1 : 0;
    if (e.seq !== expectedSeq) return { ok: false, kind: "gap", seq: e.seq, reason: `non-contiguous seq (expected ${expectedSeq})` };
    const expectedPrev = prev ? prev.hash : GENESIS_PREV;
    if (e.prevHash !== expectedPrev) return { ok: false, kind: "chain-break", seq: e.seq, reason: "prevHash does not match the previous entry" };
    if (entryHash(e.seq, e.prevHash, bodyOf(e)) !== e.hash) return { ok: false, kind: "chain-break", seq: e.seq, reason: "recomputed hash mismatch (entry edited)" };
    if (e.kind === "intent") intents.add(e.eventId); else results.add(e.eventId);
    prev = e;
  }
  return { ok: true, count: entries.length, pending: [...intents].filter((id) => !results.has(id)) };
}
