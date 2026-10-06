import { describe, expect, test } from "vitest";
import {
  boardItemsToPost, postedFileName, claimedFileName, grantedFileName, rejectedFileName, doneFileName,
  parseBoardItemName, isValidItemId, boardAdmitEnabled, type BoardItem,
} from "../src/swarm/task-board.js";
import type { TaskPlan } from "../src/swarm/task-plan.js";
import type { ReadyTask } from "../src/swarm/task-ready.js";

// Minimal cast fixtures — boardItemsToPost reads only a few fields per node.
const node = (nodeId: string, over: Record<string, unknown> = {}): unknown => ({
  nodeId, kind: "work", goal: `do ${nodeId}`, dependsOn: [], outputContract: { requiredOutputs: [] }, acceptance: [],
  artifactScope: [`src/${nodeId}`], estimatedRuntimeSec: 60, retryBudget: 1, specDigest: `sd-${nodeId}`, ...over,
});
const plan = (nodes: unknown[], over: Record<string, unknown> = {}): TaskPlan =>
  ({ jobId: "J", planRevision: 3, nodes, jobBudget: {}, planDigest: "pd", ...over } as unknown as TaskPlan);
const ready = (nodeId: string): ReadyTask => ({ nodeId, proposedBindings: [], inputBindingDigest: `ibd-${nodeId}` });

describe("task-board boardItemsToPost (§2d-a curate: ready nodes → board items)", () => {
  test("maps each ready node to a board item carrying spec summary / fit-domain / identity", () => {
    const p = plan([
      node("a", { goal: "build A", dependsOn: ["x"], artifactScope: ["src/a"], sourceWriteScope: ["src/a", "docs"], roleProfile: "builder", modelTier: "heavy" }),
      node("b"),
    ]);
    const items = boardItemsToPost([ready("a"), ready("b")], p, { postedBy: "coord", nowSec: 1000 });
    expect(items.map((i) => i.itemId)).toEqual(["a", "b"]);
    const a = items[0]!;
    expect(a).toMatchObject({
      itemId: "a", jobId: "J", nodeId: "a", planRevision: 3, specDigest: "sd-a", inputBindingDigest: "ibd-a",
      goal: "build A", kind: "work", dependsOn: ["x"], fitProfile: "builder", modelTier: "heavy", postedBy: "coord", postedAtSec: 1000,
    });
    expect(a.fileDomain.sort()).toEqual(["docs", "src/a"]); // artifactScope ∪ sourceWriteScope, deduped
    expect(items[1]!.fitProfile).toBeUndefined(); // no roleProfile ⇒ omitted
    expect(items[1]!.priority).toBeUndefined();   // no TaskSpec source ⇒ absent
  });

  test("a ready node absent from the plan is skipped (guard)", () => {
    expect(boardItemsToPost([ready("ghost")], plan([node("a")]), { postedBy: "c", nowSec: 1 })).toEqual([]);
  });
});

describe("task-board file-name convention + parser (one canonical form, incl. granted/rejected)", () => {
  test("round-trips every state", () => {
    expect(parseBoardItemName(postedFileName("a"))).toEqual({ itemId: "a", state: "posted", who: "" });
    expect(parseBoardItemName(claimedFileName("a", "w1"))).toEqual({ itemId: "a", state: "claimed", who: "w1" });
    expect(parseBoardItemName(grantedFileName("a", "w1"))).toEqual({ itemId: "a", state: "granted", who: "w1" });
    expect(parseBoardItemName(rejectedFileName("a", "w1"))).toEqual({ itemId: "a", state: "rejected", who: "w1" });
    expect(parseBoardItemName(doneFileName("a", "w1"))).toEqual({ itemId: "a", state: "done", who: "w1" });
  });
  test("rejects unknown / malformed shapes rather than mis-splitting", () => {
    expect(parseBoardItemName("a.weird.w1.json")).toBeNull();   // unknown state token
    expect(parseBoardItemName("a.claimed.json")).toBeNull();    // missing who
    expect(parseBoardItemName("a.b.c.d.json")).toBeNull();      // too many segments
    expect(parseBoardItemName("a.txt")).toBeNull();             // not .json
    expect(parseBoardItemName(".json")).toBeNull();             // empty itemId
  });
  test("isValidItemId rejects ids that would break the convention", () => {
    expect(isValidItemId("build-a")).toBe(true);
    expect(isValidItemId("a.b")).toBe(false);  // dot collides with the separator
    expect(isValidItemId("a/b")).toBe(false);
    expect(isValidItemId("a b")).toBe(false);
    expect(isValidItemId("")).toBe(false);
  });
});

describe("task-board dormancy gate (coordinator boundary #1: default OFF)", () => {
  test("SWARM_BOARD_ADMIT default-off; only explicit truthy enables", () => {
    expect(boardAdmitEnabled({})).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "" })).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "0" })).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "off" })).toBe(false);
    for (const v of ["1", "true", "yes", "on", "ON", "True"]) expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: v })).toBe(true);
  });
});
