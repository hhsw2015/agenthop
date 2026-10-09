import { describe, expect, test } from "vitest";
import { pickThreadForCwd, ownThreadByCwd } from "../src/codex.js";

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

  test("incomplete cwd map (a loaded thread's cwd not read yet) -> no unique match, no false pin (P1-3)", () => {
    // A's cwd is known and matches, but B is loaded with its cwd NOT read yet -> must NOT declare A the unique match
    // (a pending read is not "a different cwd"). >1 loaded so the fallback is undefined -> message waits, no misdeliver.
    expect(pickThreadForCwd([A, B], new Map([[A, "/work/happycapy"]]), "/work/happycapy")).toBeUndefined();
    // once B's cwd is known (and differs), A becomes the unambiguous unique match
    expect(pickThreadForCwd([A, B], new Map([[A, "/work/happycapy"], [B, "/work/other"]]), "/work/happycapy")).toBe(A);
  });
});

// F47-1: STRICT identity resolver — must require a UNIQUE cwd match, NEVER the sole-loaded delivery fallback.
describe("ownThreadByCwd (identity adoption: unique cwd match only, no sole-loaded fallback)", () => {
  const A = "thread-A", B = "thread-B", C = "thread-C";
  test("unique cwd match -> adopt it", () => {
    expect(ownThreadByCwd([A, B], new Map([[A, "/projects/own"], [B, "/projects/other"]]), "/projects/own")).toBe(A);
  });
  test("F47-1 counterexample: sole loaded whose cwd CLEARLY differs -> undefined (never steal its identity)", () => {
    expect(ownThreadByCwd([B], new Map([[B, "/projects/other"]]), "/projects/own")).toBeUndefined();
  });
  test("ambiguous (two threads in my cwd) -> undefined", () => {
    expect(ownThreadByCwd([A, C], new Map([[A, "/projects/own"], [C, "/projects/own"]]), "/projects/own")).toBeUndefined();
  });
  test("incomplete cwd map (a thread's cwd unknown) -> undefined (never guess)", () => {
    expect(ownThreadByCwd([A, B], new Map([[A, "/projects/own"]]), "/projects/own")).toBeUndefined();
  });
  test("no cwd given -> undefined (identity needs cwd evidence)", () => {
    expect(ownThreadByCwd([A], new Map([[A, "/projects/own"]]))).toBeUndefined();
  });
});
