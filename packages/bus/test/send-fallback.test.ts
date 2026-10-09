import { describe, expect, test } from "vitest";
import { fallbackForUnresolved, fallbackForMissedDelivery, resolveInboxTarget, relaySameMachineSid, presenceEnvOwnsSid } from "../src/send-fallback.js";
import type { UnifiedPeer, ResolveError } from "../src/resolve.js";

const peer = (p: Partial<UnifiedPeer>): UnifiedPeer => ({ id: "run-1", tool: "claude", cwd: "/x", title: "t", via: "local", ...p });
const err = (kind: ResolveError["kind"], error = "e"): ResolveError => ({ kind, error });

describe("send durable-fallback routing (bus-reachability §1)", () => {
  test("unresolved + a same-machine sid ⇒ durable to that sid; no sid ⇒ none carrying the resolve error", () => {
    expect(fallbackForUnresolved("sid-abc", 'No session matches "x".')).toEqual({ kind: "durable", sid: "sid-abc" });
    expect(fallbackForUnresolved(null, 'No session matches "x".')).toEqual({ kind: "none", reason: 'No session matches "x".' });
  });

  test("resolved LOCAL peer, delivery missed ⇒ durable to stableId, falling back to the per-run id when no stableId yet", () => {
    expect(fallbackForMissedDelivery(peer({ via: "local", stableId: "sid-1", id: "run-1" }))).toEqual({ kind: "durable", sid: "sid-1" });
    expect(fallbackForMissedDelivery(peer({ via: "local", stableId: undefined, id: "run-9" }))).toEqual({ kind: "durable", sid: "run-9" });
  });

  test("resolved RELAY peer, delivery missed ⇒ none — cross-machine has no local durable inbox (never a false 'queued')", () => {
    const r = fallbackForMissedDelivery(peer({ via: "relay", title: "remote:box-1", pub: "pk" }));
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.reason).toContain("another machine");
  });
});

describe("F40 resolveInboxTarget — the single write-side addressing entry", () => {
  test("resolved LOCAL ⇒ durable keyed by the STABLE identity; the handle is only the display label (never the key)", () => {
    const p = peer({ via: "local", stableId: "conv-1", id: "run-1", title: "codex:Work-driftXX" });
    const t = resolveInboxTarget("codex:Work-driftXX", p, null);
    expect(t).toMatchObject({ kind: "durable", sid: "conv-1", label: "codex:Work-driftXX" });
    if (t.kind === "durable") { expect(t.sid).not.toBe("codex:Work-driftXX"); expect(t.peer).toBe(p); } // key is stableId, routing name only labels
  });

  test("resolved LOCAL with no stableId yet ⇒ durable keyed by the per-run id (never the handle tail)", () => {
    const t = resolveInboxTarget("codex:Work-abc", peer({ via: "local", stableId: undefined, id: "run-9", title: "codex:Work-abc" }), null);
    expect(t).toMatchObject({ kind: "durable", sid: "run-9" });
  });

  test("resolved RELAY ⇒ relay target (caller does a live send); never a local durable key", () => {
    const p = peer({ via: "relay", title: "remote:box", pub: "pk" });
    expect(resolveInboxTarget("remote:box", p, null)).toEqual({ kind: "relay", peer: p });
  });

  test("F45 ③: a SAME-MACHINE relay peer (its own sid owns a local presence pid) ⇒ durable, keyed by that exact sid", () => {
    // cross-broker but same machine: relayLocalSid is the peer's own stableId (a local presence match), so durable-always
    // holds across brokers — the fix for a dispatch that resolved as relay and landed in no inbox.
    const p = peer({ via: "relay", stableId: "sid-same", id: "run-r", title: "claude:agenthop-sameXX", pub: "pk" });
    const t = resolveInboxTarget("claude:agenthop-sameXX", p, null, "sid-same");
    expect(t).toMatchObject({ kind: "durable", sid: "sid-same", label: "claude:agenthop-sameXX" });
    if (t.kind === "durable") expect(t.peer).toBe(p);
  });

  test("F45 ③: a truly CROSS-MACHINE relay peer (no local presence match) stays relay", () => {
    const p = peer({ via: "relay", stableId: "sid-remote", title: "remote:box", pub: "pk" });
    expect(resolveInboxTarget("remote:box", p, null, null)).toEqual({ kind: "relay", peer: p });
  });
});

describe("F45-P1-2 relaySameMachineSid — a live pid is not proof; the instance must OWN the sid", () => {
  const relayPeer = (sid?: string) => peer({ via: "relay", stableId: sid, title: "claude:agenthop-x", pub: "pk" });

  test("instance-ownership PROVEN ⇒ route durable to the peer's own sid", () => {
    expect(relaySameMachineSid(relayPeer("sid-1"), (sid) => sid === "sid-1")).toBe("sid-1");
  });
  test("ownership UNPROVEN (stale file / recycled unrelated pid) ⇒ null (keep relay, no false durable)", () => {
    expect(relaySameMachineSid(relayPeer("sid-1"), () => false)).toBeNull();
  });
  test("a LOCAL peer is not this helper's concern ⇒ null", () => {
    expect(relaySameMachineSid(peer({ via: "local", stableId: "sid-1" }), () => true)).toBeNull();
  });
  test("relay peer with no stableId ⇒ null", () => {
    expect(relaySameMachineSid(relayPeer(undefined), () => true)).toBeNull();
  });

  // presenceEnvOwnsSid: the correlation the IO adds on top of signal-0 — the daemon's ENV, not argv (F45-P1-2 round-4).
  test("env with AGENTHOP_PID_FILE=.../<sid>.pid ⇒ owns the sid (the real presence daemon)", () => {
    expect(presenceEnvOwnsSid("node /h/.agenthop/presence.mjs AGENTHOP_PID_FILE=/h/.agenthop/presence/fe0376cd.pid AGENTHOP_HOST_PID=42", "fe0376cd")).toBe(true);
  });
  test("env with CLAUDE_CODE_SESSION_ID=<sid> ⇒ owns the sid", () => {
    expect(presenceEnvOwnsSid("node presence.mjs CLAUDE_CODE_SESSION_ID=fe0376cd", "fe0376cd")).toBe(true);
  });
  test("unrelated process carrying the sid as a plain ARG ⇒ NOT owned (argv is not identity)", () => {
    expect(presenceEnvOwnsSid("node worker.js --diagnostic-for fe0376cd", "fe0376cd")).toBe(false);
    expect(presenceEnvOwnsSid("node fe0376cd-tool.js", "fe0376cd")).toBe(false);
  });
  test("AGENTHOP_PID_FILE for a DIFFERENT sid ⇒ not owned", () => {
    expect(presenceEnvOwnsSid("node presence.mjs AGENTHOP_PID_FILE=/h/.agenthop/presence/OTHER.pid", "fe0376cd")).toBe(false);
  });
  test("null/empty env ⇒ not owned (unverifiable ⇒ keep relay)", () => {
    expect(presenceEnvOwnsSid(null, "fe0376cd")).toBe(false);
    expect(presenceEnvOwnsSid("", "fe0376cd")).toBe(false);
  });

  test("UNRESOLVED no-match + an offline presence sid ⇒ durable to THAT sid (label = the address); no sid ⇒ none", () => {
    expect(resolveInboxTarget("who", err("none", "no match"), "off-sid")).toMatchObject({ kind: "durable", sid: "off-sid", label: "who" });
    expect(resolveInboxTarget("who", err("none", "no match"), null)).toEqual({ kind: "none", reason: "no match" });
  });

  test("AMBIGUOUS / empty ⇒ none, NEVER a durable fallback even if an offline sid exists (B1: no weak-match misroute)", () => {
    expect(resolveInboxTarget("x", err("ambiguous", "2 match"), "off-sid")).toEqual({ kind: "none", reason: "2 match" });
    expect(resolveInboxTarget("", err("empty", "empty"), "off-sid")).toEqual({ kind: "none", reason: "empty" });
  });
});
