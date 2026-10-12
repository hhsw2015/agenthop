#!/usr/bin/env node
// run-selftests — run every *.selftest.mts under the repo through tsx and gate on them (zero-bug project #0).
//
// The repo has dozens of `*.selftest.mts` standalone assertion scripts (pure cores: they `console.log` oks and
// `process.exit(1)` on the first failure). vitest's default glob only matches `*.{test,spec}.*`, so NONE of them ran in CI
// — the crash/symlink/tri-state/CAS safety fixtures for the most critical primitives did not gate merges (infra audit §0).
// This runner closes that: it discovers them all, runs each with tsx, and exits non-zero if any fails OR if discovery itself
// could not be completed (STCI-P2-1: a stat/readdir fault is NEVER swallowed — an unreadable subtree might HIDE selftests, so
// an incomplete discovery is a failure, not a smaller green set). A per-file timeout force-terminates a stuck child
// (STCI-P2-2: SIGTERM grace then SIGKILL, on an async/interruptible wait — a child that ignores SIGTERM cannot hang the run).
//
//   node scripts/run-selftests.mjs                 # run all, sorted deterministically
//   SELFTEST_SHARD=1/3 node scripts/run-selftests.mjs   # run shard 1 of 3 (round-robin over the sorted list)
//   SELFTEST_TIMEOUT=180000 node scripts/run-selftests.mjs   # per-file timeout ms (default 120000)
//   SELFTEST_KILL_GRACE=3000 node scripts/run-selftests.mjs  # ms between SIGTERM and the SIGKILL fallback (default 2000)
//   SELFTEST_ROOT=<dir>      node scripts/run-selftests.mjs  # discovery root (default: the repo); used by the runner's own test
//
// Exit 0 iff discovery completed AND every selected selftest exited 0. No cherry-picking: the only selection is sharding (ruling c).
import { readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.SELFTEST_ROOT ? path.resolve(process.env.SELFTEST_ROOT) : repoRoot;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-plugin", "dist-swarm", "dist-presence", ".claude"]);
const MAX_OUT = 16 * 1024 * 1024;

/**
 * Recursively collect every `*.selftest.mts` path (root-relative, POSIX), skipping build/vendor dirs. STCI-P2-1: a readdir or
 * stat FAULT is recorded as a discovery ERROR (named), NOT silently skipped — an unreadable dir/entry might hide selftests, so
 * a readable subset is not proof of completeness. Returns both the files and the discovery errors; the caller fails loud on any error.
 */
function collect(dir, files, errors) {
  let names;
  try { names = readdirSync(dir); }
  catch (e) { errors.push({ path: path.relative(root, dir).split(path.sep).join("/") || ".", why: `readdir: ${e instanceof Error ? e.message : e}` }); return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    let st;
    try { st = statSync(abs); } // follows symlinks: a broken-link *.selftest.mts throws here and is recorded, not skipped
    catch (e) { errors.push({ path: rel, why: `stat: ${e instanceof Error ? e.message : e}` }); continue; }
    if (st.isDirectory()) collect(abs, files, errors);
    else if (name.endsWith(".selftest.mts")) files.push(rel);
  }
}

/** Resolve the tsx bin (repo root first, then the bus package — a pnpm workspace keeps it there). */
function tsxBin() {
  for (const p of [path.join(repoRoot, "node_modules/.bin/tsx"), path.join(repoRoot, "packages/bus/node_modules/.bin/tsx")]) {
    try { statSync(p); return p; } catch { /* try next */ }
  }
  return "tsx"; // last resort: PATH
}

function parseShard(raw) {
  if (!raw) return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!m) { console.error(`run-selftests: bad SELFTEST_SHARD ${JSON.stringify(raw)} (want "i/n", 1-based)`); process.exit(2); }
  const i = Number(m[1]), n = Number(m[2]);
  if (i < 1 || i > n || n < 1) { console.error(`run-selftests: SELFTEST_SHARD ${raw} out of range`); process.exit(2); }
  return { i, n };
}

/**
 * Run one selftest to completion, async + interruptible (STCI-P2-2). The child is spawned `detached` so it leads its OWN process
 * group; on timeout we signal the WHOLE GROUP (`process.kill(-pid, …)`) — SIGTERM, then SIGKILL after SELFTEST_KILL_GRACE. This is
 * essential because `tsx` spawns a node GRANDCHILD that inherits the stdout/stderr pipes: killing only the tsx parent leaves the
 * grandchild alive holding the pipes open, so 'close' never fires and the run hangs. Group-killing reaps the whole tree; SIGKILL
 * cannot be ignored. A final HARD backstop force-resolves even if 'close' is somehow still withheld, so the runner can NEVER hang.
 */
function runOne(bin, absPath, cwd, timeoutMs, graceMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, [absPath], { cwd, detached: true }); // own process group ⇒ we can kill the whole tree (tsx + its node grandchild)
    let out = "", err = "", timedOut = false, settled = false;
    const cap = (buf, s) => (s.length + buf.length <= MAX_OUT ? s + buf : s); // bounded capture (replaces spawnSync maxBuffer)
    child.stdout.on("data", (d) => { out = cap(d.toString(), out); });
    child.stderr.on("data", (d) => { err = cap(d.toString(), err); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } };
    let killTimer, hardTimer;
    const termTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        hardTimer = setTimeout(() => finish({ code: null, signal: "SIGKILL" }), 3000); // never hang even if 'close' is withheld
      }, Math.max(0, graceMs));
    }, timeoutMs);
    const finish = (res) => { if (settled) return; settled = true; clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(hardTimer); resolve({ ...res, out, err, ms: Date.now() - t0, timedOut }); };
    child.on("error", (e) => finish({ spawnError: e }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

async function main() {
  const files = [], discoveryErrors = [];
  collect(root, files, discoveryErrors);
  files.sort();
  // Defend the gate: discovering ZERO selftests (and no error explaining why) means the layout/glob broke — fail LOUD.
  if (files.length === 0 && discoveryErrors.length === 0) { console.error(`run-selftests: found NO *.selftest.mts under ${root} — discovery is broken (not a pass)`); process.exit(2); }
  const shard = parseShard(process.env.SELFTEST_SHARD);
  const selected = shard ? files.filter((_, idx) => idx % shard.n === shard.i - 1) : files;
  const timeoutMs = Number(process.env.SELFTEST_TIMEOUT) || 120000;
  const graceMs = Number(process.env.SELFTEST_KILL_GRACE) || 2000;
  const bin = tsxBin();

  console.log(`run-selftests: ${selected.length}${shard ? ` (shard ${shard.i}/${shard.n} of ${files.length})` : ""} file(s), timeout ${timeoutMs}ms (+${graceMs}ms SIGKILL grace), tsx=${path.relative(repoRoot, bin) || bin}\n`);

  const failures = [];
  let passed = 0;
  for (const rel of selected) {
    const r = await runOne(bin, path.join(root, rel), root, timeoutMs, graceMs);
    const ok = !r.timedOut && !r.spawnError && r.code === 0;
    if (ok) { passed++; console.log(`  ok   ${rel}  (${r.ms}ms)`); continue; }
    const why = r.timedOut ? `TIMEOUT >${timeoutMs}ms (SIGKILL after ${graceMs}ms grace)` : r.spawnError ? `spawn error: ${r.spawnError.message}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`;
    const tail = `${r.out}${r.err}`.trim().split("\n").slice(-12).join("\n");
    failures.push({ rel, why, tail });
    console.log(`  FAIL ${rel}  (${r.ms}ms) — ${why}`);
  }

  // STCI-P2-1: discovery errors are failures — a readable subset passing is NOT a completed run.
  if (discoveryErrors.length) {
    console.log(`\n=== discovery errors (${discoveryErrors.length}) — an incomplete discovery is a FAILURE, not a smaller green set ===`);
    for (const d of discoveryErrors) console.log(`  DISCOVERY-FAIL ${d.path} — ${d.why}`);
  }
  console.log(`\nrun-selftests: ${passed}/${selected.length} passed${failures.length ? `, ${failures.length} FAILED` : ""}${discoveryErrors.length ? `, ${discoveryErrors.length} DISCOVERY ERROR(S)` : ""}.`);
  if (failures.length) {
    console.log("\n=== failures (last lines each) ===");
    for (const f of failures) console.log(`\n--- ${f.rel} (${f.why}) ---\n${f.tail}`);
  }
  if (failures.length || discoveryErrors.length) process.exit(1);
}

main().catch((e) => { console.error(`run-selftests: unexpected: ${e instanceof Error ? e.stack : e}`); process.exit(1); });
