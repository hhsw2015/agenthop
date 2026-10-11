/**
 * coordinator-ops-receipt — the PURE decision core for making the COORDINATOR's own operations receipt-verified (F53 root fix,
 * user 亲令「彻底修复」). The reflexive north star: "交代晚上、早上验收" applies to the coordinator too — a spawn/inject/bind is
 * NOT done because an API returned ok instantly; it is done only when DURABLE evidence proves it. Three deliverables wire to
 * this: ① the succession shell-swap bus-join step (runbook + optional startup-command), ② verifyOpsAction (below), ③ the
 * live-sentinel succession-heartbeat rule (successionHeartbeatDue below).
 *
 * Pure core below (selftested). IO (the coordinator wakeup routine that gathers evidence + the sentinel wiring) is the seam.
 */

// ============================================================================================================
// ② opsReceipt — verifyOpsAction: did the coordinator's operation actually take, by DURABLE evidence?
// ============================================================================================================

/** The coordinator's own operation being verified. `spawn` = brought up a replacement shell/agent; `inject` = sent work/keys to
 *  a target that must act on them. */
export type OpsActionKind = "spawn" | "inject";
export interface OpsAction {
  kind: OpsActionKind;
  target: string; // the member/session the op acted on (for the audit record)
}

/** DURABLE evidence the coordinator's wakeup routine gathers for an op. The API's instantaneous return is DELIBERATELY not a
 *  field here — it is never evidence (F53). A `spawn` is confirmed by any of {the target visible on the bus / its check-in in the
 *  coordinator inbox / its screen-session id matching the expected}. An `inject` by any of {a next-round inbox receipt from the
 *  target / a durable target artifact: a new commit on its branch, or the expected report file}. `failureSignal` is an explicit
 *  durable NEGATIVE (the target process is gone, an error artifact) ⇒ failed. */
export interface OpsEvidence {
  // spawn positives
  busVisible?: boolean;       // the target appears in the bus (agenthop_peers / bus status)
  checkinInInbox?: boolean;   // the target's [checkin] message landed in the coordinator's durable inbox
  sessionIdMatch?: boolean;   // the target's screen/herdr session id matches the expected one
  // inject positives
  inboxReceipt?: boolean;     // the target replied/receipted in the coordinator's inbox next round
  newCommit?: boolean;        // the target produced a new commit on its work branch
  reportFile?: boolean;       // the expected durable artifact / report file exists
  // explicit durable negative (either kind)
  failureSignal?: boolean;    // the target is provably gone / errored
}

export type OpsVerdict = "confirmed" | "failed" | "unknown";

/**
 * The receipt verdict for one coordinator operation, PURELY from durable evidence:
 *   - confirmed: a durable positive fact for this action kind is present.
 *   - failed: no positive fact AND an explicit durable negative (the op provably did not take).
 *   - unknown: NEITHER — no durable proof either way. This is the F53 trap (the API said ok but nothing durable confirms it);
 *     the caller MUST treat it like failed (redo + account), never "assume it worked".
 * Pure. The caller owns WHEN to gather evidence / re-check; this only reads the facts it is handed.
 */
export function verifyOpsAction(action: OpsAction, evidence: OpsEvidence): OpsVerdict {
  const positive = action.kind === "spawn"
    ? !!(evidence.busVisible || evidence.checkinInInbox || evidence.sessionIdMatch)
    : !!(evidence.inboxReceipt || evidence.newCommit || evidence.reportFile);
  if (positive) return "confirmed";
  if (evidence.failureSignal) return "failed";
  return "unknown"; // no durable proof ⇒ redo + account (never assume success) — the F53 root fix
}

/** Both `failed` and `unknown` mean the op is NOT proven done ⇒ redo + account (coordinator: "unknown=按失败重做"). Only
 *  `confirmed` discharges the obligation. Pure. */
export function opsNeedsRedo(v: OpsVerdict): boolean {
  return v !== "confirmed";
}

/** A durable "coordinator op fired, awaiting durable proof" record — the control-log `opsReceipt` put kind's payload (FC-7
 *  additive, mirrors the approval ticket's `permissionDecision` precedent). Written `status:"pending"` at fire time, then
 *  advanced by the sweep's receipt step (verifyOpsAction) to a terminal verdict. Keyed by a stable `opId` so a re-check
 *  updates the SAME entity by its control-log revision (FC-6: explicit status transition, never latest-wins). */
export type OpsReceiptStatus = "pending" | OpsVerdict; // "pending" | "confirmed" | "failed" | "unknown"
export interface OpsReceiptRecord {
  opId: string;            // stable per-op id = the entity key suffix (e.g. `${kind}:${launchId}`)
  kind: OpsActionKind;     // spawn | inject (selects which OpsEvidence fields verifyOpsAction reads)
  target: string;          // the member/session the op acted on (evidence is gathered against it)
  firedAtSec: number;      // when the op was fired (audit; never used as a latest-wins key)
  status: OpsReceiptStatus;
  verdict?: OpsVerdict;    // the last verifyOpsAction result (absent while "pending")
  checkedAtSec?: number;   // when the receipt step last verified (audit)
}

/** Pure: fold a fresh verdict into a receipt record (the sweep commits the result ONLY when `status` actually changes — FC-6
 *  explicit transition, no churn). `confirmed` discharges; `failed`/`unknown` are the account-not-auto-redo states (the caller
 *  notifies the coordinator and never re-fires, since re-fire idempotency is not dispatcher-provable). */
export function applyOpsVerdict(rec: OpsReceiptRecord, verdict: OpsVerdict, nowSec: number): OpsReceiptRecord {
  return { ...rec, status: verdict, verdict, checkedAtSec: nowSec };
}

/** Pure: a receipt still needs checking next round when it is unproven — `pending` (never checked) or `unknown` (checked, no
 *  durable proof either way; may still become confirmed later). `confirmed` (discharged) and `failed` (durable negative,
 *  accounted) are terminal. */
export function opsReceiptOpen(rec: OpsReceiptRecord): boolean {
  return rec.status === "pending" || rec.status === "unknown";
}

/** Pure: build a fresh pending receipt at op-fire time. */
export function pendingOpsReceipt(action: OpsAction, launchId: string, firedAtSec: number): OpsReceiptRecord {
  return { opId: `${action.kind}:${launchId}`, kind: action.kind, target: action.target, firedAtSec, status: "pending" };
}

// ============================================================================================================
// ③ sentinel succession-heartbeat — successionHeartbeatDue: a swapped member with no proof of life ⇒ S19
// ============================================================================================================

/** The default window before a swapped member with no heartbeat/check-in is flagged to the coordinator (coordinator ruling). */
export const SUCCESSION_HEARTBEAT_SEC_DEFAULT = 600;

/** The configured window, SWARM_SUCCESSION_HEARTBEAT_SEC (seconds); falls back to the default on an unset/invalid value. Pure. */
export function successionHeartbeatSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SWARM_SUCCESSION_HEARTBEAT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : SUCCESSION_HEARTBEAT_SEC_DEFAULT;
}

/** A roster member's succession-liveness facts, as the sentinel gathers them. `swappedAtSec` = when this member was
 *  resumed/换壳 (absent/non-finite ⇒ not a swap ⇒ never alerted here). `lastBusSec` / `lastCheckinSec` = the most recent bus
 *  heartbeat / inbox check-in times (absent ⇒ never). */
export interface SuccessionLiveness {
  member: string;
  swappedAtSec: number;
  lastBusSec?: number;
  lastCheckinSec?: number;
}

/**
 * ③ Should the sentinel raise an S19 "successor may not be alive" for this swapped member? TRUE iff: it was swapped, the window
 * has elapsed since the swap, AND neither a bus heartbeat NOR an inbox check-in has arrived SINCE the swap. A heartbeat/check-in
 * that predates the swap does NOT count (it was the old shell). Fail-closed toward NOT alerting on a non-swap / within-window /
 * any proof-of-life-since-swap. Pure.
 */
export function successionHeartbeatDue(m: SuccessionLiveness, nowSec: number, thresholdSec: number): boolean {
  if (!Number.isFinite(m.swappedAtSec)) return false;            // not a swapped member
  if (!Number.isFinite(nowSec) || nowSec - m.swappedAtSec < thresholdSec) return false; // still within the grace window
  const busSinceSwap = Number.isFinite(m.lastBusSec) && (m.lastBusSec as number) >= m.swappedAtSec;
  const checkinSinceSwap = Number.isFinite(m.lastCheckinSec) && (m.lastCheckinSec as number) >= m.swappedAtSec;
  return !busSinceSwap && !checkinSinceSwap;                      // no proof of life since the swap, past the window ⇒ alert
}
