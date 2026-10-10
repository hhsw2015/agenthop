/**
 * boot-digest-pin (DA3 — docker-agent eval Q3 / 立项③, docs/research/docker-agent-eval.md). Borrows ONLY the OCI concept, not
 * the mechanism: a boot artifact is addressed by the CONTENT DIGEST of what it is (`sha256:…` = immutable, reproducible), never
 * by a MUTABLE tag (`latest`, a URL, a branch). Today the remote boot pulls its install script from a mutable URL
 * (`HERDR_INSTALL_URL = https://herdr.dev/install.sh`) and a role by name — so "same boot-template" does NOT guarantee "same
 * member": the source can drift between two placements. Pinning each artifact by digest gives (a) reproducibility — same digest
 * ⇒ same boot; (b) a pull-anywhere cache semantics that aligns with placement treating location as a ledger field.
 *
 * This is the PURE core (no IO, no clock, no network): the manifest schema, the digest computation, pin/immutability validation,
 * pulled-content verification (drift detection), and a reproducibility equality. The SEAM — where vm-ctl's boot family
 * (remote-bootstrap.buildBootstrapScript / vm-ctl up) would resolve each artifact, VERIFY the pulled bytes against the pinned
 * digest, and REFUSE a mutable ref — is documented here and in the design; this module does NOT edit the signed vm-ctl /
 * placement / remote-bootstrap files (independent file, dormant-ahead-of-use behind SWARM_BOOT_DIGEST_PIN).
 *
 * Trust-boundary discipline (mirrors task-plan loadPlan / grill-gate): an untrusted manifest validates WHOLE or rejects with a
 * reason — a duplicate id, an unknown kind, a non-digest `digest` (a `latest` masquerading as a pin), a pulled-content digest
 * that does not match the pin — all reject; nothing is silently accepted.
 */

import { sha256Hex } from "./digest.js";

export type BootArtifactKind = "install-script" | "role-profile" | "repo-commit" | "boot-template" | "notebook";
const KINDS = new Set<string>(["install-script", "role-profile", "repo-commit", "boot-template", "notebook"]);

/** One pinned boot artifact. `digest` is the content address (sha256 hex, 64 lowercase). `sourceRef` is the MUTABLE origin
 *  (url/tag/branch) kept for provenance only — it is NEVER what a reproducible boot pulls by. */
export type BootArtifact = { id: string; kind: BootArtifactKind; digest: string; sourceRef?: string };
export type BootManifest = { schema: "boot-digest-pin/v1"; artifacts: BootArtifact[] };

type Res<T> = { ok: true; value: T } | { ok: false; reason: string };

const DIGEST_RE = /^[0-9a-f]{64}$/;              // bare sha256 hex (the stored digest)
const PINNED_REF_RE = /^sha256:[0-9a-f]{64}$/;   // an immutable ref form `sha256:<hex>`
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Read an OWN DATA property's value (BDP-P2-3): never the prototype chain, never invoking an accessor (a getter field reads as
 *  undefined ⇒ absent). Each field is captured ONCE and used for validation, de-dup AND output, so a getter cannot return a
 *  valid value during the check and a different one at copy time. */
function ownVal(o: object, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && "value" in d ? d.value : undefined;
}

/** Content address of an artifact's bytes/text. A reproducible boot pins THIS, not the URL it came from. */
export function computeArtifactDigest(content: string): string {
  return sha256Hex(content);
}

/** The immutable ref form a reproducible boot pulls by. */
export function pinnedRef(digest: string): string {
  if (!DIGEST_RE.test(digest)) throw new Error(`pinnedRef: not a sha256 digest: ${digest}`);
  return `sha256:${digest}`;
}

/** True ONLY for an immutable `sha256:<hex>` ref. A tag, a branch, a `latest`, or a plain URL is MUTABLE ⇒ false (the caller
 *  must refuse it for a reproducible boot). */
export function isImmutableRef(ref: unknown): ref is string {
  return typeof ref === "string" && PINNED_REF_RE.test(ref);
}

/** Extract the bare digest from a `sha256:<hex>` ref, or null if the ref is mutable/malformed. */
export function digestOfRef(ref: string): string | null {
  return PINNED_REF_RE.test(ref) ? ref.slice("sha256:".length) : null;
}

/** Trust boundary: parse an untrusted manifest. Whole-reject on a bad schema, a non-array artifacts, a duplicate id, an unknown
 *  kind, a `digest` that is not a bare sha256 hex (so a `latest`/tag can never pose as a pin), or a non-string sourceRef. */
export function validateBootManifest(input: unknown): Res<BootManifest> {
  if (!isObj(input)) return { ok: false, reason: "manifest must be an object" };
  if (ownVal(input, "schema") !== "boot-digest-pin/v1") return { ok: false, reason: "manifest.schema must be \"boot-digest-pin/v1\"" };
  const artifactsRaw = ownVal(input, "artifacts");
  if (!Array.isArray(artifactsRaw)) return { ok: false, reason: "manifest.artifacts must be an array" };
  const ids = new Set<string>();
  const artifacts: BootArtifact[] = [];
  for (let i = 0; i < artifactsRaw.length; i += 1) { // index walk (BDP-P2-2): never input.artifacts.entries()/iterator
    const raw = artifactsRaw[i];
    if (!isObj(raw)) return { ok: false, reason: `artifact[${i}] must be an object` };
    const id = ownVal(raw, "id"), kind = ownVal(raw, "kind"), digest = ownVal(raw, "digest"), sourceRef = ownVal(raw, "sourceRef"); // capture once
    if (!isNonEmptyStr(id)) return { ok: false, reason: `artifact[${i}].id must be a non-empty string` };
    if (ids.has(id)) return { ok: false, reason: `duplicate artifact id "${id}"` };
    ids.add(id);
    if (typeof kind !== "string" || !KINDS.has(kind)) return { ok: false, reason: `artifact "${id}".kind unknown` };
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return { ok: false, reason: `artifact "${id}".digest must be a bare sha256 hex (a tag/latest is not a pin)` };
    if (sourceRef !== undefined && typeof sourceRef !== "string") return { ok: false, reason: `artifact "${id}".sourceRef must be a string` };
    artifacts.push({ id, kind: kind as BootArtifactKind, digest, ...(typeof sourceRef === "string" ? { sourceRef } : {}) }); // output the captured values
  }
  return { ok: true, value: { schema: "boot-digest-pin/v1", artifacts } };
}

/** Build a pinned manifest from the actual artifact CONTENTS (computes each digest). Whole-reject on a duplicate id or an
 *  unknown kind — the authoring boundary, so a manifest is pinned by construction. */
export function buildBootManifest(items: readonly { id: string; kind: BootArtifactKind; content: string; sourceRef?: string }[]): Res<BootManifest> {
  if (!Array.isArray(items)) return { ok: false, reason: "items must be an array" };
  const ids = new Set<string>();
  const artifacts: BootArtifact[] = [];
  for (let i = 0; i < items.length; i += 1) { // index walk (BDP-P2-2): never the input's iterator, which could hide a dup/bad item
    const it = items[i];
    if (!isObj(it)) return { ok: false, reason: `item[${i}] must be an object` };
    const id = ownVal(it, "id"), kind = ownVal(it, "kind"), content = ownVal(it, "content"), sourceRef = ownVal(it, "sourceRef"); // capture once
    if (!isNonEmptyStr(id)) return { ok: false, reason: `item[${i}].id must be a non-empty string` };
    if (ids.has(id)) return { ok: false, reason: `duplicate artifact id "${id}"` };
    ids.add(id);
    if (typeof kind !== "string" || !KINDS.has(kind)) return { ok: false, reason: `artifact "${id}" has an unknown kind` };
    if (typeof content !== "string") return { ok: false, reason: `artifact "${id}".content must be a string` };
    if (sourceRef !== undefined && typeof sourceRef !== "string") return { ok: false, reason: `artifact "${id}".sourceRef must be a string (a built manifest must pass validateBootManifest — BDP-P2-1)` };
    artifacts.push({ id, kind: kind as BootArtifactKind, digest: computeArtifactDigest(content), ...(typeof sourceRef === "string" ? { sourceRef } : {}) });
  }
  return { ok: true, value: { schema: "boot-digest-pin/v1", artifacts } };
}

/** The SEAM check vm-ctl boot runs after pulling: recompute the digest of what was ACTUALLY fetched and compare it to the pin.
 *  A mismatch means the mutable source drifted since the manifest was pinned — REJECT (never boot a non-reproducible member).
 *  Rejects an unknown id (the manifest does not pin this artifact). */
export function verifyPulledArtifact(manifest: BootManifest, id: string, pulledContent: string): Res<{ digest: string }> {
  const art = manifest.artifacts.find((a) => a.id === id);
  if (!art) return { ok: false, reason: `artifact "${id}" is not in the manifest (unpinned ⇒ refuse)` };
  const actual = computeArtifactDigest(pulledContent);
  if (actual !== art.digest) return { ok: false, reason: `artifact "${id}" digest drift: pinned ${art.digest.slice(0, 12)}… but pulled ${actual.slice(0, 12)}…` };
  return { ok: true, value: { digest: actual } };
}

/** Reproducibility equality: two manifests pin the SAME boot iff they pin the same id→digest set (order-independent; sourceRef
 *  provenance is ignored — only content identity decides reproducibility). Placement uses this to know two boots are identical. */
export function sameBootPin(a: BootManifest, b: BootManifest): boolean {
  if (a.artifacts.length !== b.artifacts.length) return false;
  const bById = new Map(b.artifacts.map((x) => [x.id, x.digest]));
  for (const art of a.artifacts) if (bById.get(art.id) !== art.digest) return false;
  return true;
}

/** Dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_VM_CTL). vm-ctl boot enforces digest-pin only when on. */
export function bootDigestPinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_BOOT_DIGEST_PIN ?? "");
}
