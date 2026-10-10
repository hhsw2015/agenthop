import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ackInbox, claimInbox, recoverStaleClaims, releaseInbox, writeInbox, watchInbox, validInboxMsg, composeInboxMsg, quarantineInbox, poisonDlqEnabled, poisonDlqThreshold, shouldQuarantinePoison, recordPoisonStrike, clearPoisonStrikes, buildPoisonS19, enqueuePoisonNotice, drainPoisonNotices, type InboxMsg } from "../src/inbox.js";
import { deliverToCoordinator } from "../src/checkin.js";
import type { SelfInfo } from "../src/label.js";

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

  test("watchInbox fires onChange when a message lands in a watched inbox dir (near-live surfacing, B2/B3)", async () => {
    let fired = 0;
    const stop = watchInbox(HOME, ["s1"], () => { fired++; });
    try {
      await new Promise((r) => setTimeout(r, 40));            // let the watcher attach to the (mkdir'd) dir
      writeInbox(HOME, "s1", msg("ping", 1000));
      for (let i = 0; i < 50 && fired === 0; i++) await new Promise((r) => setTimeout(r, 20)); // fs.watch is async/platform-timed
      expect(fired).toBeGreaterThan(0);                       // the write triggered the watch (the accelerator path)
    } finally { stop(); }
  });

  test("B8/F32: writeInbox REJECTS an invalid record at the write boundary — never publishes a file the receiver can only quarantine", () => {
    // The three reviewer cases (bus-reachability B8): a bad ts must be rejected by the writer, not published and then
    // quarantined by the receiver (and ts=null previously CRASHED on `.toString()` instead of a clean rejection).
    // F38: an unknown non-empty via ("carrier-pigeon") is now VALID (a label, not poison); an EMPTY via is still rejected.
    for (const bad of [{ ...msg("x", 0), ts: "bad-clock" }, { ...msg("x", 0), ts: NaN }, { ...msg("x", 0), ts: null }, { ...msg("x", 0), via: "" }, { ...msg("x", 1000), from: 42 }]) {
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
    // F38: `via` is a free-form provenance LABEL — a non-empty unknown label ("durable-inbox") PASSES (kept + shown as-is);
    // an EMPTY, missing, or mistyped via is still rejected as poison.
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "durable-inbox", ts: 1 })).toMatchObject({ via: "durable-inbox" });
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "", ts: 1 })).toBeNull();     // empty via
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", ts: 1 })).toBeNull();               // missing via
    expect(validInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: 7, ts: 1 })).toBeNull();       // via mistyped (not a string)
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

  test("F38: composeInboxMsg yields a validator-passing durable-inbox envelope that round-trips write→claim (the drift that was quarantined)", () => {
    const m = composeInboxMsg({ from: "f32a0507", fromLabel: "claude:agenthop-f32a0507", text: "packet ready", taskRef: "F38", title: "root fix" });
    expect(m.via).toBe("durable-inbox"); // default label
    expect(Number.isFinite(m.ts)).toBe(true);
    expect(validInboxMsg(m)).not.toBeNull(); // produces a passing record by construction
    // end-to-end: a composed durable-inbox envelope now writes + claims cleanly (before F38 it would have been quarantined)
    writeInbox(HOME, "s-f38", composeInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "durable-inbox", ts: 2000, taskRef: "F38" }));
    const c = claimInbox(HOME, ["s-f38"], "p");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ via: "durable-inbox", taskRef: "F38" });
    // composeInboxMsg refuses to emit an invalid record (empty via)
    expect(() => composeInboxMsg({ from: "a", fromLabel: "b", text: "hi", via: "" })).toThrow();
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

describe("FC-2 poison dead-letter quarantine (SWARM_POISON_DLQ)", () => {
  const dirOf = (key: string) => path.join(HOME, ".agenthop", "inbox", key);

  test("poisonDlqEnabled default OFF; truthy words ON", () => {
    expect(poisonDlqEnabled({})).toBe(false);
    expect(poisonDlqEnabled({ SWARM_POISON_DLQ: "0" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "YES"]) expect(poisonDlqEnabled({ SWARM_POISON_DLQ: on })).toBe(true);
  });

  test("poisonDlqThreshold default 3; valid int >= 1 honored; junk/0/negative ⇒ 3", () => {
    expect(poisonDlqThreshold({})).toBe(3);
    expect(poisonDlqThreshold({ SWARM_POISON_DLQ_THRESHOLD: "5" })).toBe(5);
    expect(poisonDlqThreshold({ SWARM_POISON_DLQ_THRESHOLD: "1" })).toBe(1);
    for (const bad of ["0", "-2", "2.5", "abc", ""]) expect(poisonDlqThreshold({ SWARM_POISON_DLQ_THRESHOLD: bad })).toBe(3);
  });

  test("shouldQuarantinePoison: fires at/above threshold, never below; guards NaN strikes + bad threshold", () => {
    expect(shouldQuarantinePoison(3, 3)).toBe(true);
    expect(shouldQuarantinePoison(4, 3)).toBe(true);
    expect(shouldQuarantinePoison(2, 3)).toBe(false);
    expect(shouldQuarantinePoison(NaN, 3)).toBe(false);  // no count ⇒ never
    expect(shouldQuarantinePoison(5, 0)).toBe(false);    // threshold < 1 ⇒ never (guards misconfig)
  });

  test("recordPoisonStrike increments and the count is keyed by the STABLE base (survives claim→release→reclaim)", () => {
    const base = path.join(dirOf("s1"), "0000000000001000-aaaaaa.json");
    mkdirSync(dirOf("s1"), { recursive: true });
    const mem = new Map<string, number>();
    expect(recordPoisonStrike(`${base}.claim-123`, mem)).toBe(1); // claimed form
    expect(recordPoisonStrike(base, mem)).toBe(2);                // released form ⇒ SAME key
    expect(recordPoisonStrike(`${base}.claim-456`, mem)).toBe(3); // reclaimed by a new pid ⇒ still the same count
    clearPoisonStrikes(base, mem);
    expect(recordPoisonStrike(base, mem)).toBe(1);                // cleared (sidecar + mem) ⇒ starts over
  });

  test("the strike sidecar is NOT a .json ⇒ claimInbox never lists it as a deliverable message", () => {
    writeInbox(HOME, "s1", msg("hello", 1000));
    const jsonName = readdirSync(dirOf("s1")).find((n) => n.endsWith(".json"))!;
    recordPoisonStrike(path.join(dirOf("s1"), jsonName), new Map()); // drop a .poison sidecar next to the message
    const claimed = claimInbox(HOME, ["s1"], "p");
    expect(claimed.length).toBe(1);                         // ONLY the message, not the sidecar
    expect(claimed[0].msg.text).toBe("hello");
    expect(existsSync(path.join(dirOf("s1"), `${jsonName}.poison`))).toBe(true); // sidecar untouched by the claim
  });

  test("buildPoisonS19 carries strikes + trace + source + a bounded preview", () => {
    const poison = { from: "x", fromLabel: "alice", text: "A".repeat(500), via: "durable-inbox", ts: 42 };
    const s19 = buildPoisonS19("my-sid", "me", poison, 3, "TypeError: boom");
    expect(s19.taskRef).toBe("poison-dlq");
    expect(s19.title).toBe("poison quarantine");
    expect(s19.from).toBe("my-sid");
    expect(s19.fromLabel).toBe("me");
    expect(s19.text).toContain("3");                 // strike count
    expect(s19.text).toContain("TypeError: boom");   // failure trace
    expect(s19.text).toContain("alice");             // source label
    expect(s19.text).toContain("durable-inbox");     // source via
    expect(s19.text).toContain("…");                 // preview truncated (500 > 240)
    expect(validInboxMsg(s19)).not.toBeNull();       // a well-formed inbox message
  });

  test("PD-P2-1: buildPoisonS19 strips transport-unsafe control chars so the NOTICE is not itself poison", () => {
    const poison = { from: "x", fromLabel: "al\u0000ice", text: "payload\u0000with NUL", via: "dur\u0000able", ts: 42 };
    const s19 = buildPoisonS19("my-sid", "me", poison, 3, "Error\u0000trace");
    expect(s19.text).not.toContain("\u0000");        // no NUL anywhere ⇒ a real push won't ERR_INVALID_ARG_VALUE on the alert
    expect(s19.text).toContain("�");            // replaced with the visible marker
    expect(s19.text).toContain("payload");           // the safe content survives
    expect(validInboxMsg(s19)).not.toBeNull();
  });

  test("PD-P2-2: deliverToCoordinator is 3-state — skip (no coordinator) vs retry (unresolvable) so the obligation is retained", () => {
    const self = { id: "me", stableId: "me", title: "me" } as SelfInfo;
    const m = buildPoisonS19("me", "me", { from: "x", fromLabel: "alice", text: "boom", via: "local", ts: 1 }, 3, "t");
    expect(deliverToCoordinator(HOME, self, undefined, m)).toBe("skip");    // no coordinator ⇒ permanent
    expect(deliverToCoordinator(HOME, self, "", m)).toBe("skip");           // blank handle ⇒ permanent
    expect(deliverToCoordinator(HOME, self, "coord-ghost", m)).toBe("retry"); // not resolvable here ⇒ retain + retry
  });

  const pnMsg = (text: string, ts: number): InboxMsg => buildPoisonS19("me", "me", { from: "x", fromLabel: "a", text, via: "local", ts }, 3, "t");
  const pnDir = (): string => path.join(HOME, ".agenthop", "swarm", "poison-notices");
  const pnJsonCount = (): number => { try { return readdirSync(pnDir()).filter((n) => n.endsWith(".json")).length; } catch { return 0; } };
  const srcPath = (sid: string, base: string): string => path.join(HOME, ".agenthop", "inbox", sid, base);
  const confirmQuarantine = (source: string): void => { const q = path.join(path.dirname(source), "quarantine"); mkdirSync(q, { recursive: true }); writeFileSync(path.join(q, `${path.basename(source)}.${Date.now()}.cafebabecafebabe`), "bytes"); };

  test("PD-P2-2 + PD-R4-P2-1: a record delivers to its BOUND target ONLY after the quarantine is VERIFIED on disk", () => {
    const source = srcPath("s1", "0000000000001000-aaaaaa.json");
    expect(enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("boom", 1000))).toBe(true);
    expect(pnJsonCount()).toBe(1);
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; }); // quarantine NOT yet confirmed ⇒ keep, never a premature report
    expect(calls).toBe(0);
    expect(pnJsonCount()).toBe(1);
    confirmQuarantine(source);                                   // bytes now in quarantine/ ⇒ verified
    const sent: { target: string; msg: InboxMsg }[] = [];
    drainPoisonNotices(HOME, (target, m) => { sent.push({ target, msg: m }); return "sent"; });
    expect(sent.length).toBe(1);
    expect(sent[0]!.target).toBe("coord-a");                     // BOUND target (PD-R3-P1-1)
    expect(sent[0]!.msg.text).toContain("boom");
    expect(pnJsonCount()).toBe(0);                               // cleared only after the confirmed send
  });

  test("PD-R5-P2-2: a FRESH drain (restart) recovers via fs verification — no separate confirmation write to lose", () => {
    const source = srcPath("s1", "0000000000002000-bbbb.json");
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("recover", 2000)); // process 1 wrote the obligation BEFORE the move
    confirmQuarantine(source);                                            // the move happened; process 1 crashed before any confirm
    let delivered = 0;
    drainPoisonNotices(HOME, () => { delivered++; return "sent"; });       // process 2 verifies from the fs
    expect(delivered).toBe(1);                                            // recovered — obligation never stranded
    expect(pnJsonCount()).toBe(0);
  });

  test("PD-R5-P2-1 / FC-7: a PRIOR bound v1 record is MOVED to needs-migration (importable), never deleted as corrupt", () => {
    const dir = pnDir(); mkdirSync(dir, { recursive: true });
    const v1 = { schema: "poison-notice/v1", target: "coord-a", msg: pnMsg("priorbound", 5) }; // last version's bound record (no `source`)
    writeFileSync(path.join(dir, "aaaa0000000000000000000000000001.json"), JSON.stringify(v1));
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; });
    expect(calls).toBe(0);                 // not delivered (stage unverifiable)
    expect(pnJsonCount()).toBe(0);         // moved out of the active queue (NOT deleted)
    expect(readdirSync(path.join(dir, "needs-migration")).length).toBe(1); // kept + exposed for manual migration
  });

  test("FC-7 / PD-R3-P1-1 A: a legacy bare-InboxMsg record is MOVED to needs-migration (never target-guessed/deleted)", () => {
    const dir = pnDir(); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bbbb0000000000000000000000000002.json"), JSON.stringify(pnMsg("legacy", 6)));
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; });
    expect(calls).toBe(0);
    expect(pnJsonCount()).toBe(0);
    expect(readdirSync(path.join(dir, "needs-migration")).length).toBe(1);
  });

  test("PD-R3-P1-1: delivers each confirmed record to its OWN bound target, never the drainer's coordinator", () => {
    const s1 = srcPath("s1", "m1.json"), s2 = srcPath("s2", "m2.json");
    enqueuePoisonNotice(HOME, s1, "coord-a", pnMsg("t1", 10)); confirmQuarantine(s1);
    enqueuePoisonNotice(HOME, s2, "coord-b", pnMsg("t2", 20)); confirmQuarantine(s2);
    const targets: string[] = [];
    drainPoisonNotices(HOME, (t) => { targets.push(t); return "sent"; });
    expect(targets.sort()).toEqual(["coord-a", "coord-b"]);
  });

  test("PD-R4-P2-1: the same source is idempotent — re-enqueue OVERWRITES, never piling up duplicate reports", () => {
    const source = srcPath("s1", "dup.json");
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("dup", 3000));
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("dup", 3000));
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("dup", 3000));
    expect(pnJsonCount()).toBe(1);         // ONE record
    confirmQuarantine(source);
    let delivered = 0;
    drainPoisonNotices(HOME, () => { delivered++; return "sent"; });
    expect(delivered).toBe(1);             // delivered exactly once
  });

  test("PD-R3-P2-1: a valid but momentarily UNREADABLE record is KEPT (not dropped as corrupt); deliver not called", () => {
    const source = srcPath("s1", "keep.json");
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("keep", 7)); confirmQuarantine(source);
    const f = path.join(pnDir(), readdirSync(pnDir()).find((n) => n.endsWith(".json"))!);
    chmodSync(f, 0o000);
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; });
    expect(calls).toBe(0);
    expect(existsSync(f)).toBe(true);
    chmodSync(f, 0o600);
  });

  test("PD-P2-2: enqueuePoisonNotice returns false when it cannot persist (caller keeps the source + strike)", () => {
    const swarmDir = path.join(HOME, ".agenthop", "swarm");
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(path.join(swarmDir, "poison-notices"), "blocker"); // a FILE where the queue dir should be ⇒ mkdir fails
    expect(enqueuePoisonNotice(HOME, srcPath("s1", "b.json"), "coord-a", pnMsg("b", 9))).toBe(false);
  });

  test("PD-R6-P2-1 A: a DIFFERENT event's receipt sharing the source-name prefix does NOT confirm this event (exact match)", () => {
    const source = srcPath("s1", "event.json");
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("mine", 1));
    const q = path.join(HOME, ".agenthop", "inbox", "s1", "quarantine");
    mkdirSync(q, { recursive: true });
    // another event `event.json.other.json` quarantined — receipt shares the "event.json." PREFIX but is NOT ours
    writeFileSync(path.join(q, "event.json.other.json.123456.cafebabecafebabe"), "other-bytes");
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; });
    expect(calls).toBe(0);           // our event is NOT confirmed by the other's receipt
    expect(pnJsonCount()).toBe(1);   // obligation retained (our event really isn't quarantined yet)
  });

  test("PD-R6-P2-1 B: a directory named like a receipt does NOT confirm quarantine (must be a regular file)", () => {
    const source = srcPath("s1", "evt.json");
    enqueuePoisonNotice(HOME, source, "coord-a", pnMsg("mine", 2));
    const q = path.join(HOME, ".agenthop", "inbox", "s1", "quarantine");
    mkdirSync(path.join(q, "evt.json.123456.cafebabecafebabe"), { recursive: true }); // a DIR with a receipt-shaped name
    let calls = 0;
    drainPoisonNotices(HOME, () => { calls++; return "sent"; });
    expect(calls).toBe(0);           // a dir is not the quarantined bytes
    expect(pnJsonCount()).toBe(1);
    writeFileSync(path.join(q, "evt.json.123457.cafebabecafebabe"), "bytes"); // a real FILE receipt DOES confirm
    let delivered = 0;
    drainPoisonNotices(HOME, () => { delivered++; return "sent"; });
    expect(delivered).toBe(1);
  });

  test("the durable queue has no in-memory cap — 300 confirmed notices all drain over bounded passes, a corrupt one is dropped", () => {
    const dir = pnDir(); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "00000000000000000000000000000001.json"), "not valid json{"); // read-OK but invalid ⇒ corrupt ⇒ dropped
    for (let i = 0; i < 300; i++) { const s = srcPath("s1", `m${i}.json`); expect(enqueuePoisonNotice(HOME, s, "coord-a", pnMsg(`m${i}`, 2000 + i))).toBe(true); confirmQuarantine(s); }
    expect(pnJsonCount()).toBe(301);
    let delivered = 0;
    for (let pass = 0; pass < 6; pass++) drainPoisonNotices(HOME, () => { delivered++; return "sent"; }); // bounded per tick (64)
    expect(delivered).toBe(300);
    expect(pnJsonCount()).toBe(0);
  });

  test("PD-P2-3: the in-memory map drives the count to threshold even when the sidecar write keeps failing", () => {
    const mem = new Map<string, number>();
    const base = path.join(HOME, "no-such-dir", "x.json"); // parent missing ⇒ sidecar read AND write both fail
    expect(recordPoisonStrike(base, mem)).toBe(1);
    expect(recordPoisonStrike(base, mem)).toBe(2);
    expect(recordPoisonStrike(base, mem)).toBe(3);          // reaches threshold despite zero successful persistence
    expect(existsSync(`${base}.poison`)).toBe(false);       // nothing was ever written
  });

  test("PD-P2-4: a corrupt sidecar (prefix-parse bait) is ignored, never authorizing an early quarantine", () => {
    mkdirSync(dirOf("s1"), { recursive: true });
    const base = path.join(dirOf("s1"), "0000000000002000-bbbbbb.json");
    writeFileSync(`${base}.poison`, "2-not-a-counter"); // parseInt would read 2 ⇒ next 3 ⇒ premature quarantine
    expect(recordPoisonStrike(base, new Map())).toBe(1);  // whole-string parse rejects it ⇒ treated as 0 ⇒ starts at 1
    writeFileSync(`${base}.poison`, "2");                 // a VALID complete integer IS honored
    expect(recordPoisonStrike(base, new Map())).toBe(3);  // max(2, 0) + 1
  });
});

describe("writeInbox — idempotency key (durable-first credential, exactly-once across claim/ack/restart — digest MD-P2-1)", () => {
  const dirOf = (key: string) => path.join(HOME, ".agenthop", "inbox", key);
  const jsonFiles = (key: string) => readdirSync(dirOf(key)).filter((n) => n.endsWith(".json"));
  const cred = (sid: string, idk: string) => path.join(dirOf(sid), ".pubcred", createHash("sha256").update(idk).digest("hex"));
  const digest = (text: string, ts: number) => ({ from: "d", fromLabel: "swarm-digest", text, via: "local" as const, ts, taskRef: "morning-digest" });

  test("a keyed publish writes ONE message + a PUBLISHED credential; a re-send is a no-op; no key => unique names", () => {
    writeInbox(HOME, "s1", msg("one", 1), "evt-k");
    writeInbox(HOME, "s1", msg("two", 2), "evt-k");                       // SAME event => no-op (first publication retained)
    expect(jsonFiles("s1")).toEqual(["evt-k.json"]);
    expect(JSON.parse(readFileSync(path.join(dirOf("s1"), "evt-k.json"), "utf8")).text).toBe("one");
    expect(readFileSync(cred("s1", "evt-k"), "utf8")).toBe("published");  // durable credential, confirmed
    writeInbox(HOME, "s1", msg("r1", 3)); writeInbox(HOME, "s1", msg("r2", 4)); // no key => unique random names
    expect(jsonFiles("s1").length).toBe(3);
  });

  test("REPLAY: a re-send after the receiver claimed+acked is a no-op (the credential survives consumption)", () => {
    writeInbox(HOME, "s1", digest("brief", 1), "evt-k");
    const first = claimInbox(HOME, ["s1"], "pidA"); expect(first.length).toBe(1);
    ackInbox(first[0]!.file);                                             // consumed => the message .json is gone
    expect(jsonFiles("s1").length).toBe(0);
    writeInbox(HOME, "s1", digest("brief", 2), "evt-k");                  // recovery re-send
    expect(claimInbox(HOME, ["s1"], "pidB").length).toBe(0);             // credential published => NOT re-delivered
  });

  test("durable-first recovery: PENDING credential + message present => upgrade (no resend); + message absent => retain (no resend)", () => {
    mkdirSync(path.dirname(cred("s1", "evt-k")), { recursive: true });
    writeFileSync(cred("s1", "evt-k"), "pending");                        // simulate a crash after the send, before the upgrade
    writeFileSync(path.join(dirOf("s1"), "evt-k.json"), JSON.stringify(validInboxMsg(digest("brief", 1))));
    writeInbox(HOME, "s1", digest("brief", 2), "evt-k");                  // recovery: message present => upgrade, no 2nd copy
    expect(jsonFiles("s1")).toEqual(["evt-k.json"]);
    expect(readFileSync(cred("s1", "evt-k"), "utf8")).toBe("published");
    for (const c of claimInbox(HOME, ["s1"], "p")) ackInbox(c.file);     // receiver consumes it
    writeFileSync(cred("s1", "evt-k"), "pending");                        // force back to an unconfirmable pending state
    writeInbox(HOME, "s1", digest("brief", 3), "evt-k");                  // pending + message absent => insufficient evidence
    expect(claimInbox(HOME, ["s1"], "p2").length).toBe(0);               // retain, never resend (no dup)
  });

  test("a reserved dot key (. / ..) is a SAFE sha256 filename: publishes, no path traversal (MD-R6-P2-1)", () => {
    writeInbox(HOME, "s1", msg("dotdot", 1), "..");
    writeInbox(HOME, "s1", msg("dot", 2), ".");
    expect(claimInbox(HOME, ["s1"], "p").length).toBe(2);                 // both delivered
    expect(readdirSync(path.join(HOME, ".agenthop", "inbox"))).toEqual(["s1"]); // only s1 — no sibling dir created by a `..` escape
  });

  test("FC-7: a legacy keyless publication of the SAME notice is adopted, not duplicated by the new key", () => {
    writeInbox(HOME, "s1", digest("morning brief", 1));                   // legacy random name, no key
    writeInbox(HOME, "s1", digest("morning brief", 2), "evt-k");          // keyed re-publish of the SAME notice
    expect(jsonFiles("s1").length).toBe(1);                               // adopted the legacy one, no second message
    expect(readFileSync(cred("s1", "evt-k"), "utf8")).toBe("published");
    expect(claimInbox(HOME, ["s1"], "p").length).toBe(1);
  });

  test("a DIFFERENT keyless notice (distinct taskRef/text) is never collapsed by the key", () => {
    writeInbox(HOME, "s1", msg("unrelated", 1));
    writeInbox(HOME, "s1", digest("brief", 2), "evt-k");
    expect(jsonFiles("s1").length).toBe(2);
  });

  test("an unsafe key (separator/traversal) is CONFINED: random fallback in the selected box, no sibling-box overwrite (MD-R7-P1-1)", () => {
    const victimDir = path.join(HOME, ".agenthop", "inbox", "victim"); mkdirSync(victimDir, { recursive: true });
    const victim = path.join(victimDir, "kept.json");
    writeFileSync(victim, JSON.stringify({ from: "v", fromLabel: "v", text: "keep", via: "local", ts: 1 }));
    const before = readFileSync(victim, "utf8");
    writeInbox(HOME, "s1", msg("escape-attempt", 9), "../victim/kept");    // unsafe key ⇒ never used as a path segment
    expect(readFileSync(victim, "utf8")).toBe(before);                      // sibling box untouched (no escape)
    expect(jsonFiles("s1").length).toBe(1);                                 // delivered to the SELECTED box (random name, no dedup)
    expect(existsSync(path.join(dirOf("s1"), ".pubcred"))).toBe(false);     // unsafe key ⇒ no credential (treated as no-key)
  });

  test("writeInbox returns a confirmed status: published on first, already on a confirmed re-send (MD-P2-1)", () => {
    expect(writeInbox(HOME, "s1", digest("brief", 1), "evt-k")).toBe("published");
    expect(writeInbox(HOME, "s1", digest("brief", 2), "evt-k")).toBe("already"); // credential published ⇒ confirmed, no 2nd copy
    expect(writeInbox(HOME, "s1", msg("nokey", 3))).toBe("published");           // no key ⇒ always a fresh publish
  });
});
