#!/usr/bin/env node
// Box-side: merge the dispatcher's assignment.json (AUTHORITATIVE identity) with the Claude worker's self-reported
// outcome (worker-report.json) into the canonical result.json (task-result.ts TaskResult, schemaVersion 1). The
// identity fields ALWAYS come from the assignment, so the dispatcher's V2 identity check can never be tripped by what
// the worker writes; only outcome / outputs / validationEvidence come from the worker. A missing or garbled report
// degrades to an explicit outcome=failure result (never a hang / never a silent nothing), so the dispatcher's V1-V8
// see a definite verdict — which is exactly why "只 milestone 无合格 result ⇏ SUCCEEDED" holds (§7 T1).
//
// CLI: node swarm-build-result.mjs <assignment.json> <worker-report.json> <out/result.json>   (atomic temp+rename)

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Pure merge. Identity ⇐ assignment; work parts ⇐ report (defaulted + sanitized). A failure always carries a reason. */
export function buildResultJson(assignment, report) {
  const r = report && typeof report === "object" ? report : null;
  const outcome = r && r.outcome === "success" ? "success" : "failure";
  const outputs = r && Array.isArray(r.outputs) ? r.outputs : [];
  const validationEvidence = r && Array.isArray(r.validationEvidence) ? r.validationEvidence : [];
  const result = {
    schemaVersion: 1,
    jobId: assignment.jobId,
    planRevision: assignment.planRevision,
    nodeId: assignment.nodeId,
    attemptId: assignment.attemptId,
    assignmentId: assignment.assignmentId,
    inputBindingDigest: assignment.inputBindingDigest,
    outcome,
    outputs,
    validationEvidence,
  };
  if (outcome === "failure") {
    result.failureReason = r && typeof r.failureReason === "string" && r.failureReason
      ? r.failureReason
      : "worker produced no usable outcome report";
  }
  return result;
}

function main() {
  const [asgPath, reportPath, outPath] = process.argv.slice(2);
  if (!asgPath || !reportPath || !outPath) {
    console.error("usage: swarm-build-result.mjs <assignment.json> <worker-report.json> <out/result.json>");
    process.exit(2);
  }
  const assignment = JSON.parse(readFileSync(asgPath, "utf8"));
  let report = null;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; } // missing/garbled ⇒ failure
  const result = buildResultJson(assignment, report);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, outPath); // atomic: a reader never sees a half-written result.json
  console.log(`result.json: outcome=${result.outcome} attempt=${result.attemptId}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
