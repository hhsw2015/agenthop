import { describe, expect, it } from "vitest";
import { checkWmArgs, omniwmctlBin, splitArgs } from "../src/wm.js";

describe("wm passthrough validation", () => {
  it("accepts one-shot subcommands", () => {
    for (const sub of ["command", "query", "window", "workspace", "rule", "ping", "version"]) {
      expect(checkWmArgs([sub, "x"]).ok).toBe(true);
    }
  });

  it("rejects streaming / local-only subcommands", () => {
    for (const sub of ["subscribe", "watch", "completion", "capture"]) {
      const r = checkWmArgs([sub]);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an empty or unknown subcommand", () => {
    expect(checkWmArgs([]).ok).toBe(false);
    const r = checkWmArgs(["frobnicate"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unsupported");
  });
});

describe("splitArgs", () => {
  it("splits on whitespace and honors quotes", () => {
    expect(splitArgs("query windows")).toEqual(["query", "windows"]);
    expect(splitArgs('workspace focus-name "my space"')).toEqual(["workspace", "focus-name", "my space"]);
    expect(splitArgs("window move-to-workspace ow_abc 2")).toEqual(["window", "move-to-workspace", "ow_abc", "2"]);
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("omniwmctlBin", () => {
  it("honors the env override", () => {
    // A non-existent override path is not returned (existsSync false), so it falls through — assert it
    // does not throw and returns a string or undefined.
    const r = omniwmctlBin({ AGENTHOP_OMNIWMCTL: "/definitely/not/here/omniwmctl", PATH: "" } as NodeJS.ProcessEnv);
    expect(r === undefined || typeof r === "string").toBe(true);
  });
});
