import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DmError, ephemeralKeys, openDm, sealDm, shortId, type SessionKeys } from "../src/dm.js";

const PREFIX = "[[agenthop:bus-dm]] ";

function keys(): SessionKeys {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  return { publicKey: jwk.x!, privateKey: jwk.d! };
}

describe("session keys", () => {
  it("generates fresh matching raw X25519 key pairs", () => {
    const first = ephemeralKeys();
    const second = ephemeralKeys();
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.privateKey).not.toBe(second.privateKey);
    for (const pair of [first, second]) {
      for (const value of Object.values(pair)) {
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(value, "base64url")).toHaveLength(32);
      }
      const privateKey = createPrivateKey({
        key: { kty: "OKP", crv: "X25519", x: pair.publicKey, d: pair.privateKey },
        format: "jwk",
      });
      expect(createPublicKey(privateKey).export({ format: "jwk" }).x).toBe(pair.publicKey);
    }
  });

  it("uses the first 80 hash bits for a deterministic grouped base32 id", () => {
    const publicKey = Buffer.alloc(32).toString("base64url");
    expect(shortId(publicKey)).toBe("mzuh-vlpy-mk6x-o3ep");
    expect(shortId(publicKey)).toMatch(/^[a-z2-7]{4}(?:-[a-z2-7]{4}){3}$/);
    expect(shortId(keys().publicKey)).not.toBe(shortId(publicKey));
  });

  it("rejects malformed public keys with DmError", () => {
    for (const publicKey of ["", "!".repeat(43), "YQ", "a".repeat(44)]) {
      expect(() => shortId(publicKey)).toThrow(DmError);
    }
  });
});

describe("direct message seals", () => {
  it.each(["", "plain text, not JSON", "你好 👋\nsecond line\u0000end", '{"task":"check"}'])(
    "round-trips arbitrary UTF-8 and authenticates the sender: %j",
    (payload) => {
      const alice = keys();
      const bob = keys();
      expect(openDm(bob, sealDm(alice, bob.publicKey, payload))).toEqual({ from: alice.publicKey, payload });
      expect(openDm(alice, sealDm(bob, alice.publicKey, payload))).toEqual({ from: bob.publicKey, payload });
    },
  );

  it("randomizes seals while opening remains stateless", () => {
    const alice = keys();
    const bob = keys();
    const wire = sealDm(alice, bob.publicKey, "repeat");
    expect(sealDm(alice, bob.publicKey, "repeat")).not.toBe(wire);
    expect(openDm(bob, wire)).toEqual(openDm(bob, wire));
  });

  it("does not expose the sender key or payload in the envelope", () => {
    const alice = keys();
    const bob = keys();
    const payload = "private message to the recipient only";
    const wire = sealDm(alice, bob.publicKey, payload);
    expect(wire.startsWith(PREFIX)).toBe(true);
    const raw = Buffer.from(wire.slice(PREFIX.length), "base64url");
    expect(raw.includes(Buffer.from(alice.publicKey, "base64url"))).toBe(false);
    expect(raw.includes(Buffer.from(payload))).toBe(false);
  });

  it("rejects another recipient, the sender, and a wrong private key", () => {
    const alice = keys();
    const bob = keys();
    const stranger = keys();
    const wire = sealDm(alice, bob.publicKey, "for bob");
    for (const recipient of [alice, stranger, { ...bob, privateKey: stranger.privateKey }]) {
      expect(() => openDm(recipient, wire)).toThrow(DmError);
    }
  });

  it("does not let an attacker claim another sender's public key", () => {
    const alice = keys();
    const bob = keys();
    const attacker = keys();
    // Knowing Alice's public key cannot replace the DH secret from her private key.
    const forged = sealDm({ ...attacker, publicKey: alice.publicKey }, bob.publicKey, "I am Alice");
    expect(() => openDm(bob, forged)).toThrow(DmError);
    expect(openDm(bob, sealDm(attacker, bob.publicKey, "I am Alice")).from).toBe(attacker.publicKey);
  });

  it("rejects changes to every byte of the ephemeral key, sender seal, and body seal", () => {
    const bob = keys();
    const wire = sealDm(keys(), bob.publicKey, "authenticated content");
    const raw = Buffer.from(wire.slice(PREFIX.length), "base64url");
    for (let at = 0; at < raw.length; at++) {
      const changed = Buffer.from(raw);
      changed[at] ^= 1;
      expect(() => openDm(bob, PREFIX + changed.toString("base64url")), `byte ${at}`).toThrow(DmError);
    }
  });

  it("rejects truncation, invalid framing, and noncanonical base64url", () => {
    const bob = keys();
    const wire = sealDm(keys(), bob.publicKey, "payload");
    const raw = Buffer.from(wire.slice(PREFIX.length), "base64url");
    for (let length = 0; length < raw.length; length++) {
      expect(() => openDm(bob, PREFIX + raw.subarray(0, length).toString("base64url"))).toThrow(DmError);
    }
    for (const malformed of ["", "hello", PREFIX, PREFIX + "!".repeat(160), wire + "=", wire + "\n", wire.replace(PREFIX, "[[agenthop:invite]] ")]) {
      expect(() => openDm(bob, malformed)).toThrow(DmError);
    }
  });

  it("rejects malformed and low-order keys using DmError", () => {
    const alice = keys();
    const bob = keys();
    const wire = sealDm(alice, bob.publicKey, "payload");
    for (const invalid of ["", "!".repeat(43), "YQ", Buffer.alloc(32).toString("base64url")]) {
      expect(() => sealDm(alice, invalid, "payload")).toThrow(DmError);
      expect(() => openDm({ ...bob, publicKey: invalid }, wire)).toThrow(DmError);
    }
    expect(() => sealDm({ ...alice, privateKey: "bad" }, bob.publicKey, "payload")).toThrow(DmError);
    expect(() => openDm({ ...bob, privateKey: "bad" }, wire)).toThrow(DmError);
  });
});
