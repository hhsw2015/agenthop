import { describe, expect, test } from "vitest";
import { advance, type ControlRecord } from "../src/swarm/control.js";
import { type Manifest } from "../src/swarm/manifest.js";
import { type ObservedTip, tipToEvent } from "../src/swarm/acceptance.js";

const T0 = 1_000_000;
function rec(p: Partial<ControlRecord> = {}): ControlRecord {
  return { launchId: "rw-aaaa", state: "RUNNING", generation: 0, allocStart: T0, budgetSec: 3480, updatedAt: T0, ...p };
}
function man(p: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: 1, launchId: "rw-aaaa", generation: 0, kind: "milestone", ...p };
}
function tip(p: Partial<ObservedTip> = {}): ObservedTip {
  return { sha: "newsha1", manifest: man(), isDescendantOfAccepted: true, ...p };
}

describe("fencing", () => {
  test("skips when no manifest, wrong launchId, or stale generation", () => {
    expect(tipToEvent(rec(), tip({ manifest: null })).kind).toBe("skip");
    expect(tipToEvent(rec(), tip({ manifest: man({ launchId: "rw-other" }) })).kind).toBe("skip");
    expect(tipToEvent(rec({ generation: 3 }), tip({ manifest: man({ generation: 2 }) })).kind).toBe("skip");
  });
  test("no-rollback: a tip that is NOT a descendant of the last accepted sha is rejected", () => {
    const r = rec({ sha: "accepted0" });
    const out = tipToEvent(r, tip({ sha: "sidebranch", isDescendantOfAccepted: false }));
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason.includes("no-rollback")).toBe(true);
  });
  test("already-accepted sha is a no-op", () => {
    expect(tipToEvent(rec({ sha: "x1" }), tip({ sha: "x1" })).kind).toBe("skip");
  });
});

describe("advance mapping", () => {
  test("milestone tip advances sha and the event applies in RUNNING", () => {
    const r = rec({ sha: "old0" });
    const out = tipToEvent(r, tip({ sha: "new1", manifest: man({ kind: "milestone", next: "do X" }) }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(r, out.event, T0 + 1);
      expect(res.ok && res.record.sha === "new1" && res.record.manifest === "do X").toBe(true);
    }
  });
  test("rescue tip is recorded like a milestone (recovery point), not a final", () => {
    const out = tipToEvent(rec(), tip({ manifest: man({ kind: "rescue" }) }));
    expect(out.kind === "advance" && out.event.type === "milestone").toBe(true);
  });
  test("final tip only accepted once the record is DRAINING", () => {
    expect(tipToEvent(rec({ state: "RUNNING" }), tip({ manifest: man({ kind: "final" }) })).kind).toBe("skip");
    const draining = rec({ state: "DRAINING" });
    const out = tipToEvent(draining, tip({ sha: "fin1", manifest: man({ kind: "final" }) }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(draining, out.event, T0 + 1);
      expect(res.ok && res.record.state === "CHECKPOINTED" && res.record.sha === "fin1").toBe(true);
    }
  });
});

describe("EXPIRED recovery (#10): a late confirmed tip advances the canonical sha without un-expiring", () => {
  test("recover_sha advances sha, stays EXPIRED", () => {
    const expired = rec({ state: "EXPIRED", sha: "s1" });
    const out = tipToEvent(expired, tip({ sha: "s2", manifest: man({ kind: "milestone" }) }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      expect(out.event.type).toBe("recover_sha");
      const res = advance(expired, out.event, T0 + 1);
      expect(res.ok && res.record.state === "EXPIRED" && res.record.sha === "s2").toBe(true);
    }
  });
  test("a non-descendant late tip is still rejected even in EXPIRED", () => {
    const expired = rec({ state: "EXPIRED", sha: "s1" });
    expect(tipToEvent(expired, tip({ sha: "evil", isDescendantOfAccepted: false })).kind).toBe("skip");
  });
});
