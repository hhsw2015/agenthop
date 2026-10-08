/**
 * seat-caps — minted seat identity + HMAC capability credentials (S14 C8).
 *
 * Closes two bug families at the code layer:
 *  - F40 drift: a seat's identity is a COORDINATOR-MINTED UUID (`mintedId`), issued in the spawn/birth-cert envelope —
 *    NOT the CLI's self-reported thread id (which changes on restart/new thread). The node carries a signed `idToken`
 *    to self-PROVE it (holding a signature, not just asserting a UUID).
 *  - R16 relay laundering: an authorized action (vm-spawn / three-gate-proxy / …) requires a `cap` credential HMAC-signed
 *    by the dispatcher's secret. A peer that merely RELAYS "the user approved" carries no cap ⇒ it fails verification ⇒
 *    structurally cannot launder authority. The secret stays dispatcher-side and is NEVER injected into a node.
 *
 * Generalizes the proven `mint.ts` HMAC pattern (CPA eph-token) and ADDS the verify half (the gate execution points
 * call). Pure mint/verify above the line (selftested); the dispatcher-secret reader (IO) below. The two wiring points —
 * ISSUE at spawn, VERIFY at execution — are dormant until separately flipped (like SWARM_BOARD_ADMIT); this module
 * changes no existing runtime.
 *
 * HARD BOUNDARY (unchanged stance): a `cap` proves DISPATCHER authorization, NOT user authorization. For the three
 * gates (money / external-publish / irreversible) the dispatcher mints the matching cap ONLY AFTER a genuine user gate
 * is satisfied — the cap is execution-layer enforcement, the user gate remains the issuance precondition. A cap never
 * bypasses the user.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ============================================================================================================
// Pure core — mint + verify (selftested in seat-caps.selftest.mts)
// ============================================================================================================

/** Authorized action classes a `cap` can grant. */
export type CapAct = "vm-spawn" | "three-gate-proxy" | "board-admit" | "seat-spawn";
export const CAP_ACTS: readonly CapAct[] = ["vm-spawn", "three-gate-proxy", "board-admit", "seat-spawn"];

/** Hard ceiling on a cap's lifetime (= a Railway box's life; short exp is the v1 revocation story). */
export const MAX_CAP_TTL_SEC = 3600;

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** HS256-sign a claim set → compact JWT. Deterministic given the secret. Pure. */
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signing = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = b64url(createHmac("sha256", secret).update(signing).digest());
  return `${signing}.${sig}`;
}

/** Coordinator mints a seat's STABLE identity: a UUID, independent of any CLI-reported thread id. Pure (injectable rand). */
export function mintSeatId(rand: () => string = () => randomUUID()): string {
  return rand();
}

/** Identity credential (`iss:"id"`): proves the holder is the coordinator-minted `mintedId`. Issued at spawn; `ttlSec`
 *  optional (omit = seat-lifetime, bounded by secret rotation). Pure. */
export function mintIdToken(input: { mintedId: string; secret: string; now?: number; ttlSec?: number }): string {
  if (!input.mintedId) throw new Error("mintIdToken: mintedId required");
  if (!input.secret) throw new Error("mintIdToken: secret required");
  const now = Math.floor(input.now ?? Date.now() / 1000);
  const payload: Record<string, unknown> = { iss: "id", sub: input.mintedId, iat: now };
  if (input.ttlSec !== undefined) payload.exp = now + Math.max(1, Math.floor(input.ttlSec));
  return signHs256(payload, input.secret);
}

/** Capability credential (`iss:"cap"`): authorizes `mintedId` to perform `act` until `exp`. TTL clamped to [1, MAX]. Pure. */
export function mintCapToken(input: { mintedId: string; act: CapAct; secret: string; ttlSec?: number; now?: number; nonce?: string }): string {
  if (!input.mintedId) throw new Error("mintCapToken: mintedId required");
  if (!CAP_ACTS.includes(input.act)) throw new Error(`mintCapToken: unknown act ${input.act}`);
  if (!input.secret) throw new Error("mintCapToken: secret required");
  const now = Math.floor(input.now ?? Date.now() / 1000);
  const ttl = Math.min(Math.max(1, Math.floor(input.ttlSec ?? MAX_CAP_TTL_SEC)), MAX_CAP_TTL_SEC);
  const payload: Record<string, unknown> = { iss: "cap", sub: input.mintedId, act: input.act, iat: now, exp: now + ttl };
  if (input.nonce) payload.nonce = input.nonce;
  return signHs256(payload, input.secret);
}

export type VerifyResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Verify a token — the ONLY gate an execution point calls. Checks, in order: present + well-formed → header `alg=HS256`
 * (blocks `alg:none` / algorithm-downgrade) → HMAC signature (constant-time) → `iss` match → not expired → optional
 * `sub` match → optional `act` match (cap only). A missing token (`""`) or a relayed message carrying no token simply
 * fails at step 1 — that IS the anti-laundering property. Pure (secret + now injected).
 */
export function verifyToken(token: string, opts: { secret: string; iss: "id" | "cap"; now?: number; sub?: string; act?: CapAct }): VerifyResult {
  if (typeof token !== "string" || !token) return { ok: false, reason: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, sig] = parts;
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad header" };
  }
  if ((header as { alg?: unknown })?.alg !== "HS256") return { ok: false, reason: "alg not HS256" };
  const expected = b64url(createHmac("sha256", opts.secret).update(`${h}.${p}`).digest());
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad signature" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (claims.iss !== opts.iss) return { ok: false, reason: `iss mismatch (want ${opts.iss})` };
  const now = Math.floor(opts.now ?? Date.now() / 1000);
  if (claims.exp !== undefined && now >= (claims.exp as number)) return { ok: false, reason: "expired" };
  if (opts.sub !== undefined && claims.sub !== opts.sub) return { ok: false, reason: "sub mismatch" };
  if (opts.iss === "cap" && opts.act !== undefined && claims.act !== opts.act) return { ok: false, reason: "act mismatch" };
  return { ok: true, claims };
}

/** The identity claim a minted seat contributes to bus-identity (the fusion seam, §③). `form:"minted"` is a HARD claim
 *  whose provenance is the mint event — entityId anchors it over the drift-prone thread id. Pure shape builder; wiring
 *  it into recordSelfObserve/announce is a dormant future flip (not done here). */
export function mintedClaim(mintedId: string): { value: string; form: "minted"; confidence: "hard"; provenance: "mint" } {
  return { value: mintedId, form: "minted", confidence: "hard", provenance: "mint" };
}

// ============================================================================================================
// IO shell — dispatcher-secret reader (NOT wired; the verify/issue points read it when the flip lands)
// ============================================================================================================

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** `seat-identity-caps` wiring flip, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT). */
export function seatCapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_SEAT_CAPS ?? "");
}

/** The dispatcher's signing/verifying secret: `DISPATCHER_SECRET` env, else `~/.agenthop/dispatcher_secret`. NEVER inject
 *  this into a node — nodes hold pre-signed tokens, only the dispatcher + execution-point verifiers hold the secret. */
export function readDispatcherSecret(): string {
  const env = process.env.DISPATCHER_SECRET;
  if (env && env.trim()) return env.trim();
  try {
    const fromFile = readFileSync(path.join(homedir(), ".agenthop", "dispatcher_secret"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through
  }
  throw new Error("No DISPATCHER_SECRET in the environment and ~/.agenthop/dispatcher_secret is missing/empty");
}
