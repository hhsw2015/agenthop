/**
 * soak-evidence selftest. Record shapes (timed, nulls instead of guesses), append-only behaviour, and one-report-per-failure-episode.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/soak-evidence.selftest.mts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { appendEvidence, bridgeTickRecord, inboxOldestRecord, shouldReportEvidenceFailure, commitEvidenceReport, sampleRoleBox, soakDir } from "./soak-evidence.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const NOW = Date.parse("2026-10-16T20:00:00.000Z"), BOX = "c0c0c0c0-1111-4222-8333-444444444444"; // made-up

const r1 = inboxOldestRecord(NOW, BOX, [{ mtimeSec: NOW / 1000 - 600 }, { mtimeSec: NOW / 1000 - 30 }], true);
t("inbox-oldest: ISO ts first, oldest age in seconds, owner", r1.ts === "2026-10-16T20:00:00.000Z" && r1.oldest_age_s === 600 && r1.live_owner === true && Object.keys(r1)[0] === "ts");
t("inbox-oldest: an empty box is a measured 0", inboxOldestRecord(NOW, BOX, [], false).oldest_age_s === 0);
const r3 = inboxOldestRecord(NOW, BOX, null, null, "box unreadable");
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
  t("sample: box directory absent (no inbox yet) ⇒ one record, oldest 0", sampleRoleBox(h, BOXK, null, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 0);
  mkdirSync(boxDir, { recursive: true });
  t("sample: empty box ⇒ one record, oldest 0", sampleRoleBox(h, BOXK, true, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 0 && lines().length === 2);
  const f = path.join(boxDir, "m1.json"); writeFileSync(f, JSON.stringify({ fromLabel: "x" })); utimesSync(f, NOW / 1000 - 900, NOW / 1000 - 900);
  t("sample: one mail 15min old ⇒ one record, oldest 900s", sampleRoleBox(h, BOXK, true, NOW, readBoxMails) && lines().at(-1).oldest_age_s === 900 && lines().length === 3);
  chmodSync(boxDir, 0o000);
  t("sample: box unreadable ⇒ one record, null + reason", sampleRoleBox(h, BOXK, true, NOW, readBoxMails) && lines().at(-1).oldest_age_s === null && typeof lines().at(-1).reason === "string" && lines().length === 4);
  chmodSync(boxDir, 0o700);
  t("sample: a reader that throws ⇒ still one record (null + reason)", sampleRoleBox(h, BOXK, null, NOW, () => { throw new Error("boom"); }) && lines().at(-1).oldest_age_s === null && lines().length === 5);
  rmSync(h, { recursive: true, force: true });
}
rmSync(home, { recursive: true, force: true });
console.log("PASS soak-evidence");
