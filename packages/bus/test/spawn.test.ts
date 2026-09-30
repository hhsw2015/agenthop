import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENTS, buildAppleScript, codexTrustNeeded, diffNewWindowIds, forgetSpawn, isSpawnedWindow, launchId, moveArgv, readRegistry, recordSpawn, resolveCli } from "../src/spawn.js";

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ PATH: "", ...over }) as NodeJS.ProcessEnv;

describe("resolveCli", () => {
  it("gives a known tool its default no-confirmation flags", () => {
    const r = resolveCli("codex", env({}));
    expect("argv" in r).toBe(true);
    if ("argv" in r) expect(r.argv.slice(1)).toEqual(AGENTS.codex);
  });

  it("rejects an unknown tool unless raw commands are allowed", () => {
    expect("error" in resolveCli("rm-rf", env({}))).toBe(true);
    expect("argv" in resolveCli("rm-rf", env({ AGENTHOP_SPAWN_ALLOW_CMD: "1" }))).toBe(true);
  });

  it("honors per-tool bin and args overrides", () => {
    const r = resolveCli("claude", env({ AGENTHOP_SPAWN_BIN_CLAUDE: "/opt/claude", AGENTHOP_SPAWN_ARGS_CLAUDE: "--foo bar" }));
    expect("argv" in r && r.argv).toEqual(["/opt/claude", "--foo", "bar"]);
  });
});

describe("launchId", () => {
  it("is tool-tagged and unique", () => {
    const a = launchId("codex");
    expect(a.startsWith("agenthop-spawn:codex:")).toBe(true);
    expect(a).not.toBe(launchId("codex"));
  });
});

describe("buildAppleScript", () => {
  it("sets command, cwd, env list and returns the window id", () => {
    const s = buildAppleScript({ command: "/abs/codex --yolo", cwd: "/tmp/proj", env: ["PATH=/x", "AGENTHOP_LAUNCH_ID=abc"] });
    expect(s).toContain('tell application "Ghostty"');
    expect(s).toContain("new surface configuration");
    expect(s).toContain('set command of c to "/abs/codex --yolo"');
    expect(s).toContain('set initial working directory of c to "/tmp/proj"');
    expect(s).toContain('set environment variables of c to {"PATH=/x", "AGENTHOP_LAUNCH_ID=abc"}');
    expect(s).toContain("new window with configuration c");
    expect(s).toContain("return id of w");
  });

  it("escapes quotes/backslashes so a crafted cwd cannot break out of the string", () => {
    const s = buildAppleScript({ command: "/abs/x", cwd: '/tmp/a"b\\c', env: [] });
    expect(s).toContain('set initial working directory of c to "/tmp/a\\"b\\\\c"');
  });
});

describe("diffNewWindowIds", () => {
  const shell = (ids: string[]) => JSON.stringify({ result: { payload: { windows: ids.map((id) => ({ id })) } } });
  it("returns ids present after but not before", () => {
    expect(diffNewWindowIds(["ow_a"], shell(["ow_a", "ow_b"]))).toEqual(["ow_b"]);
    expect(diffNewWindowIds(["ow_a", "ow_b"], shell(["ow_a", "ow_b"]))).toEqual([]);
    expect(diffNewWindowIds([], "not json")).toEqual([]);
  });
});

describe("moveArgv", () => {
  it("uses `window move-to-workspace <id> <ws>` order", () => {
    expect(moveArgv("ow_abc", "🚀")).toEqual(["window", "move-to-workspace", "ow_abc", "🚀"]);
  });
});

describe("codexTrustNeeded", () => {
  it("is false when a trust entry for the path already exists", () => {
    const cfg = '[projects."/a/b"]\ntrust_level = "trusted"\n';
    expect(codexTrustNeeded(cfg, "/a/b")).toBe(false);
    expect(codexTrustNeeded(cfg, "/a/c")).toBe(true);
    expect(codexTrustNeeded("", "/a/b")).toBe(true);
  });
});

describe("spawn registry (only despawn windows we spawned)", () => {
  it("records, recognizes, and forgets spawned windows; refuses unknown ids", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-reg-"));
    try {
      // A window we never spawned is not despawnable.
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false);
      recordSpawn({ windowId: "window-abc", launchId: "lid1", tool: "codex", cwd: "/x", ts: 1 }, home);
      expect(isSpawnedWindow("window-abc", home)).toBe(true);
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false); // still refused
      expect(readRegistry(home).map((r) => r.windowId)).toEqual(["window-abc"]);
      forgetSpawn("window-abc", home);
      expect(isSpawnedWindow("window-abc", home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
