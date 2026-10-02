// Generate a task-river fixture THROUGH the real writer, so the render path is exercised against data
// that came out of createTask/applyResult rather than hand-written JSON. Hand-written JSON only proves the
// reader; this proves the writer, which is what the dispatcher will actually call.
//
//   tsx scripts/swarm-viz-fixture.ts            # write fixtures into ~/.agenthop/swarm/tasks/
//   tsx scripts/swarm-viz-fixture.ts --clean    # remove only the fixtures it created
//   tsx scripts/swarm-viz-fixture.ts --home /tmp/x
//
// Fixtures are namespaced with a `fixture-` id prefix so --clean can never touch a real task.
import { resolveHome } from "./swarm-viz-export.js";
import { applyResult, cancelTask, createTask, readTasks, type TaskRecord } from "../packages/bus/src/tasklog.js";
import { rmSync } from "node:fs";
import path from "node:path";

const PREFIX = "fixture-";

export type FixturePlan = {
  id: string;
  dispatchedBy: string;
  assignees: string[];
  goal: string;
  /** Results applied in order; state rolls up through the real state machine. */
  results: Array<{ launchId: string; state: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }>;
  /** Cancelled instead of completed. */
  cancel?: boolean;
  /** Ages for createdAt/last result, ms before now, so the river has a spread. */
  createdAtOffsetMs: number;
};

/** The scenarios worth drawing: a clean fan-out, a partial gather, a failure, a cancel, a stuck one. */
export function plans(now = Date.now()): FixturePlan[] {
  const min = 60_000;
  return [
    {
      id: PREFIX + "fanout-done",
      dispatchedBy: "disp",
      assignees: ["rw-a1", "rw-a2", "rw-a3"],
      goal: "review the handoff",
      results: [
        { launchId: "rw-a1", state: "done", usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.04 } },
        { launchId: "rw-a2", state: "done", usage: { inputTokens: 900, outputTokens: 210, costUsd: 0.03 } },
        { launchId: "rw-a3", state: "done", usage: { inputTokens: 1100, outputTokens: 260, costUsd: 0.035 } },
      ],
      createdAtOffsetMs: 8 * min,
    },
    {
      id: PREFIX + "partial",
      dispatchedBy: "disp",
      assignees: ["rw-b1", "rw-b2", "rw-b3", "rw-b4"],
      goal: "three of four critics reported",
      results: [
        { launchId: "rw-b1", state: "done" },
        { launchId: "rw-b2", state: "done" },
        { launchId: "rw-b3", state: "working" },
      ],
      createdAtOffsetMs: 5 * min,
    },
    {
      id: PREFIX + "one-failed",
      dispatchedBy: "disp",
      assignees: ["rw-c1", "rw-c2"],
      goal: "one critic errored",
      results: [
        { launchId: "rw-c1", state: "done" },
        { launchId: "rw-c2", state: "error" },
      ],
      createdAtOffsetMs: 3 * min,
    },
    {
      id: PREFIX + "cancelled",
      dispatchedBy: "disp",
      assignees: ["rw-d1"],
      goal: "operator pulled the plug",
      results: [],
      cancel: true,
      createdAtOffsetMs: 2 * min,
    },
    {
      id: PREFIX + "still-running",
      dispatchedBy: "disp",
      assignees: ["rw-e1"],
      goal: "no result yet",
      results: [],
      createdAtOffsetMs: 20_000,
    },
  ];
}

/** Build each fixture through the writer. Returns the created records (as the writer produced them). */
export function generate(home: string, now = Date.now()): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const p of plans(now)) {
    const created = createTask(home, {
      dispatchedBy: p.dispatchedBy,
      assignees: p.assignees,
      goal: p.goal,
      taskId: p.id,
      createdAt: now - p.createdAtOffsetMs,
    });
    if (!created) continue;
    let at = created.createdAt + 5_000;
    for (const r of p.results) {
      const next = applyResult(home, p.id, { launchId: r.launchId, state: r.state, usage: r.usage, at });
      if (!next) break;
      at += 20_000;
    }
    if (p.cancel) cancelTask(home, p.id, at);
    const final = readTasks(home).find((t) => t.taskId === p.id);
    if (final) out.push(final);
  }
  return out;
}

/** Remove only the fixtures this script creates. Never touches a task without the prefix. */
export function clean(home: string): string[] {
  const removed: string[] = [];
  for (const t of readTasks(home)) {
    if (!t.taskId.startsWith(PREFIX)) continue;
    try {
      rmSync(path.join(home, ".agenthop", "swarm", "tasks", `${t.taskId}.json`), { force: true });
      removed.push(t.taskId);
    } catch {
      // leave it; --clean is best-effort
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--home");
  const home = at >= 0 ? args[at + 1]! : resolveHome();
  if (args.includes("--clean")) {
    const removed = clean(home);
    console.log(removed.length ? `removed: ${removed.join(", ")}` : "nothing to remove");
    return;
  }
  const made = generate(home);
  console.log(`wrote ${made.length} fixture task(s) to ${path.join(home, ".agenthop", "swarm", "tasks")}`);
  for (const t of made) {
    const done = t.results.filter((r) => r.state === "done").length;
    console.log(`  ${t.taskId.padEnd(28)} ${t.state.padEnd(10)} ${done}/${t.assignees.length} done`);
  }
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invoked) main();
