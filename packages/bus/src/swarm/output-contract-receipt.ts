/**
 * output-contract DURABLE RECEIPT seam (OW-2 / OW-3). The signed pure core (output-contract.ts: validate/probe/verify/present)
 * is BYTE-UNCHANGED; this is the thin durable bookkeeping that makes the delivery-receipt verification RECOVERABLE AND its
 * coordinator reminder EXACTLY-ONCE.
 *
 * The problem it closes: taskPass commits the accept verdict FIRST, then runs the verification. If the verification's present
 * IO transiently fails, or the dispatcher crashes between the accept commit and the verification, a later pass recovers from
 * the already-accepted state and (correctly) does not re-accept — so the verification/reminder would be lost forever. So the
 * verification obligation is tracked SEPARATELY from the accept, keyed by the stable accepted-item identity (attemptId).
 *
 * Two correctness guarantees:
 *  - OW-2 EXACTLY-ONCE reminder: the S19 card is published via writeInbox's IDEMPOTENCY KEY (publishOnce — a durable
 *    exactly-once credential). So a re-present (after a `.done` marker write/read fault, OR a crash between present and mark)
 *    is deduped AT THE DURABLE LAYER and creates NO duplicate card. The `.done` marker is now only an OPTIMIZATION (skip
 *    re-probing a settled item); the inbox credential — not the marker — is what proves the card was published.
 *  - OW-3 COLLISION-FREE identity: the marker filename AND the idempotency key are a sha256 DIGEST of the FULL attemptId.
 *    A replace-separators+truncate scheme maps distinct legal ids (e.g. "job_a/build/a0" and "job/a_build/a0") to the SAME
 *    name, letting one accepted item inherit another's completion; a digest is injective-in-practice and a safe filename.
 *    `ocReceiptDischarged` ALSO re-reads the marker and confirms the recorded attemptId matches (belt-and-suspenders).
 *
 * Pure (shouldDischargeReceipt, the digest key) + thin fail-soft IO (stat/write the marker, idempotent inbox present). No clock
 * beyond an injected `atSec`. Additive (FC-7): a NEW `~/.agenthop/swarm/output-contract/` dir; nothing migrates.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import type { ExpectedOutput, OutputVerdict } from "./output-contract.js";

/** The durable-receipt dir (sibling of console/ under the swarm home). */
function receiptDir(home: string): string { return path.join(home, ".agenthop", "swarm", "output-contract"); }

/** OW-3: a STABLE, COLLISION-FREE key from the FULL attemptId. A replace/truncate scheme collides distinct legal ids; a sha256
 *  digest is injective-in-practice AND a safe single path segment (so it can never escape the dir either). */
function receiptKey(attemptId: string): string { return createHash("sha256").update(attemptId, "utf8").digest("hex"); }

/** The per-accepted-item discharge marker, keyed by the digest of the FULL attemptId (OW-3 — no replace/truncate collision). */
export function ocReceiptMarkerPath(home: string, attemptId: string): string {
  return path.join(receiptDir(home), `${receiptKey(attemptId)}.done`);
}

/** Has THIS accepted item's verification obligation already been durably DISCHARGED? True ONLY when the marker exists AND records
 *  this exact attemptId (OW-3 belt-and-suspenders: a different id can never inherit a same-named marker's completion). Absent /
 *  unreadable / corrupt / id-mismatch ⇒ NOT discharged ⇒ re-offered — which is SAFE because the present is idempotent (OW-2), so a
 *  re-offer never duplicates the card. */
export function ocReceiptDischarged(home: string, attemptId: string): boolean {
  try {
    const m = JSON.parse(readFileSync(ocReceiptMarkerPath(home, attemptId), "utf8")) as { attemptId?: unknown };
    return m !== null && typeof m === "object" && m.attemptId === attemptId;
  } catch { return false; }
}

/** PURE discharge rule: the obligation is complete iff the verdict is NOT `unmet` (met/unknown ⇒ nothing to present), OR it is
 *  `unmet` AND the coordinator reminder was CONFIRMED durably present. An `unmet` that could not be presented (unresolved
 *  coordinator / a deferred/pending/unknown publish) is NOT discharged ⇒ retried next pass. `unknown` is never escalated, and is
 *  dischargeable (we verified; there is simply nothing to assert — FC-2 r3). */
export function shouldDischargeReceipt(verdict: OutputVerdict, presented: boolean): boolean {
  return verdict !== "unmet" || presented;
}

/** Mark this accepted item's verification obligation DISCHARGED (atomic temp+rename), recording the FULL attemptId. Best-effort:
 *  a write fault leaves NO marker, so the item is re-offered next pass — and the idempotent present (below) makes that re-offer
 *  duplicate-safe, so a lost marker never double-reminds. Existence+id is the signal. */
export function ocReceiptMark(home: string, attemptId: string, info: { verdict: OutputVerdict; atSec: number }): void {
  const file = ocReceiptMarkerPath(home, attemptId);
  try {
    mkdirSync(receiptDir(home), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify({ attemptId, verdict: info.verdict, atSec: info.atSec }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* fail-soft: no marker ⇒ re-offered next pass; the idempotent present makes that safe (no duplicate card) */ }
}

/**
 * OW-2 — present an UNMET output contract to the coordinator EXACTLY ONCE. The card is published through writeInbox's idempotency
 * key (`oc-<digest(attemptId)>`), which is a durable exactly-once credential (publishOnce): a re-present with the same key — after
 * a marker fault or a crash between present and mark — is deduped at the inbox layer, so the coordinator sees ONE card per accepted
 * item. Returns true ONLY when the card is CONFIRMED durably present (`published` now OR `already` published); false on a not-yet-
 * durable result (`deferred`/`pending`/`unknown`) or any fault ⇒ the caller does NOT discharge ⇒ it is retried next pass. The
 * message is byte-identical to the signed presentUnmetToCoordinator (the signed function stays untouched; the wiring uses this
 * idempotent variant). from==coordinatorId matches the signed shell.
 */
export function presentUnmetOnce(home: string, coordinatorId: string, taskId: string, expected: ExpectedOutput, attemptId: string): boolean {
  try {
    const r = writeInbox(home, coordinatorId, composeInboxMsg({
      from: coordinatorId,
      fromLabel: "output-contract",
      text: `task ${taskId} CLAIMED delivered but its output contract did NOT verify — kind=${expected.kind}${expected.ref ? ` ref=${expected.ref}` : ""}. A claim must attach verifiable evidence (AgentGate EXIT-fingerprint, distributed). Re-check the deliverable or halt the ticket.`,
      via: "output-contract",
      taskRef: `output-contract:${taskId}`,
      title: "output contract UNMET — decide",
    }), `oc-${receiptKey(attemptId)}`);
    return r === "published" || r === "already"; // confirmed durably present; deferred/pending/unknown ⇒ retain + retry
  } catch { return false; } // a write fault ⇒ not presented ⇒ not discharged ⇒ retried (never a false discharge)
}
