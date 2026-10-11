/**
 * output-contract DURABLE RECEIPT seam (OW-2). The signed pure core (output-contract.ts: validate/probe/verify/present) is
 * BYTE-UNCHANGED; this is the thin durable bookkeeping that makes the delivery-receipt verification RECOVERABLE rather than a
 * best-effort inline fire.
 *
 * The problem it closes: taskPass commits the accept verdict FIRST, then runs the verification. If the verification's present
 * IO transiently fails, or the dispatcher crashes between the accept commit and the verification, a later pass recovers from
 * the already-accepted state and (correctly) does not re-accept — so the verification/reminder would be lost forever. So the
 * verification obligation must be tracked SEPARATELY from the accept, keyed by the stable accepted-item identity (attemptId),
 * and discharged ONLY once the verification (plus any required coordinator present) has durably completed.
 *
 * Mechanism: taskPass OFFERS every accepted dispatch that declared an expectedOutput to the injected verify hook EVERY pass
 * (idempotent — the dispatcher no-ops a discharged one via the marker here). The dispatcher writes a `.done` marker only when
 * `shouldDischargeReceipt` says the obligation is complete (verified, and — for an `unmet` — actually presented). An undischarged
 * item is re-offered next pass / after a restart, so a transient failure or a crash is retried, never silently dropped.
 *
 * Pure (shouldDischargeReceipt, the marker path) + a thin fail-soft IO (stat/write the marker). No clock beyond an injected
 * `atSec`. Additive (FC-7): a NEW `~/.agenthop/swarm/output-contract/` dir; nothing migrates.
 */
import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { OutputVerdict } from "./output-contract.js";

/** The durable-receipt dir (sibling of console/ under the swarm home). */
function receiptDir(home: string): string { return path.join(home, ".agenthop", "swarm", "output-contract"); }

/** The per-accepted-item discharge marker. `attemptId` is the STABLE accepted-item identity; sanitized to one safe path segment
 *  (it becomes a filename) so a crafted id can never escape the dir. An empty/degenerate id maps to a fixed "_" (still confined). */
export function ocReceiptMarkerPath(home: string, attemptId: string): string {
  const safe = attemptId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
  return path.join(receiptDir(home), `${safe}.done`);
}

/** Has this accepted item's verification obligation already been durably DISCHARGED? Fail-soft: a stat fault reads as NOT
 *  discharged (⇒ re-verify, which is idempotent) — never a false "done" that would drop an un-presented reminder. */
export function ocReceiptDischarged(home: string, attemptId: string): boolean {
  try { return existsSync(ocReceiptMarkerPath(home, attemptId)); }
  catch { return false; }
}

/** PURE discharge rule: the obligation is complete iff the verdict is NOT `unmet` (met/unknown ⇒ nothing to present), OR it is
 *  `unmet` AND the coordinator reminder was actually PRESENTED. An `unmet` that could not be presented (unresolved coordinator /
 *  a present fault) is NOT discharged ⇒ it is retried next pass. `unknown` is never escalated, and is dischargeable (we verified;
 *  there is simply nothing to assert — FC-2 r3). */
export function shouldDischargeReceipt(verdict: OutputVerdict, presented: boolean): boolean {
  return verdict !== "unmet" || presented;
}

/** Mark this accepted item's verification obligation DISCHARGED (atomic temp+rename). Best-effort: a write fault leaves NO
 *  marker, so the item is simply re-offered next pass (the obligation is retained, never falsely discharged). The payload is
 *  audit-only — existence is the signal. */
export function ocReceiptMark(home: string, attemptId: string, info: { verdict: OutputVerdict; atSec: number }): void {
  const file = ocReceiptMarkerPath(home, attemptId);
  try {
    mkdirSync(receiptDir(home), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify({ attemptId, verdict: info.verdict, atSec: info.atSec }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* fail-soft: no marker ⇒ re-offered next pass (obligation retained), never a false discharge */ }
}
