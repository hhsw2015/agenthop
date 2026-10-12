#!/usr/bin/env node
// run-selftests — run every *.selftest.mts under the repo through tsx and gate on them (zero-bug project #0).
//
// The repo has dozens of `*.selftest.mts` standalone assertion scripts (pure cores: they `console.log` oks and
// `process.exit(1)` on the first failure). vitest's default glob only matches `*.{test,spec}.*`, so NONE of them ran in CI
// — the crash/symlink/tri-state/CAS safety fixtures for the most critical primitives did not gate merges (infra audit §0).
// This runner closes that: it discovers them all, runs each with tsx from the repo root, and exits non-zero if any fails.
//
//   node scripts/run-selftests.mjs                 # run all, sorted deterministically
//   SELFTEST_SHARD=1/3 node scripts/run-selftests.mjs   # run shard 1 of 3 (round-robin over the sorted list)
//   SELFTEST_TIMEOUT=180000 node scripts/run-selftests.mjs   # per-file timeout ms (default 120000)
//
// Exit 0 iff every selected selftest exits 0. No cherry-picking: the only selection is sharding (coordinator ruling c).
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-plugin", "dist-swarm", "dist-presence", ".claude"]);

/** Recursively collect every `*.selftest.mts` path (repo-relative, POSIX), skipping build/vendor dirs. */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) out.push(...collect(abs));
    else if (name.endsWith(".selftest.mts")) out.push(path.relative(repoRoot, abs).split(path.sep).join("/"));
  }
  return out;
}

/** Resolve the tsx bin (root first, then the bus package — a pnpm workspace keeps it there). */
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

const all = collect(repoRoot).sort();
// Defend the gate itself: discovering ZERO selftests means the glob/layout broke — fail LOUD, never a silent false-green.
if (all.length === 0) { console.error(`run-selftests: found NO *.selftest.mts under ${repoRoot} — discovery is broken (not a pass)`); process.exit(2); }
const shard = parseShard(process.env.SELFTEST_SHARD);
// round-robin assignment over the SORTED list → each shard gets an even, deterministic slice regardless of per-file cost order.
const files = shard ? all.filter((_, idx) => idx % shard.n === shard.i - 1) : all;
const timeoutMs = Number(process.env.SELFTEST_TIMEOUT) || 120000;
const bin = tsxBin();

console.log(`run-selftests: ${files.length}${shard ? ` (shard ${shard.i}/${shard.n} of ${all.length})` : ""} file(s), timeout ${timeoutMs}ms, tsx=${path.relative(repoRoot, bin) || bin}\n`);

const failures = [];
let passed = 0;
for (const rel of files) {
  const t0 = Date.now();
  const r = spawnSync(bin, [path.join(repoRoot, rel)], { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  const ok = !timedOut && r.status === 0;
  if (ok) { passed++; console.log(`  ok   ${rel}  (${ms}ms)`); continue; }
  const why = timedOut ? `TIMEOUT >${timeoutMs}ms` : r.error ? `spawn error: ${r.error.message}` : `exit ${r.status}`;
  const tail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-12).join("\n");
  failures.push({ rel, why, tail });
  console.log(`  FAIL ${rel}  (${ms}ms) — ${why}`);
}

console.log(`\nrun-selftests: ${passed}/${files.length} passed${failures.length ? `, ${failures.length} FAILED` : ""}.`);
if (failures.length) {
  console.log("\n=== failures (last lines each) ===");
  for (const f of failures) console.log(`\n--- ${f.rel} (${f.why}) ---\n${f.tail}`);
  process.exit(1);
}
