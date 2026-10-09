import { afterEach, describe, expect, test } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fallbackForUnresolved, fallbackForMissedDelivery, resolveInboxTarget, isValidSessionId } from "../src/send-fallback.js";
import { probeLivenessSock, claimLivenessSocket } from "../src/swarm/task-liveness.js";
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

describe("F45-R7-P1-2 isValidSessionId — a sid used as a filesystem key must be ONE safe path segment (no namespace escape)", () => {
  test("accepts real native sids (UUID) and plain per-run/handle tokens", () => {
    for (const ok of ["01a0ead5-f1f9-7dc2-b667-1de38c6e4984", "run-1", "sid-abc", "conv_1", "A1b2C3"]) expect(isValidSessionId(ok)).toBe(true);
  });
  test("rejects anything that could escape <home>/.agenthop (traversal, separators, empty, over-long)", () => {
    for (const bad of ["../bridge", "..", ".", "a/b", "a\\b", "", "has space", "x.sock", "a\u0000b", "/abs", "x".repeat(129)]) expect(isValidSessionId(bad)).toBe(false);
  });
});

describe("F45-R7-P1-2 resolveInboxTarget — an unsafe durable key is never emitted", () => {
  test("RELAY peer with an unsafe relayLocalSid (e.g. \"../bridge\") falls back to RELAY, never a traversing durable write", () => {
    const p = peer({ via: "relay", title: "remote:box", pub: "pk" });
    expect(resolveInboxTarget("remote:box", p, null, "../bridge")).toEqual({ kind: "relay", peer: p });
  });
  test("LOCAL peer whose stableId is unsafe ⇒ none (fail closed — refuse to write outside the inbox namespace)", () => {
    const t = resolveInboxTarget("x", peer({ via: "local", stableId: "../../evil", id: "run-1", title: "t" }), null);
    expect(t.kind).toBe("none");
    if (t.kind === "none") expect(t.reason).toContain("not a valid session id");
  });
  test("UNRESOLVED no-match with an unsafe offline sid ⇒ none (not a traversing durable)", () => {
    const t = resolveInboxTarget("who", err("none", "no match"), "../bridge");
    expect(t.kind).toBe("none");
    if (t.kind === "none") expect(t.reason).toContain("not a valid session id");
  });
});

describe("F40 resolveInboxTarget — offline / ambiguous fallback (continued)", () => {
  test("UNRESOLVED no-match + an offline presence sid ⇒ durable to THAT sid (label = the address); no sid ⇒ none", () => {
    expect(resolveInboxTarget("who", err("none", "no match"), "off-sid")).toMatchObject({ kind: "durable", sid: "off-sid", label: "who" });
    expect(resolveInboxTarget("who", err("none", "no match"), null)).toEqual({ kind: "none", reason: "no match" });
  });
  test("AMBIGUOUS / empty ⇒ none, NEVER a durable fallback even if an offline sid exists (B1: no weak-match misroute)", () => {
    expect(resolveInboxTarget("x", err("ambiguous", "2 match"), "off-sid")).toEqual({ kind: "none", reason: "2 match" });
    expect(resolveInboxTarget("", err("empty", "empty"), "off-sid")).toEqual({ kind: "none", reason: "empty" });
  });
});

describe("F45-R1 probeLivenessSock — a live LISTENER proves the current instance (window-free, ruling B)", () => {
  const dirs: string[] = [];
  const mk = () => { const d = mkdtempSync(path.join(tmpdir(), "f45-sock-")); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("a live listener ⇒ true (connect accepted = current instance alive)", async () => {
    const sock = path.join(mk(), "s.sock");
    const srv = net.createServer((c) => c.destroy()); await new Promise<void>((r) => srv.listen(sock, r));
    try { expect(await probeLivenessSock(sock, 500)).toBe(true); } finally { srv.close(); }
  });
  test("no file (dead/never-ran) ⇒ false (ENOENT, keep relay)", async () => {
    expect(await probeLivenessSock(path.join(mk(), "absent.sock"), 300)).toBe(false);
  });
  test("a STALE sock file with no listener (daemon died) ⇒ false (keep relay)", async () => {
    const sock = path.join(mk(), "stale.sock");
    writeFileSync(sock, ""); // a leftover file that is NOT a live listener ⇒ connect fails ⇒ false
    expect(await probeLivenessSock(sock, 300)).toBe(false);
  });
});

describe("F45-R7-P2-1 claimLivenessSocket — never unlink a LIVE listener (ruling: safe handover, no cross-delete)", () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];
  const mk = () => { const d = mkdtempSync(path.join(tmpdir(), "f45-claim-")); dirs.push(d); return d; };
  afterEach(() => {
    for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("a FREE path ⇒ binds and listens (a probe then connects)", async () => {
    const sock = path.join(mk(), "s.sock");
    const srv = await claimLivenessSocket(sock, 300);
    expect(srv).not.toBeNull();
    if (srv) servers.push(srv);
    expect(await probeLivenessSock(sock, 500)).toBe(true);
  });

  test("a DEAD stale FILE (no listener) ⇒ reclaimed: unlink + bind (probe then connects)", async () => {
    const sock = path.join(mk(), "s.sock");
    writeFileSync(sock, "leftover"); // a regular file left by a crashed daemon — not a live listener
    const srv = await claimLivenessSocket(sock, 300);
    expect(srv).not.toBeNull();
    if (srv) servers.push(srv);
    expect(await probeLivenessSock(sock, 500)).toBe(true);
  });

  test("a LIVE incumbent ⇒ DEFER (null) and the incumbent stays alive — its endpoint is NOT stolen", async () => {
    const sock = path.join(mk(), "s.sock");
    const incumbent = net.createServer((c) => c.destroy()); incumbent.on("error", () => {});
    await new Promise<void>((r) => incumbent.listen(sock, r));
    servers.push(incumbent);
    const srv = await claimLivenessSocket(sock, 500);
    expect(srv).toBeNull();                               // we deferred — did not take over a live listener
    expect(await probeLivenessSock(sock, 500)).toBe(true); // the incumbent is still serving (not unlinked)
  });
});
