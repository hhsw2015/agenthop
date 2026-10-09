import { afterEach, describe, expect, test } from "vitest";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fallbackForUnresolved, fallbackForMissedDelivery, resolveInboxTarget, isValidSessionId } from "../src/send-fallback.js";
import { probeLivenessSock, probeSessionAlive, openLivenessSocket, sidSockPrefix, sockPathFits, instanceSockPath, MAX_SOCK_PATH_BYTES } from "../src/swarm/task-liveness.js";
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

describe("F45-R7-P1-2 sid→socket is a bounded, collision-free mapping (no traversal, no truncation collision)", () => {
  test("sidSockPrefix: 32 hex, stable per sid, distinct across sids — a traversal sid becomes pure hex (can't escape)", () => {
    expect(sidSockPrefix("x")).toMatch(/^[0-9a-f]{32}$/);
    expect(sidSockPrefix("x")).toBe(sidSockPrefix("x"));            // stable
    expect(sidSockPrefix("a")).not.toBe(sidSockPrefix("b"));        // distinct
    expect(sidSockPrefix("../bridge")).toMatch(/^[0-9a-f]{32}$/);   // no "/" or "." survives into the socket name
    const a = "x".repeat(127) + "a", b = "x".repeat(127) + "b";     // the r8 truncation counterexample
    expect(sidSockPrefix(a)).not.toBe(sidSockPrefix(b));            // two long sids ⇒ distinct prefixes ⇒ distinct sockets
  });
  test("sockPathFits: rejects a path over the sun_path bound (would silently truncate)", () => {
    expect(sockPathFits("/tmp/ah/s.sock")).toBe(true);
    expect(sockPathFits("/" + "x".repeat(MAX_SOCK_PATH_BYTES) + ".sock")).toBe(false);
  });
});

describe("F45-R7 openLivenessSocket + probeSessionAlive — per-instance ownership, no cross-delete, no truncation collision", () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];
  // Short /tmp home: the socket path (home + .agenthop/presence/<32hex>.<nonce>.sock) must fit sun_path (~103), and macOS
  // tmpdir() (/var/folders/.../T/) is already too long on its own — the same bound the fix enforces.
  const mkHome = () => { const d = mkdtempSync(path.join("/tmp", "f45l-")); mkdirSync(path.join(d, ".agenthop", "presence"), { recursive: true }); dirs.push(d); return d; };
  afterEach(() => {
    for (const s of servers.splice(0)) { try { s.close(); } catch { /* noop */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("open ⇒ probeSessionAlive true; no socket ⇒ false (keep relay)", async () => {
    const home = mkHome();
    expect(await probeSessionAlive(home, "sid-A", 400)).toBe(false);
    const res = await openLivenessSocket(home, "sid-A", 400);
    expect(res).not.toBeNull();
    if (res) servers.push(res.server);
    expect(await probeSessionAlive(home, "sid-A", 400)).toBe(true);
  });

  test("P1-2: two DISTINCT 127-char sids do NOT collide — only the one that opened is alive (no kernel truncation match)", async () => {
    const home = mkHome();
    const a = "x".repeat(127) + "a", b = "x".repeat(127) + "b";
    const res = await openLivenessSocket(home, a, 400);
    expect(res).not.toBeNull();
    if (res) { servers.push(res.server); expect(sockPathFits(res.path)).toBe(true); } // bounded hash name fits sun_path
    expect(await probeSessionAlive(home, a, 400)).toBe(true);
    expect(await probeSessionAlive(home, b, 400)).toBe(false); // distinct hash ⇒ no shared endpoint ⇒ no false durable
  });

  test("P2-1: two instances of the SAME sid own DISTINCT paths; closing one leaves the other alive (no cross-delete)", async () => {
    const home = mkHome();
    const r1 = await openLivenessSocket(home, "sid-S", 400);
    const r2 = await openLivenessSocket(home, "sid-S", 400);
    expect(r1).not.toBeNull(); expect(r2).not.toBeNull();
    if (!r1 || !r2) return;
    servers.push(r1.server, r2.server);
    expect(r1.path).not.toBe(r2.path);                    // unique per-instance nonce paths
    r1.server.close();                                     // the old instance exits — unlinks ONLY its own path
    await new Promise((r) => setTimeout(r, 50));
    expect(await probeSessionAlive(home, "sid-S", 400)).toBe(true); // r2 still serving (its path was not deleted)
  });

  test("P2-1: a DEAD orphan (stale file, no listener) is TOLERATED, not deleted — the live socket still answers", async () => {
    const home = mkHome();
    const deadPath = instanceSockPath(home, "sid-O", "deadbeef");
    writeFileSync(deadPath, "leftover");                   // a crashed instance's leftover under the same sid prefix
    const res = await openLivenessSocket(home, "sid-O", 400);
    expect(res).not.toBeNull();
    if (res) servers.push(res.server);
    expect(await probeSessionAlive(home, "sid-O", 400)).toBe(true); // the live socket answers; the dead orphan is skipped
    // NO probe-authorized delete (F45-R7-P2-1): the orphan is left on disk, never removed by a probe signal.
    expect(() => rmSync(deadPath)).not.toThrow();          // still present ⇒ not swept
  });
});
