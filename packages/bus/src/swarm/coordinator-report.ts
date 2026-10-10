/**
 * coordinator-report — where a dispatcher notice goes when the coordinator is UNRESOLVED (F45 ②).
 *
 * The incident's other half: when `resolveSession(COORDINATOR, …)` returns null (the stable sid lost its presence binding,
 * see shell-succession), the dispatcher's `notifyCoordinator` falls straight to a log line and returns "logged". A STALL
 * alert then dies in a file nobody reads — the coordinator is DEAF. The ruling: a log file does NOT count as reporting; a
 * notice that MUST reach the coordinator has to ESCALATE to a real surface — a structured S19 incident event, or (failing
 * that) a herdr send-text to the coordinator's pane. Only when neither surface exists does it fall to a log, and that case
 * is reported honestly as a NON-report (isReport=false) so the caller knows the notice went unheard.
 *
 * Pure decision below (selftested); wiring the escalation into the dispatcher's notifyCoordinator is LIVE BY DEFAULT
 * (opt-out — `SWARM_COORD_ESCALATE=0` reverts to log-only escalation; user ruling 2026-10-10).
 */

// ============================================================================================================
// Pure core (selftested in coordinator-report.selftest.mts)
// ============================================================================================================

import { flagDefaultOn } from "./flag-default.js";

export type ReportSurface = "inbox" | "s19" | "herdr-pane" | "log";

/** `isReport` says whether the CHOSEN surface COUNTS as a reporting surface (one that can inform the coordinator) — it is
 *  FALSE only for "log" (a log line is not a report, the F45 ② ruling). F45-N1: this is a ROUTING decision made from
 *  availability inputs; it does NOT mean the notice was delivered. Actual delivery success is confirmed separately by the
 *  IO caller's receipt. The caller treats isReport=false as "no reporting surface was chosen" (escalate/alarm), never as a
 *  confirmed send. */
export interface ReportPlan {
  surface: ReportSurface;
  isReport: boolean;
  reason: string;
}

/** Severity decides whether a notice MUST reach the coordinator. "info" may rest in the log when the coordinator is
 *  unresolved; "stall"/"critical" MUST escalate. */
export type ReportSeverity = "info" | "stall" | "critical";

/**
 * CHOOSE where a coordinator notice should go (a routing plan — not a delivery; the IO caller performs the send and
 * confirms it):
 *  - coordinator RESOLVED ⇒ "inbox" (the durable-inbox path; a reporting surface).
 *  - UNRESOLVED + info ⇒ "log" (not a reporting surface, but info does not escalate).
 *  - UNRESOLVED + stall/critical ⇒ choose a reporting surface: "s19" (structured incident, preferred) ▸ "herdr-pane"
 *    (send-text) ▸ "log" (DEGRADED, isReport=false — no reporting surface available, surfaced so the caller can alarm).
 * Pure. */
export function coordinatorReportPlan(opts: { coordinatorResolved: boolean; s19Available: boolean; herdrPaneAvailable: boolean; severity: ReportSeverity }): ReportPlan {
  if (opts.coordinatorResolved) return { surface: "inbox", isReport: true, reason: "coordinator resolved — route to durable inbox" };
  if (opts.severity === "info") return { surface: "log", isReport: false, reason: "coordinator unresolved; info notice does not escalate — route to log (not a reporting surface)" };
  if (opts.s19Available) return { surface: "s19", isReport: true, reason: "coordinator unresolved — route to a structured S19 incident event (preferred)" };
  if (opts.herdrPaneAvailable) return { surface: "herdr-pane", isReport: true, reason: "coordinator unresolved, no S19 surface — route to send-text on the coordinator's herdr pane" };
  return { surface: "log", isReport: false, reason: "coordinator unresolved and no S19/pane surface — DEGRADED to log; no reporting surface available (not a report)" };
}

// ============================================================================================================
// IO shell — wiring the escalation into notifyCoordinator (LIVE BY DEFAULT; kill with SWARM_COORD_ESCALATE=0)
// ============================================================================================================

/** coordinator-escalation — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], user ruling 2026-10-10): on unless
 *  SWARM_COORD_ESCALATE is explicitly OFF (`=0`), which reverts to log-only escalation. (Was opt-in default-OFF while dormant.) */
export function coordEscalateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_COORD_ESCALATE);
}
