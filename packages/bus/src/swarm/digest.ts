/**
 * Canonical JSON + SHA-256 for the business-orchestration (brain) layer. Every cross-boundary identity in the brain
 * design is "canonical JSON's SHA-256": planDigest / specDigest (task-plan.ts), inputBindingDigest (task-state.ts),
 * resultClosureDigest and the §2.6 operation payload digests (task-result.ts). The producer (box worker copies the
 * digest back) and the consumer (dispatcher validator) MUST serialize byte-identically or every V4/V5/V6 comparison
 * silently fails — the exact producer/consumer-mismatch class manifest.ts already learned (one shared encoder, both
 * ends). So the canonicalization lives in ONE place with a fixed rule:
 *   - object keys sorted (insertion order is NOT semantic), recursively;
 *   - array order preserved (order IS semantic — e.g. plan.nodes tie-break, §2.1);
 *   - `undefined` fields dropped (same as absent); `null` kept;
 *   - non-finite numbers rejected — a digest input must be fully defined, never NaN/Infinity (which JSON.stringify
 *     would silently turn into `null` and collapse two different inputs to one digest).
 * Callers that need a stable array digest (e.g. inputBindings) sort the array themselves on a declared key BEFORE
 * hashing — this module never reorders arrays for them.
 */

import { createHash } from "node:crypto";

/** Deterministic JSON string: recursively sorted object keys, preserved array order, dropped `undefined`. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new Error(`canonicalJson: non-finite number ${String(v)}`);
    return JSON.stringify(v);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((e) => (e === undefined ? "null" : serialize(e))).join(",") + "]";
  if (t === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(o[k])).join(",") + "}";
  }
  // undefined at a position a value is required, or bigint/function/symbol: not a valid digest input.
  throw new Error(`canonicalJson: unsupported value of type ${t}`);
}

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 (hex) of a value's canonical JSON — the one digest primitive all brain identities are built on. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
