/**
 * Managed-delegation envelope + dual-custody (cluster-liveness L2-struct, design §2b/§2c). The PURE core of "dispatch =
 * register receipt first, then IO" and "custody covers BOTH ends of a handoff" — the lifecycle of a delegated unit of work
 * from request to accepted result, independent of any message reaching anyone (F21/F22 root-fix: the artifact is discovered +
 * consumed via the completion-slot even if all messages are lost, the owner is unroutable, and the coordinator exits).
 *
 * Pure here; the IO (directory-scan observer, the production/consumption wait commits, downstream intent) is the dispatcher
 * wiring in a following sub-increment — mirroring projection (buildProjectionFiles → writeProjection) and incident-episode.
 * The registry is an IO-owned file (NOT a control-log entity type — that stays f32a0507's); the production/consumption waits
 * reuse the existing WaitRecord so the sweep supervises/escalates them.
 *
 * Identity invariants (§2b):
 *  - requestId is the ROUND identity. The completion-slot's target digest does NOT identify the round (r7 and r8 can target
 *    the same commit), so acceptance matches on requestId — an r7 artifact must never close r8's wait.
 *  - payloadDigest verifies the immutable payload (bytes or locator+version); it is verify-only, never a substitute for the
 *    bytes (the recovery loop must be able to rebuild the original request from the durable record). Same requestId with a
 *    DIFFERENT payloadDigest is a conflict — rejected, never silently overwritten.
 *  - the completion-slot's targetDigest is verified against the discovered candidate — a stale round / wrong SHA / half-write /
 *    author self-report does NOT pass acceptance (§2c).
 */

import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type CompletionSlot = {
  locator: string;        // where the artifact should appear (the observer polls this)
  targetDigest: string;   // commit SHA / spec / contract hash a candidate is verified against (NOT the author's self-report)
  resultFormat: string;   // expected result format
  acceptor: string;       // who verifies + accepts (the consumption owner)
};
export type DelegationSubject = { jobId: string; revision?: number };
export type DelegationPhase = "production" | "consumption" | "done";
export type DelegationEnvelope = {
  requestId: string;              // the round identity (acceptance matches on this)
  payloadDigest: string;          // digest of the immutable payload (verify-only — never a substitute for the bytes)
  payload?: string;               // the immutable full payload, inlined (reconstructable source — §2b-P1-1)
  payloadLocator?: string;        // OR where the full immutable payload lives
  payloadVersion?: string;        // the FIXED version/ref for the locator (so it resolves to a specific immutable version)
  subject: DelegationSubject;     // subject + revision/epoch
  completionSlot: CompletionSlot;
  owner: string;                  // production owner
  productionWaitId: string;
  consumptionWaitId?: string;     // set when production completes (phase → consumption)
  phase: DelegationPhase;
  openedAtSec: number;
  producedAtSec?: number;         // artifact discovered + target-digest-verified (production closed)
  acceptedAtSec?: number;         // acceptor accepted (consumption closed)
};
export type DelegationRegistry = { envelopes: Record<string, DelegationEnvelope> }; // keyed by requestId
export const emptyDelegationRegistry = (): DelegationRegistry => ({ envelopes: {} });

/** A production/consumption WaitRecord for the caller to open in CONTROL (the sweep then supervises/escalates it). */
export type DelegationWaitSpec = { waitId: string; jobId: string; owner: string; deadlineSec: number; requestId: string };
/** A close action the caller applies via advanceWait(close) — resolution references the round (requestId) + locator (§2b-a). */
export type DelegationClose = { waitId: string; resolution: { outcome: string; reason: string; sourceOperationId: string } };

const subjectEq = (a: DelegationSubject, b: DelegationSubject): boolean => a.jobId === b.jobId && (a.revision ?? null) === (b.revision ?? null);

export type OpenSpec = {
  requestId: string; payloadDigest: string;
  payload?: string; payloadLocator?: string; payloadVersion?: string;  // a RECONSTRUCTABLE source is required (one of the two forms)
  subject: DelegationSubject; completionSlot: CompletionSlot; owner: string; productionDeadlineSec: number;
};
export type OpenResult =
  | { ok: true; registry: DelegationRegistry; envelope: DelegationEnvelope; openProductionWait?: DelegationWaitSpec }
  | { ok: false; reason: string };

/** Open a delegation: register the envelope (phase=production) + emit the production-wait spec. Idempotent on the same
 *  (requestId, payloadDigest): returns the existing envelope with NO new wait (replay-safe). A same requestId with a DIFFERENT
 *  payloadDigest is a CONFLICT — rejected, never overwritten (§2b: 同 ID 异载荷=冲突拒收). The envelope MUST carry a
 *  RECONSTRUCTABLE payload source — an inline immutable `payload`, OR a `payloadLocator` + fixed `payloadVersion` — so the
 *  recovery loop can rebuild the original request from the durable record alone; a bare digest cannot, so NO executable
 *  production receipt is emitted for it (review d3ac478-P1-1). The caller commits the wait FIRST, then persists the registry. */
export function openDelegation(reg: DelegationRegistry, spec: OpenSpec, nowSec: number): OpenResult {
  if (spec.requestId.length === 0 || spec.payloadDigest.length === 0) return { ok: false, reason: "requestId + payloadDigest are required" };
  const hasInline = spec.payload !== undefined && spec.payload.length > 0;
  const hasLocator = spec.payloadLocator !== undefined && spec.payloadLocator.length > 0 && spec.payloadVersion !== undefined && spec.payloadVersion.length > 0;
  if (!hasInline && !hasLocator) return { ok: false, reason: "a reconstructable payload source is required: inline payload, OR payloadLocator + fixed payloadVersion (a digest alone cannot rebuild the request)" };
  const existing = reg.envelopes[spec.requestId];
  if (existing !== undefined) {
    if (existing.payloadDigest !== spec.payloadDigest) return { ok: false, reason: `requestId ${spec.requestId} already registered with a different payloadDigest (conflict)` };
    return { ok: true, registry: reg, envelope: existing }; // idempotent re-open (same round, same payload) — no new wait
  }
  const productionWaitId = `deleg-${encodeURIComponent(spec.requestId)}-prod`;
  const envelope: DelegationEnvelope = {
    requestId: spec.requestId, payloadDigest: spec.payloadDigest,
    ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
    ...(spec.payloadLocator !== undefined ? { payloadLocator: spec.payloadLocator } : {}),
    ...(spec.payloadVersion !== undefined ? { payloadVersion: spec.payloadVersion } : {}),
    subject: spec.subject, completionSlot: spec.completionSlot, owner: spec.owner, productionWaitId, phase: "production", openedAtSec: nowSec,
  };
  const registry = { envelopes: { ...reg.envelopes, [spec.requestId]: envelope } };
  return { ok: true, registry, envelope, openProductionWait: { waitId: productionWaitId, jobId: spec.subject.jobId, owner: spec.owner, deadlineSec: spec.productionDeadlineSec, requestId: spec.requestId } };
}

/** The identity a completion/result record SELF-DECLARES (§2b: a completion record carries requestId + payloadDigest + subject
 *  revision). The observer reads these FROM the artifact; the guard binds them to the envelope so a result from a different
 *  request/epoch cannot fulfill this one even when it lands at the same locator with the same target digest. */
export type CompletionRecord = { requestId: string; payloadDigest: string; subject: DelegationSubject };
export type Candidate = { observedLocator: string; observedDigest: string; record: CompletionRecord };
export type ObserveResult =
  | { verified: true; registry: DelegationRegistry; closeProductionWait: DelegationClose; openConsumptionWait: DelegationWaitSpec }
  | { verified: false; reason: string };

/** The completion-slot observer discovered a candidate — verify it against the slot + the envelope (§2c) and, iff it passes,
 *  transition production → consumption: close the production wait (resolution refs the round + locator) and open the consumption
 *  wait (owner = acceptor). Verification is INDEPENDENT of any author self-report: the envelope must be in production, the
 *  locator must match, the observedDigest must equal the slot's targetDigest, AND the completion record's own declared
 *  requestId + payloadDigest + subject revision must match the envelope — so a result bound to a DIFFERENT request or epoch
 *  (even at the same locator/target) fails and closes nothing (an r7 artifact never closes r8's wait — review d3ac478-P1-2). */
export function observeCandidate(reg: DelegationRegistry, cand: Candidate, consumptionDeadlineSec: number, nowSec: number): ObserveResult {
  const env = reg.envelopes[cand.record.requestId];
  if (env === undefined) return { verified: false, reason: `no delegation for requestId ${cand.record.requestId}` };
  if (env.phase !== "production") return { verified: false, reason: `delegation ${cand.record.requestId} not in production (phase=${env.phase})` };
  if (cand.observedLocator !== env.completionSlot.locator) return { verified: false, reason: `locator mismatch (want ${env.completionSlot.locator}, saw ${cand.observedLocator})` };
  if (cand.observedDigest !== env.completionSlot.targetDigest) return { verified: false, reason: `target digest mismatch — stale/wrong/half-write (want ${env.completionSlot.targetDigest}, saw ${cand.observedDigest})` };
  if (cand.record.payloadDigest !== env.payloadDigest) return { verified: false, reason: `completion record payloadDigest ${cand.record.payloadDigest} ≠ request ${env.payloadDigest} — result bound to a different request` };
  if (!subjectEq(cand.record.subject, env.subject)) return { verified: false, reason: `completion record subject/revision ${JSON.stringify(cand.record.subject)} ≠ envelope ${JSON.stringify(env.subject)} — wrong epoch` };
  const consumptionWaitId = `deleg-${encodeURIComponent(env.requestId)}-cons`;
  const next: DelegationEnvelope = { ...env, phase: "consumption", consumptionWaitId, producedAtSec: nowSec };
  const registry = { envelopes: { ...reg.envelopes, [env.requestId]: next } };
  return {
    verified: true, registry,
    closeProductionWait: { waitId: env.productionWaitId, resolution: { outcome: "produced", reason: `artifact at ${cand.observedLocator} verified for requestId ${env.requestId}`, sourceOperationId: `deleg-produced-${env.requestId}` } },
    openConsumptionWait: { waitId: consumptionWaitId, jobId: env.subject.jobId, owner: env.completionSlot.acceptor, deadlineSec: consumptionDeadlineSec, requestId: env.requestId },
  };
}

export type AcceptResult =
  | { accepted: true; registry: DelegationRegistry; closeConsumptionWait: DelegationClose }
  | { accepted: false; reason: string };

/** The acceptor accepted the produced result (downstream intent/terminal is registered by the caller in the SAME batch as the
 *  close — §2b-a). Transition consumption → done + close the consumption wait. Acceptance is BOUND to the declared
 *  completionSlot.acceptor — a producer, an empty id, or any other party CANNOT close the consumption wait (review d3ac478-P2);
 *  an automated agent (the observer) accepts AS the configured acceptor, having performed the acceptor's verification. A
 *  non-consumption phase rejects. */
export function acceptDelegation(reg: DelegationRegistry, requestId: string, by: string, nowSec: number): AcceptResult {
  const env = reg.envelopes[requestId];
  if (env === undefined) return { accepted: false, reason: `no delegation for requestId ${requestId}` };
  if (env.phase !== "consumption" || env.consumptionWaitId === undefined) return { accepted: false, reason: `delegation ${requestId} not awaiting consumption (phase=${env.phase})` };
  if (by !== env.completionSlot.acceptor) return { accepted: false, reason: `acceptance must come from the declared acceptor ${env.completionSlot.acceptor}, not ${by.length === 0 ? "<empty>" : by}` };
  const next: DelegationEnvelope = { ...env, phase: "done", acceptedAtSec: nowSec };
  const registry = { envelopes: { ...reg.envelopes, [requestId]: next } };
  return { accepted: true, registry, closeConsumptionWait: { waitId: env.consumptionWaitId, resolution: { outcome: "accepted", reason: `result accepted by ${by} for requestId ${requestId}`, sourceOperationId: `deleg-accepted-${requestId}` } } };
}

/** Execution-side receipt check (§2b/§2d): a managed receiver may start work ONLY if it holds a committed receipt matching the
 *  envelope's round identity — requestId + payloadDigest + subject — AND production is not terminated. PURE identity check; the
 *  caller ALSO verifies the production WaitRecord is still live in CONTROL (open OR action_pending — a reminder in flight is
 *  NOT invalid). A plaintext request with no matching envelope ⇒ false (the receiver refuses: "请走信封"). */
export function receiptMatches(env: DelegationEnvelope | undefined, claim: { requestId: string; payloadDigest: string; subject: DelegationSubject }): boolean {
  return env !== undefined && env.phase === "production" && env.requestId === claim.requestId && env.payloadDigest === claim.payloadDigest && subjectEq(env.subject, claim.subject);
}

/** Read the durable registry. Missing ⇒ empty (first run); corrupt ⇒ THROWS (the caller is fail-soft + skips, never a silent
 *  reset that would lose in-flight delegations). */
export function readDelegations(file: string): DelegationRegistry {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyDelegationRegistry(); throw e; }
  const parsed = JSON.parse(raw) as DelegationRegistry;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.envelopes !== "object" || parsed.envelopes === null) throw new Error("delegations: malformed registry");
  return parsed;
}

/** Write the registry atomically (unique temp + exclusive create + rename). Persist AFTER the control-log action commits, so the
 *  registry never leads CONTROL. */
export function writeDelegations(file: string, reg: DelegationRegistry): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o644, flag: "wx" });
  renameSync(tmp, file);
}
