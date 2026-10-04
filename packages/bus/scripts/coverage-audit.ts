/**
 * T3b acceptance F — independent requirement-coverage audit (design 1d0a1ffc §3 F). Reads ONLY the produced plan (there
 * is no model "covers" field to trust) and classifies each requirement by STRUCTURED EVIDENCE, not by a self-written
 * marker: "implemented" requires the baseline's requiredCheck to be present in a node's acceptance AND the marker to appear
 * positively (not inside an explicit-omission clause). A marker sitting in a "do NOT implement … [I1]" clause, or a node
 * that keeps the marker but drops the required-check obligation, is NOT implemented. Not a general NL prover — a targeted
 * omission check + structured-acceptance evidence against a hand-made baseline (reviewer P2-5).
 */

export type ReqBaseline = { id: string; marker: string; requiredCheck?: string; expect: "implemented" | "constrained-review" | "deferred" };
export type Disposition = "implemented" | "constrained-review" | "deferred" | "UNCOVERED";

type PlanNodeLike = { kind?: string; goal?: string; acceptance?: Array<{ check?: string } | unknown> };
type PlanLike = { nodes: PlanNodeLike[] };

const OMISSION = /(do not|don'?t|does not|will not|won'?t|not implement|not implemented|skip|omit|omitted|without|out of scope|no longer|instead only|only print)/i;

/** The sentence/segment of `text` that contains `marker` (so negation is judged in-clause, not across the whole goal). */
function markerClause(text: string, marker: string): string {
  const segs = text.split(/[.;\n]/);
  return segs.find((s) => s.includes(marker)) ?? text;
}
function acceptanceHasCheck(n: PlanNodeLike, check: string): boolean {
  return Array.isArray(n.acceptance) && n.acceptance.some((a) => a !== null && typeof a === "object" && (a as { check?: string }).check === check);
}

export function auditCoverage(plan: PlanLike, reqs: ReqBaseline[]): Record<string, Disposition> {
  const out: Record<string, Disposition> = {};
  for (const req of reqs) {
    let deferred = false, review = false, implemented = false;
    for (const n of plan.nodes) {
      const goal = String(n.goal ?? "");
      const accStr = JSON.stringify(n.acceptance ?? []);
      if (!goal.includes(req.marker) && !accStr.includes(req.marker)) continue;
      // An explicit omission/deferral clause for this marker is NOT implementation.
      if (/\bDEFER\b/.test(goal) || OMISSION.test(markerClause(goal, req.marker))) { deferred = true; continue; }
      if (n.kind === "design" || n.kind === "review") { review = true; continue; }
      // A plain node mentioning the marker positively counts as implemented ONLY with the required structured evidence —
      // keeping the marker but dropping the required check is NOT implementation.
      if (req.requiredCheck === undefined || acceptanceHasCheck(n, req.requiredCheck)) implemented = true;
    }
    // Precedence: a review/design gate CONSTRAINS the requirement (even if also implemented); then genuine implementation;
    // then an explicit deferral; else a drop. An omission clause never reaches "implemented" (it set deferred and skipped).
    out[req.id] = review ? "constrained-review" : implemented ? "implemented" : deferred ? "deferred" : "UNCOVERED";
  }
  return out;
}

/** Reconcile an audit against the baseline's expectations. Returns the per-requirement verdicts and a pass flag. */
export function reconcile(plan: PlanLike, reqs: ReqBaseline[]): { pass: boolean; audit: Record<string, Disposition>; mismatches: Array<{ id: string; expected: string; got: Disposition }> } {
  const audit = auditCoverage(plan, reqs);
  const mismatches = reqs.filter((r) => audit[r.id] !== r.expect).map((r) => ({ id: r.id, expected: r.expect, got: audit[r.id]! }));
  return { pass: mismatches.length === 0, audit, mismatches };
}
