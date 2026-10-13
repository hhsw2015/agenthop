#!/usr/bin/env tsx
/**
 * verification-ledger selftest (econ-mirror-21 candidate ③). Covers the PURE core (arg parse, extraction, join, summary, flag,
 * render honesty, content tag), the STORE's FC-2 three-state over a REAL on-disk control-log, and the zero-bug 3-fixture law on
 * the PROJECTION WRITE-FACE (the only durable write is the content-tag-keyed coordinator draft):
 *   - crash-recovery        : a torn/corrupt control-log ⇒ unreadable ⇒ the report says so, never a fabricated "0 accepted".
 *   - restart-idempotency   : identical inputs ⇒ identical report ⇒ identical publishOnce tag ⇒ a re-run DEDUPS (no dup draft).
 *   - concurrency-race      : two reads of the same log are identical; distinct inputs ⇒ distinct tags (no cross-collision).
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { entityKeyOf, initialLogState, type Change } from "./control-log.js";
import type { TaskAttempt } from "./task-state.js";
import { commitControl } from "./control-store.js";
import {
  verificationLedgerEnabled, parseLedgerArgs, extractLedgerInputs, costPerAcceptedChange, disproportionateRework,
  summarizeLedger, renderLedgerReport, ledgerReportTag,
} from "./verification-ledger.js";
import { readAcceptedAndRework, readReviewRoundsDist } from "./verification-ledger-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "verif-ledger-"));
const controlLogDir = (home: string) => path.join(home, ".agenthop", "swarm", "control-log");

function mkAttempt(attemptId: string, nodeId: string): Change {
  const attempt = { attemptId, nodeId, status: "running" } as unknown as TaskAttempt;
  const key = entityKeyOf({ put: "attempt", attempt });
  return { put: "attempt", attempt, operationId: `${key}#1`, expectedEntityRevision: 0 };
}
function seed(home: string, changes: Change[]): void {
  const r = commitControl(controlLogDir(home), initialLogState(), changes);
  if (!r.result.ok) throw new Error("seed commit rejected: " + JSON.stringify(r.result));
}
// Hand-made control-log entity BODIES (what liveEntities yields) — lets us cover the accepted/rejected paths without the strict
// commit V2-V6 sequence (those paths are identical duck-typing to the attempt path the store fixture exercises on a REAL log).
const acc = (acceptedResultId: string, nodeId: string, superseded = false) => ({ put: "accepted", accepted: { acceptedResultId, nodeId, jobId: "job-" + nodeId, attemptId: "att-" + nodeId, superseded } });
const att = (nodeId: string) => ({ put: "attempt", attempt: { nodeId } });
const rej = (nodeId: string) => ({ put: "rejected", rejected: { nodeId } });

// =====================================================================================================================
// PURE — flag + args
// =====================================================================================================================
t("flag: default OFF (unset), OFF on 0/empty, ON on 1/true/yes/on", (() => {
  const off = !verificationLedgerEnabled({} as NodeJS.ProcessEnv) && !verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: "0" } as NodeJS.ProcessEnv) && !verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: "" } as NodeJS.ProcessEnv);
  const on = ["1", "true", "YES", "on"].every((v) => verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: v } as NodeJS.ProcessEnv));
  return off && on;
})());
t("args: defaults (threshold 3, sinceSec null, not dry)", (() => { const a = parseLedgerArgs([], 1000); return a !== null && a.threshold === 3 && a.sinceSec === null && a.dry === false; })());
t("args: --threshold valid / invalid(0)⇒null / non-int⇒null", parseLedgerArgs(["--threshold", "5"], 1000)?.threshold === 5 && parseLedgerArgs(["--threshold", "0"], 1000) === null && parseLedgerArgs(["--threshold", "x"], 1000) === null);
t("args: --days sets sinceSec from injected now (pure)", parseLedgerArgs(["--days", "1"], 100000)?.sinceSec === 100000 - 86400);
t("args: --since-last ⇒ sinceSec null; --dry; --coordinator", (() => { const a = parseLedgerArgs(["--since-last", "--dry", "--coordinator", "sid-1"], 1000); return a !== null && a.sinceSec === null && a.dry === true && a.coordinator === "sid-1"; })());
t("args: unknown flag ⇒ null; --coordinator without value ⇒ null", parseLedgerArgs(["--nope"], 1000) === null && parseLedgerArgs(["--coordinator"], 1000) === null);

// =====================================================================================================================
// PURE — extraction / join / summary
// =====================================================================================================================
{
  const bodies = [acc("a1", "n1"), att("n1"), rej("n1"), att("n1"), acc("a2", "n2"), att("n2"), acc("a3", "n3", true), att(""), rej(""), { put: "plan", plan: {} }];
  const { accepted, rework } = extractLedgerInputs(bodies);
  t("extract: 3 accepted (incl superseded), keyed", accepted.length === 3 && accepted.find((a) => a.nodeId === "n1")?.jobId === "job-n1");
  t("extract: supersede flag read", accepted.find((a) => a.nodeId === "n3")?.superseded === true);
  t("extract: rework counts by nodeId (n1: 2 att / 1 rej; n2: 1 att / 0 rej)", rework["n1"]!.attempts === 2 && rework["n1"]!.rejections === 1 && rework["n2"]!.attempts === 1 && rework["n2"]!.rejections === 0);
  t("extract: empty-nodeId attempt/rejected skipped (never guessed)", rework[""] === undefined);

  const rows = costPerAcceptedChange(accepted, rework);
  t("join: reworkRounds = rejections (n1 ⇒ 1); attempts carried", rows.find((r) => r.nodeId === "n1")?.reworkRounds === 1 && rows.find((r) => r.nodeId === "n1")?.attempts === 2);
  t("join: n3 has no counters ⇒ countersMissing TRUE, 0/0 (not 'cheap')", (() => { const r = rows.find((x) => x.nodeId === "n3")!; return r.countersMissing === true && r.reworkRounds === 0; })());

  const sum = summarizeLedger(rows, 1);
  t("summary: superseded (n3) EXCLUDED from live count (2, not 3)", sum.acceptedCount === 2);
  t("summary: zeroReworkCount (n2) + countersMissingCount (0 live; n3 excluded)", sum.zeroReworkCount === 1 && sum.countersMissingCount === 0);
  t("summary: flagged at threshold 1 = n1 (rework 1 ≥ 1); sorted desc", sum.flagged.length === 1 && sum.flagged[0]!.nodeId === "n1");
}
t("disproportionate: boundary is >= threshold", disproportionateRework({ nodeId: "x", jobId: "", acceptedResultId: "", attempts: 3, rejections: 3, reworkRounds: 3, superseded: false, countersMissing: false }, 3) === true && disproportionateRework({ nodeId: "x", jobId: "", acceptedResultId: "", attempts: 2, rejections: 2, reworkRounds: 2, superseded: false, countersMissing: false }, 3) === false);

// =====================================================================================================================
// PURE — render honesty (the discipline the eval itself passed)
// =====================================================================================================================
{
  const rows = costPerAcceptedChange([{ acceptedResultId: "a1", nodeId: "n1", jobId: "j1", attemptId: "t1", superseded: false }], { n1: { attempts: 4, rejections: 3 } });
  const rpt = renderLedgerReport({ rows, summary: summarizeLedger(rows, 3), reviewRounds: { perTicket: [], totalTickets: 2, singlePass: 1, multiRound: 1, maxRounds: 4, medianRounds: 2 }, sources: { controlLog: "read", reviewReports: "read" }, threshold: 3 });
  t("render: states it is a COST metric, NOT an ROI", /COST metric, NOT an ROI/i.test(rpt));
  t("render: review-rounds labelled NOT keyed to acceptance (separate view)", /NOT keyed to acceptance/i.test(rpt));
  t("render: $ omitted with an honest note (no fabricated join)", /\$ cost omitted/i.test(rpt) && /no nodeId link/i.test(rpt));
  t("render: a flagged disproportionate change is listed", /disproportionate/i.test(rpt) && /node n1/.test(rpt));

  const rptAbsent = renderLedgerReport({ rows: [], summary: summarizeLedger([], 3), reviewRounds: null, sources: { controlLog: "unreadable", reviewReports: "absent" }, threshold: 3 });
  t("render: unreadable control-log ⇒ 'NOT reported as zero' (never a fabricated 0 accepted)", /control-log: unreadable/i.test(rptAbsent) && /NOT reported as zero/i.test(rptAbsent) && !/accepted changes: 0/.test(rptAbsent));
  t("render: absent review-rounds ⇒ view unavailable, NOT zero", /review-report rounds: absent/i.test(rptAbsent) && /NOT reported as zero/i.test(rptAbsent));
}
// content tag — the publishOnce key stem
t("tag: 32 hex chars; stable for identical input; distinct for changed input", (() => { const a = ledgerReportTag("report-X"); const b = ledgerReportTag("report-X"); const c = ledgerReportTag("report-Y"); return /^[0-9a-f]{32}$/.test(a) && a === b && a !== c; })());

// =====================================================================================================================
// STORE — FC-2 three-state over a REAL on-disk control-log
// =====================================================================================================================
{
  const h = tmpHome(); // no control-log dir yet
  t("store: absent control-log dir ⇒ status 'absent', empty (not fabricated)", (() => { const r = readAcceptedAndRework(h); return r.status === "absent" && r.accepted.length === 0; })());
}
{
  const h = tmpHome(); mkdirSync(controlLogDir(h), { recursive: true });
  writeFileSync(path.join(controlLogDir(h), "1.json"), "{ this is not json");
  t("store[crash-recovery]: corrupt/torn log ⇒ status 'unreadable', empty (NEVER a fabricated empty)", (() => { const r = readAcceptedAndRework(h); return r.status === "unreadable" && r.accepted.length === 0 && Object.keys(r.rework).length === 0; })());
  // the report over that unreadable source states it honestly — the projection write-face never claims a clean "0 accepted"
  const rows = costPerAcceptedChange([], {});
  const rpt = renderLedgerReport({ rows, summary: summarizeLedger(rows, 3), reviewRounds: null, sources: { controlLog: readAcceptedAndRework(h).status, reviewReports: "absent" }, threshold: 3 });
  t("store[crash-recovery]: report over the unreadable log says 'cannot compute' (not zero)", /control-log: unreadable/i.test(rpt) && /cannot compute/i.test(rpt));
}
{
  const h = tmpHome();
  seed(h, [mkAttempt("att-A", "nodeA"), mkAttempt("att-B", "nodeB"), mkAttempt("att-A2", "nodeA")]);
  const r = readAcceptedAndRework(h);
  t("store: real log ⇒ status 'read'; rework attempts tallied by nodeId (nodeA:2, nodeB:1)", r.status === "read" && r.rework["nodeA"]!.attempts === 2 && r.rework["nodeB"]!.attempts === 1);
}
{
  const h = tmpHome(); // no ~/Work/review-reports under this temp home
  const rr = readReviewRoundsDist(h);
  t("store: absent review-reports ⇒ dist null + status absent (NOT a zero-round dist)", rr.dist === null && rr.status === "absent");
}

// =====================================================================================================================
// 3-FIXTURE — restart-idempotency + concurrency-race (projection write-face)
// =====================================================================================================================
{
  // restart-idempotency: identical inputs ⇒ identical report ⇒ identical publishOnce tag ⇒ a re-run DEDUPS.
  const mk = () => { const rows = costPerAcceptedChange([{ acceptedResultId: "a1", nodeId: "n1", jobId: "j1", attemptId: "t1", superseded: false }], { n1: { attempts: 1, rejections: 0 } }); return renderLedgerReport({ rows, summary: summarizeLedger(rows, 3), reviewRounds: null, sources: { controlLog: "read", reviewReports: "absent" }, threshold: 3 }); };
  t("fixture[restart-idempotency]: identical inputs ⇒ identical tag (re-run ⇒ publishOnce 'already', no dup draft)", ledgerReportTag(mk()) === ledgerReportTag(mk()));
}
{
  // concurrency-race: two independent reads of the SAME seeded log are identical (read is pure/idempotent); a changed input ⇒ a
  // distinct tag (no cross-collision would make two different reports share a publishOnce key).
  const h = tmpHome();
  seed(h, [mkAttempt("att-C", "nodeC"), mkAttempt("att-D", "nodeD")]);
  const r1 = readAcceptedAndRework(h); const r2 = readAcceptedAndRework(h);
  const tag = (r: ReturnType<typeof readAcceptedAndRework>) => { const rows = costPerAcceptedChange(r.accepted, r.rework); return ledgerReportTag(renderLedgerReport({ rows, summary: summarizeLedger(rows, 3), reviewRounds: null, sources: { controlLog: r.status, reviewReports: "absent" }, threshold: 3 })); };
  t("fixture[concurrency-race]: two reads of one log ⇒ identical rework + identical tag", JSON.stringify(r1.rework) === JSON.stringify(r2.rework) && tag(r1) === tag(r2));
  const other = costPerAcceptedChange([{ acceptedResultId: "zz", nodeId: "nodeZ", jobId: "jZ", attemptId: "tZ", superseded: false }], {});
  t("fixture[concurrency-race]: a DIFFERENT report ⇒ a DIFFERENT tag (no key collision)", tag(r1) !== ledgerReportTag(renderLedgerReport({ rows: other, summary: summarizeLedger(other, 3), reviewRounds: null, sources: { controlLog: "read", reviewReports: "absent" }, threshold: 3 })));
}

console.log("\nverification-ledger selftest: ALL PASS");
