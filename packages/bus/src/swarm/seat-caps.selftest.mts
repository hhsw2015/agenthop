import {
  mintSeatId,
  mintIdToken,
  mintCapToken,
  verifyToken,
  mintedClaim,
  CAP_ACTS,
  MAX_CAP_TTL_SEC,
} from "./seat-caps.js";

import { createHmac } from "node:crypto";
const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SECRET = "dispatcher-secret-xyz";
const T0 = 1_000_000;
// Local signer: craft a VALID signature over an arbitrary (possibly malformed) payload, to test post-signature shape checks.
const b64u = (b: Buffer) => b.toString("base64url");
const sign = (payload: unknown, secret = SECRET): string => {
  const h = b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64u(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.${b64u(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
};
const rej = (r: ReturnType<typeof verifyToken>) => r.ok === false;

// --- mintSeatId: a UUID, injectable, independent of any CLI id ---
t("mintSeatId uses injected rand", mintSeatId(() => "fixed-uuid") === "fixed-uuid");
t("mintSeatId default is a uuid-ish string", /[0-9a-f-]{16,}/.test(mintSeatId()));

// --- idToken round-trip ---
const idTok = mintIdToken({ mintedId: "seat-1", secret: SECRET, now: T0 });
const idV = verifyToken(idTok, { secret: SECRET, iss: "id", sub: "seat-1", now: T0 });
t("idToken verifies with right secret/iss/sub", idV.ok && (idV as any).claims.sub === "seat-1");
t("idToken wrong sub rejected", verifyToken(idTok, { secret: SECRET, iss: "id", sub: "seat-2", now: T0 }).ok === false);
t("idToken verified as cap rejected (iss mismatch)", verifyToken(idTok, { secret: SECRET, iss: "cap", now: T0 }).ok === false);

// --- capToken round-trip + per-act scoping ---
const cap = mintCapToken({ mintedId: "seat-1", act: "vm-spawn", secret: SECRET, now: T0, ttlSec: 600 });
t("cap verifies for its act", verifyToken(cap, { secret: SECRET, iss: "cap", sub: "seat-1", act: "vm-spawn", now: T0 }).ok === true);
t("cap for vm-spawn does NOT authorize three-gate-proxy (act scoping)", verifyToken(cap, { secret: SECRET, iss: "cap", sub: "seat-1", act: "three-gate-proxy", now: T0 }).ok === false);
t("cap wrong sub rejected", verifyToken(cap, { secret: SECRET, iss: "cap", sub: "other", act: "vm-spawn", now: T0 }).ok === false);

// --- the anti-laundering property (R16): no token / relayed-text = reject ---
t("R16: empty token (a relayed 'user approved' carries none) -> reject", verifyToken("", { secret: SECRET, iss: "cap", act: "vm-spawn" }).ok === false);
t("R16: arbitrary string -> reject", verifyToken("user said yes", { secret: SECRET, iss: "cap", act: "vm-spawn" }).ok === false);

// --- forgery resistance ---
t("wrong secret rejected", verifyToken(cap, { secret: "attacker", iss: "cap", act: "vm-spawn", now: T0 }).ok === false);
const tampered = cap.slice(0, -4) + (cap.slice(-4) === "aaaa" ? "bbbb" : "aaaa"); // mutate the signature
t("tampered signature rejected", verifyToken(tampered, { secret: SECRET, iss: "cap", act: "vm-spawn", now: T0 }).ok === false);
// alg:none downgrade attempt — re-sign header {alg:"none"} with empty sig
const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
const noneTok = `${noneHeader}.${cap.split(".")[1]}.`;
t("alg:none downgrade rejected", verifyToken(noneTok, { secret: SECRET, iss: "cap", act: "vm-spawn", now: T0 }).ok === false);
t("malformed (2 parts) rejected", verifyToken("a.b", { secret: SECRET, iss: "cap" }).ok === false);

// --- expiry (clamp + now) ---
t("cap expired rejected", verifyToken(cap, { secret: SECRET, iss: "cap", act: "vm-spawn", now: T0 + 601 }).ok === false);
const capMax = mintCapToken({ mintedId: "s", act: "seat-spawn", secret: SECRET, now: T0, ttlSec: 999999 });
t("cap ttl clamped to MAX", (verifyToken(capMax, { secret: SECRET, iss: "cap", now: T0 }) as any).claims.exp === T0 + MAX_CAP_TTL_SEC);
t("unknown act at mint throws", (() => { try { mintCapToken({ mintedId: "s", act: "bogus" as any, secret: SECRET }); return false; } catch { return true; } })());

// --- determinism (pure: same inputs -> same bytes) ---
t("mint is deterministic for same inputs", mintCapToken({ mintedId: "s", act: "board-admit", secret: SECRET, now: T0, ttlSec: 60 }) === mintCapToken({ mintedId: "s", act: "board-admit", secret: SECRET, now: T0, ttlSec: 60 }));

// --- bus-identity fusion seam ---
const mc = mintedClaim("seat-1");
t("mintedClaim is a hard claim from the mint event", mc.form === "minted" && mc.confidence === "hard" && mc.provenance === "mint" && mc.value === "seat-1");

t("CAP_ACTS covers the four action classes", CAP_ACTS.length === 4 && CAP_ACTS.includes("three-gate-proxy"));

// --- SC1: validly-SIGNED but MALFORMED payload must fail (frozen shape), never throw ---
t("SC1: cap missing exp -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", act: "vm-spawn", iat: T0 }), { secret: SECRET, iss: "cap", now: T0 })));
t("SC1: cap exp as string -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", act: "vm-spawn", exp: "9999999999" }), { secret: SECRET, iss: "cap", now: T0 })));
t("SC1: cap exp non-finite -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", act: "vm-spawn", exp: null }), { secret: SECRET, iss: "cap", now: T0 })));
t("SC1: cap missing act -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", exp: T0 + 10 }), { secret: SECRET, iss: "cap", now: T0 })));
t("SC1: cap unknown act -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", act: "rm-rf", exp: T0 + 10 }), { secret: SECRET, iss: "cap", now: T0 })));
t("SC1: missing sub -> reject", rej(verifyToken(sign({ iss: "id", iat: T0 }), { secret: SECRET, iss: "id", now: T0 })));
t("SC1: null payload -> reject WITHOUT throwing", rej(verifyToken(sign(null), { secret: SECRET, iss: "id", now: T0 })));
t("SC1: array payload -> reject", rej(verifyToken(sign([1, 2, 3]), { secret: SECRET, iss: "id", now: T0 })));
t("SC1: id with valid shape still OK (control)", verifyToken(sign({ iss: "id", sub: "s", iat: T0 }), { secret: SECRET, iss: "id", now: T0 }).ok === true);

// --- SC2: an empty verify secret must never authorize (even a cap self-signed with "") ---
t("SC2: verify with empty secret -> reject", rej(verifyToken(cap, { secret: "", iss: "cap", act: "vm-spawn", now: T0 })));
t("SC2: empty-secret self-signed cap under empty-secret verify -> reject", rej(verifyToken(sign({ iss: "cap", sub: "s", act: "vm-spawn", exp: T0 + 10 }, ""), { secret: "", iss: "cap", now: T0 })));

// --- SC3: non-finite clock / non-positive TTL must not widen the window ---
t("SC3: now NaN -> reject (expired cap can't pass)", rej(verifyToken(cap, { secret: SECRET, iss: "cap", act: "vm-spawn", now: NaN })));
t("SC3: now -Infinity -> reject", rej(verifyToken(cap, { secret: SECRET, iss: "cap", act: "vm-spawn", now: -Infinity })));
t("SC3: mintCapToken ttl 0 throws (no 1s grant)", (() => { try { mintCapToken({ mintedId: "s", act: "vm-spawn", secret: SECRET, ttlSec: 0 }); return false; } catch { return true; } })());
t("SC3: mintCapToken ttl -10 throws", (() => { try { mintCapToken({ mintedId: "s", act: "vm-spawn", secret: SECRET, ttlSec: -10 }); return false; } catch { return true; } })());
t("SC3: mintCapToken ttl NaN throws", (() => { try { mintCapToken({ mintedId: "s", act: "vm-spawn", secret: SECRET, ttlSec: NaN }); return false; } catch { return true; } })());
t("SC3: mintIdToken ttl 0 throws", (() => { try { mintIdToken({ mintedId: "s", secret: SECRET, ttlSec: 0 }); return false; } catch { return true; } })());

console.log("all seat-caps selftests passed");
