import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ackInbox, claimInbox, recoverStaleClaims, releaseInbox, writeInbox, validInboxMsg } from "../src/inbox.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-inbox-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const msg = (text: string, ts: number) => ({ from: "rw-x", fromLabel: "peer", text, via: "local" as const, ts });

describe("durable inbox", () => {
  test("write -> claim returns it; ack removes it for good", () => {
    writeInbox(HOME, "s1", msg("hello", 1000));
    const c = claimInbox(HOME, ["s1"], "pidA");
    expect(c.length).toBe(1);
    expect(c[0].msg.text).toBe("hello");
    ackInbox(c[0].file);
    expect(claimInbox(HOME, ["s1"], "pidA").length).toBe(0);
  });

  test("claim is atomic: a second claimer gets nothing until the first releases", () => {
    writeInbox(HOME, "s1", msg("one", 1000));
    const a = claimInbox(HOME, ["s1"], "pidA");
    expect(a.length).toBe(1);
    expect(claimInbox(HOME, ["s1"], "pidB").length).toBe(0); // A holds it
    releaseInbox(a[0].file); // A couldn't deliver -> put it back
    const b = claimInbox(HOME, ["s1"], "pidB");
    expect(b.length).toBe(1);
    expect(b[0].msg.text).toBe("one");
  });

  test("oldest message first (persist order by ts)", () => {
    writeInbox(HOME, "s1", msg("second", 2000));
    writeInbox(HOME, "s1", msg("first", 1000));
    const c = claimInbox(HOME, ["s1"], "p");
    expect(c.map((x) => x.msg.text)).toEqual(["first", "second"]);
  });

  test("claims across multiple keys (stableId + per-run id), de-duped dirs", () => {
    writeInbox(HOME, "stable", msg("a", 1000));
    writeInbox(HOME, "runid", msg("b", 2000));
    const c = claimInbox(HOME, ["stable", "runid", "stable"], "p");
    expect(c.map((x) => x.msg.text).sort()).toEqual(["a", "b"]);
  });

  test("empty / missing inbox -> no claims, no throw", () => {
    expect(claimInbox(HOME, ["nope"], "p")).toEqual([]);
  });

  test("recoverStaleClaims rescues a message a dead claimer orphaned", () => {
    writeInbox(HOME, "s1", msg("stranded", 1000));
    // Simulate a drainer that claimed then died (never ack'd/released): rename .json -> .claim-<deadpid>.
    const c = claimInbox(HOME, ["s1"], "999999"); // pid 999999 is not running
    expect(c.length).toBe(1);
    // Still claimed -> a fresh claim sees nothing (claimInbox only looks at .json).
    expect(claimInbox(HOME, ["s1"], "p2").length).toBe(0);
    // Recovery releases the dead pid's claim; now it is claimable again.
    recoverStaleClaims(HOME, ["s1"]);
    const again = claimInbox(HOME, ["s1"], "p2");
    expect(again.length).toBe(1);
    expect(again[0].msg.text).toBe("stranded");
  });

  test("recoverStaleClaims leaves a LIVE claimer's message alone", () => {
    writeInbox(HOME, "s1", msg("inflight", 1000));
    claimInbox(HOME, ["s1"], String(process.pid)); // claimed by us (alive)
    recoverStaleClaims(HOME, ["s1"]); // must NOT steal it
    expect(claimInbox(HOME, ["s1"], "p2").length).toBe(0);
  });
});

describe("F28 poison-pill defense", () => {
  const inboxDirOf = (key: string) => path.join(HOME, ".agenthop", "inbox", key);
  const writeRaw = (key: string, name: string, content: string): void => { const d = inboxDirOf(key); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, name), content); };
  const ledger = () => path.join(HOME, ".agenthop", "swarm", "dead-letters.jsonl");

  test("validInboxMsg: valid ⇒ msg; a missing/mistyped required field ⇒ null; optional + S11 extras tolerated", () => {
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "local", ts: 1 })).toMatchObject({ from: "a", text: "hi" });
    expect(validInboxMsg({ fromLabel: "b", text: "hi", via: "local", ts: 1 })).toBeNull();      // no from (the exact crash input)
    expect(validInboxMsg({ from: "a", fromLabel: "b", via: "local", ts: 1 })).toBeNull();        // no text
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "local" })).toBeNull();   // no ts
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "bogus", ts: 1 })).toBeNull(); // bad via
    expect(validInboxMsg({ from: 1, fromLabel: "b", text: "hi", via: "local", ts: 1 })).toBeNull();   // from mistyped
    expect(validInboxMsg(null)).toBeNull();
    expect(validInboxMsg("not an object")).toBeNull();
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "local", ts: 1, taskRef: "x", title: "t" })).toMatchObject({ from: "a" }); // S11 extras OK
  });

  test("a poison file (missing field / unparseable) is QUARANTINED on claim — never returned, no throw, dead-letter logged", () => {
    writeRaw("s1", "0000000000001000-aaaaaa.json", JSON.stringify({ fromLabel: "b", text: "no-from", via: "local", ts: 1000 })); // missing from (undefined.replace crash)
    writeRaw("s1", "0000000000002000-bbbbbb.json", "{ not json");   // unparseable
    writeInbox(HOME, "s1", msg("good", 3000));                       // a valid message in the same batch
    const c = claimInbox(HOME, ["s1"], "p");                         // must NOT throw
    expect(c.map((x) => x.msg.text)).toEqual(["good"]);              // only the valid message delivered
    expect(readdirSync(path.join(inboxDirOf("s1"), "quarantine")).length).toBe(2); // both poison files quarantined out of the path
    expect(existsSync(ledger())).toBe(true);
    expect(readFileSync(ledger(), "utf8").trim().split("\n").length).toBe(2); // one dead-letter line per poison
  });

  test("a stale-claim-carrying poison is released then quarantined — the poison-pill loop is broken (no re-crash)", () => {
    writeRaw("s1", "0000000000001000-cccccc.json.claim-999999", JSON.stringify({ text: "no-from", via: "local", ts: 1000 })); // poison a dead claimer left
    recoverStaleClaims(HOME, ["s1"]);                    // releases .claim-999999 → .json
    const c = claimInbox(HOME, ["s1"], "p");             // claims → validates → quarantines; no throw, no delivery
    expect(c.length).toBe(0);
    expect(readdirSync(path.join(inboxDirOf("s1"), "quarantine")).length).toBe(1);
  });
});
