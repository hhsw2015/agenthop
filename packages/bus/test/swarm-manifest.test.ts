import { describe, expect, test } from "vitest";
import { encodeManifest, type Manifest, MAX_MANIFEST_BYTES, parseManifest, validateForPublish } from "../src/swarm/manifest.js";

function man(p: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: 1, launchId: "rw-aaaa", generation: 0, kind: "milestone", createdAt: 1_000_000, ...p };
}

describe("encode / parse", () => {
  test("round-trips and is byte-stable (so an unchanged manifest skips a redundant commit)", () => {
    const m = man({ goal: "build", next: "tests", kind: "final" });
    expect(parseManifest(encodeManifest(m))).toEqual(m);
    expect(encodeManifest(m)).toBe(encodeManifest({ ...m }));
  });
  test("rejects malformed / bad schema / bad kind / bad generation / partial", () => {
    expect(parseManifest("")).toBeNull();
    expect(parseManifest("{}")).toBeNull();
    expect(parseManifest(JSON.stringify({ ...man(), schemaVersion: 2 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...man(), kind: "bogus" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...man(), generation: -1 }))).toBeNull();
    const whole = encodeManifest(man());
    expect(parseManifest(whole.slice(0, whole.length - 3))).toBeNull();
  });
});

describe("producer/parser agree on the size bound (Codex #13)", () => {
  test("validateForPublish rejects exactly what parseManifest would reject", () => {
    const huge = man({ goal: "x".repeat(MAX_MANIFEST_BYTES) });
    const pub = validateForPublish(huge);
    expect(pub.ok).toBe(false); // producer refuses to publish it...
    expect(parseManifest(encodeManifest(huge))).toBeNull(); // ...and the parser would have rejected it too
  });
  test("a normal manifest passes publish AND parses back", () => {
    const m = man({ goal: "g", next: "n", kind: "rescue" });
    expect(validateForPublish(m).ok).toBe(true);
    expect(parseManifest(encodeManifest(m))?.kind).toBe("rescue");
  });
});

describe("createdAt is optional (omitted for idempotency)", () => {
  test("a manifest without createdAt round-trips and is byte-stable across rebuilds", () => {
    const m = man({ goal: "g", next: "n" });
    delete (m as { createdAt?: number }).createdAt;
    const once = encodeManifest(m);
    expect(parseManifest(once)).toEqual(m);
    expect(once).toBe(encodeManifest({ ...m })); // same inputs -> identical bytes -> no redundant commit
    expect(once.includes("createdAt")).toBe(false);
  });
});

describe("kind distinguishes final from best-effort rescue", () => {
  test("all three kinds round-trip", () => {
    for (const kind of ["milestone", "final", "rescue"] as const) {
      expect(parseManifest(encodeManifest(man({ kind })))?.kind).toBe(kind);
    }
  });
});
