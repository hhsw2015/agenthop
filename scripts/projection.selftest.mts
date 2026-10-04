// Selftest for the projection reader — pure logic (layering, edges) + a real temp-dir round trip.
// Kept OUT of projection.ts so that module has no top-level side effects (the msglog P1 lesson).
//   tsx scripts/projection.selftest.mts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  artifactGaps, assignLayers, foldWaitLog, parseBoardFileName, planEdges, readBoardView, readKanbanView,
  readProjection, readStatuses, stallVerdict, type BoardItem, type TaskNode, type TaskPlan, type WaitRecord,
} from "./projection.js";

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

// =============================================================================================
// board-viz: the progress-board readers and the two derived signals (gaps, stall)
// =============================================================================================

// --- board filename IS the status (claim protocol = atomic rename) ---
{
  t("plain name -> open", (() => { const p = parseBoardFileName("board-viz.json"); return p?.itemId === "board-viz" && p.status === "open" && p.claimant === null; })());
  t("claimed name carries the claimant", (() => { const p = parseBoardFileName("x.claimed.viz-member-2.json"); return p?.itemId === "x" && p.status === "claimed" && p.claimant === "viz-member-2"; })());
  t("done name carries the finisher", (() => { const p = parseBoardFileName("y.done.90b58f9c.json"); return p?.status === "done" && p.claimant === "90b58f9c"; })());
  t("a claimant with dots survives", parseBoardFileName("z.claimed.a.b.c.json")?.claimant === "a.b.c");
  t("non-json is ignored", parseBoardFileName("notes.md") === null);
  t("unknown middle token stays in the id (conservative: open, not a guessed claim)", (() => { const p = parseBoardFileName("item.weird.json"); return p?.itemId === "item.weird" && p.status === "open"; })());
}

// --- wait fold: last write (by seq) wins; non-wait and malformed changes are skipped ---
{
  const w = (waitId: string, state: string, extra: Partial<WaitRecord> = {}): WaitRecord => ({ waitId, state, ...extra });
  const folded = foldWaitLog([
    { seq: 3, changes: [{ put: "wait", wait: w("a", "resolved") }] },
    { seq: 1, changes: [{ put: "wait", wait: w("a", "open") }, { put: "wait", wait: w("b", "open") }] },
    { seq: 2, changes: [{ put: "other", wait: w("a", "bogus") }, { broken: true }] },
  ]);
  t("fold applies in seq order, last write wins", folded.find((x) => x.waitId === "a")?.state === "resolved");
  t("fold keeps independent waits", folded.find((x) => x.waitId === "b")?.state === "open");
  t("fold skips non-wait and malformed changes", folded.length === 2);
}

// --- artifact gaps (INV-2b-c): done + unresolved related wait = gap; resolved = consumed; none = unknown ---
{
  const item = (itemId: string, status: BoardItem["status"], mtimeMs: number | null = 1000): BoardItem =>
    ({ itemId, status, claimant: null, file: itemId + ".json", mtimeMs, dependsOn: [], conflictsWith: [], fileDomain: [] });
  const waits: WaitRecord[] = [
    { waitId: "coord-alpha-review", state: "open" },
    { waitId: "coord-beta-close", state: "resolved" },
  ];
  const gaps = artifactGaps([item("alpha", "done"), item("beta", "done"), item("gamma", "done"), item("delta", "open")], waits);
  t("done + open related wait -> gap with that wait", gaps.find((g) => g.itemId === "alpha")?.waitId === "coord-alpha-review");
  t("done + resolved related wait -> consumed, no gap", !gaps.some((g) => g.itemId === "beta"));
  t("done + no related wait -> gap with consumer unknown", gaps.find((g) => g.itemId === "gamma")?.waitId === null);
  t("an open item is never a gap", !gaps.some((g) => g.itemId === "delta"));
  t("a done item without mtime cannot measure a gap", artifactGaps([item("x", "done", null)], []).length === 0);
}

// --- 停摆定理: all idle + no unresolved wait + unfinished work = red ---
{
  const openItem: BoardItem = { itemId: "i", status: "open", claimant: null, file: "i.json", mtimeMs: 1, dependsOn: [], conflictsWith: [], fileDomain: [] };
  const openWait: WaitRecord = { waitId: "w", state: "open" };
  t("idle + open item + no wait -> STALLED", stallVerdict(["idle", "idle"], [], [openItem], []).stalled);
  t("an open wait means someone is supervising -> not stalled", !stallVerdict(["idle"], [openWait], [openItem], []).stalled);
  t("action_pending also counts as supervision", !stallVerdict(["idle"], [{ waitId: "w", state: "action_pending" }], [openItem], []).stalled);
  t("anyone working -> not stalled", !stallVerdict(["idle", "working"], [], [openItem], []).stalled);
  t("unknown status is not idle (cannot-see must not scream)", !stallVerdict(["idle", "unknown"], [], [openItem], []).stalled);
  t("no peers seen -> not stalled (observer blindness is not a stall)", !stallVerdict([], [], [openItem], []).stalled);
  t("everything done -> idle is fine", !stallVerdict(["idle"], [], [{ ...openItem, status: "done" }], ["succeeded"]).stalled);
  t("an unfinished job alone triggers it", stallVerdict(["idle"], [], [], ["running"]).stalled);
  t("a failed job is unfinished business", stallVerdict(["idle"], [], [], ["failed"]).stalled);
  t("stalled verdict carries a human reason", stallVerdict(["idle"], [], [openItem], []).reason.length > 0);
}

// --- round trip: a board directory + control-log + PROGRESS.md on disk ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-board-"));
  try {
    const swarm = path.join(home, ".agenthop", "swarm");
    mkdirSync(path.join(swarm, "board"), { recursive: true });
    mkdirSync(path.join(swarm, "control-log"), { recursive: true });
    writeFileSync(path.join(swarm, "board", "task-a.json"), JSON.stringify({ itemId: "task-a", priority: "high", dependsOn: ["rev2 frozen"], conflictsWith: [], fileDomain: ["x"], fitProfile: "anyone" }));
    writeFileSync(path.join(swarm, "board", "task-b.claimed.sess-1.json"), JSON.stringify({ itemId: "task-b" }));
    writeFileSync(path.join(swarm, "board", "task-c.done.sess-2.json"), JSON.stringify({ itemId: "task-c" }));
    writeFileSync(path.join(swarm, "board", "torn.json"), "{ not json"); // unreadable body, filename still speaks
    writeFileSync(path.join(swarm, "control-log", "1.json"), JSON.stringify({ seq: 1, changes: [{ put: "wait", wait: { waitId: "coord-task-c-review", state: "open", owner: "claude:X" } }] }));
    writeFileSync(path.join(swarm, "PROGRESS.md"), "# progress\nhello");

    const v = readBoardView(home);
    t("board items read with filename status", v.items.length === 4 && v.items.find((i) => i.itemId === "task-b")?.status === "claimed");
    t("claimant read from filename", v.items.find((i) => i.itemId === "task-b")?.claimant === "sess-1");
    t("a torn body still yields an item (filename carries the state)", v.items.find((i) => i.itemId === "torn")?.status === "open");
    t("dependsOn passes through", v.items.find((i) => i.itemId === "task-a")?.dependsOn[0] === "rev2 frozen");
    t("waits folded from control-log", v.waits.length === 1 && v.waits[0]!.state === "open");
    t("waits source labelled", v.waitsSource === "control-log");
    t("done item with open related wait -> artifact gap", v.gaps.length === 1 && v.gaps[0]!.itemId === "task-c" && v.gaps[0]!.waitId === "coord-task-c-review");
    t("PROGRESS.md passthrough", v.progress?.text.includes("hello") === true);

    // projection waits/ (schema §8c) takes over WITHOUT a render change — the migration promise.
    const pw = path.join(home, ".agenthop", "swarm", "projection", "waits");
    mkdirSync(pw, { recursive: true });
    writeFileSync(path.join(pw, "coord-task-c-review.json"), JSON.stringify({ waitId: "coord-task-c-review", state: "resolved" }));
    const v2 = readBoardView(home);
    t("projection waits dir wins once populated", v2.waitsSource === "projection" && v2.waits[0]!.state === "resolved");
    t("resolved wait -> the gap closes", v2.gaps.length === 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- empty home: every reader degrades to empty, never throws ---
{
  const v = readBoardView("/tmp/definitely-no-such-home-xyz");
  t("absent swarm dir -> empty board view", v.items.length === 0 && v.waits.length === 0 && v.waitsSource === "none" && v.progress === null && v.gaps.length === 0);
}

// --- kanban-view: three columns + member swimlanes over board/waits/status/heartbeat ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-kanban-"));
  try {
    const swarm = path.join(home, ".agenthop", "swarm");
    const status = path.join(home, ".agenthop", "status");
    mkdirSync(path.join(swarm, "board"), { recursive: true });
    mkdirSync(path.join(swarm, "control-log"), { recursive: true });
    mkdirSync(status, { recursive: true });
    const now = 1_000_000;
    // board: one ready open, one dep-gated open, one claimed (by 90b58f9c), one done.
    writeFileSync(path.join(swarm, "board", "task-ready.json"), JSON.stringify({ itemId: "task-ready", dependsOn: [], postedAtSec: now - 100 }));
    writeFileSync(path.join(swarm, "board", "task-blocked.json"), JSON.stringify({ itemId: "task-blocked", dependsOn: ["task-missing"], postedAtSec: now - 90 }));
    writeFileSync(path.join(swarm, "board", "task-wip.claimed.90b58f9c.json"), JSON.stringify({ itemId: "task-wip" }));
    writeFileSync(path.join(swarm, "board", "task-shipped.done.90b58f9c.json"), JSON.stringify({ itemId: "task-shipped" }));
    // waits: one open (supervises in-progress).
    writeFileSync(path.join(swarm, "control-log", "1.json"), JSON.stringify({ seq: 1, changes: [{ put: "wait", wait: { waitId: "w-review", state: "open", owner: "claude:X", deadlineSec: now + 60 } }] }));
    // status: 90b58f9c working (has the claimed item), 20cab0a5 working (no item), f32a0507 idle.
    writeFileSync(path.join(status, "90b58f9c-5bac-4318-a996-2373c179d674.json." + (now * 1000 + 1)), JSON.stringify({ state: "working", seq: now * 1000 + 1 }));
    writeFileSync(path.join(status, "20cab0a5-b30e-4723-8399-7bc5cf78f6f7.json." + (now * 1000 + 2)), JSON.stringify({ state: "working", seq: now * 1000 + 2 }));
    writeFileSync(path.join(status, "f32a0507-27bd-47d2-adea-9f30b87612ae.json." + (now * 1000 + 3)), JSON.stringify({ state: "idle", seq: now * 1000 + 3 }));
    // heartbeat (L1).
    writeFileSync(path.join(swarm, "heartbeat.json"), JSON.stringify({ instance: "disp-1", pass: { lastTickSec: now - 5, inFlight: null, mode: "lifecycle" }, sweep: { lastTickSec: now - 7, inFlight: null, mode: "sweep" } }));

    // highest-seq status wins (register semantics)
    const st = readStatuses(home);
    t("kanban status: current state per session by highest seq", st.get("90b58f9c-5bac-4318-a996-2373c179d674")?.state === "working" && st.size === 3);

    const k = readKanbanView(home, now);
    t("kanban todo column = open items", k.columns.todo.length === 2 && k.columns.todo.every((c) => c.kind === "item" && c.status === "open"));
    t("kanban dep-gate: unmet dependency marks blocked with a reason", (() => { const b = k.columns.todo.find((c) => c.id === "task-blocked"); return !!b && b.blocked === true && (b.note ?? "").includes("task-missing"); })());
    t("kanban ready item is not blocked", k.columns.todo.find((c) => c.id === "task-ready")?.blocked === false);
    t("kanban in-progress = claimed items + open waits", k.columns.inProgress.some((c) => c.id === "task-wip" && c.kind === "item") && k.columns.inProgress.some((c) => c.id === "w-review" && c.kind === "wait"));
    t("kanban done = done items (+ resolved waits)", k.columns.done.some((c) => c.id === "task-shipped"));
    t("kanban swimlane: the claimant with an in-flight card, live state resolved by prefix", (() => { const l = k.swimlanes.find((s) => s.member === "90b58f9c"); return !!l && l.state === "working" && l.cards.length === 1 && l.cards[0]!.id === "task-wip"; })());
    t("kanban swimlane: a working member with no board item still shows (who's active)", (() => { const l = k.swimlanes.find((s) => s.member === "20cab0a5"); return !!l && l.state === "working" && l.cards.length === 0; })());
    t("kanban swimlane: an idle member with no item is omitted (focus on who's doing what)", !k.swimlanes.some((s) => s.member.startsWith("f32a0507")));
    t("kanban heartbeat: pass/sweep ages derived from lastTick", k.heartbeat?.passAgeSec === 5 && k.heartbeat?.sweepAgeSec === 7);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
{
  const k = readKanbanView("/tmp/definitely-no-such-home-xyz", 1);
  t("kanban: absent sources -> empty columns, no swimlanes, no heartbeat", k.columns.todo.length === 0 && k.columns.inProgress.length === 0 && k.columns.done.length === 0 && k.swimlanes.length === 0 && k.heartbeat === null);
}

console.log("all projection selftests passed");
