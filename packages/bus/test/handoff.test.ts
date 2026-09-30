import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatHandoff, gitSnapshotText } from "../src/handoff.js";

describe("handoff", () => {
  it("formats a checkpoint with task, next, and git sections", () => {
    const text = formatHandoff("claude:Work-abcd1234", { summary: "Refactor the parser", next: "Add tests" }, process.cwd());
    expect(text).toContain("[handoff from claude:Work-abcd1234]");
    expect(text).toContain("## Task");
    expect(text).toContain("Refactor the parser");
    expect(text).toContain("## Next");
    expect(text).toContain("Add tests");
    expect(text).toContain("## Git"); // this test runs inside the repo
  });

  it("bounds an oversized summary and omits git outside a repo", () => {
    const huge = "x".repeat(20_000);
    const text = formatHandoff("a", { summary: huge }, "/no/such/dir/xyz");
    expect(text).not.toContain("## Git");
    expect(text.length).toBeLessThan(13_000); // summary capped to 12k
  });

  it("reads a git snapshot in a repo and none outside one", () => {
    expect(gitSnapshotText(process.cwd())).toMatch(/@ [0-9a-f]+/); // "<branch> @ <shorthash>"
    const dir = mkdtempSync(path.join(tmpdir(), "ah-nogit-"));
    try {
      expect(gitSnapshotText(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a clean vs changed working tree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ah-git-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(path.join(dir, "a.txt"), "hi\n");
      g("add", ".");
      g("commit", "-qm", "init");
      expect(gitSnapshotText(dir)).toContain("working tree: clean");
      writeFileSync(path.join(dir, "a.txt"), "hi\nmore\n");
      const snap = gitSnapshotText(dir)!;
      expect(snap).toContain("working tree: 1 changed");
      expect(snap).toContain("a.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
