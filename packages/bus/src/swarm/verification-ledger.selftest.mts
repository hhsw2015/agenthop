#!/usr/bin/env tsx
/**
 * verification-ledger selftest (econ-mirror-21 candidate ③, r2). Covers the PURE core (arg parse, extraction, the job-keyed +
 * sequence-windowed join, summary, render honesty, content tag), the STORE's FC-2 three-state over a REAL on-disk control-log, and
 * the zero-bug 3-fixture law on the PROJECTION WRITE-FACE. The r2 regressions target the five review findings:
 *   VL-1 compound (jobId,nodeId) key — same nodeId in two jobs never merges; a "constructor" nodeId never pollutes; an unlinked
 *        rejection is counted unresolved, never folded.
 *   VL-2 sequence window — a rejection AFTER an acceptance belongs to a later revision's window, never the already-accepted change.
 *   VL-3 unknown ≠ zero — a countersMissing change is excluded from the mean + first-try count; coverage is reported.
 *   VL-4 partial review-rounds — complete:false renders as a LOWER BOUND, never a complete zero.
 *   VL-5 --since-last retired — the parser rejects it; the report labels each source's range.
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
import { readLedgerInputs, readReviewRoundsDist } from "./verification-ledger-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "verif-ledger-"));
const controlLogDir = (home: string) => path.join(home, ".agenthop", "swarm", "control-log");

function mkAttempt(attemptId: string, jobId: string, nodeId: string, createdAtSeq: number): Change {
  const attempt = { attemptId, jobId, nodeId, createdAtSeq, status: "running" } as unknown as TaskAttempt;
  const key = entityKeyOf({ put: "attempt", attempt });
  return { put: "attempt", attempt, operationId: `${key}#1`, expectedEntityRevision: 0 };
}
function seed(home: string, changes: Change[]): void {
  const r = commitControl(controlLogDir(home), initialLogState(), changes);
  if (!r.result.ok) throw new Error("seed commit rejected: " + JSON.stringify(r.result));
}
// Hand-made control-log entity BODIES (what liveEntities yields) — unit-tests the pure join/attribution (where the bugs were)
// deterministically, without the strict commit V2-V6 accepted/rejected sequence. Fields mirror the real AcceptedResult/TaskAttempt/
// RejectedResult shapes (jobId/nodeId/planRevision/decidedAtSeq/attemptId/createdAtSeq/atSeq).
const acc = (acceptedResultId: string, jobId: string, nodeId: string, decidedAtSeq: number, o: { rev?: number; attemptId?: string; superseded?: boolean } = {}) =>
  ({ put: "accepted", accepted: { acceptedResultId, jobId, nodeId, planRevision: o.rev ?? 1, decidedAtSeq, attemptId: o.attemptId ?? ("att-" + acceptedResultId), superseded: o.superseded ?? false } });
const att = (attemptId: string, jobId: string, nodeId: string, createdAtSeq: number) => ({ put: "attempt", attempt: { attemptId, jobId, nodeId, createdAtSeq } });
const rej = (attemptId: string, atSeq: number) => ({ put: "rejected", rejected: { attemptId, atSeq } });

// =====================================================================================================================
// PURE — flag + args (VL-5)
// =====================================================================================================================
t("flag: default OFF (unset), OFF on 0/empty, ON on 1/true/yes/on", (() => {
  const off = !verificationLedgerEnabled({} as NodeJS.ProcessEnv) && !verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: "0" } as NodeJS.ProcessEnv) && !verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: "" } as NodeJS.ProcessEnv);
  const on = ["1", "true", "YES", "on"].every((v) => verificationLedgerEnabled({ SWARM_VERIFICATION_LEDGER: v } as NodeJS.ProcessEnv));
  return off && on;
})());
t("args: defaults (threshold 3, sinceSec null, not dry)", (() => { const a = parseLedgerArgs([], 1000); return a !== null && a.threshold === 3 && a.sinceSec === null && a.dry === false; })());
t("args: --threshold valid / 0⇒null / non-int⇒null", parseLedgerArgs(["--threshold", "5"], 1000)?.threshold === 5 && parseLedgerArgs(["--threshold", "0"], 1000) === null && parseLedgerArgs(["--threshold", "x"], 1000) === null);
t("args: --days sets sinceSec from injected now (pure)", parseLedgerArgs(["--days", "1"], 100000)?.sinceSec === 100000 - 86400);
t("args VL-5: --since-last is RETIRED ⇒ rejected (null), not a silent full scan", parseLedgerArgs(["--since-last"], 1000) === null);
t("args: unknown flag ⇒ null; --coordinator without value ⇒ null", parseLedgerArgs(["--nope"], 1000) === null && parseLedgerArgs(["--coordinator"], 1000) === null);

// =====================================================================================================================
// PURE — extraction
// =====================================================================================================================
{
  const inputs = extractLedgerInputs([acc("a1", "j", "n", 2), att("t1", "j", "n", 1), rej("t1", 5), { put: "plan", plan: {} }, acc("bad", "j", "", 3), att("bad", "j", "n", NaN)]);
  t("extract: accepted/attempt/rejected pulled; required-field-missing skipped (empty nodeId, NaN seq)", inputs.accepted.length === 1 && inputs.attempts.length === 1 && inputs.rejections.length === 1 && inputs.accepted[0]!.jobId === "j" && inputs.accepted[0]!.decidedAtSeq === 2);
}

// =====================================================================================================================
// VL-1 — compound (jobId,nodeId) key: same nodeId in two jobs must NOT merge
// =====================================================================================================================
{
  const bodies = [
    att("aA", "job-a", "build", 1), acc("accA", "job-a", "build", 2, { attemptId: "aA" }),                 // A: first-try, 0 rework
    att("aB1", "job-b", "build", 3), rej("aB1", 4), att("aB2", "job-b", "build", 5), rej("aB2", 6),        // B: 3 rejects
    att("aB3", "job-b", "build", 7), rej("aB3", 8), att("aB4", "job-b", "build", 9), acc("accB", "job-b", "build", 10, { attemptId: "aB4" }),
  ];
  const cpac = costPerAcceptedChange(extractLedgerInputs(bodies));
  const A = cpac.rows.find((r) => r.jobId === "job-a")!; const B = cpac.rows.find((r) => r.jobId === "job-b")!;
  t("VL-1: same nodeId 'build' in two jobs does NOT merge — A rework 0 / B rework 3 (not both 3)", A.reworkRounds === 0 && B.reworkRounds === 3);
  t("VL-1: A stays first-try (1 attempt), not inflated by job-b's attempts", A.attempts === 1 && B.attempts === 4);
  const sum = summarizeLedger(cpac, 1);
  t("VL-1: total rework (known) = 3, not 6 (no cross-job double count)", sum.totalReworkKnown === 3);
  t("VL-1: only B is disproportionate at threshold 1 (A not falsely flagged)", sum.flagged.length === 1 && sum.flagged[0]!.jobId === "job-b");
}
// VL-1 prototype pollution: a nodeId named "constructor" must not hit Object.prototype (would make attempts NaN via a bare object).
{
  const cpac = costPerAcceptedChange(extractLedgerInputs([att("c1", "jx", "constructor", 1), acc("accC", "jx", "constructor", 2, { attemptId: "c1" })]));
  const row = cpac.rows.find((r) => r.nodeId === "constructor")!;
  t("VL-1: nodeId 'constructor' is Map-keyed ⇒ attempts is a finite number (not NaN from a prototype key)", Number.isFinite(row.attempts) && row.attempts === 1 && row.reworkRounds === 0);
}
// VL-1 unresolved rejection: a rejection whose attemptId has no attempt is counted unresolved, NEVER folded into a node.
{
  const cpac = costPerAcceptedChange(extractLedgerInputs([att("t1", "j", "n", 1), acc("a1", "j", "n", 2, { attemptId: "t1" }), rej("ghost", 5)]));
  t("VL-1: a rejection with no linkable attempt ⇒ unresolvedRejections 1, not folded into node n", cpac.unresolvedRejections === 1 && cpac.rows.find((r) => r.nodeId === "n")!.reworkRounds === 0);
}

// =====================================================================================================================
// VL-2 — sequence window: a rejection AFTER an acceptance belongs to a later revision, never the accepted change
// =====================================================================================================================
{
  const base = [att("p1", "jp", "n", 1), acc("accP1", "jp", "n", 2, { attemptId: "p1", rev: 1 }),
    att("p2", "jp", "n", 3), rej("p2", 4), att("p3", "jp", "n", 5), rej("p3", 6), att("p4", "jp", "n", 7), rej("p4", 8)];
  const cpac1 = costPerAcceptedChange(extractLedgerInputs(base));
  t("VL-2: rev1 accepted (seq2) ⇒ rework 0 — the 3 rejections at seq 4/6/8 are AFTER its acceptance, NOT its cost", cpac1.rows.find((r) => r.acceptedResultId === "accP1")!.reworkRounds === 0);
  // add a rev2 acceptance at seq9 — NOW those 3 post-rev1 rejections fall in rev2's window (2,9)
  const cpac2 = costPerAcceptedChange(extractLedgerInputs([...base, acc("accP2", "jp", "n", 9, { attemptId: "p4", rev: 2 })]));
  t("VL-2: a later rev2 accept (seq9) carries the (2,9) window rework = 3; rev1 still 0 (no retro-rewrite)", cpac2.rows.find((r) => r.acceptedResultId === "accP2")!.reworkRounds === 3 && cpac2.rows.find((r) => r.acceptedResultId === "accP1")!.reworkRounds === 0);
}

// =====================================================================================================================
// VL-3 — unknown ≠ zero: a countersMissing change is excluded from the mean + first-try count
// =====================================================================================================================
{
  const known = [att("k1", "jk", "n", 1), rej("k1", 2), att("k2", "jk", "n", 3), rej("k2", 4), att("k3", "jk", "n", 5), rej("k3", 6), att("k4", "jk", "n", 7), acc("accK", "jk", "n", 8, { attemptId: "k4" })]; // rework 3
  const missing = [acc("accM", "jm", "n", 2)]; // NO attempt for jm/n ⇒ countersMissing
  const cpac = costPerAcceptedChange(extractLedgerInputs([...known, ...missing]));
  const sum = summarizeLedger(cpac, 3);
  t("VL-3: countersMissing flagged on the attempt-less accept", cpac.rows.find((r) => r.acceptedResultId === "accM")!.countersMissing === true && cpac.rows.find((r) => r.acceptedResultId === "accK")!.countersMissing === false);
  t("VL-3: mean/first-try over KNOWN only (mean 3, not diluted to 1.5; first-try 0; coverage 1/2)", sum.meanReworkKnown === 3 && sum.zeroReworkKnown === 0 && sum.knownCount === 1 && sum.acceptedCount === 2 && sum.countersMissingCount === 1);
  const allMissing = summarizeLedger(costPerAcceptedChange(extractLedgerInputs([acc("accM", "jm", "n", 2)])), 3);
  t("VL-3: all-unknown ⇒ knownCount 0 + meanReworkKnown 0 (coverage shows 0 sample, not a false 'first-try')", allMissing.knownCount === 0 && allMissing.meanReworkKnown === 0 && allMissing.zeroReworkKnown === 0 && allMissing.acceptedCount === 1);
}
t("disproportionate: boundary is >= threshold", disproportionateRework({ jobId: "j", nodeId: "n", acceptedResultId: "", planRevision: 1, decidedAtSeq: 1, attempts: 3, reworkRounds: 3, superseded: false, countersMissing: false }, 3) === true && disproportionateRework({ jobId: "j", nodeId: "n", acceptedResultId: "", planRevision: 1, decidedAtSeq: 1, attempts: 2, reworkRounds: 2, superseded: false, countersMissing: false }, 3) === false);
// superseded excluded from the live summary
{
  const cpac = costPerAcceptedChange(extractLedgerInputs([att("s1", "js", "n", 1), acc("accS", "js", "n", 2, { attemptId: "s1", superseded: true })]));
  t("summary: superseded accept EXCLUDED from live count", summarizeLedger(cpac, 3).acceptedCount === 0);
}

// =====================================================================================================================
// PURE — render honesty (incl VL-3 coverage, VL-4 partial, VL-5 ranges)
// =====================================================================================================================
{
  const cpac = costPerAcceptedChange(extractLedgerInputs([att("k1", "jk", "n", 1), rej("k1", 2), att("k2", "jk", "n", 3), rej("k2", 4), att("k3", "jk", "n", 5), rej("k3", 6), att("k4", "jk", "n", 7), acc("accK", "jk", "n", 8, { attemptId: "k4" }), rej("ghost", 9)]));
  const rpt = renderLedgerReport({ summary: summarizeLedger(cpac, 3), reviewRounds: { perTicket: [], totalTickets: 2, singlePass: 1, multiRound: 1, maxRounds: 4, medianRounds: 2 }, sources: { controlLog: "read", reviewReports: "read", reviewReportsComplete: true }, reviewWindowDays: 7, threshold: 3 });
  t("render: COST not ROI; $ omitted (no (job,node) link); review NOT keyed to acceptance", /COST metric, NOT an ROI/i.test(rpt) && /\$ cost omitted/i.test(rpt) && /NOT keyed to acceptance/i.test(rpt));
  t("render: mean is over the KNOWN sample with coverage; unresolved rejections surfaced", /known-cost sample: 1\/1/.test(rpt) && /mean rework \(known\)/.test(rpt) && /could not be linked to an attempt/i.test(rpt));
  t("render VL-5: control-log labelled FULL current projection; review range labelled (last 7d)", /FULL current projection/i.test(rpt) && /last 7d/i.test(rpt));
  t("render: a flagged disproportionate change lists job/node", /disproportionate/i.test(rpt) && /jk\/n/.test(rpt));

  const partial = renderLedgerReport({ summary: summarizeLedger(costPerAcceptedChange(extractLedgerInputs([])), 3), reviewRounds: { perTicket: [], totalTickets: 1, singlePass: 1, multiRound: 0, maxRounds: 1, medianRounds: 1 }, sources: { controlLog: "read", reviewReports: "read", reviewReportsComplete: false }, reviewWindowDays: null, threshold: 3 });
  t("render VL-4: partial review-rounds (complete:false) ⇒ 'PARTIAL' / 'LOWER BOUND', never a complete zero", /PARTIAL/i.test(partial) && /LOWER BOUND/i.test(partial));

  const absent = renderLedgerReport({ summary: summarizeLedger(costPerAcceptedChange(extractLedgerInputs([])), 3), reviewRounds: null, sources: { controlLog: "unreadable", reviewReports: "absent", reviewReportsComplete: true }, reviewWindowDays: null, threshold: 3 });
  t("render: unreadable control-log ⇒ 'NOT reported as zero'; absent review ⇒ unavailable", /control-log: unreadable/i.test(absent) && /NOT reported as zero/i.test(absent) && /review-report rounds: absent/i.test(absent));
}
t("tag: 32 hex; stable for identical TEXT; distinct for different TEXT", (() => { const a = ledgerReportTag("X"); return /^[0-9a-f]{32}$/.test(a) && a === ledgerReportTag("X") && a !== ledgerReportTag("Y"); })());

// =====================================================================================================================
// STORE — FC-2 three-state over a REAL on-disk control-log
// =====================================================================================================================
{
  const h = tmpHome();
  t("store: absent control-log dir ⇒ status 'absent', empty inputs (not fabricated)", (() => { const r = readLedgerInputs(h); return r.status === "absent" && r.inputs.accepted.length === 0 && r.inputs.attempts.length === 0; })());
}
{
  const h = tmpHome(); mkdirSync(controlLogDir(h), { recursive: true });
  writeFileSync(path.join(controlLogDir(h), "1.json"), "{ this is not json");
  t("store[crash-recovery]: corrupt/torn log ⇒ status 'unreadable', empty (NEVER a fabricated empty)", (() => { const r = readLedgerInputs(h); return r.status === "unreadable" && r.inputs.attempts.length === 0; })());
  const rpt = renderLedgerReport({ summary: summarizeLedger(costPerAcceptedChange(readLedgerInputs(h).inputs), 3), reviewRounds: null, sources: { controlLog: readLedgerInputs(h).status, reviewReports: "absent", reviewReportsComplete: true }, reviewWindowDays: null, threshold: 3 });
  t("store[crash-recovery]: report over the unreadable log says 'cannot compute' (not zero)", /control-log: unreadable/i.test(rpt) && /cannot compute/i.test(rpt));
}
{
  const h = tmpHome();
  seed(h, [mkAttempt("att-A", "job-a", "nodeA", 1), mkAttempt("att-B", "job-b", "nodeB", 2), mkAttempt("att-A2", "job-a", "nodeA", 3)]);
  const r = readLedgerInputs(h);
  t("store: real log ⇒ status 'read'; attempts extracted with job/node from a REAL commitControl replay", r.status === "read" && r.inputs.attempts.length === 3 && r.inputs.attempts.filter((a) => a.jobId === "job-a").length === 2);
}
{
  const h = tmpHome();
  const rr = readReviewRoundsDist(h);
  t("store: absent review-reports ⇒ dist null + status absent + complete forwarded (NOT a zero-round dist)", rr.dist === null && rr.status === "absent" && typeof rr.complete === "boolean");
}

// =====================================================================================================================
// 3-FIXTURE — projection write-face (titles narrowed to what they actually prove, per review)
// =====================================================================================================================
{
  // restart-idempotency: identical report TEXT ⇒ identical tag. (The REAL restart/publish safety is publishOnce in inbox.ts; this only
  // proves the tag is a deterministic content hash so a re-run produces the SAME key ⇒ publishOnce dedups — not re-proven here.)
  const mk = () => renderLedgerReport({ summary: summarizeLedger(costPerAcceptedChange(extractLedgerInputs([att("t1", "j", "n", 1), acc("a1", "j", "n", 2, { attemptId: "t1" })])), 3), reviewRounds: null, sources: { controlLog: "read", reviewReports: "absent", reviewReportsComplete: true }, reviewWindowDays: null, threshold: 3 });
  t("fixture[restart-idempotency]: identical inputs ⇒ identical report TEXT ⇒ identical tag (deterministic; dedup is publishOnce's job)", ledgerReportTag(mk()) === ledgerReportTag(mk()));
}
{
  // concurrency-race: two independent reads of the SAME log are identical (read is pure/idempotent) ⇒ identical tag. (Not a real
  // parallel-publish test — that safety is publishOnce's.)
  const h = tmpHome();
  seed(h, [mkAttempt("att-C", "job-c", "nodeC", 1), mkAttempt("att-D", "job-d", "nodeD", 2)]);
  const r1 = readLedgerInputs(h); const r2 = readLedgerInputs(h);
  t("fixture[concurrency-race]: two reads of one log ⇒ identical inputs (deterministic read)", JSON.stringify(r1.inputs) === JSON.stringify(r2.inputs));
}

console.log("\nverification-ledger selftest: ALL PASS");
