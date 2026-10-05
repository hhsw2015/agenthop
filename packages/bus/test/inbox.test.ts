import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ackInbox, claimInbox, recoverStaleClaims, releaseInbox, writeInbox, validInboxMsg, quarantineInbox } from "../src/inbox.js";

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

  test("B8/F32: writeInbox REJECTS an invalid record at the write boundary — never publishes a file the receiver can only quarantine", () => {
    // The three reviewer cases (bus-reachability B8): a bad ts must be rejected by the writer, not published and then
    // quarantined by the receiver (and ts=null previously CRASHED on `.toString()` instead of a clean rejection).
    for (const bad of [{ ...msg("x", 0), ts: "bad-clock" }, { ...msg("x", 0), ts: NaN }, { ...msg("x", 0), ts: null }, { ...msg("x", 0), via: "carrier-pigeon" }, { ...msg("x", 1000), from: 42 }]) {
      expect(() => writeInbox(HOME, "s1", bad as never)).toThrow();
    }
    expect(claimInbox(HOME, ["s1"], "p").length).toBe(0); // nothing was published
    writeInbox(HOME, "s1", msg("good", 1000));            // a valid one still writes + normalizes
    const c = claimInbox(HOME, ["s1"], "p");
    expect(c.map((x) => x.msg.text)).toEqual(["good"]);
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
    // S11 display fields present ⇒ PRESERVED (not dropped), + fromMode/actionId preserved; a mistyped extension ⇒ rejected
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "local", ts: 1, fromMode: "bypass", actionId: "act-1", taskRef: "liveness-impl-L2", title: "re-review" }))
      .toEqual({ from: "a", fromLabel: "b", text: "hi", via: "local", ts: 1, fromMode: "bypass", actionId: "act-1", taskRef: "liveness-impl-L2", title: "re-review" });
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "local", ts: 1, taskRef: 7 })).toBeNull(); // mistyped extension
  });

  test("P2: a valid S11-carrying message round-trips through write→claim with taskRef/title intact", () => {
    writeInbox(HOME, "s1", { from: "rw-x", fromLabel: "peer", text: "body", via: "local", ts: 1000, taskRef: "F28", title: "poison fix" });
    const c = claimInbox(HOME, ["s1"], "p");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ text: "body", taskRef: "F28", title: "poison fix" }); // fields survive the validator rebuild
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

  test("P2-3: two same-base poison files get DISTINCT quarantine names — neither rename overwrites the other's evidence", () => {
    const d = inboxDirOf("s1"); mkdirSync(d, { recursive: true });
    for (const pid of ["101", "202"]) writeFileSync(path.join(d, `same.json.claim-${pid}`), JSON.stringify({ bad: pid }));
    expect(quarantineInbox(HOME, path.join(d, "same.json.claim-101"), "schema/parse", JSON.stringify({ from: "A", text: "x" }))).toBe("quarantined");
    expect(quarantineInbox(HOME, path.join(d, "same.json.claim-202"), "schema/parse", JSON.stringify({ from: "B", text: "y" }))).toBe("quarantined");
    expect(readdirSync(path.join(d, "quarantine")).length).toBe(2);                 // both preserved — atomic link never overwrote the other
    expect(readFileSync(ledger(), "utf8").trim().split("\n").length).toBe(2);        // one audit line each
  });

  test("P2-2: quarantining a VANISHED source ⇒ 'vanished', writes NO dead-letter, never throws", () => {
    mkdirSync(inboxDirOf("s1"), { recursive: true });
    expect(quarantineInbox(HOME, path.join(inboxDirOf("s1"), "gone.json.claim-1"), "schema/parse")).toBe("vanished"); // file does not exist
    expect(existsSync(ledger())).toBe(false);                                        // no "quarantined" line for a file never moved
  });

  test("P2-2: a move FAILURE ⇒ 'failed', leaves the file in place, writes NO dead-letter (no false quarantine claim)", () => {
    const d = inboxDirOf("s1"); mkdirSync(d, { recursive: true });
    const f = path.join(d, "poison.json.claim-1");
    writeFileSync(f, JSON.stringify({ bad: 1 }));
    chmodSync(d, 0o500); // read-only dir ⇒ mkdir(quarantine)/link fails
    let threw = false; let res: string | undefined;
    try { res = quarantineInbox(HOME, f, "schema/parse", JSON.stringify({ from: "A", text: "x" })); } catch { threw = true; } finally { chmodSync(d, 0o700); }
    expect(threw).toBe(false);                 // never throws (a throw would kill the flush → crash the server)
    if (res !== "failed") return;              // running as root ignores the mode — can't exercise the failure here
    expect(existsSync(f)).toBe(true);          // bytes preserved in place for a later retry
    expect(existsSync(ledger())).toBe(false);  // and NO false "quarantined" audit line
  });

  test("P2-2: claimInbox RELEASES a poison whose quarantine FAILED — not a stuck live-pid claim (recoverable)", () => {
    writeRaw("s1", "0000000000001000-dddddd.json", JSON.stringify({ text: "no-from", via: "local", ts: 1000 })); // poison (missing from)
    writeFileSync(path.join(inboxDirOf("s1"), "quarantine"), "blocker"); // a FILE at quarantine/ ⇒ mkdir(quarantine) fails ⇒ quarantine "failed"
    expect(claimInbox(HOME, ["s1"], "p").length).toBe(0); // claim succeeds, quarantine fails ⇒ released; no throw, no delivery
    const names = readdirSync(inboxDirOf("s1"));
    expect(names).toContain("0000000000001000-dddddd.json");         // RELEASED back to .json for a later retry
    expect(names.some((n) => n.includes(".claim-"))).toBe(false);    // NOT left stuck as .claim-<live-pid>
  });
});
