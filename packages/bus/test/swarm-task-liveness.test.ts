import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileIsAlive, resolveSession, makeFileLiveness, listSessions, type LivenessIO } from "../src/swarm/task-liveness.js";

/**
 * File liveness (§0b R2, TEMP sweep-side; bus-identity replaces it). Codex review fixes pinned here:
 *  - P1-4/P2-2: status AGE is NOT a heartbeat (event-driven) and is not read; pid + signal 0 only; never convict on a
 *    weak signal (F17) — no pid ⇒ suspected (not dead), EPERM ⇒ alive (exists), only ESRCH ⇒ dead, other errno ⇒ suspected.
 *  - P2-3/F16: resolveSession demands a UNIQUE match; ambiguous short-id ⇒ null (never guess which session = misrouted inbox).
 */

const io = (over: Partial<LivenessIO>): LivenessIO => ({
  readPid: () => 123,
  procAlive: () => "alive",
  ...over,
});

describe("fileIsAlive — pid + signal 0 only; status age never downgrades (P1-4), weak signal never convicts (F17/P2-2)", () => {
  test("pid present + process alive ⇒ alive (no status consulted — a silent healthy session stays alive)", () => {
    expect(fileIsAlive("s", io({}))).toBe("alive");
  });
  test("no presence pid ⇒ suspected, NOT dead (bus-not-visible / daemon absent ≠ session died — P2-2)", () => {
    expect(fileIsAlive("s", io({ readPid: () => null }))).toBe("suspected");
  });
  test("signal 0 ⇒ ESRCH (no such process) ⇒ dead (the one strong death signal)", () => {
    expect(fileIsAlive("s", io({ procAlive: () => "dead" }))).toBe("dead");
  });
  test("signal 0 ⇒ EPERM (process exists, not ours to signal) ⇒ alive, not dead (EPERM ≠ ESRCH — P2-2)", () => {
    // makeFileLiveness maps EPERM → "alive"; at the decision layer that is simply procAlive="alive".
    expect(fileIsAlive("s", io({ procAlive: () => "alive" }))).toBe("alive");
  });
  test("signal 0 ⇒ any other errno ⇒ suspected (unknown — leave for investigation, never dead; F17)", () => {
    expect(fileIsAlive("s", io({ procAlive: () => "unknown" }))).toBe("suspected");
  });
});

describe("resolveSession — unique match only; ambiguity rejected (F16/P2-3)", () => {
  const ids = ["20cab0a5-b30e-4723-8399", "4fd84f9f-aaaa", "726d408c"];
  test("exact id match is unambiguous", () => {
    expect(resolveSession("codex:happycapy-726d408c", ids)).toBe("726d408c");
  });
  test("a unique prefix match resolves", () => {
    expect(resolveSession("claude:swarm-brain-io-20cab0a5", ids)).toBe("20cab0a5-b30e-4723-8399");
  });
  test("ambiguous short-id (two native ids share the prefix) ⇒ null — never guess (F16)", () => {
    const amb = ["deadbeef-1111", "deadbeef-2222"]; // two different sessions, same 8-hex short id
    expect(resolveSession("codex:Other-deadbeef", amb)).toBeNull();
  });
  test("no match ⇒ null (⇒ caller treats owner as unresolvable/suspected, not dead)", () => {
    expect(resolveSession("claude:ghost-00000000", ids)).toBeNull();
  });
  test("empty tail ⇒ null", () => {
    expect(resolveSession("nodash", [])).toBe(null); // "nodash" has no '-', tail is the whole string; no match ⇒ null
  });
  test("B4: a FULL session id passed as the handle matches exactly (not reduced to its last '-' segment)", () => {
    const full = "20cab0a5-b30e-4723-8399-7bc5cf78f6f7"; // a complete UUID sid, e.g. the presence/<sid>.pid of an offline session
    // Only the whole-match path can resolve this: the tail is "7bc5cf78f6f7" (absent from the roster), and `full` is not a
    // prefix of itself-minus-tail, so pre-B4 this returned null (the regression) — now it resolves to the full id.
    expect(resolveSession(full, [full])).toBe(full);
    expect(resolveSession(full, [full, "4fd84f9f-aaaa"])).toBe(full); // still exact even alongside other sessions
  });
});

describe("makeFileLiveness — real fs/proc binding (status deliberately not read)", () => {
  test("readPid round-trips a presence file; missing ⇒ null; self pid ⇒ alive", () => {
    const home = mkdtempSync(path.join(tmpdir(), "liveness-"));
    mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
    writeFileSync(path.join(home, ".agenthop", "presence", "sess-1.pid"), `${process.pid}\n`);
    const io2 = makeFileLiveness(home);
    expect(io2.readPid("sess-1")).toBe(process.pid);
    expect(io2.readPid("missing")).toBeNull();
    expect(io2.procAlive(process.pid)).toBe("alive"); // signal 0 to ourselves succeeds
    expect(listSessions(home)).toEqual(["sess-1"]);
    // end-to-end: our own live session reads alive
    expect(fileIsAlive("sess-1", io2)).toBe("alive");
  });
});
