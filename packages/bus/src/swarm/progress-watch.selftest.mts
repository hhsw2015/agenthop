/**
 * progress-watch selftest (L4 r2, long-run-liveness 2026-10-16). Pure judge (three-state) + episode/owed/commit state machine + the
 * real file readers on a private home + the coordinator-block lookup (authority, budget). Each reviewer counterexample is a case.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/progress-watch.selftest.mts  (from repo root)
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeProgress, planEmits, commitDelivery, initialWatchState, readProgressFacts, readBoxMails, writeL0Alert, findCoordinatorBlock,
  budgeted, HANDOFF_STALE_SEC, CARLY_STALE_SEC, DEDUP_SEC, RETRY_SEC, BLOCK_BUDGET_MS, type ProgressFacts, type Mail, type Budget } from "./progress-watch.js";
import { BEAT_STALE_SEC } from "./carly-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const NOW = 1_800_000_000;
const ok = (o: Partial<ProgressFacts> = {}): ProgressFacts => ({ nowSec: NOW, beatSec: NOW - 60, handoffMtimeSec: NOW - 600, mails: [], carlyBeatSec: NOW - 60, ...o });
const v = (f: ProgressFacts, k = "coordinator-stalled") => judgeProgress(f).find((j) => j.key === k)!.verdict;
const mail = (ageSec: number, sender: string | null = "claude:agenthop-x (Infra Dev)"): Mail => ({ sender, mtimeSec: NOW - ageSec });
const five = [mail(7200), mail(60), mail(60), mail(60), mail(60)];

// --- judge: on / off / unknown ---
t("normal cycle: off / off", v(ok()) === "off" && v(ok(), "carly-stale") === "off");
t("handoff 3h old, beat fresh ⇒ on", v(ok({ handoffMtimeSec: NOW - 3 * 3600 })) === "on");
t("box: 5 real mails, oldest 2h ⇒ on", v(ok({ mails: five })) === "on");
t("box: 3 real mails, oldest 30min ⇒ off", v(ok({ mails: [mail(1800), mail(60), mail(60)] })) === "off");
t("box: 2 real mails, oldest 3h ⇒ off (needs ≥3)", v(ok({ mails: [mail(10800), mail(10800)] })) === "off");
t("box: machine senders (from/fromLabel) are not real mail", v(ok({ mails: [mail(9000, "swarm-observer"), mail(9000, "swarm-observer"), mail(9000, "idle-explainer"), mail(9000, "disp-21990")] })) === "off");
t("beat stale ⇒ unknown here (no alert: death is the death paths' job; and not a recovery)", v(ok({ beatSec: NOW - BEAT_STALE_SEC - 1, handoffMtimeSec: NOW - 5 * 3600 })) === "unknown");
t("beat absent ⇒ unknown here", v(ok({ beatSec: "absent", handoffMtimeSec: NOW - 5 * 3600 })) === "unknown");
t("beat unreadable ⇒ unknown", v(ok({ beatSec: "unknown" })) === "unknown");
t("handoff unreadable (EIO) ⇒ unknown, not off", v(ok({ handoffMtimeSec: "unknown" })) === "unknown");
t("handoff absent (ENOENT) ⇒ off", v(ok({ handoffMtimeSec: "absent" })) === "off");
t("box unreadable ⇒ unknown", v(ok({ mails: "unknown" })) === "unknown");
t("box absent ⇒ off", v(ok({ mails: "absent" })) === "off");
// PW-SOURCE-UNKNOWN ②: three old observer mails whose bodies cannot be read must NOT become three real mails
t("3 old mails with unreadable senders ⇒ unknown, never on", v(ok({ mails: [mail(9000, null), mail(9000, null), mail(9000, null)] })) === "unknown");
t("unreadable-sender mail that cannot reach the threshold ⇒ off", v(ok({ mails: [mail(9000, null)] })) === "off");
t("real old mails already ≥3 ⇒ on even with unknown ones", v(ok({ mails: [...five, mail(9000, null)] })) === "on");
t("handoff on wins over an unknown box", v(ok({ handoffMtimeSec: NOW - 3 * 3600, mails: "unknown" })) === "on");
t("thresholds: handoff exactly 2h ⇒ off", v(ok({ handoffMtimeSec: NOW - HANDOFF_STALE_SEC })) === "off");
t("carly beat 31min / absent ⇒ on; unreadable ⇒ unknown", v(ok({ carlyBeatSec: NOW - CARLY_STALE_SEC - 60 }), "carly-stale") === "on"
  && v(ok({ carlyBeatSec: "absent" }), "carly-stale") === "on" && v(ok({ carlyBeatSec: "unknown" }), "carly-stale") === "unknown");
const txt = judgeProgress(ok({ handoffMtimeSec: NOW - 3 * 3600, mails: five }))[0]!.text;
t("alert text names handoff age, real mail count, oldest age and the instruction", /handoff 3\.0h old/.test(txt) && /5 real mail\(s\), oldest 2\.0h/.test(txt) && /do not wait for the user/.test(txt));

// --- state machine: episode, owed, commit on success (PW-EMIT-COMMIT) ---
const J = (f: ProgressFacts) => judgeProgress(f).filter((j) => j.key === "coordinator-stalled");
const stalled = J(ok({ handoffMtimeSec: NOW - 3 * 3600 }));
{
  const st = initialWatchState();
  let r = planEmits(st, stalled, NOW);
  t("commit: first round attempts once", r.attempt.length === 1);
  commitDelivery(st, "coordinator-stalled", false, NOW); // every surface failed
  r = planEmits(st, stalled, NOW + 5);
  t("commit: a wholly failed attempt is NOT throttled for 30min — but retried only after RETRY_SEC", r.attempt.length === 0);
  r = planEmits(st, stalled, NOW + RETRY_SEC);
  t("commit: retried after RETRY_SEC (owed)", r.attempt.length === 1);
  commitDelivery(st, "coordinator-stalled", true, NOW + RETRY_SEC); // IO is back: delivered
  let n = 0; for (let i = 1; i < 20; i++) n += planEmits(st, stalled, NOW + RETRY_SEC + i * 5).attempt.length;
  t("commit: once delivered, nothing for the next ticks", n === 0);
  r = planEmits(st, stalled, NOW + RETRY_SEC + DEDUP_SEC);
  t("commit: re-alert 30min after the DELIVERY", r.attempt.length === 1);
}
// the reviewers' end-to-end shape: first round all fail, next tick IO back ⇒ a real delivery happens
{
  const st = initialWatchState(); const delivered: number[] = [];
  let up = false;
  for (let tick = 0; tick <= 30; tick++) {
    const now = NOW + tick * 5;
    const { attempt } = planEmits(st, stalled, now);
    for (const a of attempt) { commitDelivery(st, a.key, up, now); if (up) delivered.push(now); }
    if (tick === 1) up = true; // IO recovers 5s after the failed first attempt
  }
  t("e2e: all surfaces fail, IO back 5s later ⇒ delivered within RETRY_SEC, exactly once", delivered.length === 1 && delivered[0]! - NOW <= RETRY_SEC);
}
// PW-SOURCE-UNKNOWN ①: open episode, one EIO tick, handoff never changed ⇒ no resolved, no re-alert
{
  const st = initialWatchState(); const out: string[] = [];
  const seq: Array<ProgressFacts["handoffMtimeSec"]> = [NOW - 3 * 3600, "unknown", NOW - 3 * 3600, NOW - 3 * 3600];
  seq.forEach((hm, i) => {
    const now = NOW + i * 5; const { attempt, resolved } = planEmits(st, J(ok({ nowSec: now, handoffMtimeSec: hm })), now);
    for (const a of attempt) { out.push(`fire@${i}`); commitDelivery(st, a.key, true, now); }
    for (const k of resolved) out.push(`resolved@${i}:${k}`);
  });
  t("unknown keeps the episode: stalled, EIO, stalled ⇒ one fire, no resolved, no re-fire", out.join() === "fire@0");
}
{
  const st = initialWatchState();
  planEmits(st, stalled, NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  let r = planEmits(st, J(ok({ nowSec: NOW + 5, handoffMtimeSec: NOW })), NOW + 5);
  t("affirmative recovery (handoff rewritten) ⇒ one resolved", r.resolved.join() === "coordinator-stalled");
  r = planEmits(st, J(ok({ nowSec: NOW + 10, handoffMtimeSec: NOW })), NOW + 10);
  t("resolved not repeated", r.resolved.length === 0 && r.attempt.length === 0);
  r = planEmits(st, stalled, NOW + 15);
  t("a new episode after resolve attempts immediately", r.attempt.length === 1);
}
{
  // unknown never resolves, even when the marker it carries moved: handoff rewritten (fresh) but the BOX is now unreadable ⇒ the
  // box side is unknown ⇒ verdict unknown ⇒ episode kept (only an all-sides "off" with progress evidence closes it)
  const st = initialWatchState();
  planEmits(st, J(ok({ handoffMtimeSec: NOW - 3 * 3600, mails: five })), NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  const j = J(ok({ nowSec: NOW + 5, handoffMtimeSec: NOW + 1, mails: "unknown" }));
  const r = planEmits(st, j, NOW + 5);
  t("unknown with an advanced marker ⇒ still kept (unknown never resolves)", j[0]!.verdict === "unknown" && r.resolved.length === 0);
}
{
  // a stalled coordinator that then DIES: the episode is not "resolved" by its death
  const st = initialWatchState();
  planEmits(st, stalled, NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  const r = planEmits(st, J(ok({ nowSec: NOW + 5, beatSec: NOW - BEAT_STALE_SEC - 10, handoffMtimeSec: NOW - 3 * 3600 })), NOW + 5);
  t("stalled then dead ⇒ no resolved", r.resolved.length === 0);
}
{
  // the clock jumps forward while nothing changes: verdicts go "off" on age, but the marker did not advance ⇒ no resolved
  const st = initialWatchState();
  const hm = NOW - 3 * 3600;
  planEmits(st, J(ok({ handoffMtimeSec: hm })), NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  const r = planEmits(st, J(ok({ nowSec: NOW - 7200, beatSec: NOW - 7230, handoffMtimeSec: hm })), NOW - 7200); // clock 2h back
  t("clock moves, handoff mtime unchanged ⇒ no resolved", r.resolved.length === 0);
}
{
  // an episode opened by the BOX alone (handoff fresh) resolves when the box is drained, without needing a new handoff
  const st = initialWatchState();
  planEmits(st, J(ok({ mails: five })), NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  let r = planEmits(st, J(ok({ nowSec: NOW + 5, mails: "unknown" })), NOW + 5);
  t("box-only episode: box unreadable ⇒ kept", r.resolved.length === 0);
  r = planEmits(st, J(ok({ nowSec: NOW + 10, mails: [] })), NOW + 10);
  t("box-only episode: box drained ⇒ resolved", r.resolved.join() === "coordinator-stalled");
}
{
  const st = initialWatchState();
  planEmits(st, stalled, NOW); // attempted, never delivered
  const r = planEmits(st, J(ok({ nowSec: NOW + 5 })), NOW + 5);
  t("an episode nobody was told about closes without a resolved line", r.resolved.length === 0);
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
  for (let i = 0; i < 5; i++) { const f = path.join(bdir, `m${i}.json`); writeFileSync(f, JSON.stringify(i === 4 ? { from: "disp-21990", fromLabel: "swarm-observer", text: "x" } : { fromLabel: "claude:agenthop-x (Infra Dev)", text: "x" })); utimesSync(f, NOW - 7200 + i, NOW - 7200 + i); }
  writeFileSync(path.join(bdir, "byfrom.json"), JSON.stringify({ from: "swarm-sweep", text: "x" }));
  writeFileSync(path.join(bdir, "processed", "old.json"), "{}"); writeFileSync(path.join(bdir, "torn.json"), "{not json");
  const mails = readBoxMails(bdir) as Mail[];
  t("box reader: top-level *.json only (processed/ and .pubcred ignored)", Array.isArray(mails) && mails.length === 7);
  t("box reader: sender from fromLabel, else from; unreadable body ⇒ null", mails.filter((m) => m.sender === "swarm-sweep").length === 1 && mails.filter((m) => m.sender === null).length === 1);
  const facts = readProgressFacts(home, box, NOW);
  t("facts: beat / handoff / carly read from the real paths", facts.beatSec === NOW - 30 && facts.handoffMtimeSec === NOW - 3 * 3600 && facts.carlyBeatSec === NOW - 60);
  t("fixture (handoff 3h + 4 real mails) ⇒ on", v(facts) === "on");
  t("box dir absent ⇒ absent; no coordinator box ⇒ unknown", readBoxMails(path.join(home, "nope")) === "absent" && readProgressFacts(home, null, NOW).mails === "unknown");
  const noRead = path.join(home, "noread"); mkdirSync(noRead); chmodSync(noRead, 0o000);
  t("box dir unreadable (EACCES) ⇒ unknown", readBoxMails(noRead) === "unknown"); chmodSync(noRead, 0o700);
  writeFileSync(path.join(sw, "coordinator.beat"), "garbage\n");
  t("beat that is not an integer ⇒ unknown", readProgressFacts(home, box, NOW).beatSec === "unknown");
  const f = writeL0Alert(home, { key: "coordinator-stalled", text: "x" }, NOW);
  const j = JSON.parse(readFileSync(f, "utf8"));
  t("L0 alert: ~/.agenthop/carly/alerts/coordinator_stalled-<ts>.json", path.basename(f) === `coordinator_stalled-${NOW}.json` && j.kind === "coordinator_stalled" && j.source === "dispatcher");
  t("L0 alert: no temp left", readdirSync(path.dirname(f)).every((n) => !n.includes(".tmp-")));
}

// --- coordinator block: authority (PW-COORDINATOR-OWNERSHIP) ---
const COORD = "fb801a23-df75-4c57-bc05-7d89900a924c", MEMBER = "11111111-2222-4333-8444-555555555555";
// world: block 100 runs the coordinator (agent pid 5001 under root 5000), block 200 runs a member (agent 6001 under 6000)
const world = (over: Partial<{ pid: Record<string, "absent" | "unknown" | number>; origin: Record<string, string>; parent: Record<number, number> }> = {}) => {
  const pid = { [COORD]: 5001, [MEMBER]: 6001, ...(over.pid ?? {}) } as Record<string, "absent" | "unknown" | number>;
  const origin = { [COORD]: "agent", [MEMBER]: "agent", ...(over.origin ?? {}) } as Record<string, string>;
  const parent: Record<number, number> = { 5001: 5000, 5000: 1, 6001: 6000, 6000: 1, ...(over.parent ?? {}) };
  const sent: string[] = []; let calls = 0;
  const tern = (args: string[]) => {
    calls++;
    if (args[0] === "ls") return { ok: true, stdout: JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 100, live: true }, { id: 200, live: true }] }] }] }) };
    if (args[0] === "process") return { ok: true, stdout: JSON.stringify({ child: { pid: args[1] === "100" ? 5000 : 6000 } }) };
    sent.push(args.join(" ")); return { ok: true, stdout: "" };
  };
  const isAncestor = (p: number, root: number) => { for (let x = p, n = 0; x > 1 && n < 64; n++) { if (x === root) return true; x = parent[x] ?? 1; } return false; };
  return { pid: (s: string) => pid[s] ?? "absent", origin: (s: string) => origin[s] ?? "absent", tern, isAncestor, sent, calls: () => calls };
};
{
  const w = world(); const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: the coordinator's agent pid sits under exactly block 100 ⇒ 100", "block" in r && r.block === "100");
}
{
  const w = world(); const r = findCoordinatorBlock(null, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: SWARM_COORDINATOR unresolved ⇒ none, and no tern call at all", "none" in r && w.calls() === 0);
}
{
  // reviewers' case: the coordinator has no identifiable block (its presence is gone) — a member must never be chosen instead
  const w = world({ pid: { [COORD]: "absent" } }); const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: coordinator presence absent ⇒ none (never a member's block)", "none" in r && w.calls() === 0);
}
{
  const w = world({ pid: { [COORD]: "unknown" } }); const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: coordinator presence unreadable ⇒ none", "none" in r);
}
{
  const w = world({ origin: { [COORD]: "bus" } }); const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: presence written by the bus process (origin=bus) is not an agent pid ⇒ none", "none" in r && w.calls() === 0);
}
{
  const w = world({ parent: { 5001: 6000 } }); // the coordinator pid now lives under the MEMBER's root
  const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, w.isAncestor);
  t("block: answer follows the process tree, not names", "block" in r && r.block === "200");
}
{
  const w = world({ parent: { 6000: 5000 } }); // both roots contain the pid chain ⇒ ambiguous
  const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, (p, root) => (root === 5000 || root === 6000 ? true : false));
  t("block: two blocks contain the pid ⇒ none (never guess)", "none" in r);
}
{
  const w = world(); const r = findCoordinatorBlock(COORD, w.pid, w.origin, w.tern, () => null);
  t("block: process tree unreadable ⇒ none", "none" in r);
}

// --- budget (PW-SWEEP-BUDGET): one inventory, bounded wall time ---
{
  // 8 live blocks, every `tern process` takes 1.5s on a virtual clock ⇒ the lookup must stop at the 3s budget
  let clock = 0; let calls = 0;
  const slow = (args: string[]) => { calls++; clock += 1500;
    return args[0] === "ls" ? { ok: true, stdout: JSON.stringify({ sessions: [{ tabs: [{ blocks: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, live: true })) }] }] }) }
      : { ok: false, stdout: "" }; };
  const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  const r = findCoordinatorBlock(COORD, () => 5001, () => "agent", budgeted(slow, b, () => clock), () => false);
  t("budget: 8 blocks × 1.5s ⇒ stops at the 3s budget (≤ 2 calls), answer none", "none" in r && calls <= 2 && clock <= BLOCK_BUDGET_MS);
  t("budget: says why", "none" in r && /budget/.test(r.none));
}
{
  const w = world(); const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  findCoordinatorBlock(COORD, w.pid, w.origin, budgeted(w.tern, b), w.isAncestor);
  t("budget: one ls + one process per block, per round (2 blocks ⇒ 3 calls)", b.calls === 3);
}
console.log("PASS progress-watch");
