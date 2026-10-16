/**
 * progress-watch selftest (L4 r2, long-run-liveness 2026-10-16). Pure judge (three-state) + episode/owed/commit state machine + the
 * real file readers on a private home + the coordinator-block lookup (authority, budget). Each reviewer counterexample is a case.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/progress-watch.selftest.mts  (from repo root)
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeProgress, planEmits, commitDelivery, commitResolved, initialWatchState, readProgressFacts, readBoxMails, writeL0Alert, findCoordinatorBlock,
  budgeted, roleBoxOwned, agentAmong, HANDOFF_STALE_SEC, CARLY_STALE_SEC, DEDUP_SEC, RETRY_SEC, BLOCK_BUDGET_MS, MAIL_SCAN_MAX, MAIL_BODY_MAX, type ProgressFacts, type Mail, type Budget } from "./progress-watch.js";
import { spawnSync } from "node:child_process";
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

// --- coordinator block: authority (ownership = process table; L8 ruling) + uniqueness over the WHOLE inventory (PW-LOCATOR-UNKNOWN) ---
const COORD = "fa801a23-df75-4c57-bc05-7d89900a924c"; // made-up
type Proc = { ok: boolean; stdout: string } | "fail" | "badjson" | "nochild";
const world = (procs: Record<number, Proc> = {}, agentAt: Record<number, number | null | "unknown"> = { 5000: 5001, 6000: null }) => {
  let calls = 0;
  const tern = (args: string[]) => {
    calls++;
    if (args[0] === "ls") return { ok: true, stdout: JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 100, live: true }, { id: 200, live: true }] }] }] }) };
    const id = Number(args[1]); const p = procs[id];
    if (p === "fail") return { ok: false, stdout: "" };
    if (p === "badjson") return { ok: true, stdout: "{not json" };
    if (p === "nochild") return { ok: true, stdout: "{}" };
    return p ?? { ok: true, stdout: JSON.stringify({ child: { pid: id === 100 ? 5000 : 6000 } }) };
  };
  return { tern, agentUnder: (root: number) => agentAt[root] ?? null, calls: () => calls };
};
{ const w = world(); const r = findCoordinatorBlock(COORD, w.tern, w.agentUnder);
  t("block: the coordinator's claude runs under exactly block 100, the other block proven clear ⇒ 100", "block" in r && r.block === "100"); }
{ const w = world(); const r = findCoordinatorBlock(null, w.tern, w.agentUnder);
  t("block: no live coordinator session ⇒ none, zero tern calls", "none" in r && w.calls() === 0); }
{ const w = world({}, { 5000: null, 6000: null }); const r = findCoordinatorBlock(COORD, w.tern, w.agentUnder);
  t("block: coordinator runs under no block (stale presence irrelevant) ⇒ none, never a member's block", "none" in r); }
{ const w = world({}, { 5000: 5001, 6000: 6001 }); const r = findCoordinatorBlock(COORD, w.tern, w.agentUnder);
  t("block: two blocks run the sid ⇒ none", "none" in r); }
// Chief Review's three variants: one block is a known hit, the OTHER block's process call fails / is bad JSON / has no child
for (const bad of ["fail", "badjson", "nochild"] as const) {
  const w = world({ 200: bad }); const r = findCoordinatorBlock(COORD, w.tern, w.agentUnder);
  t(`block: known hit + other block ${bad} ⇒ HOLD (uniqueness not proven)`, "none" in r && /HOLD/.test(r.none));
}
{ const w = world({}, { 5000: 5001, 6000: "unknown" }); const r = findCoordinatorBlock(COORD, w.tern, w.agentUnder);
  t("block: known hit + other block's argv unreadable ⇒ HOLD", "none" in r && /HOLD/.test(r.none)); }

// --- budget (PW-SWEEP-BUDGET): the remaining budget is the call's own timeout; a late result is refused ---
{
  let clock = 0;
  // calls take 900 / 1500 / 1500 ms (Chief Review's figures): the 3rd would end at 3900ms > 3000 ⇒ refused, lookup HOLDs
  const durations = [900, 1500, 1500]; let i = 0; const seenTimeouts: number[] = [];
  const run = (args: string[], timeoutMs: number) => { seenTimeouts.push(timeoutMs); const d = durations[i++] ?? 1500; const took = Math.min(d, timeoutMs); clock += took;
    const ok = { ok: true, stdout: args[0] === "ls" ? JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 100, live: true }, { id: 200, live: true }] }] }] }) : JSON.stringify({ child: { pid: args[1] === "100" ? 5000 : 6000 } }) };
    return d > timeoutMs ? { ok: false, stdout: "", timedOut: true } : ok; };
  const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  const r = findCoordinatorBlock(COORD, budgeted(run, b, () => clock), (root) => (root === 5000 ? 5001 : null));
  t("budget: each call gets the REMAINING budget as its timeout (3000, 2100, 600)", JSON.stringify(seenTimeouts) === JSON.stringify([3000, 2100, 600]));
  t("budget: the call cut at the budget is refused ⇒ HOLD, no block, total ≤ 3000ms", "none" in r && clock <= BLOCK_BUDGET_MS);
}
{
  let clock = 0; let calls = 0;
  const slow = (args: string[], timeoutMs: number) => { calls++; const took = Math.min(1500, timeoutMs); clock += took;
    return args[0] === "ls" ? { ok: true, stdout: JSON.stringify({ sessions: [{ tabs: [{ blocks: Array.from({ length: 8 }, (_, k) => ({ id: k + 1, live: true })) }] }] }) }
      : { ok: false, stdout: "", timedOut: took < 1500 }; };
  const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  const r = findCoordinatorBlock(COORD, budgeted(slow, b, () => clock), () => null);
  t("budget: 8 blocks × 1.5s ⇒ stops within 3s, answer none", "none" in r && clock <= BLOCK_BUDGET_MS && calls <= 2);
}
{
  // a call that IGNORES its timeout and returns a good answer after the budget is gone must not be used (PW-SWEEP-BUDGET)
  let clock = 0; const w = world();
  const late = (args: string[]) => { clock += args[0] === "process" && args[1] === "200" ? 2700 : 200; return { ...w.tern(args), timedOut: false }; };
  const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  const r = findCoordinatorBlock(COORD, budgeted(late, b, () => clock), w.agentUnder);
  t("budget: a result that arrives after the budget is spent is refused ⇒ HOLD, never a block", "none" in r && b.leftMs < 0);
}
{ const w = world(); const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 };
  findCoordinatorBlock(COORD, budgeted((a) => w.tern(a), b), w.agentUnder);
  t("budget: one ls + one process per block, per round (2 blocks ⇒ 3 calls)", b.calls === 3); }

// --- bounded fact reads (PW-SV-SWEEP-BUDGET / PW-SWEEP-BUDGET) ---
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pwb-")); const box = path.join(home, "box"); mkdirSync(box);
  for (let i = 0; i < MAIL_SCAN_MAX; i++) writeFileSync(path.join(box, `m${i}.json`), JSON.stringify({ fromLabel: "x" }));
  t("box: exactly MAIL_SCAN_MAX mails are scanned", Array.isArray(readBoxMails(box)));
  writeFileSync(path.join(box, "one-more.json"), "{}");
  t("box: more than MAIL_SCAN_MAX ⇒ unknown (this round cannot prove either way)", readBoxMails(box) === "unknown");
  const box2 = path.join(home, "box2"); mkdirSync(box2); spawnSync("mkfifo", [path.join(box2, "fifo.json")]);
  const t0 = Date.now(); const r = readBoxMails(box2);
  t("box: a FIFO named *.json ⇒ unknown, immediately (never opened)", r === "unknown" && Date.now() - t0 < 500);
  const box3 = path.join(home, "box3"); mkdirSync(box3); for (let i = 0; i < 5; i++) writeFileSync(path.join(box3, `m${i}.json`), "{}");
  let clk = 0; const r3 = readBoxMails(box3, MAIL_SCAN_MAX, 2, () => clk++); // deadline after 2 ticks of a fake clock
  t("box: a scan cut by its deadline ⇒ unknown", r3 === "unknown");
  const big = path.join(home, "box4"); mkdirSync(big); writeFileSync(path.join(big, "big.json"), JSON.stringify({ fromLabel: "claude:x", pad: "y".repeat(MAIL_BODY_MAX) }));
  const r4 = readBoxMails(big) as Mail[];
  t("box: a body over MAIL_BODY_MAX is counted, not read (sender unknown)", Array.isArray(r4) && r4.length === 1 && r4[0]!.sender === null);
  const sw = path.join(home, ".agenthop", "swarm"); mkdirSync(sw, { recursive: true });
  spawnSync("mkfifo", [path.join(sw, "coordinator.beat")]); spawnSync("mkfifo", [path.join(sw, "coordinator-handoff.md")]);
  const t1 = Date.now(); const f = readProgressFacts(home, null, NOW);
  t("facts: FIFO beat / handoff ⇒ unknown, immediately", f.beatSec === "unknown" && f.handoffMtimeSec === "unknown" && Date.now() - t1 < 500);
  rmSync(home, { recursive: true, force: true });
}

// --- the "resolved" notice is its own obligation (PW-EMIT-COMMIT-RESOLVE / PW-SV-DELIVERY-COMMIT) ---
{
  const st = initialWatchState(); const delivered: string[] = [];
  planEmits(st, stalled, NOW); commitDelivery(st, "coordinator-stalled", true, NOW); // alert delivered
  let up = false;
  for (let tick = 1; tick <= 30; tick++) {
    const now = NOW + tick * 5;
    const { resolved } = planEmits(st, J(ok({ nowSec: now, handoffMtimeSec: NOW + 1 })), now); // handoff really advanced
    for (const k of resolved) { commitResolved(st, k, up); if (up) delivered.push(`${tick}:${k}`); }
    if (tick === 2) up = true; // the notice failed on its first attempt; IO comes back 5s later
  }
  t("resolved: alert ok → resolved notice fails → IO back → exactly one delivered notice, within RETRY_SEC", delivered.length === 1 && Number(delivered[0]!.split(":")[0]) * 5 - 5 <= RETRY_SEC + 5);
  t("resolved: then nothing more", st.resolveOwed.size === 0);
}
{
  const st = initialWatchState();
  planEmits(st, stalled, NOW); commitDelivery(st, "coordinator-stalled", true, NOW);
  planEmits(st, J(ok({ nowSec: NOW + 5, handoffMtimeSec: NOW + 1 })), NOW + 5); // recovered, notice owed, not delivered
  const r = planEmits(st, J(ok({ nowSec: NOW + 10, handoffMtimeSec: NOW - 3 * 3600 + 10 })), NOW + 10);
  t("resolved: a NEW stall before the notice went out supersedes it (no stale resolved)", !st.resolveOwed.has("coordinator-stalled") && r.resolved.length === 0);
}

// --- inbox-sentinel role box (#1116): owned iff the live coordinator sid's claude is in the PROCESS TABLE (real processes) ---
{
  const { parsePs, realExactArgv, resolveAgentPid } = await import("./seat-presence.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rbo-"));
  writeFileSync(path.join(dir, "tern.c"), '#include <unistd.h>\nint main(int c,char**v){ if(c<4)return 2; if(fork()==0){char*b=v[2];v[2]="claude";execv(b,&v[2]);_exit(127);} for(;;)pause(); }\n');
  writeFileSync(path.join(dir, "claude.c"), "#include <unistd.h>\nint main(void){for(;;)pause();}\n");
  const built = ["tern", "claude"].every((n) => spawnSync("cc", ["-o", path.join(dir, n), path.join(dir, `${n}.c`)]).status === 0);
  t("role box: process fixture builds (cc)", built);
  const SIDX = "ffffffff-1111-4222-8333-444444444444"; // made-up
  const { spawn } = await import("node:child_process");
  const root = spawn(path.join(dir, "tern"), ["acp", path.join(dir, "claude"), "--output-format", "stream-json", `--session-id=${SIDX}`], { stdio: "ignore", detached: true });
  spawnSync("sleep", ["0.5"]);
  const look = () => { const rows = parsePs(spawnSync("ps", ["axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout); const ex = realExactArgv();
    return agentAmong(rows.filter((r) => r.argv.join(" ").includes("tern acp")).map((r) => r.pid), (r) => resolveAgentPid(r, SIDX, "claude", rows, ex)); };
  t("role box: live coordinator claude in the process table ⇒ owned (no STALL)", roleBoxOwned(SIDX, look()));
  t("role box: no live coordinator sid (file missing/stale/not a sid) ⇒ not owned (sentinel unchanged)", !roleBoxOwned(null, look()));
  process.kill(-root.pid!, "SIGKILL"); spawnSync("sleep", ["0.3"]);
  t("role box: that claude is gone ⇒ not owned (STALL still fires)", !roleBoxOwned(SIDX, look()));
  t("role box: process table unknown ⇒ not owned", !roleBoxOwned(SIDX, "unknown"));
  rmSync(dir, { recursive: true, force: true });
}
console.log("PASS progress-watch");
