// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/coordinator-ops-receipt.selftest.mts
// Pins the coordinator-ops-receipt pure core (F53): verifyOpsAction (durable-evidence three-state; the API return is NEVER
// evidence) + opsNeedsRedo, and the succession-heartbeat decision (successionHeartbeatDue) + its configured window.
import {
  verifyOpsAction, opsNeedsRedo, successionHeartbeatSec, successionHeartbeatDue, SUCCESSION_HEARTBEAT_SEC_DEFAULT,
  type OpsAction, type OpsEvidence, type SuccessionLiveness,
} from "./coordinator-ops-receipt.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const spawn: OpsAction = { kind: "spawn", target: "m1" };
const inject: OpsAction = { kind: "inject", target: "m1" };

// ── ② verifyOpsAction: spawn ──────────────────────────────────────────────────────────────────────────────────
t("spawn confirmed: bus visible", verifyOpsAction(spawn, { busVisible: true }) === "confirmed");
t("spawn confirmed: check-in in inbox", verifyOpsAction(spawn, { checkinInInbox: true }) === "confirmed");
t("spawn confirmed: session id match", verifyOpsAction(spawn, { sessionIdMatch: true }) === "confirmed");
t("spawn failed: explicit failure, no positive", verifyOpsAction(spawn, { failureSignal: true }) === "failed");
t("spawn unknown: no evidence (API-ok is NOT evidence — F53)", verifyOpsAction(spawn, {}) === "unknown");
t("spawn confirmed wins over failureSignal (positive present)", verifyOpsAction(spawn, { busVisible: true, failureSignal: true }) === "confirmed");
// an inject-only positive does NOT confirm a spawn (wrong evidence kind)
t("spawn unknown: inject-kind evidence does not count", verifyOpsAction(spawn, { newCommit: true, reportFile: true }) === "unknown");

// ── ② verifyOpsAction: inject ─────────────────────────────────────────────────────────────────────────────────
t("inject confirmed: inbox receipt", verifyOpsAction(inject, { inboxReceipt: true }) === "confirmed");
t("inject confirmed: new commit", verifyOpsAction(inject, { newCommit: true }) === "confirmed");
t("inject confirmed: report file", verifyOpsAction(inject, { reportFile: true }) === "confirmed");
t("inject failed: explicit failure, no positive", verifyOpsAction(inject, { failureSignal: true }) === "failed");
t("inject unknown: no evidence", verifyOpsAction(inject, {}) === "unknown");
t("inject unknown: spawn-kind evidence does not count", verifyOpsAction(inject, { busVisible: true }) === "unknown");

// ── opsNeedsRedo: only confirmed discharges ───────────────────────────────────────────────────────────────────
t("needsRedo confirmed -> false", opsNeedsRedo("confirmed") === false);
t("needsRedo failed -> true", opsNeedsRedo("failed") === true);
t("needsRedo unknown -> true (F53: never assume success)", opsNeedsRedo("unknown") === true);

// ── ③ successionHeartbeatSec ──────────────────────────────────────────────────────────────────────────────────
t("heartbeat sec default", successionHeartbeatSec({}) === SUCCESSION_HEARTBEAT_SEC_DEFAULT && SUCCESSION_HEARTBEAT_SEC_DEFAULT === 600);
t("heartbeat sec override", successionHeartbeatSec({ SWARM_SUCCESSION_HEARTBEAT_SEC: "120" }) === 120);
t("heartbeat sec invalid -> default", successionHeartbeatSec({ SWARM_SUCCESSION_HEARTBEAT_SEC: "nope" }) === 600);
t("heartbeat sec zero/neg -> default", successionHeartbeatSec({ SWARM_SUCCESSION_HEARTBEAT_SEC: "0" }) === 600 && successionHeartbeatSec({ SWARM_SUCCESSION_HEARTBEAT_SEC: "-5" }) === 600);

// ── ③ successionHeartbeatDue ──────────────────────────────────────────────────────────────────────────────────
const m = (over: Partial<SuccessionLiveness> = {}): SuccessionLiveness => ({ member: "m1", swappedAtSec: 1000, ...over });
const TH = 600;
t("due: swapped, window elapsed, no life since swap -> true", successionHeartbeatDue(m(), 1000 + TH, TH) === true);
t("not due: within window", successionHeartbeatDue(m(), 1000 + TH - 1, TH) === false);
t("not due: bus heartbeat since swap", successionHeartbeatDue(m({ lastBusSec: 1200 }), 2000, TH) === false);
t("not due: check-in since swap", successionHeartbeatDue(m({ lastCheckinSec: 1200 }), 2000, TH) === false);
t("due: bus heartbeat BEFORE swap (stale, old shell) -> true", successionHeartbeatDue(m({ lastBusSec: 900 }), 2000, TH) === true);
t("due: check-in before swap (stale) -> true", successionHeartbeatDue(m({ lastCheckinSec: 999 }), 2000, TH) === true);
t("not due: not a swapped member (NaN swappedAt)", successionHeartbeatDue(m({ swappedAtSec: NaN }), 9999, TH) === false);
t("not due: bus exactly at swap instant counts as life", successionHeartbeatDue(m({ lastBusSec: 1000 }), 2000, TH) === false);
t("not due: nowSec non-finite", successionHeartbeatDue(m(), NaN, TH) === false);

console.log("all coordinator-ops-receipt selftests passed");
