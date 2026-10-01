import { createHmac, timingSafeEqual } from "node:crypto";
import { expect, test } from "vitest";
import { MAX_TTL_SEC, mintEphToken, normalizeEphSecret } from "../src/swarm/mint.js";

const SECRET = "test-eph-secret-not-the-real-one"; // never the real /Users/.cpa_eph_secret

/** Replicate CPA's verify (internal/access/config_access/provider.go:verifyEphToken) so a passing test means
 *  CPA would accept the token: alg=HS256, HMAC matches the secret, iss="cpa-eph", exp>now. */
function cpaVerify(token: string, secret: string, now: number): { ok: boolean; reason?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "shape" };
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h!, "base64url").toString());
  if (header.alg !== "HS256") return { ok: false, reason: "alg" }; // reject alg:none / confusion
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s!, "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "sig" };
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  if (payload.iss !== "cpa-eph") return { ok: false, reason: "iss" };
  if (!(payload.exp > now)) return { ok: false, reason: "exp" };
  return { ok: true };
}

const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

test("mints a well-formed cpa-eph JWT CPA would accept", () => {
  const now = 1_700_000_000;
  const token = mintEphToken({ sub: "launch-1", ttlSec: 1800, now, secret: SECRET });
  expect(token.split(".")).toHaveLength(3);
  const p = decode(token);
  expect(p).toMatchObject({ iss: "cpa-eph", iat: now, exp: now + 1800, sub: "launch-1" });
  expect(cpaVerify(token, SECRET, now)).toEqual({ ok: true });
});

test("exp is capped at 60 min (box life) regardless of the requested ttl", () => {
  const now = 1_700_000_000;
  expect(decode(mintEphToken({ sub: "x", ttlSec: 999_999, now, secret: SECRET })).exp).toBe(now + MAX_TTL_SEC);
  expect(decode(mintEphToken({ sub: "x", now, secret: SECRET })).exp).toBe(now + MAX_TTL_SEC); // default = cap
});

test("verification fails on a tampered payload, the wrong secret, and after expiry", () => {
  const now = 1_700_000_000;
  const token = mintEphToken({ sub: "launch-1", ttlSec: 600, now, secret: SECRET });
  expect(cpaVerify(token, SECRET, now).ok).toBe(true);
  // wrong secret
  expect(cpaVerify(token, "other-secret", now)).toEqual({ ok: false, reason: "sig" });
  // tampered payload (flip sub) keeps the old sig → sig mismatch
  const [h, p, s] = token.split(".");
  const evil = JSON.parse(Buffer.from(p!, "base64url").toString());
  evil.sub = "attacker";
  const forged = `${h}.${Buffer.from(JSON.stringify(evil)).toString("base64url")}.${s}`;
  expect(cpaVerify(forged, SECRET, now)).toEqual({ ok: false, reason: "sig" });
  // expired: now past exp
  expect(cpaVerify(token, SECRET, now + 601)).toEqual({ ok: false, reason: "exp" });
});

test("optional reserved claims (budget_usd, models) are signed in when present, absent otherwise", () => {
  const now = 1_700_000_000;
  const plain = decode(mintEphToken({ sub: "x", now, secret: SECRET }));
  expect(plain.budget_usd).toBeUndefined();
  expect(plain.models).toBeUndefined();
  const withClaims = mintEphToken({ sub: "x", budgetUsd: 5, models: ["claude-opus-5"], now, secret: SECRET });
  expect(decode(withClaims)).toMatchObject({ budget_usd: 5, models: ["claude-opus-5"] });
  expect(cpaVerify(withClaims, SECRET, now).ok).toBe(true); // still verifies (claims are inside the signed payload)
});

test("normalizeEphSecret extracts the raw value from a dotenv-formatted file or a bare value", () => {
  const hex = "a".repeat(64);
  expect(normalizeEphSecret(`${hex}\n`)).toBe(hex); // bare value + newline
  expect(normalizeEphSecret(`CPA_EPH_SECRET=${hex}\n`)).toBe(hex); // dotenv line (the live-mismatch root cause)
  expect(normalizeEphSecret(`CPA_EPH_SECRET = ${hex}`)).toBe(hex); // tolerant of spaces
});

test("matches the reference minter's construction byte-for-byte for a pinned input", () => {
  const now = 1_700_000_000;
  const sub = "ref-check";
  const ttl = 3600;
  // Independent reconstruction mirroring scripts/cpa_mint_eph.py (compact JSON, same field order, base64url no pad).
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signing = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "cpa-eph", iat: now, exp: now + ttl, sub })}`;
  const expected = `${signing}.${createHmac("sha256", SECRET).update(signing).digest().toString("base64url")}`;
  expect(mintEphToken({ sub, ttlSec: ttl, now, secret: SECRET })).toBe(expected);
});
