import { describe, expect, test } from "vitest";
import { mergeProduceEvents, submitDigest } from "../src/swarm/dual-bandwidth.js";
import { validInboxMsg } from "../src/inbox.js";
import { validRoomPost } from "../src/swarm/chat-room.js";
import { validDecisionItem } from "../src/swarm/decision-batch.js";
import { isSubmitIntent } from "../src/submit-intent.js";

describe("submit-tag — submitDigest (content-addressed de-dup key)", () => {
  test("deterministic + content-addressed; time-independent; distinct content ⇒ distinct", () => {
    expect(submitDigest("alice", "ship it")).toBe(submitDigest("alice", "ship it")); // same (from,text) ⇒ same key
    expect(submitDigest("alice", "ship it")).not.toBe(submitDigest("bob", "ship it")); // author matters
    expect(submitDigest("alice", "ship it")).not.toBe(submitDigest("alice", "hold")); // text matters
    expect(typeof submitDigest("a", "b")).toBe("string");
  });
});

describe("submit-tag — mergeProduceEvents (B_prod=N, de-dup by digest, earliest ts)", () => {
  test("empty ⇒ no events", () => {
    expect(mergeProduceEvents({ batchItems: [], submits: [] })).toEqual([]);
  });
  test("native items only (no submits, no fold) ⇒ one produce per item (v0 count preserved)", () => {
    const r = mergeProduceEvents({ batchItems: [{ digest: "x1", createdAtSec: 100, foldedFrom: [] }, { digest: "x2", createdAtSec: 100, foldedFrom: [] }], submits: [] });
    expect(r.sort()).toEqual([100, 100]);
  });
  test("a submit folded into a batch item is counted ONCE, at the earliest (submit) time", () => {
    const d = submitDigest("a", "t");
    const r = mergeProduceEvents({ batchItems: [{ digest: "item", createdAtSec: 200, foldedFrom: [d] }], submits: [{ digest: d, atSec: 100 }] });
    expect(r).toEqual([100]); // not [100, 200] — the fold adds no new produce
  });
  test("an un-observed folded submit still counts ONCE, at the item's createdAtSec", () => {
    const d = submitDigest("a", "t");
    const r = mergeProduceEvents({ batchItems: [{ digest: "item", createdAtSec: 200, foldedFrom: [d] }], submits: [] }); // submit scrolled out of the log
    expect(r).toEqual([200]);
  });
  test("N submits folded into ONE item ⇒ N produce events (B_prod=N, compression does NOT shrink demand)", () => {
    const ds = ["a", "b", "c"].map((t) => submitDigest("auth", t));
    const r = mergeProduceEvents({ batchItems: [{ digest: "item", createdAtSec: 500, foldedFrom: ds }], submits: ds.map((d, i) => ({ digest: d, atSec: 100 + i })) });
    expect(r.sort((x, y) => x - y)).toEqual([100, 101, 102]); // three units of demand, each once
  });
  test("mixed: a native item + a folded item + a standalone submit = three distinct produce", () => {
    const folded = submitDigest("a", "folded");
    const standalone = submitDigest("a", "standalone");
    const r = mergeProduceEvents({
      batchItems: [{ digest: "native", createdAtSec: 300, foldedFrom: [] }, { digest: "itemF", createdAtSec: 400, foldedFrom: [folded] }],
      submits: [{ digest: folded, atSec: 200 }, { digest: standalone, atSec: 250 }],
    });
    expect(r.sort((x, y) => x - y)).toEqual([200, 250, 300]); // folded@200, standalone@250, native@300
  });
  test("earliest timestamp wins when a digest is seen more than once", () => {
    const d = submitDigest("a", "t");
    const r = mergeProduceEvents({ batchItems: [{ digest: "item", createdAtSec: 50, foldedFrom: [d] }], submits: [{ digest: d, atSec: 100 }] });
    expect(r).toEqual([50]); // min(50, 100)
  });
});

describe("submit-tag — intent validation on the envelope/post (known value or reject; absent ok)", () => {
  const baseMsg = { from: "a", fromLabel: "a", text: "t", via: "durable-inbox", ts: 1 };
  test("InboxMsg.intent: submit/report/fyi accepted + preserved; absent ok; unknown rejected", () => {
    for (const intent of ["submit", "report", "fyi"] as const) expect(validInboxMsg({ ...baseMsg, intent })?.intent).toBe(intent);
    expect(validInboxMsg(baseMsg)).not.toBeNull(); // absent ⇒ ok
    expect(validInboxMsg(baseMsg)!.intent).toBeUndefined();
    expect(validInboxMsg({ ...baseMsg, intent: "bogus" })).toBeNull(); // unknown ⇒ whole message rejected
    expect(validInboxMsg({ ...baseMsg, intent: 1 })).toBeNull();
  });
  const basePost = { seq: 1, from: "a", fromLabel: "a", text: "t", ts: 1 };
  test("RoomPost.intent: same discipline", () => {
    for (const intent of ["submit", "report", "fyi"] as const) expect(validRoomPost({ ...basePost, intent })?.intent).toBe(intent);
    expect(validRoomPost(basePost)!.intent).toBeUndefined();
    expect(validRoomPost({ ...basePost, intent: "bogus" })).toBeNull();
  });
  test("isSubmitIntent guard", () => {
    expect(isSubmitIntent("submit")).toBe(true);
    for (const bad of ["", "SUBMIT", "approve", 0, null, undefined]) expect(isSubmitIntent(bad)).toBe(false);
  });
});

describe("submit-tag — foldedFrom validation on a decision item", () => {
  const base = { id: "i0", kind: "pr", summary: "s", suggestedAction: "merge" };
  test("string[] accepted + preserved; absent ok; non-array / non-string-element rejected", () => {
    expect(validDecisionItem({ ...base, foldedFrom: ["d1", "d2"] })?.foldedFrom).toEqual(["d1", "d2"]);
    expect(validDecisionItem(base)!.foldedFrom).toBeUndefined();
    expect(validDecisionItem({ ...base, foldedFrom: [] })!.foldedFrom).toEqual([]); // empty array keeps its semantics
    expect(validDecisionItem({ ...base, foldedFrom: "d1" })).toBeNull(); // not an array
    expect(validDecisionItem({ ...base, foldedFrom: ["d1", 2] })).toBeNull(); // non-string element
    expect(validDecisionItem({ ...base, foldedFrom: ["d1", ""] })).toBeNull(); // empty-string element
  });
  test("ST-P2-2: a sparse hole / null / non-string array is whole-rejected (never written as [null]); result is a clean copy", () => {
    expect(validDecisionItem({ ...base, foldedFrom: new Array(1) })).toBeNull(); // sparse hole — .every would skip it
    expect(validDecisionItem({ ...base, foldedFrom: [null] })).toBeNull();
    expect(validDecisionItem({ ...base, foldedFrom: [42] })).toBeNull();
    const inp = ["d1", "d2"]; const out = validDecisionItem({ ...base, foldedFrom: inp })!;
    expect(out.foldedFrom).toEqual(inp);
    expect(out.foldedFrom).not.toBe(inp); // a clean copy, never the aliased input array
  });
});
