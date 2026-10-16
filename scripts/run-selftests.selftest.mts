// Selftest for the selftest RUNNER itself (zero-bug project #0 — the gate must defend itself). Runs the real runner as a
// subprocess against throwaway fixture roots (SELFTEST_ROOT) and asserts its exit code + output for the two review gaps:
//   STCI-P2-1: a discovery (stat/readdir) fault must FAIL LOUD (exit 1, named) — never a silent smaller green set.
//   STCI-P2-2: a child that ignores SIGTERM must still be force-killed (SIGKILL after grace) so the run never hangs.
// Each fixture root holds plain *.selftest.mts scripts (no repo imports); the runner resolves tsx from the real repo.
//   npx tsx scripts/run-selftests.selftest.mts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "run-selftests.mjs");
let pass = 0;
const ok = (c: boolean, m: string): void => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } pass++; console.log(`ok  ${m}`); };

/** Run the runner against a fixture root; returns { code, out }. STCI-R2-P2-1: this meta-test is ITSELF a *.selftest.mts, so
 *  when the whole suite runs sharded it inherits SELFTEST_SHARD (and may inherit SELFTEST_TIMEOUT/KILL_GRACE/MAXCAP). Those knobs
 *  would then leak into the INNER fixture runs and make e.g. "2/2 passed" shrink to "1/2" on shard 2/3 — a spurious meta failure.
 *  Scrub every SELFTEST_* control from the inherited env; each test re-supplies exactly the knobs it wants via `env`. */
function runRunner(root: string, env: Record<string, string> = {}): { code: number; out: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["SELFTEST_SHARD", "SELFTEST_TIMEOUT", "SELFTEST_KILL_GRACE", "SELFTEST_MAXCAP", "SELFTEST_ROOT", "SELFTEST_HOME"]) delete base[k];
  const r = spawnSync("node", [RUNNER], { encoding: "utf8", env: { ...base, SELFTEST_ROOT: root, ...env }, timeout: 30000 });
  return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const mkRoot = (): string => mkdtempSync(path.join(tmpdir(), "stci-"));
const goodSelftest = (dir: string, name: string): void => writeFileSync(path.join(dir, name), `console.log("ok ${name}");\n`);

// ── happy: all discoverable + passing ⇒ exit 0 ──
{
  const root = mkRoot(); goodSelftest(root, "a.selftest.mts"); mkdirSync(path.join(root, "sub")); goodSelftest(path.join(root, "sub"), "b.selftest.mts");
  const r = runRunner(root);
  ok(r.code === 0 && /2\/2 passed/.test(r.out), "happy: two passing selftests ⇒ exit 0, 2/2");
  rmSync(root, { recursive: true, force: true });
}

// ── STCI-P2-1: a broken-symlink *.selftest.mts (stat fault) must FAIL LOUD, not shrink to the readable subset ──
{
  const root = mkRoot(); const mark = path.join(root, "ran.marker");
  writeFileSync(path.join(root, "good.selftest.mts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, "x");\n`);
  symlinkSync(path.join(root, "does-not-exist-target"), path.join(root, "broken.selftest.mts")); // statSync follows ⇒ ENOENT
  const r = runRunner(root);
  ok(r.code === 1, "STCI-P2-1: a stat-fault entry ⇒ exit 1 (not a silent 1/1 green)");
  ok(/DISCOVERY-FAIL/.test(r.out) && /broken\.selftest\.mts/.test(r.out), "STCI-P2-1: the failing path is NAMED");
  ok(!existsSync(mark), "STCI-P2-1 (r6): the READABLE test beside a stat fault never ran (fail-closed before the first test)");
  rmSync(root, { recursive: true, force: true });
}

// ── STCI-P2-1b: an unreadable subdirectory (readdir fault) must FAIL LOUD (can't prove no selftests hide under it) ──
{
  const root = mkRoot(); const mark = path.join(root, "ran.marker");
  writeFileSync(path.join(root, "good.selftest.mts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, "x");\n`);
  const locked = path.join(root, "locked"); mkdirSync(locked); goodSelftest(locked, "hidden.selftest.mts");
  // chmod 000 so readdir(locked) faults. (Skipped as root, where mode is ignored — then this assertion is vacuously true.)
  const { chmodSync } = await import("node:fs");
  chmodSync(locked, 0o000);
  const r = runRunner(root);
  try {
    if (process.getuid && process.getuid() === 0) { ok(true, "STCI-P2-1b: (running as root — mode ignored — skipped)"); }
    else {
      ok(r.code === 1 && /DISCOVERY-FAIL/.test(r.out) && /locked/.test(r.out), "STCI-P2-1b: an unreadable subdir ⇒ exit 1, named (never fold to empty)");
      ok(!existsSync(mark), "STCI-P2-1b (r6): the READABLE test beside an EACCES dir never ran");
    }
  } finally { chmodSync(locked, 0o700); rmSync(root, { recursive: true, force: true }); }
}

// ── STCI-P2-2: a child that IGNORES SIGTERM must still be force-killed (SIGKILL after grace) ⇒ exit 1, bounded time ──
{
  const root = mkRoot();
  writeFileSync(path.join(root, "hang.selftest.mts"), `process.on("SIGTERM", () => {}); setInterval(() => {}, 1e9); console.log("hanging, ignoring SIGTERM");\n`);
  const t0 = Date.now();
  const r = runRunner(root, { SELFTEST_TIMEOUT: "400", SELFTEST_KILL_GRACE: "300" });
  const elapsed = Date.now() - t0;
  ok(r.code === 1 && /TIMEOUT/.test(r.out), "STCI-P2-2: a SIGTERM-ignoring child ⇒ TIMEOUT + exit 1 (SIGKILL fallback)");
  ok(elapsed < 10000, `STCI-P2-2: the run does NOT hang on it (finished in ${elapsed}ms)`);
  rmSync(root, { recursive: true, force: true });
}

// ── zero discovery (no error) ⇒ exit 2 (the layout broke) ──
{
  const root = mkRoot();
  const r = runRunner(root);
  ok(r.code === 2 && /found NO \*\.selftest\.mts/.test(r.out), "zero-discovery (empty root) ⇒ exit 2");
  rmSync(root, { recursive: true, force: true });
}

// ── a failing selftest ⇒ exit 1 and later files still run ──
{
  const root = mkRoot();
  writeFileSync(path.join(root, "a-fail.selftest.mts"), `console.error("boom"); process.exit(1);\n`);
  goodSelftest(root, "z-after.selftest.mts");
  const r = runRunner(root);
  ok(r.code === 1 && /a-fail\.selftest\.mts/.test(r.out) && /ok {3}z-after\.selftest\.mts/.test(r.out), "a failing selftest ⇒ exit 1, later files STILL run");
  rmSync(root, { recursive: true, force: true });
}

// ── STCI-R2-P2-1: an OUTER SELFTEST_SHARD must NOT leak into the inner fixture run (meta env scrubs it) ⇒ still 2/2 ──
{
  const root = mkRoot(); goodSelftest(root, "a.selftest.mts"); goodSelftest(root, "b.selftest.mts");
  const prev = process.env.SELFTEST_SHARD;
  process.env.SELFTEST_SHARD = "2/3"; // simulate the suite being run sharded while THIS meta-test executes
  try {
    const r = runRunner(root); // runRunner must scrub the inherited SHARD
    ok(r.code === 0 && /2\/2 passed/.test(r.out) && !/shard/.test(r.out), "STCI-R2-P2-1: outer SELFTEST_SHARD does NOT shrink the inner run (2/2, no shard)");
  } finally { if (prev === undefined) delete process.env.SELFTEST_SHARD; else process.env.SELFTEST_SHARD = prev; rmSync(root, { recursive: true, force: true }); }
}

// ── STCI-R2-P3-1: when capture is capped, the failure report keeps the REAL tail (last line = the marker), not the prefix ──
{
  const root = mkRoot();
  // Emit > MAXCAP bytes of filler, THEN the real failure marker on the LAST line, then exit 1. A prefix-cap would drop the marker.
  // exitCode (not exit) so the LAST console.log drains to the pipe before the child exits — otherwise the marker races and is lost.
  writeFileSync(path.join(root, "noisy-fail.selftest.mts"),
    `for (let i = 0; i < 5000; i++) console.log("filler line " + i);\nconsole.log("REAL_FAILURE_MARKER_AT_TAIL");\nprocess.exitCode = 1;\n`);
  const r = runRunner(root, { SELFTEST_MAXCAP: "2048" }); // tiny cap ⇒ capture must truncate
  ok(r.code === 1 && /REAL_FAILURE_MARKER_AT_TAIL/.test(r.out), "STCI-R2-P3-1: the real failure tail survives a capped capture");
  ok(/output truncated/.test(r.out), "STCI-R2-P3-1: the report says the output was truncated");
  rmSync(root, { recursive: true, force: true });
}

// ── STCI-R2-P3-1 (r4): a LATE stdout marker after a burst of EARLY stderr must survive — the tail is ARRIVAL-ordered, not a
// fixed stdout+stderr concat that would bury the marker under the earlier stderr. (Reverse direction too, as a non-regression.) ──
{
  const root = mkRoot();
  // 20 stderr lines first, THEN (100ms later) the real stdout failure marker. A fixed out+err concat drops the marker from the
  // last-12-lines tail; arrival order keeps it. exitCode (not exit) so the late line drains before the child exits.
  writeFileSync(path.join(root, "late-stdout.selftest.mts"),
    `for (let i = 0; i < 20; i++) console.error("early stderr warning " + i);\nsetTimeout(() => { console.log("LATE_STDOUT_MARKER"); process.exitCode = 1; }, 100);\n`);
  const r = runRunner(root);
  ok(r.code === 1 && /LATE_STDOUT_MARKER/.test(r.out), "STCI-R2-P3-1: a LATE stdout marker survives a burst of EARLY stderr (arrival-order tail)");
  rmSync(root, { recursive: true, force: true });
}
{
  const root = mkRoot();
  writeFileSync(path.join(root, "late-stderr.selftest.mts"),
    `for (let i = 0; i < 20; i++) console.log("early stdout line " + i);\nsetTimeout(() => { console.error("LATE_STDERR_MARKER"); process.exitCode = 1; }, 100);\n`);
  const r = runRunner(root);
  ok(r.code === 1 && /LATE_STDERR_MARKER/.test(r.out), "STCI-R2-P3-1: a LATE stderr marker survives early stdout (arrival-order tail, reverse)");
  rmSync(root, { recursive: true, force: true });
}

// ── fixture-safety lint (incident 2026-10-16): a selftest that kills by pattern or names a live sid is refused, nothing runs ──
{
  const fakeHome = mkRoot(); mkdirSync(path.join(fakeHome, ".agenthop", "presence"), { recursive: true }); mkdirSync(path.join(fakeHome, ".agenthop", "swarm", "roles"), { recursive: true });
  const PK = "p" + "kill"; // never a literal in this file
  const LIVE = "cccccccc-1111-4222-8333-444444444444", COORD = "dddddddd-1111-4222-8333-444444444444"; // made-up "live" sids in a fake home
  writeFileSync(path.join(fakeHome, ".agenthop", "presence", `${LIVE}.pid`), "1");
  writeFileSync(path.join(fakeHome, ".agenthop", "swarm", "roles", "coordinator.sid"), `${COORD}\n`);
  const ran = (root: string) => path.join(root, "ran.marker");
  const marker = (root: string, name: string, body: string) => writeFileSync(path.join(root, name), `import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nwriteFileSync(${JSON.stringify(ran(root))}, "x");\n${body}\n`);
  // FXL-PATTERN-COVERAGE: the pure matcher on every layout (command word built at run time so this file stays clean)
  const { killsByPattern } = await import("./run-selftests.mjs");
  const KA = "kill" + "all";
  const flagged = [`${PK} -f foo`, `sh -c "${PK} -9 -f foo"`, `${PK} -9f foo`, `${PK} -fx foo`, `${PK} --full foo`, `spawnSync("${PK}", ["-f", "x"])`,
    `spawnSync("${PK}", ["-9", "-f", "x"])`, `spawnSync(\n  "${PK}",\n  [\n    "-9",\n    "-f",\n    "x",\n  ],\n)`, `${KA} node`, `${PK} "-f" "text-only"`, `${PK} '--full' 'text-only'`, `${PK} -9 \\-f x`];
  const { jsStringLiterals } = await import("./run-selftests.mjs");
  ok(JSON.stringify(jsStringLiterals('a("x\\"y", \'q\\\'r\', `t${n}u`)')) === JSON.stringify(['x"y', "q'r", "t u"]), "js literals: \\\" / \\' decoded, ${} is a word gap");
  // FXL r9: the kill command without -f selects by NAME ("12345" is a name pattern), so it is flagged too; killing a pid you own is not
  const flagged9 = [`${PK} -9 12345`, `spawnSync("${PK}", ["-9", "claude"])`, `spawnSync("\\x70kill", ["-f", "x"])`, `spawnSync("${PK}", ["\\u002df", "x"])`,
    `spawnSync("pk\\x69ll", ["x"])`, `spawnSync("${PK.slice(0, 2)}\\u{69}ll", ["x"])`, `spawnSync("${KA.slice(0, 4)}\\u0061ll", ["x"])`];
  ok(flagged9.every((x) => killsByPattern(x)), "lint matcher r9: kill-by-name without -f, and escaped command names / flags in an argv array, are flagged");
  const clean = [`process.kill(pid, "SIGKILL")`, `spawnSync("kill", ["-9", String(child.pid)])`, `const skill = 1; ${PK}Count++`, `"un${PK}ed"`];
  ok(clean.every((x) => !killsByPattern(x)), "lint matcher: killing a pid you own (process.kill / kill <pid>) and look-alike words are not flagged");
  // FXL-SV-DECODE-PROGRESS: unfinished / unsupported escapes never move the cursor back; bounded on any input
  const { DECODE_MAX_STEPS_PER_BYTE } = await import("./run-selftests.mjs");
  const sv43 = "const a = /\\u{/; const b = String.raw`\\u{`;";
  let t0 = performance.now(); jsStringLiterals(sv43); let took = performance.now() - t0;
  ok(sv43.length === 43 && took < 50, `decoder: the 43-byte valid JS from Second Voice returns in ${took.toFixed(1)}ms (< 50ms)`);
  for (const cut of ["'\\u{", "'\\u{12", "'\\x", "'\\x4", "'\\u12", "`${", "`${{", "'\\", "\"\\u{110000}\""]) {
    t0 = performance.now(); jsStringLiterals(cut + cut + cut); took = performance.now() - t0;
    ok(took < 50, `decoder: truncated ${JSON.stringify(cut)} ×3 returns (${took.toFixed(1)}ms)`);
  }
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alpha = "\\'\"`${}u x0123456789abcdef\n/*";
  let worst = 0;
  for (let k = 0; k < 1000; k++) {
    let str = ""; const n = Math.floor(rnd() * 200); for (let q = 0; q < n; q++) str += alpha[Math.floor(rnd() * alpha.length)];
    t0 = performance.now(); jsStringLiterals(str); worst = Math.max(worst, performance.now() - t0);
  }
  ok(worst < 50, `decoder: 1000 random strings of escape-heavy text, none hangs (worst ${worst.toFixed(1)}ms)`);
  ok(DECODE_MAX_STEPS_PER_BYTE >= 1, "decoder: a per-byte step budget is declared");
  const cases: Array<[string, string]> = [
    ["kill-by-pattern, multi-line argv with a signal first", 'spawnSync(\n  "' + PK + '",\n  ["-9",\n   "-f", "some-fixture-that-matches-nothing-zz"],\n);'],
    // the banned text is assembled at run time so THIS file stays clean under the same lint
    ["kill-by-pattern in a shell string", 'spawnSync("sh", ["-c", "' + PK + ' -f some-fixture-that-matches-nothing-zz"]);'],
    ["kill-by-pattern as spawn args", 'spawnSync("' + PK + '", ["-f", "some-fixture-that-matches-nothing-zz"]);'],
    // FXL-PATTERN-COVERAGE r7: quoted flags inside a shell string decode to the same argv
    ["kill-by-pattern, double-quoted flag in sh -c", 'spawnSync("sh", ["-c", `' + PK + ' "-f" "text-only"`]);'],
    // FXL r8: the shell quotes are JS-escaped inside a JS double-quoted string (the runner must decode JS first, then shell)
    ["kill-by-pattern, JS-escaped shell quotes", 'spawnSync("sh", ["-c", "' + PK + ' \\"-f\\" \\"text-only\\""]);'],
    ["kill-by-pattern, JS unicode escape for the flag", 'spawnSync("sh", ["-c", "' + PK + ' \\u002df text-only"]);'],
    ["kill-by-pattern, single-quoted long flag", 'spawnSync("sh", ["-c", "' + PK + " '--full' 'text-only'" + '"]);'],
    // FXL r9: escaped command name / escaped flag in a static argv array; the kill command by name (no -f)
    ["kill-by-pattern, escaped command name in argv", 'function never() { spawnSync("\\x70kill", ["-f", "text-only"]); }'],
    ["kill-by-pattern, escaped -f in argv", 'function never() { spawnSync("' + PK + '", ["\\u002df", "text-only"]); }'],
    ["kill-by-name, no -f flag", 'function never() { spawnSync("' + PK + '", ["-9", "text-only"]); }'],
    // the 43-byte valid JS that hung the r8 decoder: the runner must finish its preflight (it has no kill, so it RUNS)
    ["a live presence sid", `const sid = "${LIVE}";`],
    ["the live coordinator sid", `const sid = "${COORD}";`],
  ];
  for (const [label, body] of cases) {
    const root = mkRoot(); goodSelftest(root, "a.selftest.mts"); marker(root, "b.selftest.mts", body);
    const r = runRunner(root, { SELFTEST_HOME: fakeHome });
    ok(r.code === 1 && /fixture-safety lint FAILED — nothing was run/.test(r.out) && /LINT b\.selftest\.mts/.test(r.out), `lint: ${label} ⇒ exit 1, named`);
    ok(!require("node:fs").existsSync(ran(root)), `lint: ${label} ⇒ the file never ran`);
    rmSync(root, { recursive: true, force: true });
  }
  {
    // FXL-SV-DECODE-PROGRESS through the whole runner: the 43-byte valid JS is in a selftest; preflight must finish and schedule it
    const r43 = mkRoot(); marker(r43, "h.selftest.mts", "const a = /\\u{/; const b = String.raw`\\u{`; void a; void b;");
    const t0 = performance.now(); const rr = runRunner(r43, { SELFTEST_HOME: fakeHome }); const took = performance.now() - t0;
    ok(rr.code === 0 && require("node:fs").existsSync(ran(r43)) && took < 20000, `decoder: the 43-byte JS in a selftest ⇒ preflight finishes, the file runs (${Math.round(took)}ms)`);
    rmSync(r43, { recursive: true, force: true });
  }
  const root = mkRoot(); marker(root, "c.selftest.mts", 'const sid = "eeeeeeee-1111-4222-8333-444444444444"; process.kill(process.pid, 0);');
  const r = runRunner(root, { SELFTEST_HOME: fakeHome });
  ok(r.code === 0 && require("node:fs").existsSync(ran(root)), "lint: a made-up sid and kill-by-own-pid pass (positive)");
  rmSync(root, { recursive: true, force: true });
  // fail-closed (r4): an unreadable inventory, or an unreadable selftest source, ⇒ nothing runs at all
  const chmodSync = require("node:fs").chmodSync as (p: string, m: number) => void;
  const noInv = mkRoot(); marker(noInv, "a.selftest.mts", "");
  chmodSync(path.join(fakeHome, ".agenthop", "presence"), 0o000);
  const r1 = runRunner(noInv, { SELFTEST_HOME: fakeHome }); chmodSync(path.join(fakeHome, ".agenthop", "presence"), 0o700);
  ok(r1.code === 1 && /inventory.*cannot be read/.test(r1.out) && !require("node:fs").existsSync(ran(noInv)), "lint: live-sid inventory unreadable ⇒ exit 1, NOTHING ran");
  const noSrc = mkRoot(); marker(noSrc, "a.selftest.mts", ""); writeFileSync(path.join(noSrc, "b.selftest.mts"), "console.log(1)\n"); chmodSync(path.join(noSrc, "b.selftest.mts"), 0o000);
  const r2 = runRunner(noSrc, { SELFTEST_HOME: fakeHome }); chmodSync(path.join(noSrc, "b.selftest.mts"), 0o600);
  ok(r2.code === 1 && /b\.selftest\.mts: source unreadable/.test(r2.out) && !require("node:fs").existsSync(ran(noSrc)), "lint: one selftest source unreadable ⇒ exit 1, NOTHING ran (not even the readable one)");
  // no path is exempt: a selftest at scripts/run-selftests.selftest.mts naming a live sid is refused like any other
  const self = mkRoot(); mkdirSync(path.join(self, "scripts")); marker(self, path.join("scripts", "run-selftests.selftest.mts"), `const s = "${LIVE}";`);
  const r3 = runRunner(self, { SELFTEST_HOME: fakeHome });
  ok(r3.code === 1 && /LINT scripts\/run-selftests\.selftest\.mts/.test(r3.out) && !require("node:fs").existsSync(ran(self)), "lint: no path exemption — the runner's own selftest path is checked too");
  for (const d of [noInv, noSrc, self]) rmSync(d, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(`\nall run-selftests runner selftests passed (${pass})`);
