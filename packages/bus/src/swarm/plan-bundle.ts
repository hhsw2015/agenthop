/**
 * T3b resume-bundle store/retrieve (design 1d0a1ffc §1 "payloadRef 指向不可变快照 bundle{原草案+PRD 版本+frozenContext
 * 版本引用}" + coordinator point 2) — the IO half. The immutable snapshot a needsClarification wait points at via its
 * payloadRef (the field already lives on WaitRecord/NewQueryWait from T3a; this stores and verifies the content).
 *
 * Content-addressed = immutable by construction: payloadRef = digestOf(bundle), the file is named by that digest, a
 * second store of identical content is a no-op, and load RE-VERIFIES digestOf(parsed) === payloadRef so a tampered or
 * truncated snapshot is rejected rather than silently recompiled. The frozenContext is stored by VERSION REF (frozenRefs),
 * not inline — the resume flow resolves those refs back to the full policy to re-translate (keeps registry text out of
 * plan identity, design line 20). PRD is kept by digest (version) for provenance; the draft is what recompile needs.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { digestOf, sha256Hex, canonicalJson } from "./digest.js";
import type { Draft } from "./task-translate.js";
import type { FrozenRefs } from "./task-plan.js";

/** The immutable resume snapshot. planningRequestId is the request-round identity threaded through to operationId minting. */
export type ResumeBundle = {
  draft: Draft;
  /** PRD version = its content digest (provenance); the bundle need not carry the PRD text to recompile. */
  prdDigest: string;
  /** frozenContext VERSION refs (not inline) — the resume flow resolves these to the full policy. */
  frozenRefs: FrozenRefs;
  planningRequestId: string;
};

export function defaultBundleDir(): string {
  return path.join(homedir(), ".agenthop", "swarm", "bundles");
}

/** payloadRef = the content-addressed digest of the bundle (pure; no IO). */
export function bundleDigest(bundle: ResumeBundle): string {
  return digestOf(bundle);
}

/** Helper: PRD text -> its version digest (the value to put in ResumeBundle.prdDigest). */
export function prdDigestOf(prd: string): string {
  return sha256Hex(prd);
}

/** Store the immutable snapshot; returns its payloadRef. Idempotent — identical content already on disk is a no-op
 *  (content-addressed), so re-storing never rewrites a snapshot. 0600: planning scope data is not world-readable. */
export function storeBundle(bundle: ResumeBundle, dir = defaultBundleDir()): string {
  const payloadRef = bundleDigest(bundle);
  const file = path.join(dir, `${payloadRef}.json`);
  if (existsSync(file)) return payloadRef; // content-addressed => already the same bytes
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, canonicalJson(bundle), { mode: 0o600 }); // exact hashed bytes => file digests back to payloadRef
  return payloadRef;
}

/** Retrieve + integrity-check a snapshot by payloadRef. Throws if missing, unparseable, or if the stored content's
 *  digest no longer matches the ref (tamper / truncation) — never recompile from a mutated snapshot. */
export function loadBundle(payloadRef: string, dir = defaultBundleDir()): ResumeBundle {
  if (!/^[0-9a-f]{64}$/.test(payloadRef)) throw new Error(`loadBundle: payloadRef must be a 64-hex digest, got "${payloadRef}"`);
  const file = path.join(dir, `${payloadRef}.json`);
  let parsed: ResumeBundle;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as ResumeBundle;
  } catch (e) {
    throw new Error(`loadBundle: cannot read/parse ${file}: ${(e as Error).message}`);
  }
  const actual = bundleDigest(parsed);
  if (actual !== payloadRef) throw new Error(`loadBundle: integrity check failed for ${payloadRef} (content digests to ${actual}) — snapshot tampered`);
  return parsed;
}
