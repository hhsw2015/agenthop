/**
 * Result acceptance — the two-layer validation V1-V8 (§4.2) + failure classification (§4.2 table). PURE decision over
 * an ALREADY-GATHERED candidate, exactly like acceptance.ts/tipToEvent is a pure decision over an already-observed
 * tip. All git IO (ls-remote, pinned fetch, tree listing, `git apply --check`, running acceptance commands, blob
 * OIDs) happens in the dispatcher/O1 (T2) and is passed in as plain data; this module decides accept / reject /
 * discard / stale / replay and never touches the attempt — the caller maps the verdict onto an advanceAttempt event.
 *
 * Layering the review rounds forced (each pinned by a test):
 *  - V2 (identity) and V3 (binding) are CANDIDATE-LEVEL discards: a wrong-identity or peer-late candidate is thrown
 *    away and audited; the attempt is NOT touched. Upgrading a late candidate into an attempt FAILED was v1 P2-1.
 *  - V3 is evaluated against the binding's tri-state (open/closing/closed), via task-state.candidateEligibility.
 *  - V1 (schema) is classified by SOURCE: a milestone (worker froze it) that is structurally broken is permanent; a
 *    rescue (near-death, per-file staged — may be half-written) is inconsistent-snapshot (candidate-level cost: the
 *    attempt waits for a consistent milestone, no retry charged). Codex v2-P2-4.
 *  - V6 (unique) compares resultClosureDigest — result.json content AND its referenced outputs/evidence blobs — not a
 *    single blob OID: a changed patch with byte-identical result.json is a NEW candidate (Codex P2-2).
 *  - V4 (input) compares the inputBindingDigest AND requires every bound acceptedResultId to still be the dep's
 *    CURRENT accepted (a single value per dep; T2 resolves it by decidedAtSeq among non-superseded). "Binding points
 *    at the old one while a newer accepted exists" => stale-input (fe0376cd).
 */

import { digestOf } from "./digest.js";
import type { TaskSpec } from "./task-plan.js";
import { type TaskAttempt, candidateEligibility } from "./task-state.js";

export const VALIDATOR_VERSION = "brain-v1";
/** result.json itself is a small summary; large artifacts are referenced, not inlined (§2.4). */
export const MAX_RESULT_BYTES = 64 * 1024;

export type CandidateSource = "milestone" | "rescue";

export type ResultOutput = { logicalName: string; kind: "patch" | "files" | "report" | "notes"; path: string; baseSourceCommit?: string };
export type ValidationEvidence = { check: string; cmd?: string; exitCode?: number; summaryPath?: string };

/** What the worker writes into the WORK tree (§2.4). Does NOT carry its own commit SHA (self-reference impossible). */
export type TaskResult = {
  schemaVersion: 1;
  jobId: string;
  planRevision: number;
  nodeId: string;
  attemptId: string;
  assignmentId: string;
  inputBindingDigest: string;
  outcome: "success" | "failure";
  failureReason?: string;
  outputs: ResultOutput[];
  validationEvidence: ValidationEvidence[];
};

/** What the dispatcher writes on acceptance (§2.5). */
export type AcceptedResult = {
  acceptedResultId: string;
  attemptId: string;
  nodeId: string;
  jobId: string;
  planRevision: number;
  observedWorkCommit: string;
  resultPath: string;
  resultBlobOid: string;
  resultClosureDigest: string;
  inputBindingDigest: string;
  validatorVersion: string;
  decision: "accepted";
  decidedAtSeq: number;
  superseded?: boolean;
};

export type VFailureClass = "transient-infra" | "business-fail" | "stale" | "inconsistent-snapshot" | "permanent";

export type Verdict =
  | { decision: "accept"; accepted: AcceptedResult }
  | { decision: "replay"; acceptedResultId: string; reason: string } // V6 same closure already accepted — idempotent no-op
  | { decision: "discard"; rule: "V2" | "V3" | "V6"; reason: string } // candidate-level; attempt UNTOUCHED
  | { decision: "reject"; rule: "V1" | "V7" | "V8" | "scope" | "outcome"; failureClass: VFailureClass; reason: string } // attempt-level
  | { decision: "stale"; rule: "V4" | "V5"; which: "input" | "plan"; reason: string }; // attempt-level ABANDONED (no charge)

export type ValidationInput = {
  resultText: string;
  source: CandidateSource;
  attempt: TaskAttempt;
  /** The spec the attempt was dispatched with (frozen): artifactScope / outputContract / acceptance / sourceWriteScope. */
  attemptSpec: TaskSpec;
  /** The CURRENT plan revision's specDigest for this nodeId (null = node removed) — V5. */
  currentSpecDigest: string | null;
  /** dep nodeId -> its CURRENT accepted id (single value; null if the dep has no current) — V4. */
  currentDepResults: Record<string, string | null>;
  observed: { launchId: string; generation: number; workCommit: string; resultBlobOid: string; resultPath: string };
  /** For a closing/closed matched binding: is this candidate within the cutoffTip ancestry / registered before close
   *  (CONTROL/IO fact, see task-state.candidateEligibility). Ignored for an open binding. */
  withinCutoffAncestry: boolean;
  candidateClosureDigest: string;
  existingAccepted: { acceptedResultId: string; resultClosureDigest: string } | null;
  /** V7 IO outcomes — consulted only when outcome=success. */
  contract: { requiredOutputsPresent: boolean; patchAppliesClean: boolean };
  /** V8 IO outcome — consulted only when outcome=success. */
  acceptancePassed: boolean;
  /** V8 patch sourceWriteScope check: the file set a patch output touches when applied in isolation (optional). */
  patchDiffPaths?: string[];
  /** Cumulative added/changed/deleted paths over the binding's commits since its start — scope-violation (§4.2 v3). */
  cumulativeChangedPaths: string[];
  decidedAtSeq: number;
};

// A scope entry is a path prefix: "out/" covers "out/x" but NOT "outside/x".
function underPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  return path.startsWith(p);
}
const inArtifactScope = (path: string, scope: string[]): boolean => scope.some((s) => underPrefix(path, s));

/** resultClosureDigest = canonical-JSON SHA-256 over the result.json blob OID AND the sorted (path, blobOid) of every
 *  referenced output/evidence file (§2.5). Content closure, not a single blob: a changed patch with identical
 *  result.json bytes yields a different digest (Codex P2-2). */
export function computeResultClosureDigest(input: { resultBlobOid: string; referencedFiles: Array<{ path: string; blobOid: string }> }): string {
  const files = [...input.referencedFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.blobOid < b.blobOid ? -1 : a.blobOid > b.blobOid ? 1 : 0,
  );
  return digestOf({ resultBlobOid: input.resultBlobOid, files });
}

const isString = (v: unknown): v is string => typeof v === "string";
const OUTPUT_KINDS: ReadonlySet<string> = new Set(["patch", "files", "report", "notes"]);

/** Parse + schema + size (§4.2 V1 structural part). Returns null for anything malformed/oversize — a reader catching
 *  a mid-write file degrades to null, never throws. */
export function parseTaskResult(text: string): TaskResult | null {
  if (!text || new TextEncoder().encode(text).length > MAX_RESULT_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return null;
  for (const k of ["jobId", "planRevision", "nodeId", "attemptId", "assignmentId", "inputBindingDigest", "outcome"]) {
    if (o[k] === undefined) return null;
  }
  if (!isString(o.jobId) || !isString(o.nodeId) || !isString(o.attemptId) || !isString(o.assignmentId) || !isString(o.inputBindingDigest)) return null;
  if (typeof o.planRevision !== "number" || !Number.isInteger(o.planRevision)) return null;
  if (o.outcome !== "success" && o.outcome !== "failure") return null;
  if (o.failureReason !== undefined && !isString(o.failureReason)) return null;
  if (!Array.isArray(o.outputs)) return null;
  const outputs: ResultOutput[] = [];
  for (const raw of o.outputs) {
    if (typeof raw !== "object" || raw === null) return null;
    const ro = raw as Record<string, unknown>;
    if (!isString(ro.logicalName) || !isString(ro.kind) || !OUTPUT_KINDS.has(ro.kind) || !isString(ro.path)) return null;
    if (ro.baseSourceCommit !== undefined && !isString(ro.baseSourceCommit)) return null;
    outputs.push({ logicalName: ro.logicalName, kind: ro.kind as ResultOutput["kind"], path: ro.path, ...(ro.baseSourceCommit !== undefined ? { baseSourceCommit: ro.baseSourceCommit as string } : {}) });
  }
  if (!Array.isArray(o.validationEvidence)) return null;
  const evidence: ValidationEvidence[] = [];
  for (const raw of o.validationEvidence) {
    if (typeof raw !== "object" || raw === null) return null;
    const ve = raw as Record<string, unknown>;
    if (!isString(ve.check)) return null;
    evidence.push({ check: ve.check, ...(ve.cmd !== undefined ? { cmd: ve.cmd as string } : {}), ...(ve.exitCode !== undefined ? { exitCode: ve.exitCode as number } : {}), ...(ve.summaryPath !== undefined ? { summaryPath: ve.summaryPath as string } : {}) });
  }
  return {
    schemaVersion: 1,
    jobId: o.jobId,
    planRevision: o.planRevision,
    nodeId: o.nodeId,
    attemptId: o.attemptId,
    assignmentId: o.assignmentId,
    inputBindingDigest: o.inputBindingDigest,
    outcome: o.outcome,
    ...(o.failureReason !== undefined ? { failureReason: o.failureReason as string } : {}),
    outputs,
    validationEvidence: evidence,
  };
}

/** Run V1-V8 (+ scope) in dependency order and classify. Pure. */
export function validateResult(i: ValidationInput): Verdict {
  const { attempt, attemptSpec, source } = i;
  const bySource = (business: boolean): VFailureClass => (source === "rescue" ? "inconsistent-snapshot" : business ? "business-fail" : "permanent");

  // V3: the candidate must sit on one of THIS attempt's bindings (match by launchId+generation), and that binding's
  // tri-state must admit it. Both failures are candidate-level discards — never touch the attempt.
  const binding = attempt.executionBindings.find((b) => b.launchId === i.observed.launchId && b.publishGeneration === i.observed.generation);
  if (!binding) return { decision: "discard", rule: "V3", reason: `no binding for ${i.observed.launchId} g${i.observed.generation}` };
  const elig = candidateEligibility(binding, i.withinCutoffAncestry);
  if (!elig.eligible) return { decision: "discard", rule: "V3", reason: elig.reason };

  // V1: parse/schema/size, then declared outputs within artifactScope. Classified by source.
  const result = parseTaskResult(i.resultText);
  if (!result) return { decision: "reject", rule: "V1", failureClass: bySource(false), reason: "result.json unparseable/oversize/invalid schema" };
  for (const out of result.outputs) {
    if (!inArtifactScope(out.path, attemptSpec.artifactScope)) {
      return { decision: "reject", rule: "V1", failureClass: bySource(false), reason: `declared output ${out.path} outside artifactScope` };
    }
  }

  // V2: identity must match the attempt (and the matched binding's assignment). Candidate-level discard.
  if (result.jobId !== attempt.jobId || result.nodeId !== attempt.nodeId || result.attemptId !== attempt.attemptId || result.assignmentId !== binding.assignmentId) {
    return { decision: "discard", rule: "V2", reason: "identity mismatch (job/node/attempt/assignment)" };
  }

  // V5: the current plan still has this node with the attempt's specDigest, else the task itself changed -> stale.
  if (i.currentSpecDigest === null) return { decision: "stale", rule: "V5", which: "plan", reason: "node removed in current revision" };
  if (i.currentSpecDigest !== attempt.specDigest) return { decision: "stale", rule: "V5", which: "plan", reason: "node spec changed (specDigest)" };

  // V4: inputs must be the frozen ones AND each bound result must still be the dep's CURRENT accepted.
  if (result.inputBindingDigest !== attempt.inputBindingDigest) return { decision: "stale", rule: "V4", which: "input", reason: "inputBindingDigest mismatch" };
  for (const ib of attempt.inputBindings) {
    if (i.currentDepResults[ib.depNodeId] !== ib.acceptedResultId) {
      return { decision: "stale", rule: "V4", which: "input", reason: `dep ${ib.depNodeId} current accepted != bound ${ib.acceptedResultId}` };
    }
  }

  // Scope-violation: cumulative changes over the binding may not touch anything outside artifactScope (+ the always
  // -allowed .swarm/manifest.json and out/results/<attemptId>/). Structural -> permanent.
  for (const p of i.cumulativeChangedPaths) {
    if (p === ".swarm/manifest.json") continue;
    if (underPrefix(p, `out/results/${attempt.attemptId}`)) continue;
    if (!inArtifactScope(p, attemptSpec.artifactScope)) return { decision: "reject", rule: "scope", failureClass: "permanent", reason: `cumulative change ${p} outside artifactScope` };
  }

  // A worker that self-reports failure carries failure evidence -> business-fail. Skip V6/V7/V8.
  if (result.outcome === "failure") {
    return { decision: "reject", rule: "outcome", failureClass: "business-fail", reason: `worker outcome=failure${result.failureReason ? `: ${result.failureReason}` : ""}` };
  }

  // V6: at most one accepted per attempt. Same closure as the existing accepted => idempotent replay; different
  // closure => a duplicate candidate (recorded, not accepted).
  if (i.existingAccepted) {
    if (i.existingAccepted.resultClosureDigest === i.candidateClosureDigest) return { decision: "replay", acceptedResultId: i.existingAccepted.acceptedResultId, reason: "same closure already accepted" };
    return { decision: "discard", rule: "V6", reason: "duplicate: different closure, attempt already accepted" };
  }

  // V7: required outputs present + patch applies clean to its base. IO outcomes passed in.
  if (!i.contract.requiredOutputsPresent) return { decision: "reject", rule: "V7", failureClass: bySource(true), reason: "required outputs missing from tree" };
  const hasPatch = attemptSpec.outputContract.requiredOutputs.some((o) => o.kind === "patch");
  if (hasPatch && !i.contract.patchAppliesClean) return { decision: "reject", rule: "V7", failureClass: bySource(true), reason: "patch does not apply clean to baseSourceCommit" };

  // V8: project acceptance checks + patch sourceWriteScope (the patch may only edit source under sourceWriteScope).
  if (hasPatch && attemptSpec.sourceWriteScope && i.patchDiffPaths) {
    for (const p of i.patchDiffPaths) {
      if (!inArtifactScope(p, attemptSpec.sourceWriteScope)) return { decision: "reject", rule: "scope", failureClass: "permanent", reason: `patch edits ${p} outside sourceWriteScope` };
    }
  }
  if (!i.acceptancePassed) return { decision: "reject", rule: "V8", failureClass: bySource(true), reason: "acceptance checks failed" };

  // Accept.
  const accepted: AcceptedResult = {
    acceptedResultId: `${attempt.attemptId}/r1`,
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    jobId: attempt.jobId,
    planRevision: attempt.planRevision,
    observedWorkCommit: i.observed.workCommit,
    resultPath: i.observed.resultPath,
    resultBlobOid: i.observed.resultBlobOid,
    resultClosureDigest: i.candidateClosureDigest,
    inputBindingDigest: attempt.inputBindingDigest,
    validatorVersion: VALIDATOR_VERSION,
    decision: "accepted",
    decidedAtSeq: i.decidedAtSeq,
  };
  return { decision: "accept", accepted };
}
