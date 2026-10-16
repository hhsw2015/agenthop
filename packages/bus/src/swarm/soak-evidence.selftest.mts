/**
 * soak-evidence selftest. Record shapes (timed, nulls instead of guesses), append-only behaviour, and one-report-per-failure-episode.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/soak-evidence.selftest.mts
 */
import { chmodSync, writeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { appendEvidence, bridgeTickRecord, inboxOldestRecord, shouldReportEvidenceFailure, commitEvidenceReport, sampleRoleBox, ownerRound, APPEND_MAX_WRITES, soakDir } from "./soak-evidence.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const NOW = Date.parse("2026-10-16T20:00:00.000Z"), BOX = "c0c0c0c0-1111-4222-8333-444444444444"; // made-up

const r1 = inboxOldestRecord(NOW, BOX, [{ mtimeSec: NOW / 1000 - 600 }, { mtimeSec: NOW / 1000 - 30 }], { owner: true });
t("inbox-oldest: ISO ts first, oldest age in seconds, owner", r1.ts === "2026-10-16T20:00:00.000Z" && r1.oldest_age_s === 600 && r1.live_owner === true && Object.keys(r1)[0] === "ts");
t("inbox-oldest: an empty box is a measured 0", inboxOldestRecord(NOW, BOX, [], { owner: false }).oldest_age_s === 0);
const r3 = inboxOldestRecord(NOW, BOX, null, { owner: null }, "box unreadable");
t("inbox-oldest: an unreadable box is null + reason, never a number", r3.oldest_age_s === null && r3.reason === "box unreadable");
const b1 = bridgeTickRecord(NOW, 42, 41, "ok"), b2 = bridgeTickRecord(NOW, 42, 42, "ok"), b3 = bridgeTickRecord(NOW, null, 42, "unknown"), b4 = bridgeTickRecord(NOW, 7, null, "ok");
t("bridge-tick: moved true / false from the previous READ tick", b1.moved === true && b2.moved === false);
t("bridge-tick: an unreadable tick or no previous read ⇒ moved null (not false)", b3.tick === null && b3.moved === null && b4.moved === null);

const home = mkdtempSync(path.join(os.tmpdir(), "soakev-"));
t("append: first write ok", appendEvidence(home, "inbox-oldest.jsonl", r1));
t("append: second write ok", appendEvidence(home, "inbox-oldest.jsonl", r3));
const lines = readFileSync(path.join(soakDir(home), "inbox-oldest.jsonl"), "utf8").trim().split("\n");
t("append: one JSON object per line, in order (append-only)", lines.length === 2 && JSON.parse(lines[0]!).oldest_age_s === 600 && JSON.parse(lines[1]!).oldest_age_s === null);
chmodSync(soakDir(home), 0o500);
t("append: an unwritable dir ⇒ false, never throws", appendEvidence(home, "bridge-tick.jsonl", b1) === false);
chmodSync(soakDir(home), 0o700);

// SE-FAILURE-COMMIT: owed until DELIVERED; a failed report stays owed
const st = new Set<string>();
t("report: the first failure owes a report", shouldReportEvidenceFailure(st, "f", false));
commitEvidenceReport(st, "f", false); // the S19 itself failed
t("report: the S19 failed ⇒ still owed next round", shouldReportEvidenceFailure(st, "f", false));
let delivered = 0;
for (let round = 0; round < 5; round++) { if (shouldReportEvidenceFailure(st, "f", false)) { commitEvidenceReport(st, "f", true); delivered++; } }
t("report: once delivery works, exactly one delivered report for the episode", delivered === 1);
t("report: a success ends the episode (nothing owed)", !shouldReportEvidenceFailure(st, "f", true));
t("report: the next failure owes a report again", shouldReportEvidenceFailure(st, "f", false));

// SE-APPEND-BOUND: a FIFO (no reader) / symlink at the evidence path is refused at once, never waited on
{
  const h = mkdtempSync(path.join(os.tmpdir(), "soakfifo-")); mkdirSync(soakDir(h), { recursive: true });
  spawnSync("mkfifo", [path.join(soakDir(h), "bridge-tick.jsonl")]);
  const t0 = performance.now(); const okF = appendEvidence(h, "bridge-tick.jsonl", b1); const took = performance.now() - t0;
  t(`append: a FIFO carrier ⇒ false within 2s (took ${Math.round(took)}ms)`, okF === false && took < 2000);
  symlinkSync(path.join(h, "elsewhere.jsonl"), path.join(soakDir(h), "inbox-oldest.jsonl"));
  t("append: a symlink at the evidence path ⇒ false, the link target is not written", appendEvidence(h, "inbox-oldest.jsonl", r1) === false && !existsSync(path.join(h, "elsewhere.jsonl")));
  rmSync(h, { recursive: true, force: true });
}

// SE-EMPTY-ROUND: the full sample chain (real bounded box reader → record → append) writes ONE record per round in every case
{
  const { readBoxMails } = await import("./progress-watch.js");
  const h = mkdtempSync(path.join(os.tmpdir(), "soakbox-")); const BOXK = "c1c1c1c1-1111-4222-8333-444444444444";
  const boxDir = path.join(h, ".agenthop", "inbox", BOXK);
  const lines = () => { try { return readFileSync(path.join(soakDir(h), "inbox-oldest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
  t("sample: box directory absent (no inbox yet) ⇒ one record, oldest 0", sampleRoleBox(h, BOXK, { owner: null }, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 0);
  mkdirSync(boxDir, { recursive: true });
  t("sample: empty box ⇒ one record, oldest 0", sampleRoleBox(h, BOXK, { owner: true }, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 0 && lines().length === 2);
  const f = path.join(boxDir, "m1.json"); writeFileSync(f, JSON.stringify({ fromLabel: "x" })); utimesSync(f, NOW / 1000 - 900, NOW / 1000 - 900);
  t("sample: one mail 15min old ⇒ one record, oldest 900s", sampleRoleBox(h, BOXK, { owner: true }, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 900 && lines().length === 3);
  chmodSync(boxDir, 0o000);
  t("sample: box unreadable ⇒ one record, null + reason", sampleRoleBox(h, BOXK, { owner: true }, NOW, readBoxMails) && lines().at(-1).oldest_age_s === null && typeof lines().at(-1).reason === "string" && lines().length === 4);
  chmodSync(boxDir, 0o700);
  t("sample: a reader that throws ⇒ still one record (null + reason)", sampleRoleBox(h, BOXK, { owner: null }, NOW, () => { throw new Error("boom"); }) && lines().at(-1).oldest_age_s === null && lines().length === 5);
  rmSync(h, { recursive: true, force: true });
}
rmSync(home, { recursive: true, force: true });

// SE-OWNER-FRESHNESS: the owner in a record is THIS round's measurement; a round that did not measure it says null + reason
{
  const seen: Array<{ owner: boolean | null; reason?: string }> = [];
  const sample = (o: { owner: boolean | null; reason?: string }) => { seen.push(o); };
  ownerRound((set) => set({ owner: true }), sample);                         // round 1: owner proven
  ownerRound(() => { /* empty stats: early return */ }, sample);              // round 2: nothing measured
  ownerRound((set) => set({ owner: null, reason: "role sid unreadable" }), sample); // round 3: source unknown
  try { ownerRound(() => { throw new Error("boom"); }, sample); } catch { /* the body's error is rethrown */ }
  ownerRound(() => {}, sample);
  t("owner: proven ⇒ true", seen[0]!.owner === true);
  t("owner: an early-return round after a true one is null (not the old true)", seen[1]!.owner === null && typeof seen[1]!.reason === "string");
  t("owner: source unknown ⇒ null + that reason", seen[2]!.owner === null && seen[2]!.reason === "role sid unreadable");
  t("owner: a throwing round still samples, null", seen.length === 5 && seen[3]!.owner === null && seen[4]!.owner === null);
  const rec = inboxOldestRecord(NOW, BOX, [], seen[1]!);
  t("owner: record carries live_owner null + owner_reason", rec.live_owner === null && typeof rec.owner_reason === "string");
  let rethrown = false; try { ownerRound(() => { throw new Error("x"); }, () => {}); } catch { rethrown = true; }
  t("owner: the body's error is not swallowed", rethrown);
}

// SE-WRITE-RESULT: true only when the whole line is written; a short write that cannot finish is false and leaves no half line
{
  const h = mkdtempSync(path.join(os.tmpdir(), "soakshort-"));
  const f = path.join(soakDir(h), "bridge-tick.jsonl");
  t("write: a normal write (positive control)", appendEvidence(h, "bridge-tick.jsonl", b1) && readFileSync(f, "utf8").split("\n").length === 2);
  const size0 = readFileSync(f).length;
  let k = 0; const eight = (fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, k++ === 0 ? Math.min(8, len) : len);
  t("write: a short write continued to the end (8 bytes, then the rest) ⇒ true, one whole line", appendEvidence(h, "bridge-tick.jsonl", b2, eight) && readFileSync(f, "utf8").trim().split("\n").every((l) => JSON.parse(l)));
  const size1 = readFileSync(f).length;
  let calls = 0; const stuck = (fd: number, buf: Buffer, off: number, len: number) => { calls++; return calls === 1 ? writeSync(fd, buf, off, 8) : 0; };
  t("write: 8 bytes then 0 ⇒ false", appendEvidence(h, "bridge-tick.jsonl", b3, stuck) === false);
  t("write: the half line is cut back off (file as before)", readFileSync(f).length === size1);
  calls = 0; const slow = (fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, 1);
  t(`write: more than ${APPEND_MAX_WRITES} pieces needed ⇒ false (bounded), file as before`, appendEvidence(h, "bridge-tick.jsonl", b4, slow) === false && readFileSync(f).length === size1);
  const thrower = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
  t("write: a throwing write ⇒ false", appendEvidence(h, "bridge-tick.jsonl", b1, thrower) === false && readFileSync(f).length === size1);
  // the failure is a failure for the S19 path too: owed, not recovered
  const st2 = new Set<string>();
  t("write: a short write counts as a failure episode (report owed, no recovery)", shouldReportEvidenceFailure(st2, "bridge-tick.jsonl", appendEvidence(h, "bridge-tick.jsonl", b1, stuck)));
  void size0; rmSync(h, { recursive: true, force: true });
}

console.log("PASS soak-evidence");
