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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.SELFTEST_ROOT ? path.resolve(process.env.SELFTEST_ROOT) : repoRoot;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-plugin", "dist-swarm", "dist-presence", ".claude"]);
const MAX_OUT = Number(process.env.SELFTEST_MAXCAP) || 16 * 1024 * 1024; // per-file capture cap (overridable for the runner's own tail test)

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
    let combined = "", timedOut = false, settled = false, truncated = false;
    // STCI-R2-P3-1: keep ONE bounded tail in ARRIVAL order — interleave stdout+stderr as they actually arrive, NOT two separate
    // buffers concatenated in a fixed order (out+err), which would let a burst of EARLY stderr bury a LATER stdout failure
    // marker. Sliding TAIL (the LAST MAX_OUT bytes) so the final lines survive a large run; mark truncation so the report says so.
    const cap = (s) => { const n = combined + s; if (n.length <= MAX_OUT) { combined = n; return; } truncated = true; combined = n.slice(n.length - MAX_OUT); };
    child.stdout.on("data", (d) => cap(d.toString()));
    child.stderr.on("data", (d) => cap(d.toString()));
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
    const finish = (res) => {
      if (settled) return; settled = true;
      clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(hardTimer);
      // STCI-P2-2: a 'close' (even the MAIN exiting early on SIGTERM) must NOT release the group-kill obligation — a same-group
      // background member that ignored SIGTERM and held no pipe would otherwise survive. Once we have timed out, sweep the WHOLE
      // group with SIGKILL at finish time (synchronous, idempotent — ESRCH if already reaped), so no group member outlives the run.
      if (timedOut) killGroup("SIGKILL");
      resolve({ ...res, combined, ms: Date.now() - t0, timedOut, truncated });
    };
    child.on("error", (e) => finish({ spawnError: e }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

/** Fixture-safety lint (incident 2026-10-16: a selftest's cleanup `pkill -f <sid>` killed the live coordinator). A selftest may not
 *  kill by pattern, and may not name a session id that is live on this machine (any ~/.agenthop/presence/<sid>.pid, plus
 *  roles/coordinator.sid). Fixtures use made-up sids. FAIL-CLOSED (r4): if the live-sid inventory or any selftest's source cannot be
 *  read, the check is incomplete and NOTHING runs. Every selftest is checked, the runner's own included — negative fixtures build the
 *  banned text at run time (string concatenation) instead of holding it literally. Pure over (text, liveSids). */
/** Does `text` kill processes by pattern? Recognised by command name + argument SET, not by layout (FXL-PATTERN-COVERAGE): any
 *  pkill / pgrep-into-kill / killall invocation — as shell text or as a spawn argv array, on one line or across several — whose
 *  arguments include a full-command-line match flag (-f, or a combined flag like -9f / -fx) or a bare-name match (killall). The
 *  scan looks at each occurrence of the command word and the ~400 characters after it, newlines included. */
/** The words of ONE shell command line, with ordinary quoting decoded: '…' literal, "…" with backslash escapes, a bare backslash
 *  escaping the next character (FXL-PATTERN-COVERAGE r7: `pkill "-f" x` / `pkill '--full' x` must reach the option check as -f /
 *  --full). Stops at an unquoted newline / ; / & / | (end of that command). Not a shell: no expansion, no globbing. Pure. */
export function shellWords(text) {
  const words = []; let cur = null; let i = 0;
  const push = () => { if (cur !== null) { words.push(cur); cur = null; } };
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { const j = text.indexOf("'", i + 1); cur = (cur ?? "") + (j < 0 ? text.slice(i + 1) : text.slice(i + 1, j)); i = j < 0 ? text.length : j + 1; continue; }
    if (c === '"') {
      i++; cur = cur ?? "";
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\" && i + 1 < text.length) { cur += text[i + 1]; i += 2; } else { cur += text[i]; i++; } }
      i++; continue;
    }
    if (c === "\\" && i + 1 < text.length) { cur = (cur ?? "") + text[i + 1]; i += 2; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "`" || c === ")") break;
    if (/\s/.test(c)) { push(); i++; continue; }
    cur = (cur ?? "") + c; i++;
  }
  push();
  return words;
}
/** The static string literals in JS source, decoded the way JS would ('…', "…", and `…` with each ${…} replaced by a space).
 *  FXL r8: a shell line inside a JS string reaches sh only after JS escapes are applied (`"pkill \"-f\" x"` is `pkill "-f" x`). */
export function jsStringLiterals(src) {
  const out = []; let i = 0;
  const esc = (j) => {
    const c = src[j + 1];
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (c === "x") return [String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16) || 0), 4];
    if (c === "u" && src[j + 2] === "{") { const k = src.indexOf("}", j); return [String.fromCodePoint(parseInt(src.slice(j + 3, k), 16) || 0), k - j + 1]; }
    if (c === "u") return [String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16) || 0), 6];
    if (c === "\n") return ["", 2]; // line continuation
    return [simple[c] ?? c ?? "", 2];
  };
  while (i < src.length) {
    const q = src[i];
    if (q === "/" && src[i + 1] === "/") { const k = src.indexOf("\n", i); i = k < 0 ? src.length : k; continue; }
    if (q === "/" && src[i + 1] === "*") { const k = src.indexOf("*/", i + 2); i = k < 0 ? src.length : k + 2; continue; }
    if (q !== "'" && q !== '"' && q !== "`") { i++; continue; }
    let j = i + 1, cur = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\") { const [v, n] = esc(j); cur += v; j += n; continue; }
      if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
        let d = 1, k = j + 2; while (k < src.length && d > 0) { if (src[k] === "{") d++; else if (src[k] === "}") d--; k++; }
        cur += " "; j = k; continue;
      }
      if (q !== "`" && src[j] === "\n") break; // unterminated: not a literal
      cur += src[j]; j++;
    }
    out.push(cur); i = j + 1;
  }
  return out;
}
function killsByPatternRaw(text) {
  const re = /\b(pkill|killall)\b/g; let m;
  while ((m = re.exec(text)) !== null) {
    const tail = text.slice(m.index, m.index + 400);
    if (m[1] === "killall") return true; // matches by name by definition
    // the arguments up to the end of this invocation: a shell line ends at a newline / ; / && ; an argv array ends at "]"
    const arr = /^pkill["']?\s*,\s*\[([^\]]*)\]/.exec(tail);
    const args = arr ? (arr[1].match(/["']([^"']*)["']/g) ?? []).map((x) => x.slice(1, -1)) : shellWords(tail.slice(5));
    if (args.some((a) => /^-[A-Za-z0-9]*f[A-Za-z0-9]*$/.test(a) || a === "--full")) return true;
  }
  return false;
}
/** True if the source kills by pattern, read as the source itself OR as any static string literal in it after JS decoding. */
export function killsByPattern(text) {
  return killsByPatternRaw(text) || jsStringLiterals(text).some((lit) => killsByPatternRaw(lit));
}
export function fixtureLint(text, liveSids) {
  const bad = [];
  if (killsByPattern(text)) bad.push("kills by pattern (pkill -f / killall): match processes by the pid you started instead");
  for (const sid of liveSids) if (sid && text.includes(sid)) bad.push(`names the live session ${sid}: use a made-up sid`);
  return bad;
}
/** Live sids, or null when the inventory cannot be read (ENOENT on the dirs = no live sessions, a real empty answer). */
function liveSessionIds(home) {
  const out = new Set();
  try { for (const n of readdirSync(path.join(home, ".agenthop", "presence"))) { const m = /^(.+)\.pid$/.exec(n); if (m) out.add(m[1]); } }
  catch (e) { if (e && e.code !== "ENOENT") return null; }
  try { const s = readFileSync(path.join(home, ".agenthop", "swarm", "roles", "coordinator.sid"), "utf8").trim(); if (s) out.add(s); }
  catch (e) { if (e && e.code !== "ENOENT") return null; }
  return [...out];
}

async function main() {
  const files = [], discoveryErrors = [];
  collect(root, files, discoveryErrors);
  files.sort();
  // fixture-safety lint: refuse to RUN anything if a selftest could hit a live process — or if that cannot be checked (fail-closed)
  const live = liveSessionIds(process.env.SELFTEST_HOME || homedir());
  const lintFails = [];
  if (live === null) lintFails.push("(inventory): the live-session list (presence/, roles/coordinator.sid) cannot be read — check incomplete");
  for (const rel of files) {
    let text;
    try { text = readFileSync(path.join(root, rel), "utf8"); } catch (e) { lintFails.push(`${rel}: source unreadable (${e && e.code}) — check incomplete`); continue; }
    for (const why of fixtureLint(text, live ?? [])) lintFails.push(`${rel}: ${why}`);
  }
  // discovery is part of the safety check (PW-SV-FIXTURE-LINT-INCOMPLETE): a directory or file that could not be listed/stat'ed may hold
  // a selftest the lint never saw, so ANY discovery error stops the run before the first test is started (fail-closed)
  for (const d of discoveryErrors) lintFails.push(`DISCOVERY-FAIL ${d.path}: ${d.why} — check incomplete`);
  if (lintFails.length) {
    console.log(`run-selftests: fixture-safety lint FAILED — nothing was run:\n${lintFails.map((l) => `  LINT ${l}`).join("\n")}`);
    process.exitCode = 1; return;
  }
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
    // STCI-R2-P3-1: show the REAL tail — the last lines of the ARRIVAL-order sliding-tail capture (stdout+stderr interleaved as
    // they arrived), where the failure marker lives — and say so when capped.
    const tail = `${r.truncated ? "(output truncated — showing tail)\n" : ""}${r.combined.trim().split("\n").slice(-12).join("\n")}`;
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
  // STCI-R2-P3-1: set exitCode and RETURN (do not process.exit) so the full failure report above is flushed to stdout before exit.
  if (failures.length || discoveryErrors.length) process.exitCode = 1;
}

// run only when executed directly (importing the module for its pure helpers, e.g. in a selftest, must not start a whole run)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`run-selftests: unexpected: ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}
