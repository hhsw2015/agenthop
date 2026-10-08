import {
  mintSeatId,
  mintIdToken,
  mintCapToken,
  verifyToken,
  mintedClaim,
  CAP_ACTS,
  MAX_CAP_TTL_SEC,
} from "./seat-caps.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SECRET = "dispatcher-secret-xyz";
const T0 = 1_000_000;

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

console.log("all seat-caps selftests passed");
