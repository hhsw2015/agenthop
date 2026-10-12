// Selftest for the selftest RUNNER itself (zero-bug project #0 — the gate must defend itself). Runs the real runner as a
// subprocess against throwaway fixture roots (SELFTEST_ROOT) and asserts its exit code + output for the two review gaps:
//   STCI-P2-1: a discovery (stat/readdir) fault must FAIL LOUD (exit 1, named) — never a silent smaller green set.
//   STCI-P2-2: a child that ignores SIGTERM must still be force-killed (SIGKILL after grace) so the run never hangs.
// Each fixture root holds plain *.selftest.mts scripts (no repo imports); the runner resolves tsx from the real repo.
//   npx tsx scripts/run-selftests.selftest.mts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "run-selftests.mjs");
let pass = 0;
const ok = (c: boolean, m: string): void => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } pass++; console.log(`ok  ${m}`); };

/** Run the runner against a fixture root; returns { code, out }. */
function runRunner(root: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("node", [RUNNER], { encoding: "utf8", env: { ...process.env, SELFTEST_ROOT: root, ...env }, timeout: 30000 });
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
  const root = mkRoot(); goodSelftest(root, "good.selftest.mts");
  symlinkSync(path.join(root, "does-not-exist-target"), path.join(root, "broken.selftest.mts")); // statSync follows ⇒ ENOENT
  const r = runRunner(root);
  ok(r.code === 1, "STCI-P2-1: a stat-fault entry ⇒ exit 1 (not a silent 1/1 green)");
  ok(/DISCOVERY-FAIL/.test(r.out) && /broken\.selftest\.mts/.test(r.out), "STCI-P2-1: the failing path is NAMED");
  rmSync(root, { recursive: true, force: true });
}

// ── STCI-P2-1b: an unreadable subdirectory (readdir fault) must FAIL LOUD (can't prove no selftests hide under it) ──
{
  const root = mkRoot(); goodSelftest(root, "good.selftest.mts");
  const locked = path.join(root, "locked"); mkdirSync(locked); goodSelftest(locked, "hidden.selftest.mts");
  // chmod 000 so readdir(locked) faults. (Skipped as root, where mode is ignored — then this assertion is vacuously true.)
  const { chmodSync } = await import("node:fs");
  chmodSync(locked, 0o000);
  const r = runRunner(root);
  try {
    if (process.getuid && process.getuid() === 0) { ok(true, "STCI-P2-1b: (running as root — mode ignored — skipped)"); }
    else ok(r.code === 1 && /DISCOVERY-FAIL/.test(r.out) && /locked/.test(r.out), "STCI-P2-1b: an unreadable subdir ⇒ exit 1, named (never fold to empty)");
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

console.log(`\nall run-selftests runner selftests passed (${pass})`);
