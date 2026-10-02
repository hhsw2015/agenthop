/**
 * Swarm MANIFEST (pure, shared by the box publisher and the dispatcher). Replaces the receipt/seq machinery after
 * the git-channel pivot (Codex-reviewed): the git WORK branch is the durable, ordered (fast-forward), idempotent
 * (re-push = no-op) channel for the ARTIFACTS, so we no longer hand-roll a receipt log. A manifest is the small
 * SEMANTIC summary the worker writes into the work tree and commits WITH the artifacts, so a single commit SHA
 * carries both the code and its description. The dispatcher fetches a PINNED sha and reads the manifest FROM that
 * sha (never "latest tip after a separate tip read" — that mixes B's manifest with A's code), verifies it, then
 * advances CONTROL.
 *
 * The SAME schema + size limit are enforced at PUBLISH (producer) and at READ (consumer) — Codex flagged a
 * producer/parser mismatch where the box ACKed an 8KB+ receipt the parser rejected. Here, validateForPublish uses
 * the identical bound parseManifest enforces, so the box never commits a manifest the dispatcher can't read.
 *
 * `kind` distinguishes a cooperatively-quiesced FINAL (safe to hand off from) from a best-effort RESCUE snapshot
 * (near-death, NOT frozen — may be cross-file-inconsistent) and a routine MILESTONE. The dispatcher must not treat
 * a rescue as a clean final.
 */

export type ManifestKind = "milestone" | "final" | "rescue";

export type Manifest = {
  schemaVersion: 1;
  launchId: string;
  generation: number;
  kind: ManifestKind;
  /** What the task is (for a human / the resuming worker). Optional, bounded by the whole-manifest size cap. */
  goal?: string;
  /** What remains to do — the resume instruction for a successor. */
  next?: string;
  /** Epoch seconds the box wrote it (box clock; informational only). OPTIONAL and normally OMITTED: a changing
   *  timestamp every publish would make the committed tree differ each round and defeat the "skip if unchanged"
   *  idempotency (Codex). The dispatcher uses the git commit's own time if it needs one. */
  createdAt?: number;
};

/** Whole-manifest serialized size cap. A manifest is a short summary, not a payload; reject anything larger at
 *  BOTH ends so the box can never publish one the dispatcher would refuse. */
export const MAX_MANIFEST_BYTES = 16 * 1024;
// Bound by real UTF-8 BYTES, not JS code units (Codex P3): a CJK/emoji field is ~3-4 bytes/char, so a code-unit count
// under-measures the committed blob. Producer (validateForPublish) and reader (parseManifest) use the SAME measure.
const byteLen = (s: string): number => new TextEncoder().encode(s).length;
const KINDS: ReadonlySet<string> = new Set(["milestone", "final", "rescue"]);

/** Canonical JSON (fixed key order) so an unchanged manifest serializes byte-identically — lets the publisher skip
 *  a redundant commit when nothing changed (latest-snapshot idempotency; no per-round timestamp churn). */
export function encodeManifest(m: Manifest): string {
  const ordered: Manifest = {
    schemaVersion: 1,
    launchId: m.launchId,
    generation: m.generation,
    kind: m.kind,
    ...(m.goal !== undefined ? { goal: m.goal } : {}),
    ...(m.next !== undefined ? { next: m.next } : {}),
    ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
  };
  return JSON.stringify(ordered);
}

export type ManifestCheck = { ok: true } | { ok: false; reason: string };

/** Shape/size validation shared by parse + publish. */
function validate(o: Record<string, unknown>, serializedLen: number): ManifestCheck {
  if (serializedLen > MAX_MANIFEST_BYTES) return { ok: false, reason: `manifest ${serializedLen}B > ${MAX_MANIFEST_BYTES}B` };
  if (o.schemaVersion !== 1) return { ok: false, reason: "schemaVersion must be 1" };
  if (typeof o.launchId !== "string" || !o.launchId) return { ok: false, reason: "launchId" };
  if (typeof o.generation !== "number" || !Number.isInteger(o.generation) || o.generation < 0) return { ok: false, reason: "generation" };
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return { ok: false, reason: "kind" };
  if (o.goal !== undefined && typeof o.goal !== "string") return { ok: false, reason: "goal" };
  if (o.next !== undefined && typeof o.next !== "string") return { ok: false, reason: "next" };
  if (o.createdAt !== undefined && (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt))) return { ok: false, reason: "createdAt" };
  return { ok: true };
}

/** Parse + validate a manifest read from a pinned commit. Returns null for anything malformed/oversize/partial
 *  (a reader catching a mid-write file degrades to null, never throws). */
export function parseManifest(text: string): Manifest | null {
  if (!text || byteLen(text) > MAX_MANIFEST_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!validate(o, byteLen(text)).ok) return null;
  return {
    schemaVersion: 1,
    launchId: o.launchId as string,
    generation: o.generation as number,
    kind: o.kind as ManifestKind,
    goal: o.goal as string | undefined,
    next: o.next as string | undefined,
    createdAt: o.createdAt as number | undefined,
  };
}

/** Producer-side gate: the box MUST call this before committing a manifest, so it never publishes one the
 *  dispatcher's parseManifest would reject (identical bound). */
export function validateForPublish(m: Manifest): ManifestCheck {
  const encoded = encodeManifest(m);
  return validate(m as unknown as Record<string, unknown>, byteLen(encoded));
}
