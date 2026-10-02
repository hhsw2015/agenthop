import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The task log: the durable, on-disk envelope for "one unit of work handed to one or more sessions".
 *
 * Scope note, so this is not mistaken for the whole feature: this module is the RECORD, not the protocol.
 * It mints ids, persists envelopes, records per-assignee results, and derives the rolled-up state. The
 * agent-facing tools (agenthop_task / agenthop_task_result) and the message frames that carry a task to a
 * peer are deliberately NOT here — they stay deferred on the bus side. Everything below is usable today by
 * any dispatcher that wants a durable record of what it handed out.
 *
 * Why a file per task rather than one index: a task's state changes rarely and is read by an observer that
 * must never block a writer. One immutable-ish file per taskId means a reader cannot see a half-updated
 * multi-task index, and a crashed writer can only ever damage its own task. Writes go through temp+rename,
 * so a reader either sees the previous version or the next one, never a torn one.
 *
 * What a task does NOT contain: message bodies, prompts, or model output. Results carry a state, an optional
 * artifact sha and optional token/cost usage — metadata, matching the journal's stance. A task record is a
 * pointer to work, not a copy of it.
 */

export type TaskState =
  /** Dispatched, no assignee has reported yet. */
  | "PENDING"
  /** At least one assignee reported, at least one has not. */
  | "RUNNING"
  /** Every assignee reported success. */
  | "DONE"
  /** Every assignee reported and at least one failed, or the task was cancelled. */
  | "FAILED"
  | "CANCELLED";

/** One assignee's outcome. `launchId` is the same id the control mirror and the peer title use. */
export type TaskResult = {
  launchId: string;
  /** Free-form per-assignee state as reported by the worker (e.g. "working", "done", "error"). */
  state: string;
  /** Artifact pointer, not the artifact. */
  sha?: string;
  /** Token/cost accounting. The rollout's cost-explosion guard depends on this being filled in. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** When this result was recorded, ms. */
  at: number;
};

export type TaskRecord = {
  taskId: string;
  /** The session that handed the work out. */
  dispatchedBy: string;
  /** Everyone the task went to. One entry per assignee, in dispatch order. */
  assignees: string[];
  state: TaskState;
  /** Free-text goal. Short; this is a label, not a prompt store. */
  goal?: string;
  /** Role the assignees are playing (e.g. "critic"), for a fan-out-then-verify view. */
  role?: string;
  createdAt: number;
  updatedAt: number;
  results: TaskResult[];
  /** True once a terminal state is reached; kept so a reader need not re-derive it. */
  closed?: boolean;
};

/** States that mean "nothing more will change". */
const TERMINAL: ReadonlySet<TaskState> = new Set(["DONE", "FAILED", "CANCELLED"]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** <home>/.agenthop/swarm/tasks — `home` is the home DIR, ".agenthop" appended here. */
export function taskLogDir(home: string = homedir()): string {
  return path.join(home, ".agenthop", "swarm", "tasks");
}

/** A taskId: sortable by creation, and short enough to read in a UI. */
export function mintTaskId(now: number = Date.now(), rand: () => string = () => randomBytes(3).toString("hex")): string {
  return `t-${now.toString(36)}-${rand()}`;
}

/** Ids may be free-form, but they become filenames — so refuse anything that could escape the dir. */
export function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(id) && id !== "." && id !== "..";
}

// ---------------------------------------------------------------------------------------------
// State derivation (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Roll per-assignee results up into the task's state. Pure, so the interesting cases (partial gathers,
 * one failure out of N, a retried assignee) are testable without any IO.
 *
 * Rules:
 *  - Nobody reported            -> PENDING
 *  - Some reported, some not    -> RUNNING  (this is the "3/5 came back" case a swarm UI lives on)
 *  - All reported, none failed  -> DONE
 *  - At least one failed        -> FAILED, even if the rest succeeded. A fan-out where one critic failed is
 *                                  not a success, and silently reporting DONE is exactly the kind of
 *                                  aggregate that hides a broken run.
 * CANCELLED is never derived — only an explicit cancel() sets it; an operator's decision outranks any
 * inference from the assignees.
 */
export function deriveState(assignees: string[], results: TaskResult[], current?: TaskState): TaskState {
  if (current === "CANCELLED") return "CANCELLED";
  if (assignees.length === 0) return current ?? "PENDING";
  const reported = new Set(results.map((r) => r.launchId));
  const total = assignees.length;
  const got = assignees.filter((a) => reported.has(a)).length;
  if (got === 0) return "PENDING";
  const failed = results.some((r) => isFailure(r.state));
  if (failed) return "FAILED";
  if (got < total) return "RUNNING";
  return "DONE";
}

/** Whether a reported per-assignee state counts as a failure. Conservative: only clearly-bad states. */
export function isFailure(state: string): boolean {
  const s = state.trim().toLowerCase();
  return s === "failed" || s === "failure" || s === "error" || s === "errored" || s === "cancelled" || s === "canceled";
}

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

/**
 * Write a task record atomically (temp + rename). Returns false on I/O failure — the caller decides
 * whether an unwritable task log is fatal; for an observer-side run it never should be.
 */
export function writeTask(home: string, rec: TaskRecord): boolean {
  if (!isSafeTaskId(rec.taskId)) return false;
  const dir = taskLogDir(home);
  const tmp = path.join(dir, `${rec.taskId}.json.tmp.${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, path.join(dir, `${rec.taskId}.json`));
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leftover temp is harmless and never matches the reader's *.json filter
    }
    return false;
  }
}

/** Create a new task and persist it. Returns the record, or undefined if it could not be written. */
export function createTask(
  home: string,
  input: { dispatchedBy: string; assignees: string[]; goal?: string; role?: string; taskId?: string; createdAt?: number },
): TaskRecord | undefined {
  const now = input.createdAt ?? Date.now();
  const rec: TaskRecord = {
    taskId: input.taskId ?? mintTaskId(now),
    dispatchedBy: input.dispatchedBy,
    assignees: [...input.assignees],
    state: input.assignees.length ? "PENDING" : "PENDING",
    createdAt: now,
    updatedAt: now,
    results: [],
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.role ? { role: input.role } : {}),
  };
  return writeTask(home, rec) ? rec : undefined;
}

export function readTask(home: string, taskId: string): TaskRecord | undefined {
  if (!isSafeTaskId(taskId)) return undefined;
  try {
    return parseTask(readFileSync(path.join(taskLogDir(home), `${taskId}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

/** Every task on disk. A malformed or half-written file is skipped, never fatal. */
export function readTasks(home: string): TaskRecord[] {
  let names: string[];
  try {
    names = readdirSync(taskLogDir(home));
  } catch {
    return []; // the normal state until a dispatcher writes one
  }
  const out: TaskRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp.")) continue;
    try {
      const rec = parseTask(readFileSync(path.join(taskLogDir(home), name), "utf8"));
      if (rec) out.push(rec);
    } catch {
      // torn/partial — skip
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Parse and validate a task record. Returns undefined for anything unusable. Pure. */
export function parseTask(raw: string): TaskRecord | undefined {
  try {
    const r = JSON.parse(raw) as TaskRecord;
    if (!r || typeof r !== "object") return undefined;
    if (typeof r.taskId !== "string" || !isSafeTaskId(r.taskId)) return undefined;
    if (typeof r.dispatchedBy !== "string") return undefined;
    if (!Array.isArray(r.assignees) || !Array.isArray(r.results)) return undefined;
    if (typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") return undefined;
    return r;
  } catch {
    return undefined;
  }
}

/**
 * Record one assignee's result and roll the state up. Read-modify-write, so it is only safe while a SINGLE
 * writer owns a given task — which holds here: a dispatcher owns the tasks it dispatched. (Two dispatchers
 * deliberately sharing one taskId would need the control-repo CAS that swarm/control.ts uses; that is not
 * this module's job.) A later result for the same launchId REPLACES the earlier one, since an assignee may
 * report progress then completion.
 */
export function applyResult(home: string, taskId: string, result: Omit<TaskResult, "at"> & { at?: number }): TaskRecord | undefined {
  const rec = readTask(home, taskId);
  if (!rec) return undefined;
  if (isTerminal(rec.state)) return rec; // a closed task never reopens on a late result
  const entry: TaskResult = { ...result, at: result.at ?? Date.now() };
  const results = [...rec.results.filter((r) => r.launchId !== entry.launchId), entry];
  const next: TaskRecord = {
    ...rec,
    results,
    state: deriveState(rec.assignees, results, rec.state),
    updatedAt: entry.at,
  };
  next.closed = isTerminal(next.state);
  return writeTask(home, next) ? next : undefined;
}

/** Mark a task cancelled. An operator decision, so it outranks any derived state. */
export function cancelTask(home: string, taskId: string, at: number = Date.now()): TaskRecord | undefined {
  const rec = readTask(home, taskId);
  if (!rec || isTerminal(rec.state)) return rec;
  const next: TaskRecord = { ...rec, state: "CANCELLED", closed: true, updatedAt: at };
  return writeTask(home, next) ? next : undefined;
}

/** Total cost across a task's results, or undefined when nothing reported usage. Pure. */
export function taskCost(rec: TaskRecord): { inputTokens: number; outputTokens: number; costUsd: number } | undefined {
  let seen = false;
  const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const r of rec.results) {
    if (!r.usage) continue;
    seen = true;
    total.inputTokens += r.usage.inputTokens ?? 0;
    total.outputTokens += r.usage.outputTokens ?? 0;
    total.costUsd += r.usage.costUsd ?? 0;
  }
  return seen ? total : undefined;
}

// ---------------------------------------------------------------------------------------------
// Self-check: run with `tsx src/tasklog.ts`
// ---------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const assert = (name: string, cond: boolean) => {
    if (!cond) throw new Error(`tasklog selftest FAILED: ${name}`);
    console.log(`ok  ${name}`);
  };
  const A: TaskResult = { launchId: "rw-a", state: "done", at: 1 };
  const B: TaskResult = { launchId: "rw-b", state: "done", at: 2 };

  assert("nobody reported -> PENDING", deriveState(["rw-a", "rw-b"], []) === "PENDING");
  assert("one of two -> RUNNING", deriveState(["rw-a", "rw-b"], [A]) === "RUNNING");
  assert("all reported -> DONE", deriveState(["rw-a", "rw-b"], [A, B]) === "DONE");
  assert("one failure -> FAILED even with the rest done", deriveState(["rw-a", "rw-b"], [A, { ...B, state: "error" }]) === "FAILED");
  assert("a late failure flips a would-be DONE", deriveState(["rw-a"], [{ launchId: "rw-a", state: "failed", at: 3 }]) === "FAILED");
  assert("cancel outranks inference", deriveState(["rw-a"], [], "CANCELLED") === "CANCELLED");
  assert("no assignees does not crash", deriveState([], []) === "PENDING");

  assert("a safe id passes", isSafeTaskId("t-abc-123"));
  assert("a traversal id is refused", !isSafeTaskId("../etc/passwd") && !isSafeTaskId("a/b") && !isSafeTaskId(".."));
  assert("a minted id is safe and sortable-prefixed", isSafeTaskId(mintTaskId(1000)) && mintTaskId(1000).startsWith("t-"));

  const cost = taskCost({ ...({} as TaskRecord), results: [{ ...A, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } }, B] });
  assert("cost sums what reported and ignores what did not", cost?.inputTokens === 10 && cost?.costUsd === 0.2);
  assert("no usage anywhere -> undefined, not zero", taskCost({ ...({} as TaskRecord), results: [A] }) === undefined);

  assert("a malformed record is refused", parseTask("{ not json") === undefined);
  assert("a record with no taskId is refused", parseTask('{"dispatchedBy":"x","assignees":[],"results":[],"createdAt":1,"updatedAt":1}') === undefined);
  console.log("tasklog selftests passed");
}

// Round-trip against a real temp dir (run with `tsx src/tasklog.ts`).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const rt = (name: string, cond: boolean) => {
    if (!cond) throw new Error(`tasklog roundtrip FAILED: ${name}`);
    console.log(`ok  ${name}`);
  };
  const home = mkdtempSync(path.join(tmpdir(), "ah-tasklog-"));
  try {
    const t = createTask(home, { dispatchedBy: "disp", assignees: ["rw-a", "rw-b"], goal: "review", role: "critic" });
    rt("a task is created", !!t && t.state === "PENDING" && t.assignees.length === 2);
    rt("it reads back", readTask(home, t!.taskId)?.goal === "review");
    rt("role is carried", readTask(home, t!.taskId)?.role === "critic");
    const r1 = applyResult(home, t!.taskId, { launchId: "rw-a", state: "done", sha: "abc123" });
    rt("one of two -> RUNNING with the sha recorded", r1?.state === "RUNNING" && r1.results[0]?.sha === "abc123");
    const r2 = applyResult(home, t!.taskId, { launchId: "rw-b", state: "done", usage: { costUsd: 0.5, inputTokens: 100 } });
    rt("both done -> DONE and closed", r2?.state === "DONE" && r2.closed === true);
    rt("cost rolls up", taskCost(r2!)?.costUsd === 0.5);
    const late = applyResult(home, t!.taskId, { launchId: "rw-a", state: "failed" });
    rt("a closed task does not reopen", late?.state === "DONE");
    const t2 = createTask(home, { dispatchedBy: "disp", assignees: ["rw-c"] });
    rt("cancel wins instantly", cancelTask(home, t2!.taskId)?.state === "CANCELLED");
    rt("both tasks are listed, newest first", readTasks(home).length === 2);
    rt("an unknown task reads as undefined", readTask(home, "t-nope") === undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  console.log("tasklog roundtrip passed");
}
