import { describe, expect, test } from "vitest";
import { fallbackForUnresolved, fallbackForMissedDelivery } from "../src/send-fallback.js";
import type { UnifiedPeer } from "../src/resolve.js";

const peer = (p: Partial<UnifiedPeer>): UnifiedPeer => ({ id: "run-1", tool: "claude", cwd: "/x", title: "t", via: "local", ...p });

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
