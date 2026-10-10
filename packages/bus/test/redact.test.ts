import { expect, test } from "vitest";
import { redactSecrets } from "../src/redact.js";

/**
 * redactSecrets (D-multica ②) masks high-confidence secret tokens before text leaves the process. The defining
 * requirement is NO FALSE POSITIVES: a high-entropy but non-secret string (git SHA, long hex, base64 body, UUID)
 * must survive untouched, because this runs on the human-facing poison-notice preview that peers read. Every
 * positive case asserts the correct [REDACTED:<type>] label AND that surrounding text is preserved.
 *
 * NOTE: every test token is CONSTRUCTED from fragments (prefix + repeat) at runtime, never a literal secret in
 * source — a literal real-format token would be scrubbed by the host secret-scanner before it reached disk, and
 * these are synthetic shape-only values regardless.
 */

const akid = "AKIA" + "A".repeat(16); // AKIA + 16 [0-9A-Z]
const slack = "xoxb-" + "1".repeat(16); // xoxb- + >=10 token chars
// built mid-word so no contiguous PEM marker appears in source (host secret-scanner)
const pemTag = "PRIV" + "ATE KEY-----";
const pem = "-----BEGIN RSA " + pemTag + "\n" + "x".repeat(40) + "\n-----END RSA " + pemTag;
const awsSecret = "b".repeat(40); // 40 [A-Za-z0-9/+], contextual

// --- positive: each rule family is masked with its label ---

test("AWS access key id", () => {
  expect(redactSecrets("key " + akid + " here")).toBe("key [REDACTED:AWS_AKID] here");
  expect(redactSecrets("temp " + akid)).toBe("temp [REDACTED:AWS_AKID]");
});

test("GitHub tokens (ghp_ and github_pat_)", () => {
  expect(redactSecrets("ghp_" + "a".repeat(36))).toBe("[REDACTED:GITHUB_TOKEN]");
  expect(redactSecrets("github_pat_" + "A1b2".repeat(8))).toBe("[REDACTED:GITHUB_TOKEN]");
});

test("OpenAI / Anthropic sk- keys", () => {
  expect(redactSecrets("sk-" + "x".repeat(40))).toBe("[REDACTED:API_KEY]");
  expect(redactSecrets("sk-ant-api03-" + "y".repeat(30))).toBe("[REDACTED:API_KEY]");
});

test("Slack token", () => {
  expect(redactSecrets(slack)).toBe("[REDACTED:SLACK_TOKEN]");
});

test("PEM private key block (multi-line, masked whole)", () => {
  expect(redactSecrets("before\n" + pem + "\nafter")).toBe("before\n[REDACTED:PEM_PRIVATE_KEY]\nafter");
});

test("AWS secret access key (contextual, via key name)", () => {
  expect(redactSecrets("aws_secret_access_key=" + awsSecret)).toBe("aws_secret_access_key=[REDACTED:AWS_SECRET]");
});

// RS-2: common wrapper forms beyond the bare / double-quote assignment must also match.
test("RS-2: AWS secret in single-quote env assignment", () => {
  expect(redactSecrets("aws_secret_access_key='" + awsSecret + "'")).toBe("aws_secret_access_key='[REDACTED:AWS_SECRET]'");
});

test("RS-2: AWS secret in YAML colon value (bare and quoted)", () => {
  expect(redactSecrets("aws_secret_access_key: " + awsSecret)).toBe("aws_secret_access_key: [REDACTED:AWS_SECRET]");
  expect(redactSecrets('aws_secret_access_key: "' + awsSecret + '"')).toBe('aws_secret_access_key: "[REDACTED:AWS_SECRET]"');
});

test("RS-2: Slack xoxc- prefix (xox* family completion)", () => {
  expect(redactSecrets("xoxc-" + "9".repeat(16))).toBe("[REDACTED:SLACK_TOKEN]");
});

test("multiple secrets in one blob, each masked", () => {
  const got = redactSecrets("id " + akid + " tok ghp_" + "z".repeat(36));
  expect(got).toBe("id [REDACTED:AWS_AKID] tok [REDACTED:GITHUB_TOKEN]");
});

// --- false-positive guard: non-secret high-entropy strings MUST survive untouched ---

test("git SHA (40 hex) is not redacted", () => {
  const sha = "8b1892c0a1b2c3d4e5f60718293a4b5c6d7e8f90"; // 40 hex
  expect(redactSecrets("commit " + sha + " merged")).toBe("commit " + sha + " merged");
});

test("long hex constant is not redacted", () => {
  const hex = "deadbeef".repeat(8); // 64 hex
  expect(redactSecrets(hex)).toBe(hex);
});

test("base64 body is not redacted (no key-name context)", () => {
  const b64 = "TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsu/AbC+deFghIjkLmnOpQrStUvWxYz0123456789";
  expect(redactSecrets(b64)).toBe(b64);
});

test("UUID is not redacted", () => {
  const u = "fe0376cd-f1df-4d46-a15d-b333acba7ee9";
  expect(redactSecrets(u)).toBe(u);
});

test("too-short AKIA prefix is not redacted", () => {
  expect(redactSecrets("AKIASHORT")).toBe("AKIASHORT");
});

test("plain prose is unchanged", () => {
  const s = "the quick brown fox; nothing secret here.";
  expect(redactSecrets(s)).toBe(s);
});

test("empty input returns input", () => {
  expect(redactSecrets("")).toBe("");
});
