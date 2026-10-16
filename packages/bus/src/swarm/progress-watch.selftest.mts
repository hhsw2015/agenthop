/**
 * progress-watch selftest (L4, long-run-liveness 2026-10-16). Pure judge + dedup/resolve + the real file readers on a private home.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/progress-watch.selftest.mts  (from repo root)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeProgress, planEmits, initialWatchState, readProgressFacts, readBoxMails, writeL0Alert, blockForSession,
  HANDOFF_STALE_SEC, MAIL_OLD_SEC, CARLY_STALE_SEC, DEDUP_SEC, type ProgressFacts } from "./progress-watch.js";
import { BEAT_STALE_SEC } from "./carly-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const NOW = 1_800_000_000;
const ok = (o: Partial<ProgressFacts> = {}): ProgressFacts => ({ nowSec: NOW, beatSec: NOW - 60, handoffMtimeSec: NOW - 600, mails: [], carlyBeatSec: NOW - 60, ...o });
const keys = (f: ProgressFacts) => judgeProgress(f).map((a) => a.key).join(",");
const mail = (ageSec: number, fromLabel = "claude:agenthop-x (Infra Dev)") => ({ fromLabel, mtimeSec: NOW - ageSec });

// --- the judge ---
t("normal cycle: zero alerts", keys(ok()) === "");
t("handoff 3h old, beat fresh ⇒ coordinator-stalled", keys(ok({ handoffMtimeSec: NOW - 3 * 3600 })) === "coordinator-stalled");
t("box: 5 real mails, oldest 2h, fresh handoff ⇒ coordinator-stalled", keys(ok({ mails: [mail(7200), mail(60), mail(60), mail(60), mail(60)] })) === "coordinator-stalled");
t("box: 3 real mails but oldest only 30min ⇒ no alert", keys(ok({ mails: [mail(1800), mail(60), mail(60)] })) === "");
t("box: 2 real mails, oldest 3h ⇒ no alert (needs ≥3)", keys(ok({ mails: [mail(10800), mail(10800)] })) === "");
t("box: machine notices (observer etc.) are not real mail", keys(ok({ mails: [mail(9000, "swarm-observer"), mail(9000, "swarm-observer"), mail(9000, "idle-explainer"), mail(9000, "swarm-sweep")] })) === "");
t("beat STALE (death) ⇒ not reported here, even with an old handoff", keys(ok({ beatSec: NOW - BEAT_STALE_SEC - 1, handoffMtimeSec: NOW - 5 * 3600 })) === "");
t("beat absent ⇒ not reported here", keys(ok({ beatSec: null, handoffMtimeSec: NOW - 5 * 3600 })) === "");
t("handoff unreadable is no evidence of a stall", keys(ok({ handoffMtimeSec: null })) === "");
t("box unreadable is no evidence of a stall", keys(ok({ mails: null })) === "");
t("thresholds: handoff exactly 2h ⇒ no alert", keys(ok({ handoffMtimeSec: NOW - HANDOFF_STALE_SEC })) === "");
t("carly beat 31min ⇒ carly-stale", keys(ok({ carlyBeatSec: NOW - CARLY_STALE_SEC - 60 })) === "carly-stale");
t("carly beat absent ⇒ carly-stale", keys(ok({ carlyBeatSec: null })) === "carly-stale");
t("both at once", keys(ok({ handoffMtimeSec: NOW - 3 * 3600, carlyBeatSec: null })) === "coordinator-stalled,carly-stale");
const txt = judgeProgress(ok({ handoffMtimeSec: NOW - 3 * 3600, mails: [mail(7200), mail(60), mail(60), mail(60), mail(60)] }))[0]!.text;
t("alert text names handoff age, real mail count, oldest age and the instruction", /handoff 3\.0h old/.test(txt) && /5 real mail\(s\), oldest 2\.0h/.test(txt) && /do not wait for the user/.test(txt));

// --- dedup + resolve ---
{
  const st = initialWatchState();
  const stalled = judgeProgress(ok({ handoffMtimeSec: NOW - 3 * 3600 }));
  let r = planEmits(st, stalled, NOW);
  t("dedup: first round fires once", r.fire.length === 1 && r.resolved.length === 0);
  let fires = 0;
  for (let i = 1; i <= 6; i++) fires += planEmits(st, stalled, NOW + i * 5).fire.length; // 5s ticks
  t("dedup: the next 6 ticks fire nothing", fires === 0);
  r = planEmits(st, stalled, NOW + DEDUP_SEC);
  t("dedup: fires again after 30min while it persists", r.fire.length === 1);
  r = planEmits(st, [], NOW + DEDUP_SEC + 5);
  t("resolve: one resolved line when it clears", r.resolved.join() === "coordinator-stalled" && r.fire.length === 0);
  r = planEmits(st, [], NOW + DEDUP_SEC + 10);
  t("resolve: not repeated", r.resolved.length === 0);
  r = planEmits(st, stalled, NOW + DEDUP_SEC + 15);
  t("a new episode after resolve fires immediately", r.fire.length === 1);
}

// --- real file readers on a private home ---
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pw-"));
  const sw = path.join(home, ".agenthop", "swarm"); mkdirSync(sw, { recursive: true });
  const box = "c5beaa7c-acbb-4637-a197-2e9014ae42f8";
  const bdir = path.join(home, ".agenthop", "inbox", box); mkdirSync(path.join(bdir, "processed"), { recursive: true }); mkdirSync(path.join(bdir, ".pubcred"));
  writeFileSync(path.join(sw, "coordinator.beat"), `${NOW - 30}\n`);
  writeFileSync(path.join(sw, "coordinator-handoff.md"), "x"); utimesSync(path.join(sw, "coordinator-handoff.md"), NOW - 3 * 3600, NOW - 3 * 3600);
  mkdirSync(path.join(home, ".agenthop", "carly"), { recursive: true }); writeFileSync(path.join(home, ".agenthop", "carly", "carly-patrol.beat"), `${NOW - 60}\n`);
  for (let i = 0; i < 5; i++) { const f = path.join(bdir, `m${i}.json`); writeFileSync(f, JSON.stringify({ fromLabel: i === 4 ? "swarm-observer" : "claude:agenthop-x (Infra Dev)", text: "x" })); utimesSync(f, NOW - 7200 + i, NOW - 7200 + i); }
  writeFileSync(path.join(bdir, "processed", "old.json"), "{}"); writeFileSync(path.join(bdir, "torn.json"), "{not json");
  const mails = readBoxMails(bdir)!;
  t("box reader: top-level *.json only (processed/ and .pubcred ignored)", mails.length === 6);
  t("box reader: an unreadable body still counts as real mail", mails.some((m) => m.fromLabel === ""));
  const facts = readProgressFacts(home, box, NOW);
  t("facts: beat / handoff / carly read from the real paths", facts.beatSec === NOW - 30 && facts.handoffMtimeSec === NOW - 3 * 3600 && facts.carlyBeatSec === NOW - 60);
  t("fixture (handoff 3h + 5 mails) ⇒ coordinator-stalled", judgeProgress(facts).map((a) => a.key).join() === "coordinator-stalled");
  t("box absent ⇒ [] (not unreadable)", JSON.stringify(readBoxMails(path.join(home, "nope"))) === "[]");
  t("no coordinator box configured ⇒ mails null (no evidence)", readProgressFacts(home, null, NOW).mails === null);
  const f = writeL0Alert(home, judgeProgress(facts)[0]!, NOW);
  const j = JSON.parse(readFileSync(f, "utf8"));
  t("L0 alert: ~/.agenthop/carly/alerts/coordinator_stalled-<ts>.json", path.basename(f) === `coordinator_stalled-${NOW}.json` && j.kind === "coordinator_stalled" && j.source === "dispatcher");
  t("L0 alert: no temp left", readdirSync(path.dirname(f)).every((n) => !n.includes(".tmp-")));
}

// --- which block to type into ---
t("block: exactly one root resolves ⇒ that block", blockForSession([{ id: "1", rootPid: 10 }, { id: "2", rootPid: 20 }], (r) => (r === 20 ? 99 : null)) === "2");
t("block: none ⇒ null", blockForSession([{ id: "1", rootPid: 10 }], () => null) === null);
t("block: two ⇒ null (never guess)", blockForSession([{ id: "1", rootPid: 10 }, { id: "2", rootPid: 20 }], () => 99) === null);
console.log("PASS progress-watch");
