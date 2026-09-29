import { createHash, createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * OWNER: Codex. Do not let the integration side edit the bodies here.
 *
 * A "team" is the shared secret that scopes the cross-machine bus. Everyone who sets the same
 * AGENTHOP_TEAM secret is on one bus and can see one roster. The secret never reaches the relay:
 * only `nsId` (a hash) is sent, and roster entries are sealed under `nsKey`.
 *
 * Model this on packages/cli/src/seal.ts (aes-256-gcm) and packages/cli/src/identity.ts
 * (writePrivate for the 0600 config file). Keep everything here PURE crypto/config: no relay,
 * no tunnel, no MCP.
 */

export class TeamError extends Error {}

const KEY_INFO = "agenthop bus roster key v1";
const ENTRY_AAD = Buffer.from("agenthop bus roster entry v1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type Team = {
  /** Public namespace id sent to the relay (never reveals the secret). Hex sha256 of the secret. */
  nsId: string;
  /** 32-byte symmetric key for sealing roster entries. Derived from the secret via hkdf. */
  nsKey: Buffer;
};

/** Derive a Team from a raw secret string. Pure and deterministic. */
export function deriveTeam(secret: string): Team {
  validateSecret(secret);
  try {
    const raw = Buffer.from(secret, "utf8");
    return {
      nsId: createHash("sha256").update(raw).digest("hex"),
      nsKey: Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), KEY_INFO, 32)),
    };
  } catch (cause) {
    throw new TeamError("Could not derive team keys", { cause });
  }
}

/**
 * The team in effect: env AGENTHOP_TEAM first, then <home>/bus.json's `team` field, else undefined.
 * undefined means the relay layer stays off and only the local broker runs.
 */
export function loadTeam(home: string = path.join(homedir(), ".agenthop")): Team | undefined {
  const env = process.env.AGENTHOP_TEAM;
  if (env !== undefined) return deriveTeam(env);
  const config = readConfig(home);
  return typeof config.team === "string" ? deriveTeam(config.team) : undefined;
}

/** Persist a team secret to <home>/bus.json (mode 0600, whole-file write like identity.ts). */
export function setTeam(secret: string, home: string = path.join(homedir(), ".agenthop")): void {
  validateSecret(secret);
  const config = readConfig(home);
  let next: string | undefined;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, "bus.json");
    next = `${file}.new-${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(next, `${JSON.stringify({ ...config, team: secret }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } catch (cause) {
      // An exclusive-create collision belongs to somebody else; do not remove it.
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") next = undefined;
      throw cause;
    }
    chmodSync(next, 0o600);
    renameSync(next, file);
    next = undefined;
  } catch (cause) {
    throw new TeamError("Could not save team config", { cause });
  } finally {
    if (next !== undefined) {
      try { unlinkSync(next); } catch { /* Preserve the original write failure. */ }
    }
  }
}

/** Seal a roster entry (utf8 JSON) under nsKey. Returns base64url. aes-256-gcm with a random nonce. */
export function sealEntry(nsKey: Buffer, plaintext: string): string {
  validateKey(nsKey);
  if (typeof plaintext !== "string") throw new TeamError("Entry must be a string");
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", nsKey, nonce);
    cipher.setAAD(ENTRY_AAD);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    // Wire format: 12-byte nonce || ciphertext || 16-byte authentication tag.
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
  } catch (cause) {
    throw new TeamError("Could not seal roster entry", { cause });
  }
}

/** Open an entry produced by sealEntry. Throws TeamError on a wrong key or tampering. */
export function openEntry(nsKey: Buffer, sealed: string): string {
  validateKey(nsKey);
  if (typeof sealed !== "string" || !/^[A-Za-z0-9_-]+$/.test(sealed)) {
    throw new TeamError("Invalid sealed entry encoding");
  }
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < NONCE_BYTES + TAG_BYTES || raw.toString("base64url") !== sealed) {
    throw new TeamError("Invalid sealed entry encoding");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", nsKey, raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(ENTRY_AAD);
    decipher.setAuthTag(raw.subarray(-TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, -TAG_BYTES)), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (cause) {
    throw new TeamError("Could not authenticate roster entry", { cause });
  }
}

function validateSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new TeamError("Team secret must be a nonempty string");
  }
}

function validateKey(key: unknown): asserts key is Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TeamError("Team key must be a 32-byte Buffer");
  }
}

function readConfig(home: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path.join(home, "bus.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new TeamError("Could not read team config", { cause });
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (cause) {
    throw new TeamError("Invalid team config JSON", { cause });
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TeamError("Team config must be an object");
  }
  const fields = config as Record<string, unknown>;
  if ("team" in fields) validateSecret(fields.team);
  return fields;
}
