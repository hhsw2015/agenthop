import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyResult,
  cancelTask,
  createTask,
  deriveState,
  isFailure,
  isSafeTaskId,
  isTerminal,
  mintTaskId,
  parseTask,
  readTask,
  readTasks,
  taskCost,
  type TaskRecord,
  type TaskResult,
} from "../src/tasklog.js";

// These assertions used to sit in an in-module self-test behind a process.argv guard, which fires on import
// once the file is inlined into a single-file bundle — printing to stdout over the MCP transport. The last
// describe block is the regression guard for exactly that.

const A: TaskResult = { launchId: "rw-a", state: "done", at: 1 };
const B: TaskResult = { launchId: "rw-b", state: "done", at: 2 };
const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "t-x",
  dispatchedBy: "disp",
  assignees: ["rw-a"],
  state: "PENDING",
  createdAt: 1,
  updatedAt: 1,
  results: [],
  ...over,
});

describe("deriveState", () => {
  test("nobody reported -> PENDING", () => expect(deriveState(["rw-a", "rw-b"], [])).toBe("PENDING"));
  test("one of two -> RUNNING", () => expect(deriveState(["rw-a", "rw-b"], [A])).toBe("RUNNING"));
  test("all reported -> DONE", () => expect(deriveState(["rw-a", "rw-b"], [A, B])).toBe("DONE"));
  test("one failure -> FAILED even with the rest done", () =>
    expect(deriveState(["rw-a", "rw-b"], [A, { ...B, state: "error" }])).toBe("FAILED"));
  test("a single assignee failing is FAILED", () =>
    expect(deriveState(["rw-a"], [{ launchId: "rw-a", state: "failed", at: 3 }])).toBe("FAILED"));
  test("an explicit cancel outranks inference", () => expect(deriveState(["rw-a"], [], "CANCELLED")).toBe("CANCELLED"));
  test("no assignees does not crash", () => expect(deriveState([], [])).toBe("PENDING"));
  test("a partial report never reads as DONE", () =>
    expect(deriveState(["a", "b", "c"], [A, B])).not.toBe("DONE"));
});

describe("ids and parsing", () => {
  test("a safe id passes, a traversal does not", () => {
    expect(isSafeTaskId("t-abc-123")).toBe(true);
    expect(isSafeTaskId("../etc/passwd")).toBe(false);
    expect(isSafeTaskId("a/b")).toBe(false);
    expect(isSafeTaskId("..")).toBe(false);
  });

  test("a minted id is safe and prefixed", () => {
    expect(isSafeTaskId(mintTaskId(1000))).toBe(true);
    expect(mintTaskId(1000).startsWith("t-")).toBe(true);
  });

  test("a malformed record is refused", () => {
    expect(parseTask("{ not json")).toBeUndefined();
    expect(parseTask('{"dispatchedBy":"x","assignees":[],"results":[],"createdAt":1,"updatedAt":1}')).toBeUndefined();
    expect(parseTask(JSON.stringify(rec({ taskId: "../evil" })))).toBeUndefined();
  });

  test("terminal states are recognised", () => {
    expect(isTerminal("DONE")).toBe(true);
    expect(isTerminal("RUNNING")).toBe(false);
    expect(isFailure("errored")).toBe(true);
    expect(isFailure("done")).toBe(false);
  });
});

describe("cost", () => {
  test("sums what reported and ignores what did not", () => {
    const c = taskCost(rec({ results: [{ ...A, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } }, B] }));
    expect(c).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.2 });
  });

  test("no usage anywhere -> undefined, not zero", () => {
    expect(taskCost(rec({ results: [A] }))).toBeUndefined();
  });
});

describe("round trip", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "ah-tasklog-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test("create, read, and partial completion", () => {
    const t = createTask(home, { dispatchedBy: "disp", assignees: ["rw-a", "rw-b"], goal: "review", role: "critic" });
    expect(t).toBeDefined();
    expect(t!.state).toBe("PENDING");
    expect(readTask(home, t!.taskId)?.goal).toBe("review");
    expect(readTask(home, t!.taskId)?.role).toBe("critic");

    const r1 = applyResult(home, t!.taskId, { launchId: "rw-a", state: "done", sha: "abc123" });
    expect(r1?.state).toBe("RUNNING");
    expect(r1?.results[0]?.sha).toBe("abc123");

    const r2 = applyResult(home, t!.taskId, { launchId: "rw-b", state: "done", usage: { costUsd: 0.5 } });
    expect(r2?.state).toBe("DONE");
    expect(r2?.closed).toBe(true);
    expect(taskCost(r2!)?.costUsd).toBe(0.5);
  });

  test("a late result never reopens a closed task", () => {
    const t = createTask(home, { dispatchedBy: "disp", assignees: ["rw-a"] })!;
    applyResult(home, t.taskId, { launchId: "rw-a", state: "done" });
    expect(applyResult(home, t.taskId, { launchId: "rw-a", state: "failed" })?.state).toBe("DONE");
  });

  test("a result for the same assignee replaces the earlier one", () => {
    const t = createTask(home, { dispatchedBy: "disp", assignees: ["rw-a"] })!;
    applyResult(home, t.taskId, { launchId: "rw-a", state: "working" });
    const after = applyResult(home, t.taskId, { launchId: "rw-a", state: "done" });
    expect(after?.results).toHaveLength(1);
    expect(after?.state).toBe("DONE");
  });

  test("cancel wins instantly and sticks", () => {
    const t = createTask(home, { dispatchedBy: "disp", assignees: ["rw-a"] })!;
    expect(cancelTask(home, t.taskId)?.state).toBe("CANCELLED");
    expect(applyResult(home, t.taskId, { launchId: "rw-a", state: "done" })?.state).toBe("CANCELLED");
  });

  test("all tasks are listed, newest first", () => {
    createTask(home, { dispatchedBy: "d", assignees: [], createdAt: 1 });
    createTask(home, { dispatchedBy: "d", assignees: [], createdAt: 2 });
    const all = readTasks(home);
    expect(all).toHaveLength(2);
    expect(all[0]!.createdAt).toBeGreaterThan(all[1]!.createdAt);
  });

  test("an unknown task reads as undefined", () => {
    expect(readTask(home, "t-nope")).toBeUndefined();
  });
});

describe("bundled-import safety", () => {
  // The bug this guards: the in-module self-test ran on import once the file was inlined into a bundle,
  // printing to stdout over the MCP JSON-RPC transport. Import it in a real child process and assert silence.
  test("importing the module writes nothing to stdout", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const tsx = path.join(dir, "..", "node_modules", ".bin", "tsx");
    const mod = path.join(dir, "..", "src", "tasklog.ts");
    const out = execFileSync(tsx, ["-e", `import { mintTaskId } from "${mod}"; void mintTaskId(1);`], { encoding: "utf8" });
    expect(out).toBe("");
  });
});
