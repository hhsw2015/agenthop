import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest, pinnedRef, isImmutableRef, digestOfRef,
  validateBootManifest, buildBootManifest, verifyPulledArtifact, sameBootPin, bootDigestPinEnabled,
  type BootManifest,
} from "../src/swarm/boot-digest-pin.js";

const okv = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => { if (!r.ok) throw new Error(r.reason); return r.value; };
const manifest = (): BootManifest => okv(buildBootManifest([
  { id: "install", kind: "install-script", content: "#!/bin/sh\nherdr install", sourceRef: "https://herdr.dev/install.sh" },
  { id: "role", kind: "role-profile", content: '{"roleId":"reviewer"}' },
  { id: "repo", kind: "repo-commit", content: "bdd93d7" },
]));

describe("boot-digest-pin — content addressing", () => {
  test("digest is deterministic, content-addressed, 64-hex", () => {
    const d = computeArtifactDigest("hello");
    expect(d).toBe(computeArtifactDigest("hello"));
    expect(d).not.toBe(computeArtifactDigest("hellO"));
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("boot-digest-pin — immutable vs mutable refs", () => {
  test("only sha256:<hex> is immutable; tag/latest/url/branch are not", () => {
    const d = computeArtifactDigest("x");
    expect(isImmutableRef(pinnedRef(d))).toBe(true);
    for (const mut of ["latest", "main", "v1.2.3", "https://herdr.dev/install.sh", `sha256:${d}:latest`, d /* bare, not prefixed */, "sha256:xyz"]) {
      expect(isImmutableRef(mut)).toBe(false);
    }
    expect(digestOfRef(pinnedRef(d))).toBe(d);
    expect(digestOfRef("latest")).toBeNull();
    expect(() => pinnedRef("not-a-digest")).toThrow();
  });
});

describe("boot-digest-pin — validateBootManifest (whole-reject; a latest cannot pose as a pin)", () => {
  test("a built manifest round-trips through validate", () => {
    expect(okv(validateBootManifest(manifest())).artifacts.length).toBe(3);
  });
  test("rejects bad schema / non-array / dup id / unknown kind / non-digest digest / bad sourceRef", () => {
    const base = manifest();
    expect(validateBootManifest({ ...base, schema: "other" }).ok).toBe(false);
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: {} }).ok).toBe(false);
    const d = computeArtifactDigest("x");
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [{ id: "a", kind: "role-profile", digest: d }, { id: "a", kind: "role-profile", digest: d }] }).ok).toBe(false); // dup id
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [{ id: "a", kind: "docker-image", digest: d }] }).ok).toBe(false); // unknown kind
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [{ id: "a", kind: "role-profile", digest: "latest" }] }).ok).toBe(false); // a tag is not a pin
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [{ id: "a", kind: "role-profile", digest: d, sourceRef: 7 }] }).ok).toBe(false);
  });
});

describe("boot-digest-pin — buildBootManifest", () => {
  test("computes each digest; rejects a duplicate id / unknown kind", () => {
    const m = manifest();
    expect(m.artifacts.find((a) => a.id === "install")!.digest).toBe(computeArtifactDigest("#!/bin/sh\nherdr install"));
    expect(m.artifacts.find((a) => a.id === "install")!.sourceRef).toBe("https://herdr.dev/install.sh"); // provenance kept
    expect(buildBootManifest([{ id: "x", kind: "role-profile", content: "a" }, { id: "x", kind: "role-profile", content: "b" }]).ok).toBe(false);
    expect(buildBootManifest([{ id: "x", kind: "nope" as any, content: "a" }]).ok).toBe(false);
  });
});

describe("boot-digest-pin — verifyPulledArtifact (drift detection = the seam check)", () => {
  test("matching content ⇒ ok; drifted content ⇒ reject; unknown id ⇒ reject", () => {
    const m = manifest();
    expect(verifyPulledArtifact(m, "install", "#!/bin/sh\nherdr install").ok).toBe(true); // same bytes
    expect(verifyPulledArtifact(m, "install", "#!/bin/sh\nherdr install --EVIL").ok).toBe(false); // the mutable URL drifted
    expect(verifyPulledArtifact(m, "ghost", "x").ok).toBe(false); // not pinned
  });
});

describe("boot-digest-pin — sameBootPin (reproducibility equality)", () => {
  test("same id→digest set ⇒ true (order-independent, sourceRef ignored); any digest/count diff ⇒ false", () => {
    const a = manifest();
    const b = okv(buildBootManifest([ // same contents, different order, different sourceRef
      { id: "repo", kind: "repo-commit", content: "bdd93d7" },
      { id: "role", kind: "role-profile", content: '{"roleId":"reviewer"}' },
      { id: "install", kind: "install-script", content: "#!/bin/sh\nherdr install", sourceRef: "file:///pinned" },
    ]));
    expect(sameBootPin(a, b)).toBe(true);
    const drifted = okv(buildBootManifest([
      { id: "install", kind: "install-script", content: "#!/bin/sh\nherdr install --v2" },
      { id: "role", kind: "role-profile", content: '{"roleId":"reviewer"}' },
      { id: "repo", kind: "repo-commit", content: "bdd93d7" },
    ]));
    expect(sameBootPin(a, drifted)).toBe(false);
    expect(sameBootPin(a, { schema: "boot-digest-pin/v1", artifacts: a.artifacts.slice(0, 2) })).toBe(false); // count differs
  });
});

describe("boot-digest-pin — RP-family round-1 fixes (builder/validator parity, input-method trust, getter TOCTOU)", () => {
  test("BDP-P2-1: build rejects a non-string sourceRef; a successfully-built manifest always re-validates", () => {
    for (const bad of [7, null, {}, false]) {
      expect(buildBootManifest([{ id: "a", kind: "role-profile", content: "x", sourceRef: bad as unknown as string }]).ok).toBe(false);
    }
    expect(validateBootManifest(okv(buildBootManifest([{ id: "a", kind: "role-profile", content: "x", sourceRef: "ok" }]))).ok).toBe(true);
  });
  test("BDP-P2-2: validate walks slots by index — a hijacked entries() cannot hide a bad item", () => {
    const d = computeArtifactDigest("x");
    const artifacts: unknown[] = [{ id: "a", kind: "role-profile", digest: d }, { id: "b", kind: "role-profile", digest: "latest" }];
    (artifacts as { entries: unknown }).entries = function* () { yield [0, artifacts[0]]; }; // would hide the bad item
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts }).ok).toBe(false); // the latest digest is still caught
  });
  test("BDP-P2-2: build walks slots by index — a hijacked iterator cannot hide a duplicate id", () => {
    const items: unknown[] = [{ id: "a", kind: "role-profile", content: "x" }, { id: "a", kind: "role-profile", content: "y" }];
    (items as { [Symbol.iterator]: unknown })[Symbol.iterator] = function* () { yield items[0]; }; // would hide the dup
    expect(buildBootManifest(items as never).ok).toBe(false); // the duplicate id is still caught
  });
  test("BDP-P2-3: fields captured once — a digest getter (valid-then-latest) and an inherited field both reject", () => {
    const d = computeArtifactDigest("x");
    let n = 0;
    const art: Record<string, unknown> = { id: "a", kind: "role-profile" };
    Object.defineProperty(art, "digest", { enumerable: true, get() { return n++ < 2 ? d : "latest"; } });
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [art] }).ok).toBe(false); // getter field ⇒ absent ⇒ reject
    const inherited = Object.create({ id: "a", kind: "role-profile", digest: d });
    expect(validateBootManifest({ schema: "boot-digest-pin/v1", artifacts: [inherited] }).ok).toBe(false); // inherited ⇒ own-read absent ⇒ reject
  });
});

describe("boot-digest-pin — bootDigestPinEnabled (dormant, default OFF)", () => {
  test("default OFF; truthy words ON", () => {
    expect(bootDigestPinEnabled({})).toBe(false);
    expect(bootDigestPinEnabled({ SWARM_BOOT_DIGEST_PIN: "0" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "On"]) expect(bootDigestPinEnabled({ SWARM_BOOT_DIGEST_PIN: on })).toBe(true);
  });
});
