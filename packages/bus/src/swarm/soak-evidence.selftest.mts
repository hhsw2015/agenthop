/**
 * soak-evidence selftest. Record shapes (timed, nulls instead of guesses), append-only behaviour, and one-report-per-failure-episode.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/soak-evidence.selftest.mts
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvidence, bridgeTickRecord, inboxOldestRecord, shouldReportEvidenceFailure, soakDir } from "./soak-evidence.js";

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

const st = new Set<string>();
t("report: the first failure reports", shouldReportEvidenceFailure(st, "f", false));
t("report: further failures in the same episode do not", !shouldReportEvidenceFailure(st, "f", false) && !shouldReportEvidenceFailure(st, "f", false));
t("report: a success ends the episode (no report)", !shouldReportEvidenceFailure(st, "f", true));
t("report: the next failure reports again", shouldReportEvidenceFailure(st, "f", false));
rmSync(home, { recursive: true, force: true });
console.log("PASS soak-evidence");
