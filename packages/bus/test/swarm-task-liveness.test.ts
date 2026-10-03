import { describe, expect, test } from "vitest";
import { fileIsAlive, resolveSession, type LivenessIO } from "../src/swarm/task-liveness.js";

/**
 * Two-evidence liveness (§0b R2 §4, F17 code-ification). Both faces required; a single face / single tick never convicts.
 */

const io = (over: Partial<LivenessIO>): LivenessIO => ({
  readPid: () => 123,
  procAlive: () => true,
  latestStatus: () => ({ state: "working", seq: 10_000 }),
  nowMs: () => 10_050,
  ...over,
});
const STALE = 120_000;

describe("fileIsAlive — two-evidence consensus", () => {
  test("pid alive + fresh working/idle ⇒ alive", () => {
    expect(fileIsAlive("s", io({ latestStatus: () => ({ state: "working", seq: 10_000 }), nowMs: () => 10_050 }), STALE)).toBe("alive");
    expect(fileIsAlive("s", io({ latestStatus: () => ({ state: "idle", seq: 10_000 }), nowMs: () => 10_050 }), STALE)).toBe("alive");
  });
  test("no pid file ⇒ dead", () => {
    expect(fileIsAlive("s", io({ readPid: () => null }), STALE)).toBe("dead");
  });
  test("pid file present but process gone (kill -0 fails) ⇒ dead — the FILE is not proof (F17 corpse)", () => {
    expect(fileIsAlive("s", io({ readPid: () => 123, procAlive: () => false }), STALE)).toBe("dead");
  });
  test("pid alive but NEVER wrote a status ⇒ suspected, not dead (defect ②)", () => {
    expect(fileIsAlive("s", io({ latestStatus: () => null }), STALE)).toBe("suspected");
  });
  test("pid alive but status stale ⇒ suspected (process up, no heartbeat — maybe stuck; one tick never convicts)", () => {
    expect(fileIsAlive("s", io({ latestStatus: () => ({ state: "working", seq: 10_000 }), nowMs: () => 10_000 + STALE + 1 }), STALE)).toBe("suspected");
  });
  test("pid alive + fresh but a non-active state ⇒ suspected (only working/idle is alive)", () => {
    expect(fileIsAlive("s", io({ latestStatus: () => ({ state: "blocked", seq: 10_000 }), nowMs: () => 10_050 }), STALE)).toBe("suspected");
  });
});

describe("resolveSession — handle → sessionId by short-id tail (v1)", () => {
  const ids = ["20cab0a5-b30e-4723-8399", "4fd84f9f-aaaa", "726d408c"];
  test("matches the handle's tail short-id as a prefix", () => {
    expect(resolveSession("claude:swarm-brain-io-20cab0a5", ids)).toBe("20cab0a5-b30e-4723-8399");
    expect(resolveSession("codex:happycapy-726d408c", ids)).toBe("726d408c");
  });
  test("no match ⇒ null (⇒ treated dead by the caller)", () => {
    expect(resolveSession("claude:ghost-deadbeef", ids)).toBeNull();
  });
});
