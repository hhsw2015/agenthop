import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveTeam, loadTeam, openEntry, sealEntry, setTeam, TeamError } from "../src/team.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "agenthop-team-"));
  vi.stubEnv("AGENTHOP_TEAM", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test("team derivation has a stable namespace and domain-separated key", () => {
  const team = deriveTeam("bus fixture team secret");
  expect(team.nsId).toBe("671b909ffd6193534fceb203dd58ce94b8169367d1cae0251594e32828d8c122");
  expect(team.nsKey.toString("hex")).toBe("517be52ff917893b65bbd9e9b349c2b052d506e14d6d6fc4e5212b30468244cd");
  expect(deriveTeam("bus fixture team secret")).toEqual(team);
  expect(deriveTeam("another secret").nsId).not.toBe(team.nsId);
  expect(deriveTeam(" another secret ").nsId).not.toBe(deriveTeam("another secret").nsId);
});

test.each(["", " \t\n", undefined, null, 42])("rejects invalid secret %j", (secret) => {
  expect(() => deriveTeam(secret as string)).toThrow(TeamError);
  expect(() => setTeam(secret as string, home)).toThrow(TeamError);
  expect(existsSync(path.join(home, "bus.json"))).toBe(false);
});

test("absent config or absent team leaves relay disabled without writing", () => {
  expect(loadTeam(path.join(home, "not-created"))).toBeUndefined();
  expect(existsSync(path.join(home, "not-created"))).toBe(false);
  writeFileSync(path.join(home, "bus.json"), JSON.stringify({ unrelated: true }));
  expect(loadTeam(home)).toBeUndefined();
});

test("environment takes precedence even over a malformed config", () => {
  writeFileSync(path.join(home, "bus.json"), "{invalid");
  vi.stubEnv("AGENTHOP_TEAM", "环境团队 🔐");
  expect(loadTeam(home)).toEqual(deriveTeam("环境团队 🔐"));
  vi.stubEnv("AGENTHOP_TEAM", "");
  expect(() => loadTeam(home)).toThrow(TeamError);
});

test("config round trips through atomic private writes and preserves other fields", () => {
  const nestedHome = path.join(home, "nested");
  setTeam("first secret", nestedHome);
  const file = path.join(nestedHome, "bus.json");
  expect(loadTeam(nestedHome)).toEqual(deriveTeam("first secret"));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeFileSync(file, JSON.stringify({ team: "first secret", relay: "test-relay", options: { enabled: true } }));
  chmodSync(file, 0o644);
  setTeam("second secret", nestedHome);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ team: "second secret", relay: "test-relay", options: { enabled: true } });
  expect(loadTeam(nestedHome)).toEqual(deriveTeam("second secret"));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(nestedHome)).toEqual(["bus.json"]);
});

test.each(["not-json", "null", "[]", "42", '"string"', '{"team":null}', '{"team":42}', '{"team":""}']) (
  "rejects malformed config %s without replacing it",
  (config) => {
    const file = path.join(home, "bus.json");
    writeFileSync(file, config);
    expect(() => loadTeam(home)).toThrow(TeamError);
    expect(() => setTeam("valid secret", home)).toThrow(TeamError);
    expect(readFileSync(file, "utf8")).toBe(config);
  },
);

test("filesystem errors are reported as TeamError", () => {
  mkdirSync(path.join(home, "bus.json"));
  expect(() => loadTeam(home)).toThrow(TeamError);
  expect(() => setTeam("secret", home)).toThrow(TeamError);
  const blockedHome = path.join(home, "file");
  writeFileSync(blockedHome, "not a directory");
  expect(() => loadTeam(blockedHome)).toThrow(TeamError);
  expect(() => setTeam("secret", blockedHome)).toThrow(TeamError);
});

test.each(["", "hello", '{"title":"你好 👩🏽‍💻","line":"a\\nb"}', "line\nwith\u0000null", "x".repeat(65536)]) (
  "roster entries round trip arbitrary UTF-8 (%#)",
  (plaintext) => {
    const { nsKey } = deriveTeam("secret");
    const sealed = sealEntry(nsKey, plaintext);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sealed, "base64url").byteLength).toBe(Buffer.byteLength(plaintext) + 28);
    expect(openEntry(nsKey, sealed)).toBe(plaintext);
    expect(sealEntry(nsKey, plaintext)).not.toBe(sealed);
  },
);

test.each(["nonce", "ciphertext", "tag"]) ("rejects tampered %s", (segment) => {
  const { nsKey } = deriveTeam("secret");
  const raw = Buffer.from(sealEntry(nsKey, "roster entry"), "base64url");
  const offset = segment === "nonce" ? 0 : segment === "ciphertext" ? 12 : raw.byteLength - 1;
  raw[offset] = raw[offset]! ^ 1;
  expect(() => openEntry(nsKey, raw.toString("base64url"))).toThrow(TeamError);
});

test("rejects a different team key", () => {
  const sealed = sealEntry(deriveTeam("first").nsKey, "entry");
  expect(() => openEntry(deriveTeam("second").nsKey, sealed)).toThrow(TeamError);
});

test.each([Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33), null, "x".repeat(32)]) (
  "rejects an invalid AES key (%#)",
  (key) => {
    expect(() => sealEntry(key as Buffer, "entry")).toThrow(TeamError);
    expect(() => openEntry(key as Buffer, "entry")).toThrow(TeamError);
  },
);

test("rejects malformed, truncated, padded, and noncanonical base64url", () => {
  const { nsKey } = deriveTeam("secret");
  const sealed = sealEntry(nsKey, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(sealed.at(-1)!);
  const noncanonical = sealed.slice(0, -1) + alphabet[last + 1];
  expect(Buffer.from(noncanonical, "base64url")).toEqual(Buffer.from(sealed, "base64url"));
  for (const malformed of ["", "!", "a", Buffer.alloc(27).toString("base64url"), sealed + "=", " " + sealed, sealed + "\n", sealed + "/", noncanonical, null, 42]) {
    expect(() => openEntry(nsKey, malformed as string)).toThrow(TeamError);
  }
});

test("GCM authenticates the roster domain label", () => {
  const { nsKey } = deriveTeam("secret");
  const nonce = Buffer.alloc(12);
  const cipher = createCipheriv("aes-256-gcm", nsKey, nonce);
  cipher.setAAD(Buffer.from("another agenthop domain"));
  const body = Buffer.concat([cipher.update("entry", "utf8"), cipher.final()]);
  const sealed = Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
  expect(() => openEntry(nsKey, sealed)).toThrow(TeamError);
});
