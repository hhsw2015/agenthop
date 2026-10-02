import { describe, expect, test } from "vitest";
import { pickThreadForCwd } from "../src/codex.js";

// cwd-pinned delivery target selection (reaches an idle Codex among several sharing one daemon, no cross-talk).
describe("pickThreadForCwd", () => {
  const A = "thread-A", B = "thread-B", C = "thread-C";
  const cwds = new Map([[A, "/work/happycapy"], [B, "/work/other"], [C, "/work/happycapy"]]);

  test("unique cwd match wins even with several threads loaded", () => {
    expect(pickThreadForCwd([A, B], new Map([[A, "/work/happycapy"], [B, "/work/other"]]), "/work/happycapy")).toBe(A);
  });

  test("ambiguous cwd (two threads in same dir) -> no pin, falls back", () => {
    // A and C both in /work/happycapy, and >1 loaded -> undefined (never guess)
    expect(pickThreadForCwd([A, B, C], cwds, "/work/happycapy")).toBeUndefined();
  });

  test("no cwd match but exactly one loaded -> that one", () => {
    expect(pickThreadForCwd([B], new Map([[B, "/work/other"]]), "/work/happycapy")).toBe(B);
  });

  test("no cwd match and several loaded -> undefined", () => {
    expect(pickThreadForCwd([A, B], cwds, "/work/nowhere")).toBeUndefined();
  });

  test("no cwd given, single loaded -> that one (legacy behavior preserved)", () => {
    expect(pickThreadForCwd([A], cwds)).toBe(A);
  });

  test("no cwd given, several loaded -> undefined (legacy behavior preserved)", () => {
    expect(pickThreadForCwd([A, B], cwds)).toBeUndefined();
  });

  test("cwd known for a thread that is not currently loaded is ignored", () => {
    expect(pickThreadForCwd([B], cwds, "/work/happycapy")).toBe(B); // A matches cwd but isn't loaded -> fall back to sole loaded
  });
});
