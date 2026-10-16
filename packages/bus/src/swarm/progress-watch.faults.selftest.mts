/**
 * [liveness] fault-injection list for L4 progress-watch (docs/swarm/liveness-tier.md §2.2). One case per failure class, each run
 * against the REAL readers / state machine / block lookup on a private home and real processes. Prints one line per case:
 *   FAULT <class> | inject: <how> | expect: <what> | got: <what>
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/progress-watch.faults.selftest.mts
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeProgress, planEmits, commitDelivery, initialWatchState, readProgressFacts, findCoordinatorBlock, budgeted, BLOCK_BUDGET_MS,
  RETRY_SEC, type Budget } from "./progress-watch.js";

let bad = 0;
const row = (cls: string, inject: string, expect: string, got: string, pass: boolean) => {
  console.log(`${pass ? "ok  " : "FAIL"} FAULT ${cls} | inject: ${inject} | expect: ${expect} | got: ${got}`); if (!pass) bad++;
};
const now = () => Math.floor(Date.now() / 1000);
const home = mkdtempSync(path.join(os.tmpdir(), "pwf-"));
const sw = path.join(home, ".agenthop", "swarm"); mkdirSync(sw, { recursive: true });
const BOX = "c5beaa7c-acbb-4637-a197-2e9014ae42f8";
const bdir = path.join(home, ".agenthop", "inbox", BOX); mkdirSync(bdir, { recursive: true });
mkdirSync(path.join(home, ".agenthop", "carly"), { recursive: true });
const beat = (age: number) => writeFileSync(path.join(sw, "coordinator.beat"), `${now() - age}\n`);
const handoff = (age: number) => { const f = path.join(sw, "coordinator-handoff.md"); writeFileSync(f, "x"); utimesSync(f, now() - age, now() - age); };
writeFileSync(path.join(home, ".agenthop", "carly", "carly-patrol.beat"), `${now()}\n`);
const verdict = () => judgeProgress(readProgressFacts(home, BOX, now())).find((j) => j.key === "coordinator-stalled")!.verdict;

// 1. process dead (kill -9): the coordinator process is gone ⇒ its beat goes stale ⇒ NOT this watch's alert (death paths own it)
{
  const c = spawn("sh", ["-c", `while :; do date +%s > ${path.join(sw, "coordinator.beat")}; sleep 1; done`], { stdio: "ignore" });
  spawnSync("sleep", ["1.2"]); handoff(3 * 3600);
  const before = verdict(); c.kill("SIGKILL"); spawnSync("sleep", ["0.3"]);
  beat(25 * 60); // what 25 minutes without the dead writer looks like
  const after = verdict();
  row("process-dead", "kill -9 the beat writer; beat ages 25min", "alive+stale handoff ⇒ on; after death ⇒ unknown here (death paths alert; not a recovery)", `${before} → ${after}`, before === "on" && after === "unknown");
}
// 2. alive but not advancing (kill -STOP): beat keeps coming from elsewhere, handoff frozen 3h ⇒ on, exactly once per 30min
{
  const c = spawn("sh", ["-c", `while :; do date +%s > ${path.join(sw, "coordinator.beat")}; sleep 1; done`], { stdio: "ignore" });
  spawnSync("sleep", ["1.2"]); handoff(3 * 3600);
  const st = initialWatchState(); let fires = 0; const t0 = now();
  for (let i = 0; i < 6; i++) { const r = planEmits(st, judgeProgress(readProgressFacts(home, BOX, t0 + i * 5)), t0 + i * 5); for (const a of r.attempt) { fires++; commitDelivery(st, a.key, true, t0 + i * 5); } }
  c.kill("SIGSTOP"); const stopped = verdict(); c.kill("SIGKILL");
  row("alive-not-advancing", "beat writer running, handoff mtime 3h old, 6 ticks; then kill -STOP", "on, delivered once in 6 ticks", `fires=${fires} verdict-while-stopped=${stopped}`, fires === 1 && stopped === "on");
}
beat(30); handoff(3 * 3600);
// 3. read error — EIO-like (EACCES on the handoff's dir): unknown, never "recovered"
{
  const st = initialWatchState(); const t0 = now();
  let r = planEmits(st, judgeProgress(readProgressFacts(home, BOX, t0)), t0); r.attempt.forEach((a) => commitDelivery(st, a.key, true, t0));
  chmodSync(sw, 0o000); const facts = readProgressFacts(home, BOX, t0 + 5); chmodSync(sw, 0o700);
  r = planEmits(st, judgeProgress(facts), t0 + 5);
  row("read-error EACCES", "chmod 000 ~/.agenthop/swarm for one tick", "beat+handoff unknown ⇒ no resolved, no new alert", `beat=${facts.beatSec} handoff=${facts.handoffMtimeSec} resolved=${r.resolved.length} attempt=${r.attempt.length}`,
    facts.beatSec === "unknown" && r.resolved.length === 0 && r.attempt.length === 0);
}
// 4. missing file: handoff deleted (ENOENT) is a known absence, not a stall
{
  rmSync(path.join(sw, "coordinator-handoff.md"));
  const v = verdict(); handoff(3 * 3600);
  row("missing-file", "rm coordinator-handoff.md", "absent ⇒ off (no alert from a missing handoff)", v, v === "off");
}
// 5. permission on the role box: box unreadable ⇒ unknown (cannot prove a stall from unreadable mail)
{
  handoff(600); for (let i = 0; i < 5; i++) { const f = path.join(bdir, `m${i}.json`); writeFileSync(f, JSON.stringify({ fromLabel: "claude:x" })); utimesSync(f, now() - 7200, now() - 7200); }
  const v1 = verdict(); chmodSync(bdir, 0o000); const v2 = verdict(); chmodSync(bdir, 0o700);
  for (let i = 0; i < 5; i++) chmodSync(path.join(bdir, `m${i}.json`), 0o000);
  const v3 = verdict(); for (let i = 0; i < 5; i++) chmodSync(path.join(bdir, `m${i}.json`), 0o600);
  row("read-error box", "5 real 2h-old mails; then chmod 000 the box dir; then chmod 000 each mail body", "on ; unknown ; unknown (unreadable senders never count as real)", `${v1} ; ${v2} ; ${v3}`, v1 === "on" && v2 === "unknown" && v3 === "unknown");
  for (let i = 0; i < 5; i++) rmSync(path.join(bdir, `m${i}.json`));
}
// 6. peer does not answer: tern hangs ⇒ the block lookup stops at its 3s round budget, no typing
{
  const fake = path.join(home, "tern-hang"); writeFileSync(fake, "#!/bin/sh\nsleep 30\n"); chmodSync(fake, 0o755);
  const b: Budget = { leftMs: BLOCK_BUDGET_MS, calls: 0 }; const t0 = Date.now();
  const run = (args: string[], timeoutMs: number) => { const r = spawnSync(fake, args, { timeout: timeoutMs }); return { ok: r.status === 0, stdout: String(r.stdout ?? ""), timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" }; };
  const r = findCoordinatorBlock("fa801a23-df75-4c57-bc05-7d89900a924c", budgeted(run, b), () => ({ kind: "none" }));
  const ms = Date.now() - t0;
  row("peer-no-answer", "fake tern that sleeps 30s", "the first call is cut at the 3s budget; none; ≤ 3.5s", `${"none" in r ? r.none : "block!"} in ${ms}ms`, "none" in r && ms <= 3500);
}
// 7. all delivery surfaces fail, then come back: owed, retried after RETRY_SEC, delivered once
{
  handoff(3 * 3600); const st = initialWatchState(); const t0 = now(); const log: string[] = [];
  for (let i = 0; i <= 20; i++) { const t = t0 + i * 5; const { attempt } = planEmits(st, judgeProgress(readProgressFacts(home, BOX, t)), t);
    for (const a of attempt) { const okNow = i > 0; commitDelivery(st, a.key, okNow, t); log.push(`${i}:${okNow ? "delivered" : "failed"}`); } }
  row("delivery-all-fail", "S19 + L0 + block all fail on the first attempt, back 5s later", "failed@0 then delivered within RETRY_SEC, once", log.join(","), log.length === 2 && log[0] === "0:failed" && /delivered/.test(log[1]!) && Number(log[1]!.split(":")[0]) * 5 <= RETRY_SEC);
}
// 8. double start: the second dispatcher is refused by the real single-flight lock (acquireSingleFlight), in two real processes
{
  const lock = path.join(home, "dispatcher.lock");
  const holder = `import { acquireSingleFlight } from ${JSON.stringify(path.resolve(path.dirname(new URL(import.meta.url).pathname), "single-flight.ts"))};
import { writeFileSync } from "node:fs";
const rel = acquireSingleFlight(${JSON.stringify(lock)}); const out = rel ? "acquired" : "refused"; console.log(out);
if (process.argv[3]) writeFileSync(process.argv[3], out); if (rel) setTimeout(() => { rel(); }, Number(process.argv[2] ?? 0));`;
  const f = path.join(home, "holder.mts"); writeFileSync(f, holder);
  const tsx = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..", "node_modules", ".bin", "tsx");
  const mark = path.join(home, "a.out");
  const first = spawn(tsx, [f, "6000", mark], { stdio: "ignore" });
  let firstOut = ""; for (let i = 0; i < 100 && !firstOut; i++) { spawnSync("sleep", ["0.1"]); try { firstOut = readFileSync(mark, "utf8"); } catch { /* not yet */ } }
  const second = spawnSync(tsx, [f, "0"], { encoding: "utf8", timeout: 15000 }).stdout.trim();
  first.kill("SIGTERM");
  row("double-start", "dispatcher A takes dispatcher.lock (real acquireSingleFlight, held 4s); dispatcher B starts meanwhile", "A acquired, B refused", `A=${firstOut.trim()} B=${second}`, firstOut.includes("acquired") && second === "refused");
}
// 9. mtime never changes: handoff frozen while BOTH heartbeats stay fresh ⇒ coordinator-stalled at 0 / 30 / 60 min, never resolved;
//    counted per alert key (carly-stale must stay at 0 — her beat is fresh)
{
  const st = initialWatchState(); const t0 = now(); const fires: Record<string, number[]> = {}; let res = 0;
  handoff(3 * 3600); const hm = now() - 3 * 3600;
  for (let i = 0; i <= 3700 / 5; i++) {
    const t = t0 + i * 5;
    const facts = { ...readProgressFacts(home, BOX, t), beatSec: t - 30, carlyBeatSec: t - 30, handoffMtimeSec: hm }; // beats advance with simulated time
    const r = planEmits(st, judgeProgress(facts), t);
    r.attempt.forEach((x) => { (fires[x.key] ??= []).push(t - t0); commitDelivery(st, x.key, true, t); }); res += r.resolved.length;
  }
  const cs = fires["coordinator-stalled"] ?? [];
  row("mtime-unchanged", "handoff mtime frozen, both beats fresh, 3700s of 5s ticks", "coordinator-stalled at 0s, 1800s, 3600s; carly-stale 0; zero resolved",
    `coordinator-stalled=${JSON.stringify(cs)} carly-stale=${(fires["carly-stale"] ?? []).length} resolved=${res}`,
    JSON.stringify(cs) === JSON.stringify([0, 1800, 3600]) && !(fires["carly-stale"]?.length) && res === 0);
}
// 10. clock goes back: a later round with an EARLIER clock must not re-fire or resolve
{
  const st = initialWatchState(); const t0 = now();
  let r = planEmits(st, judgeProgress(readProgressFacts(home, BOX, t0)), t0); r.attempt.forEach((x) => commitDelivery(st, x.key, true, t0));
  r = planEmits(st, judgeProgress(readProgressFacts(home, BOX, t0 - 3600)), t0 - 3600);
  row("clock-back", "next round's clock is 1h earlier", "no re-fire, no resolved", `attempt=${r.attempt.length} resolved=${r.resolved.length}`, r.attempt.length === 0 && r.resolved.length === 0);
}
rmSync(home, { recursive: true, force: true });
if (bad) { console.log(`FAIL ${bad} fault case(s)`); process.exit(1); }
console.log("PASS progress-watch faults");
