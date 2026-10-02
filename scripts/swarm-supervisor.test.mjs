// Regression test for the box supervisor publish pipeline (run: `node --test scripts/swarm-supervisor.test.mjs`).
// It drives the REAL publish() (imported, not copied) against a scripted in-memory git model, so the exact ordering
// bugs Codex found in review are locked down: P1-A (never publish past a `final`, refuse on unknown phase), P1-B
// (lost-ACK adoption via the attempted-sha set) and the P1-B residual (a read-only `unchanged`/`final-hit` return
// must NOT clear the set, or an in-flight timed-out push is forgotten and later judged "foreign" forever).
//
// The model is NOT a copy of publish — it only answers the git subcommands publish issues, backed by a tiny remote
// state. write-tree/commit-tree read the REAL manifest bytes publish wrote, so buildManifest + the unchanged-skip
// are exercised for real. A scripted push mode injects the failure shapes (lost-ACK, timeout, non-FF).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORK_DIR = mkdtempSync(path.join(os.tmpdir(), "sup-work-"));
const BRANCH = "swarm/rw-test-g0";
const MANIFEST_REL = ".swarm/manifest.json";

// env must exist BEFORE the module is imported (its top-level must() reads it) -> dynamic import after setting env.
Object.assign(process.env, {
  SWARM_LAUNCH_ID: "rw-test",
  SWARM_GENERATION: "0",
  SWARM_BUDGET_SEC: "3480",
  SWARM_DEADLINE_WALL: String(Math.floor(Date.now() / 1000) + 3480),
  SWARM_WORK_DIR: WORK_DIR,
  SWARM_BRANCH: BRANCH,
  SWARM_RUNTIME_DIR: mkdtempSync(path.join(os.tmpdir(), "sup-rt-")),
  SWARM_ALLOWLIST: "out",
});
const sup = await import("./swarm-supervisor.mjs");

// --- scripted git model: answers only what publish() calls; remote tip + commit graph live in `m`. ---
function makeGit() {
  const m = { remoteTip: "", commits: {}, unreadable: new Set(), pushMode: "ok", lsFail: false, manifestAddFails: false, n: 0 };
  const manifestNow = () => readFileSync(path.join(WORK_DIR, MANIFEST_REL), "utf8");
  const treeOf = (buf) => "tree-" + createHash("sha1").update(buf).digest("hex").slice(0, 12);
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const err = (stderr, code = 1) => ({ code, stdout: "", stderr });
  const git = async (args) => {
    const [cmd, a1, a2] = args;
    if (cmd === "ls-remote") return m.lsFail ? err("ls-remote failed") : ok(m.remoteTip ? `${m.remoteTip}\trefs/heads/${BRANCH}\n` : "");
    if (cmd === "fetch") return ok();
    if (cmd === "rev-parse" && /\^\{tree\}$/.test(args[1])) {
      const sha = args[1].replace(/\^\{tree\}$/, "");
      return m.commits[sha] ? ok(m.commits[sha].tree) : err("bad rev", 128);
    }
    if (cmd === "rev-parse") return ok(m.remoteTip); // -q --verify refs/remotes/... fallback path
    if (cmd === "show") {
      const sha = String(a1).split(":")[0];
      if (m.unreadable.has(sha)) return err("fatal: path exists on disk, but not in commit", 128);
      return m.commits[sha] ? ok(m.commits[sha].manifest) : err("fatal: not a valid object", 128);
    }
    if (cmd === "read-tree") return ok();
    if (cmd === "add") {
      if (args[2] === MANIFEST_REL && m.manifestAddFails) return err("fatal: pathspec '.swarm/manifest.json' did not match any files");
      return ok();
    }
    if (cmd === "write-tree") return ok(treeOf(manifestNow()));
    if (cmd === "commit-tree") {
      const tree = a1;
      const parent = args.includes("-p") ? args[args.indexOf("-p") + 1] : "";
      const sha = "c" + ++m.n;
      m.commits[sha] = { tree, parent, manifest: manifestNow() };
      return ok(sha);
    }
    if (cmd === "push") {
      const sha = String(a2).split(":")[0];
      const land = () => { m.remoteTip = sha; };
      switch (m.pushMode) {
        case "lostAckLands": land(); return err("fatal: the remote end hung up unexpectedly");
        case "timeoutNoLand": return err("timeout", -1);
        case "rejectNonFF": return err("! [rejected] (non-fast-forward)");
        default: land(); return ok();
      }
    }
    throw new Error("unmodeled git: " + args.join(" "));
  };
  return { git, m };
}

async function withModel(fn) {
  const { git, m } = makeGit();
  sup.__setGit(git);
  await fn(m);
}

test("P1-B: a lost-ACK push (client failure, remote landed) is adopted next round, not judged foreign", async () => {
  await withModel(async (m) => {
    sup.__reset();
    let r = await sup.publish("milestone", { next: "a" });
    assert.ok(r.ok && r.sha === m.remoteTip, "first milestone lands");
    const cA = r.sha;

    m.pushMode = "lostAckLands";
    r = await sup.publish("milestone", { next: "b" }); // differs from A -> new commit, push "fails" but lands
    assert.equal(r.ok, false, "client sees push failure");
    assert.ok(m.remoteTip !== cA, "but it actually landed on the remote");
    assert.ok(sup.__state().attempted.includes(m.remoteTip), "landed sha retained in attempted set");

    m.pushMode = "ok";
    r = await sup.publish("milestone", { next: "c" }); // sees remote=landed-B
    assert.ok(r.ok, "adopts the lost-ACK tip and keeps publishing (not foreign)");
  });
});

test("P1-B residual: an 'unchanged' read must NOT clear the set, so a late-landing timed-out push stays ours", async () => {
  await withModel(async (m) => {
    sup.__reset();
    let r = await sup.publish("milestone", { next: "x" });
    const cA = r.sha;
    assert.ok(r.ok);

    m.pushMode = "timeoutNoLand";
    r = await sup.publish("rescue", { next: "y" }); // differs -> new commit cB, push times out, remote stays A
    assert.equal(r.ok, false);
    assert.equal(m.remoteTip, cA, "remote still at A (B did not land yet)");
    const cB = sup.__state().attempted.find((s) => s !== cA);
    assert.ok(cB, "cB recorded as attempted");

    m.pushMode = "ok";
    r = await sup.publish("milestone", { next: "x" }); // same content as A -> unchanged(A)
    assert.ok(r.ok && r.unchanged, "re-reports A's tree -> unchanged");
    assert.ok(sup.__state().attempted.includes(cB), "RESIDUAL FIX: unchanged did NOT forget the in-flight cB");

    m.remoteTip = cB; // the timed-out push B lands late (legal FF over A)
    r = await sup.publish("milestone", { next: "z" });
    assert.ok(r.ok, "cB is adopted as ours (pre-fix this was permanently foreign)");
  });
});

test("P1-A: a rescue must not build past a confirmed final; it freezes instead", async () => {
  await withModel(async (m) => {
    const cF = "cF";
    m.commits[cF] = { tree: "tree-final", parent: "", manifest: JSON.stringify({ schemaVersion: 1, launchId: "rw-test", generation: 0, kind: "final" }) };
    m.remoteTip = cF;
    sup.__reset({ lastPushedSha: cF, finalized: false }); // simulate: tip is ours but we forgot it was final

    const r = await sup.publish("rescue", { next: "deadline" });
    assert.ok(r.ok && r.hitFinal && r.sha === cF, "returns the final tip unchanged");
    assert.equal(sup.__state().finalized, true, "phase recovered -> frozen");
    assert.equal(m.remoteTip, cF, "nothing pushed past the final");
  });
});

test("P1-A: unknown parent phase (unreadable manifest) is refused, not published past", async () => {
  await withModel(async (m) => {
    const cG = "cG";
    m.commits[cG] = { tree: "tree-g", parent: "", manifest: "{}" };
    m.unreadable.add(cG);
    m.remoteTip = cG;
    sup.__reset({ lastPushedSha: cG, finalized: false });

    const r = await sup.publish("rescue", { next: "deadline" });
    assert.equal(r.ok, false, "refused");
    assert.match(r.error, /manifest unreadable|phase unknown/);
    assert.equal(sup.__state().finalized, false);
    assert.equal(m.remoteTip, cG, "remote untouched");
  });
});

// --- P2 hardening ---

test("P2-b: a missing MANDATORY manifest (git add did-not-match) is a hard error, not tolerated", async () => {
  await withModel(async (m) => {
    sup.__reset();
    m.manifestAddFails = true;
    const r = await sup.publish("milestone", { next: "x" });
    assert.equal(r.ok, false, "publish refuses without the manifest");
    assert.match(r.error, /manifest/i);
    assert.equal(m.remoteTip, "", "nothing pushed");
  });
});

test("P2-c: a control-char goal is truncated by ENCODED length, kept under MAX, never silently dropped", async () => {
  await withModel(async () => {
    sup.__reset();
    const r = await sup.publish("milestone", { goal: "\u0001".repeat(5000) }); // ~30KB if capped by char count
    assert.ok(r.ok, "publishes");
    const raw = readFileSync(path.join(WORK_DIR, MANIFEST_REL), "utf8");
    assert.ok(Buffer.byteLength(raw) <= 16 * 1024, `manifest within MAX bytes (got ${Buffer.byteLength(raw)})`);
    const man = JSON.parse(raw); // must still be valid JSON
    assert.ok(typeof man.goal === "string" && man.goal.length > 0, "goal is KEPT, not dropped to a minimal manifest");
    assert.match(man.goal, /\[truncated\]/, "truncation is marked, not silent");

    // CJK (3 bytes/char): .length and byteLength DIFFER, so this proves a true UTF-8 BYTE bound, not code units (P3).
    sup.__reset();
    const r2 = await sup.publish("milestone", { goal: "好".repeat(8000) }); // 8000 chars -> 24KB UTF-8
    assert.ok(r2.ok, "publishes CJK");
    const raw2 = readFileSync(path.join(WORK_DIR, MANIFEST_REL), "utf8");
    assert.ok(Buffer.byteLength(raw2) <= 16 * 1024, `CJK manifest within MAX bytes (got ${Buffer.byteLength(raw2)})`);
    assert.match(JSON.parse(raw2).goal, /\[truncated\]/, "CJK goal truncated, not dropped");
  });
});

test("P2-a: unsafe allowlist entries are rejected at import (exit 2); literal paths pass", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const modUrl = pathToFileURL(path.join(here, "swarm-supervisor.mjs")).href;
  const run = (allowlist) => {
    const env = { ...process.env,
      SWARM_LAUNCH_ID: "rw-test", SWARM_GENERATION: "0", SWARM_BUDGET_SEC: "3480",
      SWARM_DEADLINE_WALL: String(Math.floor(Date.now() / 1000) + 3480),
      SWARM_WORK_DIR: WORK_DIR, SWARM_BRANCH: BRANCH,
      SWARM_RUNTIME_DIR: mkdtempSync(path.join(os.tmpdir(), "sup-rt-")), SWARM_ALLOWLIST: allowlist };
    try { execFileSync(process.execPath, ["-e", `import(${JSON.stringify(modUrl)})`], { env, stdio: "pipe" }); return 0; }
    catch (e) { return e.status ?? -1; }
  };
  for (const bad of ["out/**", "**", "out/*", "./out", "a:b", "../x", "."]) assert.equal(run(bad), 2, `rejected: ${bad}`);
  for (const good of ["out", "dist/bundle.js", "src/gen"]) assert.equal(run(good), 0, `accepted: ${good}`);
});
