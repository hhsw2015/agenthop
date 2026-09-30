import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENTS,
  buildAppleScript,
  buildCommand,
  codexTrustArgs,
  diffNewWindowIds,
  forgetSpawn,
  isLaunchAlive,
  isSpawnedWindow,
  launchId,
  moveArgv,
  readRegistry,
  recordForWindow,
  recordSpawn,
  resolveCli,
  shquote,
  tomlBasicString,
} from "../src/spawn.js";

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

  it("rejects an inherited-prototype key (own-key check, not `in`)", () => {
    // `"constructor" in AGENTS` is true; an `in` check would wrongly accept it then blow up on spread.
    expect("error" in resolveCli("constructor", env({}))).toBe(true);
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

describe("buildCommand", () => {
  it("shell-quotes each argv element so a space in a path stays one word", () => {
    // Ghostty runs the surface command via a shell, so a bare join would split "/my agent/codex".
    expect(buildCommand(["/opt/my agent/codex", "--flag", "a b"], [])).toBe("/usr/bin/env '/opt/my agent/codex' '--flag' 'a b'");
  });

  it("strips inherited identity env with `env -u`", () => {
    expect(buildCommand(["/bin/x"], ["CLAUDE_CODE_SESSION_ID", "AGENTHOP_TITLE"])).toBe("/usr/bin/env -u CLAUDE_CODE_SESSION_ID -u AGENTHOP_TITLE '/bin/x'");
  });

  it("neutralizes a single-quote metacharacter in an argument", () => {
    expect(shquote("a'b")).toBe("'a'\\''b'");
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

describe("codexTrustArgs", () => {
  it("pre-trusts via a per-invocation inline-table -c override (no global config write)", () => {
    // Must be an inline table: codex's -c key parser splits on `.` and ignores quotes, so a quoted
    // dotted key (projects."x".trust_level) misparses and does NOT trust.
    expect(codexTrustArgs("/a/b")).toEqual(["-c", 'projects={"/a/b"={trust_level="trusted"}}']);
  });

  it("TOML-escapes a nasty path (quotes, backslash, control chars) so it cannot break the override", () => {
    expect(tomlBasicString('/a"b\\c\n')).toBe('/a\\"b\\\\c\\n');
    expect(tomlBasicString("\u0001")).toBe("\\u0001");
    expect(codexTrustArgs('/a"b')).toEqual(["-c", 'projects={"/a\\"b"={trust_level="trusted"}}']);
  });
});

describe("isLaunchAlive", () => {
  const peers = [
    { via: "local", launchId: "L1", pid: 111 },
    { via: "relay", launchId: "L3", pid: 333 },
  ];
  it("true only for a LOCAL peer whose pid is alive now (bypasses roster drop-lag)", () => {
    expect(isLaunchAlive(peers, "L1", (pid) => pid === 111)).toBe(true);
    // Still listed in the roster but its process already exited (the ~25ms lag) ⇒ not alive ⇒ no close.
    expect(isLaunchAlive(peers, "L1", () => false)).toBe(false);
    expect(isLaunchAlive(peers, "unknown", () => true)).toBe(false);
    // A relay peer is on another machine we cannot despawn — never counts, even if "alive".
    expect(isLaunchAlive(peers, "L3", () => true)).toBe(false);
  });
});

describe("spawn registry (per-launch files; only despawn windows we spawned)", () => {
  it("records, recognizes by window id, forgets by launch id, keeps pending, skips malformed", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-reg-"));
    try {
      // A window we never spawned is not despawnable.
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false);
      recordSpawn({ windowId: "window-abc", launchId: "lid1", tool: "codex", cwd: "/x", ts: 1 }, home);
      recordSpawn({ windowId: null, launchId: "lid2", tool: "claude", cwd: "/y", ts: 2 }, home); // pending (no id yet)
      expect(isSpawnedWindow("window-abc", home)).toBe(true);
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false); // still refused
      expect(recordForWindow("window-abc", home)?.launchId).toBe("lid1");
      expect(readRegistry(home).map((r) => r.launchId).sort()).toEqual(["lid1", "lid2"]);

      // A junk file in the registry dir is ignored, never throws.
      writeFileSync(path.join(home, ".agenthop", "spawned", "junk.json"), "not json{");
      writeFileSync(path.join(home, ".agenthop", "spawned", "nullrec.json"), "null");
      expect(readRegistry(home).map((r) => r.launchId).sort()).toEqual(["lid1", "lid2"]);

      forgetSpawn("lid1", home);
      expect(isSpawnedWindow("window-abc", home)).toBe(false);
      expect(readRegistry(home).map((r) => r.launchId)).toEqual(["lid2"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
