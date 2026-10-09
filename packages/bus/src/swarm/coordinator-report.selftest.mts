import { coordinatorReportPlan } from "./coordinator-report.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const plan = (o: Partial<Parameters<typeof coordinatorReportPlan>[0]> = {}) =>
  coordinatorReportPlan({ coordinatorResolved: false, s19Available: false, herdrPaneAvailable: false, severity: "stall", ...o });

// --- resolved: normal inbox path ---
t("resolved -> inbox, isReport", (() => { const p = plan({ coordinatorResolved: true }); return p.surface === "inbox" && p.isReport; })());
t("resolved wins even if s19/herdr available", plan({ coordinatorResolved: true, s19Available: true, herdrPaneAvailable: true }).surface === "inbox");

// --- unresolved + stall/critical: must escalate ---
t("unresolved stall + s19 -> s19, isReport", (() => { const p = plan({ s19Available: true }); return p.surface === "s19" && p.isReport; })());
t("unresolved critical + s19 -> s19", plan({ severity: "critical", s19Available: true }).surface === "s19");
t("unresolved stall + no s19 + herdr -> herdr-pane, isReport", (() => { const p = plan({ herdrPaneAvailable: true }); return p.surface === "herdr-pane" && p.isReport; })());
t("s19 preferred over herdr when both", plan({ s19Available: true, herdrPaneAvailable: true }).surface === "s19");
t("unresolved stall + neither -> log, NOT a report", (() => { const p = plan(); return p.surface === "log" && p.isReport === false; })());
t("degraded-log reason flags no reporting surface", /DEGRADED|no reporting surface/.test(plan().reason));

// --- unresolved + info: does not escalate ---
t("unresolved info -> log, NOT a report (no escalation)", (() => { const p = plan({ severity: "info" }); return p.surface === "log" && p.isReport === false; })());
t("unresolved info + s19 available -> still log (info never escalates)", plan({ severity: "info", s19Available: true }).surface === "log");

// --- the core invariant: log is NEVER counted as a report ---
t("every log surface has isReport=false", [plan(), plan({ severity: "info" }), plan({ severity: "critical" })].filter((p) => p.surface === "log").every((p) => p.isReport === false));
t("every non-log surface has isReport=true", [plan({ coordinatorResolved: true }), plan({ s19Available: true }), plan({ herdrPaneAvailable: true })].every((p) => p.isReport === true));

console.log("all coordinator-report selftests passed");
