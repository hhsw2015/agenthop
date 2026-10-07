import { describe, expect, test } from "vitest";
import {
  validDecisionItem, validDecisionBatch, validDecision, validDecisionsDoc, buildBatch, resolveBatch, actionable,
  type DecisionItem, type DecisionsDoc,
} from "../src/swarm/decision-batch.js";

const item = (id: string, p: Partial<DecisionItem> = {}): DecisionItem => ({ id, kind: "pr", summary: `s-${id}`, suggestedAction: "merge", ...p });
const batch = (items: DecisionItem[]) => buildBatch({ batchId: "b1", owner: "coord", items, nowSec: 100 });
const doc = (decisions: DecisionsDoc["decisions"]): DecisionsDoc => ({ batchId: "b1", decidedAtSec: 200, decisions });

describe("decision-batch pure core", () => {
  test("buildBatch + validDecisionBatch: valid round-trips; duplicate item id ⇒ null (ambiguity is poison)", () => {
    expect(validDecisionBatch(batch([item("a"), item("b")]))).toMatchObject({ batchId: "b1", owner: "coord" });
    expect(validDecisionBatch(batch([item("a"), item("a")]))).toBeNull(); // duplicate id
    expect(validDecisionBatch({ batchId: "b", owner: "o", createdAtSec: 1, items: [{ id: "x" }] })).toBeNull(); // bad item
    expect(validDecisionBatch({ batchId: "", owner: "o", createdAtSec: 1, items: [] })).toBeNull(); // empty batchId
  });

  test("validDecisionItem: evidenceRef optional; missing required ⇒ null", () => {
    expect(validDecisionItem(item("a", { evidenceRef: "path://x" }))).toMatchObject({ id: "a", evidenceRef: "path://x" });
    expect(validDecisionItem(item("a", { evidenceRef: undefined }))).toMatchObject({ id: "a" });
    expect(validDecisionItem({ id: "a", kind: "pr", summary: "s" })).toBeNull(); // no suggestedAction
    expect(validDecisionItem({ id: "a", kind: "pr", summary: "s", suggestedAction: "", })).toBeNull(); // empty suggestedAction
  });

  test("validDecision / validDecisionsDoc: verdict whitelist; a bad decision rejects the whole doc", () => {
    expect(validDecision({ id: "a", verdict: "approve" })).toEqual({ id: "a", verdict: "approve" });
    expect(validDecision({ id: "a", verdict: "maybe" })).toBeNull();
    expect(validDecisionsDoc(doc([{ id: "a", verdict: "reject", reason: "dup" }]))).toMatchObject({ batchId: "b1" });
    expect(validDecisionsDoc({ batchId: "b1", decidedAtSec: 1, decisions: [{ id: "a", verdict: "nope" }] })).toBeNull();
  });

  test("resolveBatch: matched→resolved, no-decision→undecided, foreign id→unknownIds, duplicate decision first-wins", () => {
    const b = batch([item("a"), item("b"), item("c")]);
    const r = resolveBatch(b, doc([
      { id: "a", verdict: "approve" },
      { id: "b", verdict: "defer" },
      { id: "a", verdict: "reject" }, // duplicate for a — ignored (first wins)
      { id: "zzz", verdict: "approve" }, // not in the batch
    ]));
    expect(r.resolved.map((x) => [x.item.id, x.verdict])).toEqual([["a", "approve"], ["b", "defer"]]);
    expect(r.undecided.map((x) => x.id)).toEqual(["c"]);
    expect(r.unknownIds).toEqual(["zzz"]);
  });

  test("actionable excludes defer (a defer is 'ask again', not an action)", () => {
    const b = batch([item("a"), item("b")]);
    const r = resolveBatch(b, doc([{ id: "a", verdict: "approve" }, { id: "b", verdict: "defer" }]));
    expect(actionable(r.resolved).map((x) => x.item.id)).toEqual(["a"]);
  });

  test("DB-P1-1: resolveBatch rejects a doc bound to another batch (a same-id item never borrows a foreign verdict)", () => {
    const b = batch([item("a"), item("b")]); // batchId "b1"
    const foreign: DecisionsDoc = { batchId: "OTHER", decidedAtSec: 9, decisions: [{ id: "a", verdict: "approve" }, { id: "b", verdict: "reject" }] };
    const r = resolveBatch(b, foreign);
    expect(r.resolved).toEqual([]);                     // nothing resolved against the wrong batch
    expect(r.undecided.map((x) => x.id)).toEqual(["a", "b"]); // all items stay undecided
    expect(r.unknownIds).toEqual(["a", "b"]);            // the foreign ids are reported, acted on by nothing
  });
});
