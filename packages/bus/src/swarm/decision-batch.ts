/**
 * Decision-batch pure core (R22-P1①, DHH-eval borrow). The event→decision compression layer: the coordinator aggregates N
 * pending items that each need a human verdict (呈批件 / 并库候选 / 签收确认 / 立项请求) into ONE batch the user clears on a
 * single screen — DHH's "which of these 12 PRs to merge or close" email, generalized. One line per item, binary-mostly
 * (approve / reject) plus defer. The point is to shrink the user's decision load (R22 north star: protect judgment bandwidth),
 * NOT to add a slow approval hop — the coordinator stays a COMPRESSION layer, never a human-speed intermediary.
 *
 * Pure (no fs / no clock beyond an injected nowSec), so the schema + match/resolve decisions — where a wrong match would
 * execute the wrong verdict — are unit-tested without disk. The IO half (persist batch, read user decisions, consume-once)
 * lives in decision-batch-store.ts. Delivery reuses the durable inbox (no new transport).
 */

/** One item awaiting a verdict. `summary` is ONE line (the whole point); `suggestedAction` is the coordinator's recommended
 *  default; `evidenceRef` is a POINTER (path / url / handle), never inlined content (S18). `kind` groups it for the UI. */
export type DecisionItem = { id: string; kind: string; summary: string; suggestedAction: string; evidenceRef?: string; foldedFrom?: string[] };

/** A batch of items the owner (coordinator) asks the user to clear in one pass. */
export type DecisionBatch = { batchId: string; owner: string; createdAtSec: number; items: DecisionItem[] };

/** The user's verdict per item — binary-mostly, plus defer (decide later; stays pending). */
export type Verdict = "approve" | "reject" | "defer";
export const VERDICTS: readonly Verdict[] = ["approve", "reject", "defer"];

/** One decision the user made; `reason` is an optional one-line note. */
export type Decision = { id: string; verdict: Verdict; reason?: string };

/** The user's decisions for a batch (written back by the console/CLI). */
export type DecisionsDoc = { batchId: string; decidedAtSec: number; decisions: Decision[] };

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStr = (v: unknown): v is string => typeof v === "string";

/** Validate a parsed decision item (schema guard): id/kind/summary/suggestedAction non-empty strings; evidenceRef optional
 *  string. Returns the normalized item or null (caller rejects — never persist / never act on a malformed item). */
export function validDecisionItem(raw: unknown): DecisionItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyStr(r.id) || !isNonEmptyStr(r.kind) || !isNonEmptyStr(r.summary) || !isNonEmptyStr(r.suggestedAction)) return null;
  if (r.evidenceRef !== undefined && !isStr(r.evidenceRef)) return null;
  // submit-tag (T5-2): foldedFrom records the content digests of the chat-room/inbox submits this item compressed, so the gauge
  // counts each logical submission once (B_prod=N) and never double-counts a submit and the batch item it folds into. Validate
  // EACH slot explicitly (ST-P2-2): Array.prototype.every SKIPS sparse holes and would run an input-supplied `every` — iterate
  // by index over a genuine array, reject a hole (undefined) or a non-string, and emit a CLEAN copy (never alias the input).
  let foldedFrom: string[] | undefined;
  if (r.foldedFrom !== undefined) {
    if (!Array.isArray(r.foldedFrom)) return null;
    const ff: string[] = [];
    for (let i = 0; i < r.foldedFrom.length; i += 1) {
      const v = r.foldedFrom[i];
      if (!isNonEmptyStr(v)) return null; // a hole or a non-empty-string element ⇒ whole-reject (never write a [null])
      ff.push(v);
    }
    foldedFrom = ff;
  }
  return {
    id: r.id, kind: r.kind, summary: r.summary, suggestedAction: r.suggestedAction,
    ...(isStr(r.evidenceRef) ? { evidenceRef: r.evidenceRef } : {}),
    ...(foldedFrom !== undefined ? { foldedFrom } : {}),
  };
}

/** Validate a parsed batch: batchId/owner non-empty, createdAtSec finite, items an array of valid items with UNIQUE ids
 *  (a duplicate id would make a verdict ambiguous). Returns the normalized batch or null. */
export function validDecisionBatch(raw: unknown): DecisionBatch | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyStr(r.batchId) || !isNonEmptyStr(r.owner)) return null;
  if (typeof r.createdAtSec !== "number" || !Number.isFinite(r.createdAtSec)) return null;
  if (!Array.isArray(r.items)) return null;
  const items: DecisionItem[] = [];
  const seen = new Set<string>();
  for (const raw2 of r.items) {
    const it = validDecisionItem(raw2);
    if (!it || seen.has(it.id)) return null; // malformed OR duplicate id ⇒ reject the whole batch (ambiguity is poison)
    seen.add(it.id);
    items.push(it);
  }
  return { batchId: r.batchId, owner: r.owner, createdAtSec: r.createdAtSec, items };
}

/** Validate a parsed decision. */
export function validDecision(raw: unknown): Decision | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyStr(r.id)) return null;
  if (r.verdict !== "approve" && r.verdict !== "reject" && r.verdict !== "defer") return null;
  if (r.reason !== undefined && !isStr(r.reason)) return null;
  return { id: r.id, verdict: r.verdict, ...(isStr(r.reason) ? { reason: r.reason } : {}) };
}

/** Validate a parsed decisions doc: batchId non-empty, decidedAtSec finite, decisions an array of valid decisions (a torn /
 *  mistyped one rejects the whole doc — never act on a half-parsed verdict set). */
export function validDecisionsDoc(raw: unknown): DecisionsDoc | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyStr(r.batchId)) return null;
  if (typeof r.decidedAtSec !== "number" || !Number.isFinite(r.decidedAtSec)) return null;
  if (!Array.isArray(r.decisions)) return null;
  const decisions: Decision[] = [];
  for (const raw2 of r.decisions) {
    const d = validDecision(raw2);
    if (!d) return null;
    decisions.push(d);
  }
  return { batchId: r.batchId, decidedAtSec: r.decidedAtSec, decisions };
}

/** Build a fresh batch (ids deduped at validation). */
export function buildBatch(i: { batchId: string; owner: string; items: DecisionItem[]; nowSec: number }): DecisionBatch {
  return { batchId: i.batchId, owner: i.owner, createdAtSec: i.nowSec, items: i.items };
}

export type ResolvedDecision = { item: DecisionItem; verdict: Verdict; reason?: string };

/**
 * Match the user's decisions onto the batch. Returns:
 *  - `resolved`: items with an approve/reject/defer verdict (first decision per id wins; a duplicate is ignored),
 *  - `undecided`: batch items with NO decision yet (a defer counts as decided — it is an explicit "later", still in resolved),
 *  - `unknownIds`: decision ids that match no batch item (reported, never acted on).
 * Pure — the coordinator executes `resolved` (approve/reject) and re-asks `undecided`+deferred in the next batch; a stale /
 * foreign decision can never trigger an action it was not matched to.
 */
export function resolveBatch(batch: DecisionBatch, doc: DecisionsDoc): { resolved: ResolvedDecision[]; undecided: DecisionItem[]; unknownIds: string[] } {
  // DB-P1-1: the decisions MUST be for THIS batch. A doc carrying a different batchId never resolves against it — otherwise
  // a verdict for batch B's item "1" would borrow batch A's item "1" (same id, different batch) and execute the wrong action.
  // A mismatched doc produces NO resolved/undecided-removal; its ids are reported as unknown (acted on by nothing).
  if (doc.batchId !== batch.batchId) return { resolved: [], undecided: batch.items, unknownIds: doc.decisions.map((d) => d.id) };
  const byId = new Map(batch.items.map((it) => [it.id, it]));
  const decidedIds = new Set<string>();
  const resolved: ResolvedDecision[] = [];
  const unknownIds: string[] = [];
  for (const d of doc.decisions) {
    const item = byId.get(d.id);
    if (!item) { unknownIds.push(d.id); continue; }
    if (decidedIds.has(d.id)) continue; // a duplicate decision for the same id — first wins, rest ignored
    decidedIds.add(d.id);
    resolved.push({ item, verdict: d.verdict, ...(d.reason !== undefined ? { reason: d.reason } : {}) });
  }
  const undecided = batch.items.filter((it) => !decidedIds.has(it.id));
  return { resolved, undecided, unknownIds };
}

/** The verdicts the coordinator ACTS on now (approve/reject) — a defer is an explicit "ask again", not an action. */
export function actionable(resolved: ResolvedDecision[]): ResolvedDecision[] {
  return resolved.filter((r) => r.verdict !== "defer");
}
