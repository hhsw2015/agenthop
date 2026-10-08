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
 * Pure decision below (selftested); wiring the escalation into the dispatcher's notifyCoordinator is dormant
 * (`SWARM_COORD_ESCALATE` off) so the live default is unchanged until the merge gate turns it on.
 */

// ============================================================================================================
// Pure core (selftested in coordinator-report.selftest.mts)
// ============================================================================================================

export type ReportSurface = "inbox" | "s19" | "herdr-pane" | "log";

/** `isReport` is TRUE iff the notice reached a surface that actually informs the coordinator. It is FALSE only for "log"
 *  — a log line is not a report (the F45 ② ruling). The caller treats isReport=false as a delivery FAILURE to retry, not
 *  a success. */
export interface ReportPlan {
  surface: ReportSurface;
  isReport: boolean;
  reason: string;
}

/** Severity decides whether a notice MUST reach the coordinator. "info" may rest in the log when the coordinator is
 *  unresolved; "stall"/"critical" MUST escalate. */
export type ReportSeverity = "info" | "stall" | "critical";

/**
 * Decide where a coordinator notice goes.
 *  - coordinator RESOLVED ⇒ "inbox" (the durable-inbox path; a real report).
 *  - UNRESOLVED + info ⇒ "log" (not a report, but info does not escalate).
 *  - UNRESOLVED + stall/critical ⇒ escalate: "s19" (structured incident, preferred) ▸ "herdr-pane" (send-text) ▸ "log"
 *    (DEGRADED, isReport=false — the notice is deaf, surfaced so the caller can retry/alarm).
 * Pure. */
export function coordinatorReportPlan(opts: { coordinatorResolved: boolean; s19Available: boolean; herdrPaneAvailable: boolean; severity: ReportSeverity }): ReportPlan {
  if (opts.coordinatorResolved) return { surface: "inbox", isReport: true, reason: "coordinator resolved — durable inbox" };
  if (opts.severity === "info") return { surface: "log", isReport: false, reason: "coordinator unresolved; info notice does not escalate — logged (not a report)" };
  if (opts.s19Available) return { surface: "s19", isReport: true, reason: "coordinator unresolved — escalated to a structured S19 incident event" };
  if (opts.herdrPaneAvailable) return { surface: "herdr-pane", isReport: true, reason: "coordinator unresolved, no S19 surface — send-text to the coordinator's herdr pane" };
  return { surface: "log", isReport: false, reason: "coordinator unresolved and no S19/pane surface — DEGRADED to log; notice is DEAF (not a report)" };
}

// ============================================================================================================
// IO shell — wiring the escalation into notifyCoordinator (dormant: SWARM_COORD_ESCALATE off; exercised by live runs)
// ============================================================================================================

/** coordinator-escalation wiring flip, default OFF (dormant-ahead-of-use; live default stays log-only until the gate). */
export function coordEscalateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_COORD_ESCALATE ?? "");
}
