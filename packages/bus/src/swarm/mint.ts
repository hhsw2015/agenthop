import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Mint a CPA **ephemeral capability token** — the dispatcher half of the CPA eph-token track.
 *
 * A short-lived HS256 `cpa-eph` JWT a VM presents to CPA as its bearer, so the box never holds the real relay
 * key: CPA's verify path (LIVE) checks alg=HS256 + HMAC(MASTER_SECRET) + iss="cpa-eph" + exp>now. Contract:
 * CLIProxyAPIPlus/docs/cpa-ephemeral-token.md. Offline — HMAC only, never calls CPA. Matches the reference
 * minter CLIProxyAPIPlus/scripts/cpa_mint_eph.py byte-for-byte for the same (secret, now, sub, ttl).
 *
 * Per the user's final spec: TTL-only. `exp` is capped at ≤60 min (the Railway box's life) regardless of the
 * requested ttl, derived from the DISPATCHER's clock (never the VM's — microVM clocks skew). budget_usd/models
 * are reserved, optional, inert on CPA by default.
 */

/** Hard ceiling on a token's lifetime: 60 min = a Railway box's life (contract). */
export const MAX_TTL_SEC = 3600;

export type MintInput = {
  /** Agent / launch id — rides as `sub` for audit only (not a limit). Bind one token to one VM via its launchId. */
  sub: string;
  /** Requested lifetime in seconds; clamped to [1, MAX_TTL_SEC]. Default MAX_TTL_SEC. */
  ttlSec?: number;
  /** Reserved, optional (absent = uncapped). Signed in so it can't be tampered; enforced only if CPA wires a ledger. */
  budgetUsd?: number;
  /** Reserved, optional (absent = CPA's list endpoint returns EMPTY). Controls the /v1/models RESPONSE only, not usage. */
  models?: string[];
  /** Unix seconds; injectable for deterministic tests. Default Date.now()/1000. */
  now?: number;
  /** The shared secret (CPA_EPH_SECRET). Required. Never logged. */
  secret: string;
};

const b64url = (buf: Buffer): string => buf.toString("base64url"); // Node base64url is already unpadded

export function mintEphToken(input: MintInput): string {
  if (!input.sub) throw new Error("mintEphToken: sub (agent/launch id) is required");
  if (!input.secret) throw new Error("mintEphToken: secret is required (CPA_EPH_SECRET)");
  const now = Math.floor(input.now ?? Date.now() / 1000);
  const ttl = Math.min(Math.max(1, Math.floor(input.ttlSec ?? MAX_TTL_SEC)), MAX_TTL_SEC);
  const header = { alg: "HS256", typ: "JWT" };
  // Field order matches the reference minter's payload so the bytes agree for the same inputs.
  const payload: Record<string, unknown> = { iss: "cpa-eph", iat: now, exp: now + ttl, sub: input.sub };
  if (input.budgetUsd !== undefined) payload.budget_usd = input.budgetUsd;
  if (input.models !== undefined) payload.models = input.models;
  const signing = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = b64url(createHmac("sha256", input.secret).update(signing).digest());
  return `${signing}.${sig}`;
}

/** The dispatcher's copy of the shared secret: `CPA_EPH_SECRET` env, else `~/.cpa_eph_secret` (trimmed). Never inject this into a VM. */
export function readEphSecret(): string {
  const env = process.env.CPA_EPH_SECRET?.trim();
  if (env) return env;
  try {
    const fromFile = readFileSync(path.join(homedir(), ".cpa_eph_secret"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through to the error below
  }
  throw new Error("No CPA_EPH_SECRET in the environment and ~/.cpa_eph_secret is missing/empty");
}
