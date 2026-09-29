import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createHash } from "node:crypto";

/**
 * OWNER: Codex. Do not let the integration side edit the bodies here.
 *
 * A session's cryptographic identity and the sealing of direct messages between two sessions.
 * Model the sealing on packages/cli/src/invite.ts (Noise-IK): the recipient learns and can verify
 * the sender's public key by opening it, and the relay cannot tell who is talking to whom.
 * Model the key generation + base32 shortId on packages/cli/src/identity.ts.
 *
 * Keep everything here PURE crypto: no relay, no tunnel, no fs, no MCP. Payload is arbitrary utf8
 * (the integration layer puts JSON in it); do not assume any structure.
 */

export class DmError extends Error {}

const PREFIX = "[[agenthop:bus-dm]] ";
const AAD = Buffer.from("agenthop-bus-dm-v1");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SENDER_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

export type SessionKeys = {
  /** Raw 32-byte X25519 public key, base64url. This is the session's address on the bus. */
  publicKey: string;
  /** Raw 32-byte X25519 private scalar, base64url. Never leaves this process. */
  privateKey: string;
};

/** A fresh X25519 key pair for this session. Not persisted (a session is short-lived). */
export function ephemeralKeys(): SessionKeys {
  try {
    const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
    return { publicKey: jwk.x!, privateKey: jwk.d! };
  } catch {
    throw new DmError("cannot_generate_keys");
  }
}

/** A short, readable id derived from a public key (sha256 -> base32 in groups of four). */
export function shortId(publicKey: string): string {
  const digest = createHash("sha256").update(keyBytes(publicKey)).digest().subarray(0, 10);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >> bits) & 31];
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/**
 * Seal `payload` to `recipientPub` so that only the recipient can open it and, on opening, is
 * assured which sender wrote it. Noise-IK shape. Returns a self-contained wire string.
 */
export function sealDm(sender: SessionKeys, recipientPub: string, payload: string): string {
  try {
    const ephemeral = ephemeralKeys();
    const e = keyBytes(ephemeral.publicKey);
    const r = keyBytes(recipientPub);
    const s = keyBytes(sender.publicKey);
    const es = agree(ephemeral, recipientPub);
    const ss = agree(sender, recipientPub);
    const sealedSender = seal(derive(es, Buffer.concat([e, r]), "agenthop bus dm sender v1"), s);
    const body = seal(
      derive(Buffer.concat([es, ss]), Buffer.concat([e, r, s]), "agenthop bus dm body v1"),
      Buffer.from(payload, "utf8"),
    );
    return PREFIX + Buffer.concat([e, sealedSender, body]).toString("base64url");
  } catch {
    throw new DmError("cannot_seal_dm");
  }
}

export type OpenedDm = {
  /** The sender's public key, base64url — authenticated by the seal, not merely claimed. */
  from: string;
  payload: string;
};

/** Open a DM sealed to us. Throws DmError if it is not for us, was tampered with, or is malformed. */
export function openDm(recipient: SessionKeys, wire: string): OpenedDm {
  try {
    if (!wire.startsWith(PREFIX)) throw new DmError("not_a_dm");
    const encoded = wire.slice(PREFIX.length);
    const raw = Buffer.from(encoded, "base64url");
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || raw.toString("base64url") !== encoded) {
      throw new DmError("invalid_encoding");
    }
    if (raw.length < KEY_BYTES + SENDER_BYTES + NONCE_BYTES + TAG_BYTES) {
      throw new DmError("incomplete_dm");
    }
    const e = raw.subarray(0, KEY_BYTES);
    const r = keyBytes(recipient.publicKey);
    const es = agree(recipient, e.toString("base64url"));
    const s = open(
      derive(es, Buffer.concat([e, r]), "agenthop bus dm sender v1"),
      raw.subarray(KEY_BYTES, KEY_BYTES + SENDER_BYTES),
    );
    const from = s.toString("base64url");
    const ss = agree(recipient, from);
    const body = open(
      derive(Buffer.concat([es, ss]), Buffer.concat([e, r, s]), "agenthop bus dm body v1"),
      raw.subarray(KEY_BYTES + SENDER_BYTES),
    );
    return { from, payload: body.toString("utf8") };
  } catch {
    throw new DmError("cannot_open_dm");
  }
}

function keyBytes(encoded: string): Buffer {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new DmError("invalid_key");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== KEY_BYTES || bytes.toString("base64url") !== encoded) throw new DmError("invalid_key");
  return bytes;
}

function agree(own: SessionKeys, publicKey: string): Buffer {
  keyBytes(own.publicKey);
  keyBytes(own.privateKey);
  keyBytes(publicKey);
  return diffieHellman({
    privateKey: createPrivateKey({
      key: { kty: "OKP", crv: "X25519", x: own.publicKey, d: own.privateKey },
      format: "jwk",
    }),
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" }),
  });
}

function derive(secret: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, info, KEY_BYTES));
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function open(key: Buffer, raw: Buffer): Buffer {
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new DmError("incomplete_seal");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
}
