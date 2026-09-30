import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENTS,
  buildAppleScript,
  buildCommand,
  claimOwnSpawn,
  codexEnvForwardArgs,
  codexTrustArgs,
  diffNewWindowIds,
  forgetSpawn,
  isSpawnedWindow,
  launchId,
  moveArgv,
  readRegistry,
  recordForWindow,
  recordSpawn,
  resolveCli,
  resolveDespawnTarget,
  shquote,
  tomlBasicString,
  writeClaim,
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
  it("sets command, cwd, env list and returns window id + surface UUID (one script, no capture race)", () => {
    const s = buildAppleScript({ command: "/abs/codex --yolo", cwd: "/tmp/proj", env: ["PATH=/x", "AGENTHOP_LAUNCH_ID=abc"] });
    expect(s).toContain('tell application "Ghostty"');
    expect(s).toContain("new surface configuration");
    expect(s).toContain('set command of c to "/abs/codex --yolo"');
    expect(s).toContain('set initial working directory of c to "/tmp/proj"');
    expect(s).toContain('set environment variables of c to {"PATH=/x", "AGENTHOP_LAUNCH_ID=abc"}');
    expect(s).toContain("new window with configuration c");
    // The dispatcher only returns the window id; the surface identity is claimed by the child itself.
    expect(s).toContain("return id of w");
    expect(s).not.toContain("terminals of w");
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

describe("codexEnvForwardArgs", () => {
  it("sets the launch id in the env TABLE LEAF (merges; preserves the user's env_vars/env)", () => {
    // Must target env.<KEY>, NOT the env_vars array — overriding env_vars would drop a user's
    // AGENTHOP_TEAM passthrough (cross-machine team). Verified against codex 0.159.2 that this merges.
    expect(codexEnvForwardArgs("agenthop-spawn:codex:abcd")).toEqual(["-c", 'mcp_servers.agenthop.env.AGENTHOP_LAUNCH_ID="agenthop-spawn:codex:abcd"']);
  });
});

describe("spawn registry (per-launch files; only despawn windows we spawned)", () => {
  it("records, recognizes by window id, forgets by launch id, keeps pending, skips malformed", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-reg-"));
    try {
      // A window we never spawned is not despawnable.
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false);
      recordSpawn({ windowId: "window-abc", surfaceId: null, launchId: "lid1", tool: "codex", cwd: "/x", ts: 1 }, home);
      writeClaim("lid1", "FA9BC882-UUID", home); // the child's separate claim file
      recordSpawn({ windowId: null, surfaceId: null, launchId: "lid2", tool: "claude", cwd: "/y", ts: 2 }, home); // pending, unclaimed
      expect(isSpawnedWindow("window-abc", home)).toBe(true);
      expect(isSpawnedWindow("window-USERS-OWN", home)).toBe(false); // still refused
      const abc = recordForWindow("window-abc", home)!;
      expect(abc.launchId).toBe("lid1");
      expect(abc.surfaceId).toBe("FA9BC882-UUID"); // merged from the claim file
      expect(abc.claimed).toBe(true);
      expect(readRegistry(home).find((r) => r.launchId === "lid2")?.claimed).toBe(false); // pending is unclaimed
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

  it("ignores a claim whose surfaceId is a non-string (would crash despawn's asEsc)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-reg-"));
    try {
      const dir = path.join(home, ".agenthop", "spawned");
      recordSpawn({ windowId: "w1", surfaceId: null, launchId: "good", tool: "codex", cwd: "/x", ts: 1 }, home);
      writeClaim("good", "UUID-GOOD", home);
      recordSpawn({ windowId: "w2", surfaceId: null, launchId: "corrupt", tool: "codex", cwd: "/y", ts: 2 }, home);
      writeFileSync(path.join(dir, "corrupt.claim.json"), JSON.stringify({ launchId: "corrupt", surfaceId: 73, claimed: true }));
      const recs = Object.fromEntries(readRegistry(home).map((r) => [r.launchId, r]));
      expect(recs.good!.surfaceId).toBe("UUID-GOOD");
      expect(recs.good!.claimed).toBe(true);
      expect(recs.corrupt!.surfaceId).toBeNull(); // corrupt claim ignored → stays unclaimed, never crashes despawn
      expect(recs.corrupt!.claimed).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("claimOwnSpawn (child self-registers its authoritative surface UUID)", () => {
  it("writes surfaceId + claimed=true onto its own launch record, merging with the pending record", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-claim-"));
    try {
      const lid = "agenthop-spawn:codex:abcd1234";
      // dispatcher's pending record (window filled, not yet claimed)
      recordSpawn({ windowId: "win-1", surfaceId: null, launchId: lid, tool: "codex", cwd: "/proj", ts: 5 }, home);
      const ok = await claimOwnSpawn({ home, env: { AGENTHOP_LAUNCH_ID: lid } as NodeJS.ProcessEnv, discover: async () => "SURFACE-UUID-1" });
      expect(ok).toBe(true);
      const rec = recordForWindow("win-1", home)!;
      expect(rec.surfaceId).toBe("SURFACE-UUID-1");
      expect(rec.claimed).toBe(true);
      expect(rec.cwd).toBe("/proj"); // merged from the pending record, not clobbered
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op when not a spawned session, or when discovery fails", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-claim-"));
    try {
      expect(await claimOwnSpawn({ home, env: {} as NodeJS.ProcessEnv, discover: async () => "X" })).toBe(false); // no launch id
      expect(await claimOwnSpawn({ home, env: { AGENTHOP_LAUNCH_ID: "agenthop-spawn:codex:z" } as NodeJS.ProcessEnv, discover: async () => undefined })).toBe(false); // discovery failed
      expect(readRegistry(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveDespawnTarget", () => {
  it("prefers the unique launchId, disambiguates a reused window id, rejects unknown", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ah-reg-"));
    try {
      // Two launches whose window id was reused by the OS across them (same windowId, different surface).
      recordSpawn({ windowId: "win-1", surfaceId: null, launchId: "lidA", tool: "codex", cwd: "/x", ts: 1 }, home);
      writeClaim("lidA", "UUID-A", home);
      recordSpawn({ windowId: "win-1", surfaceId: null, launchId: "lidB", tool: "claude", cwd: "/y", ts: 2 }, home);
      writeClaim("lidB", "UUID-B", home);

      const byLaunch = resolveDespawnTarget("lidB", home);
      expect("rec" in byLaunch && byLaunch.rec.surfaceId).toBe("UUID-B"); // unique launchId wins exactly

      const byWindow = resolveDespawnTarget("win-1", home);
      expect("ambiguous" in byWindow && byWindow.ambiguous.length).toBe(2); // reused window id → ambiguous

      expect("error" in resolveDespawnTarget("nope", home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
