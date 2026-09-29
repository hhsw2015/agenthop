import { expect, test } from "vitest";
import { codexDeliveryThread, resolvePeer, type UnifiedPeer } from "../src/core.js";

/**
 * Recipient selection (identity-review #2/#5): a silent wrong pick is a misdelivered message, so
 * exact matches must be unique, ids must beat titles, and an empty target must be rejected.
 */

function peer(p: Partial<UnifiedPeer> & { id: string }): UnifiedPeer {
  return { tool: "codex", cwd: "/x", title: p.id, via: "local", ...p };
}

const A = peer({ id: "run-a", stableId: "01a0ead5-aaaa", title: "codex:Work-01a0ead5" });
const B = peer({ id: "run-b", stableId: "01a0ead5-bbbb", title: "codex:Work-01a0ead5" }); // same short handle
const C = peer({ id: "run-c", stableId: "beef1234-cccc", title: "claude:Work-beef1234" });

const ok = (r: UnifiedPeer | { error: string }): UnifiedPeer => {
  if ("error" in r) throw new Error(`expected a peer, got error: ${r.error}`);
  return r;
};

test("rejects an empty / whitespace target instead of matching a lone peer", () => {
  expect(resolvePeer([C], "self", "   ")).toHaveProperty("error");
  expect(resolvePeer([C], "self", "")).toHaveProperty("error");
});

test("exact stableId and run id resolve uniquely", () => {
  expect(ok(resolvePeer([A, C], "self", "01a0ead5-aaaa")).id).toBe("run-a");
  expect(ok(resolvePeer([A, C], "self", "run-c")).id).toBe("run-c");
});

test("duplicate full handle is ambiguous, never a silent pick-first (both roster orders)", () => {
  const r1 = resolvePeer([A, B], "self", "codex:Work-01a0ead5");
  const r2 = resolvePeer([B, A], "self", "codex:Work-01a0ead5");
  expect(r1).toHaveProperty("error");
  expect(r2).toHaveProperty("error");
  // The error must surface the full ids the caller needs to disambiguate.
  if ("error" in r1) expect(r1.error).toContain("01a0ead5-aaaa");
});

test("a real id beats a peer whose title spoofs that id", () => {
  const victim = peer({ id: "run-v", stableId: "SECRET-ID" });
  const attacker = peer({ id: "run-x", stableId: "run-x-sid", title: "SECRET-ID" });
  expect(ok(resolvePeer([victim, attacker], "self", "SECRET-ID")).id).toBe("run-v");
});

test("prefix resolves one but is ambiguous for several", () => {
  expect(ok(resolvePeer([C], "self", "claude:Work")).id).toBe("run-c");
  expect(resolvePeer([A, B], "self", "codex:Work")).toHaveProperty("error");
});

test("self is never a candidate", () => {
  expect(resolvePeer([A], "run-a", "codex:Work-01a0ead5")).toHaveProperty("error");
});

test("two runs sharing a stableId still disambiguate via the unique run id", () => {
  const x = peer({ id: "run-x", stableId: "same-sid", title: "codex:Work-samesid" });
  const y = peer({ id: "run-y", stableId: "same-sid", title: "codex:Work-samesid" });
  const r = resolvePeer([x, y], "self", "codex:Work-samesid");
  expect(r).toHaveProperty("error");
  if ("error" in r) {
    expect(r.error).toContain("run-x"); // the unique run ids must be shown
    expect(r.error).toContain("run-y");
  }
  // ...and addressing by the unique run id resolves cleanly.
  expect(ok(resolvePeer([x, y], "self", "run-y")).id).toBe("run-y");
});

test("codexDeliveryThread locks delivery to the learned identity", () => {
  expect(codexDeliveryThread("claude", undefined, "sid", "daemon")).toBeUndefined(); // non-codex uses cc-socks
  expect(codexDeliveryThread("codex", "B", "A", "C")).toBe("B"); // authoritative metadata wins
  expect(codexDeliveryThread("codex", undefined, "A", "B")).toBe("A"); // locked to identity, not daemon drift A->B
  expect(codexDeliveryThread("codex", undefined, undefined, "C")).toBe("C"); // bootstrap from daemon when unset
  expect(codexDeliveryThread("codex", undefined, undefined, undefined)).toBeUndefined(); // nothing -> falls to recv
});
