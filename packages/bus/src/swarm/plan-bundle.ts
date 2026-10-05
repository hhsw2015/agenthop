/**
 * T3b resume-bundle + policy-version store (design 1d0a1ffc §1 line 20 "被引用版本以 digest 寻址的耐久快照留存" + line 21
 * "payloadRef 指向不可变快照 bundle{原草案+PRD 版本+frozenContext 版本引用}" + coordinator point 2) — the IO half.
 *
 * Two content-addressed stores, both immutable by construction and crash-safe (write to a temp file + atomic rename, so a
 * half-written file never sits at a final digest path, and a load always re-verifies digestOf(content)===ref):
 *   - resume bundle: {draft, prdDigest, frozenRefs(version strings), frozenContextDigest, planningRequestId}. payloadRef =
 *     digestOf(bundle). frozenRefs is the identity the PLAN carries; frozenContextDigest resolves the FULL policy content.
 *   - frozenContext snapshot: the full FrozenContext stored by its own digest, so a resume/replay reads EXACTLY the same
 *     policy versions (line 20's durable version retention). The plan still carries version refs only (no identity pollution).
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { digestOf, sha256Hex, canonicalJson } from "./digest.js";
import type { Draft, FrozenContext } from "./task-translate.js";
import type { FrozenRefs } from "./task-plan.js";

/** The immutable resume snapshot. planningRequestId is the request-round identity threaded through to operationId minting. */
export type ResumeBundle = {
  draft: Draft;
  /** PRD version = its content digest (provenance); the bundle need not carry the PRD text to recompile. */
  prdDigest: string;
  /** frozenContext VERSION refs (what the plan carries, for identity). */
  frozenRefs: FrozenRefs;
  /** Content digest of the full FrozenContext snapshot (how resume resolves the exact policy content). */
  frozenContextDigest: string;
  planningRequestId: string;
};

export function defaultBundleDir(): string {
  return path.join(homedir(), ".agenthop", "swarm", "bundles");
}
export function defaultPolicyDir(): string {
  return path.join(homedir(), ".agenthop", "swarm", "policies");
}

/** payloadRef = the content-addressed digest of the bundle (pure; no IO). */
export function bundleDigest(bundle: ResumeBundle): string {
  return digestOf(bundle);
}
/** PRD text -> its version digest (the value to put in ResumeBundle.prdDigest). */
export function prdDigestOf(prd: string): string {
  return sha256Hex(prd);
}

/** The frozenRefs (version strings) a FrozenContext projects to — the exact shape translateDraft stamps onto a plan.
 *  A test pins this equals translateDraft's output so the two never drift. */
export function frozenRefsOf(fc: FrozenContext): FrozenRefs {
  return {
    checkRegistry: fc.checkRegistry.version,
    ownerDomainPolicy: fc.ownerDomainPolicy.version,
    riskPolicy: fc.riskPolicy.version,
    roleCatalog: fc.roleCatalog.version,
    budgetPolicy: fc.budgetPolicy.version,
    r4ThresholdPolicy: fc.r4ThresholdPolicy.version,
    sourceBaselineDigest: fc.sourceBaselineDigest,
    ...(fc.planningRequestId !== undefined ? { planningRequestId: fc.planningRequestId } : {}),
  };
}

/** Write the exact hashed bytes atomically: temp file (unique name) + rename, 0600. A crash leaves at most an orphan temp,
 *  never a half-written file at the final digest path (reviewer: a partial file otherwise passes a later existsSync and
 *  then fails every load). Idempotent — content-addressed, so a re-store writes the same bytes. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
function loadVerified<T>(file: string, ref: string, what: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    throw new Error(`${what}: cannot read/parse ${file}: ${(e as Error).message}`);
  }
  const actual = digestOf(parsed);
  if (actual !== ref) throw new Error(`${what}: integrity check failed for ${ref} (content digests to ${actual}) — snapshot tampered`);
  return parsed;
}

export function storeBundle(bundle: ResumeBundle, dir = defaultBundleDir()): string {
  const payloadRef = bundleDigest(bundle);
  writeAtomic(path.join(dir, `${payloadRef}.json`), canonicalJson(bundle));
  return payloadRef;
}
export function loadBundle(payloadRef: string, dir = defaultBundleDir()): ResumeBundle {
  if (!/^[0-9a-f]{64}$/.test(payloadRef)) throw new Error(`loadBundle: payloadRef must be a 64-hex digest, got "${payloadRef}"`);
  return loadVerified<ResumeBundle>(path.join(dir, `${payloadRef}.json`), payloadRef, "loadBundle");
}

/** Durable version retention (line 20): store the FULL FrozenContext by its content digest; returns that digest. */
export function storeFrozenContext(fc: FrozenContext, dir = defaultPolicyDir()): string {
  const d = digestOf(fc);
  writeAtomic(path.join(dir, `${d}.json`), canonicalJson(fc));
  return d;
}
export function loadFrozenContext(digest: string, dir = defaultPolicyDir()): FrozenContext {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`loadFrozenContext: digest must be 64-hex, got "${digest}"`);
  return loadVerified<FrozenContext>(path.join(dir, `${digest}.json`), digest, "loadFrozenContext");
}
