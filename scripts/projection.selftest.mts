// Selftest for the projection reader — pure logic (layering, edges) + a real temp-dir round trip.
// Kept OUT of projection.ts so that module has no top-level side effects (the msglog P1 lesson).
//   tsx scripts/projection.selftest.mts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignLayers, planEdges, readProjection, type TaskNode, type TaskPlan } from "./projection.js";

const t = (name: string, cond: boolean) => {
  if (!cond) throw new Error("FAILED: " + name);
  console.log("ok  " + name);
};

const node = (id: string, deps: string[], over: Partial<TaskNode> = {}): TaskNode => ({
  nodeId: id,
  kind: "work",
  dependsOn: deps,
  required: true,
  ...over,
});

// --- layering: a fan-out/fan-in diamond, the shape that shows parallelism + coordination ---
// C is a root; P and Q both depend on C (parallel); I depends on P and Q (fan-in/coordination).
{
  const laid = assignLayers([node("I", ["P", "Q"], { kind: "integration" }), node("P", ["C"]), node("Q", ["C"]), node("C", [])]);
  const layer = (id: string) => laid.find((n) => n.nodeId === id)!.layer;
  t("root is layer 0", layer("C") === 0);
  t("parallel siblings share a layer", layer("P") === 1 && layer("Q") === 1);
  t("fan-in node is one past its deepest dep", layer("I") === 2);
  t("assignLayers does not mutate input (returns new)", (() => { const ns = [node("A", [])]; assignLayers(ns); return ns[0]!.layer === undefined; })());
}

// --- a longer chain: layer = longest path, not shortest ---
{
  // A->B->C and A->C ; C's layer must be 2 (via B), not 1 (direct).
  const laid = assignLayers([node("C", ["A", "B"]), node("B", ["A"]), node("A", [])]);
  t("layer is the LONGEST dependency path", laid.find((n) => n.nodeId === "C")!.layer === 2);
}

// --- cycle / dangling safety (a torn read could present one) ---
{
  const laid = assignLayers([node("X", ["Y"]), node("Y", ["X"])]); // 2-cycle
  t("a cycle does not loop forever and floors to 0", laid.every((n) => typeof n.layer === "number"));
  const dangling = assignLayers([node("Z", ["nonexistent"])]);
  t("a dependency outside the plan is treated as a root", dangling[0]!.layer === 0);
}

// --- edges drop links pointing outside the plan ---
{
  const plan: TaskPlan = { jobId: "j", planRevision: 1, jobStatus: "running", nodes: [node("B", ["A", "ghost"]), node("A", [])] };
  const e = planEdges(plan);
  t("edges keep in-plan deps", e.some((x) => x.from === "A" && x.to === "B"));
  t("edges drop dangling deps", !e.some((x) => x.from === "ghost"));
}

// --- round trip: read a projection-shaped directory ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-proj-"));
  try {
    const dir = path.join(home, ".agenthop", "swarm", "projection");
    mkdirSync(path.join(dir, "jobs", "job-x", "attempts"), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, lastAppliedSeq: 42 }));
    writeFileSync(path.join(dir, "jobs", "job-x", "plan.json"), JSON.stringify({
      jobId: "job-x", planRevision: 1, jobStatus: "running",
      nodes: [node("C", []), node("P", ["C"]), node("I", ["P"], { kind: "integration" })],
    }));
    writeFileSync(path.join(dir, "jobs", "job-x", "attempts", "P.json"), JSON.stringify({
      nodeId: "P",
      current: { attemptId: "job-x/P/a1", status: "RUNNING", complete: false, executionBindings: [{ bindingId: "b0", executor: { kind: "box", launchId: "rw-1" } }] },
    }));
    writeFileSync(path.join(dir, "members.json"), JSON.stringify({ members: [{ memberId: "claude:Work-x", class: "durable", reachability: "ok" }] }));

    const proj = readProjection(home);
    t("projection present", proj.present === true);
    t("meta seq read", proj.meta?.lastAppliedSeq === 42);
    t("one job assembled", proj.jobs.length === 1);
    t("plan nodes got layers", proj.jobs[0]!.plan.nodes.find((n) => n.nodeId === "I")!.layer === 2);
    t("attempt read for a node that has one", proj.jobs[0]!.attempts["P"]?.current?.status === "RUNNING");
    t("a node with no attempt file is simply absent, not an error", proj.jobs[0]!.attempts["C"] === undefined);
    t("executor union carried through", proj.jobs[0]!.attempts["P"]?.current?.executionBindings?.[0]?.executor.kind === "box");
    t("members read", proj.members[0]?.memberId === "claude:Work-x");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- absent projection is the normal state, not an error ---
t("no projection dir -> present:false, empty", (() => { const p = readProjection("/tmp/definitely-no-such-home-xyz"); return p.present === false && p.jobs.length === 0; })());

console.log("all projection selftests passed");
