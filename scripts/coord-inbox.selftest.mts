// Run: packages/bus/node_modules/.bin/tsx scripts/coord-inbox.selftest.mts
// #1032 B gates: resolveCoordinatorInbox (resolve or a clear error — never guess), the coord-inbox CLI (one-line send, no write on a
// resolution failure, idempotent --key, unsafe key rejected), and migrate-coord-inbox (top-level unread only; processed/, claims and
// temps untouched; invalid left in place; idempotent incl. a crash between publish and source removal).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync, lstatSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCoordinatorInbox, CoordinatorInboxError } from "../packages/bus/src/swarm/coord-inbox.js";
import { writeInbox, claimInbox, recoverStaleClaims } from "../packages/bus/src/inbox.js";
import { migrateCoordInbox, migrationKey, migrationKeyForMessage, setReleaseUnlinkForTest } from "./migrate-coord-inbox.js";
import { validInboxMsg } from "../packages/bus/src/inbox.js";

let n = 0;
const ok = (c: boolean, name: string) => { if (!c) throw new Error("FAILED: " + name); n++; console.log("ok  " + name); };
const here = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.join(here, "..", "packages", "bus", "node_modules", ".bin", "tsx");
const scratch = mkdtempSync(path.join(tmpdir(), "coord-inbox-"));
const NEW = "c5beaa7c-0000-4000-8000-000000000001";
const OLD = "fe0376cd-0000-4000-8000-000000000002";
const home = () => {
  const h = mkdtempSync(path.join(scratch, "h-"));
  mkdirSync(path.join(h, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(h, ".agenthop", "presence", `${NEW}.pid`), String(process.pid)); // NEW is a live presence session
  return h;
};
const box = (h: string, sid: string) => path.join(h, ".agenthop", "inbox", sid);
const pending = (h: string, sid: string) => { try { return readdirSync(box(h, sid)).filter((x) => x.endsWith(".json")); } catch { return []; } };
const m = (text: string) => ({ from: "s", fromLabel: "s", text, via: "local", ts: 1000 });

try {
  // ── resolveCoordinatorInbox ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const h = home();
    ok(resolveCoordinatorInbox(h, { SWARM_COORDINATOR: NEW }) === NEW, "resolve: full sid ⇒ that sid");
    ok(resolveCoordinatorInbox(h, { SWARM_COORDINATOR: "claude:agenthop-c5beaa7c" }) === NEW, "resolve: handle ⇒ the live sid");
    const err = (env: NodeJS.ProcessEnv) => { try { resolveCoordinatorInbox(h, env); return null; } catch (e) { return e; } };
    ok(err({}) instanceof CoordinatorInboxError, "resolve: unset ⇒ clear error (never guess)");
    ok(err({ SWARM_COORDINATOR: "  " }) instanceof CoordinatorInboxError, "resolve: blank ⇒ clear error");
    ok(err({ SWARM_COORDINATOR: OLD }) instanceof CoordinatorInboxError, "resolve: an id with no live presence ⇒ error (the old coordinator id no longer resolves)");
    const amb = (() => { try { resolveCoordinatorInbox(h, { SWARM_COORDINATOR: "c5be" }, [NEW, "c5be9999-0000-4000-8000-000000000003"]); return null; } catch (e) { return e; } })();
    ok(amb instanceof CoordinatorInboxError, "resolve: an ambiguous prefix (two live c5be… sessions) ⇒ error, never a pick");
  }
  // ── coord-inbox CLI ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const h = home();
    const cli = (env: Record<string, string>, ...args: string[]) => spawnSync(TSX, [path.join(here, "coord-inbox.ts"), ...args], { env: { ...process.env, AH_HOME: h, ...env }, encoding: "utf8" });
    let r = cli({ SWARM_COORDINATOR: NEW }, "--title", "t", "hello", "there");
    ok(r.status === 0 && /published → c5beaa7c/.test(r.stdout), "cli: sends to the resolved coordinator");
    const got = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")));
    ok(got.length === 1 && got[0].text === "hello there" && got[0].title === "t", "cli: message body + title landed in the CURRENT box");
    r = cli({ SWARM_COORDINATOR: OLD }, "hi");
    ok(r.status === 2 && !existsSync(box(h, OLD)), "cli: unresolvable coordinator ⇒ exit 2 and NOTHING written (no old-box fallback)");
    r = cli({}, "hi");
    ok(r.status === 2, "cli: SWARM_COORDINATOR unset ⇒ exit 2");
    r = cli({ SWARM_COORDINATOR: NEW }, "--key", "k1", "once"); const r2 = cli({ SWARM_COORDINATOR: NEW }, "--key", "k1", "once");
    ok(r.status === 0 && r2.status === 0 && /already/.test(r2.stdout) && pending(h, NEW).length === 2, "cli: --key is idempotent (second send ⇒ already, one message)");
    r = cli({ SWARM_COORDINATOR: NEW }, "--key", "bad/key", "x");
    ok(r.status === 2 && /--key must match/.test(r.stderr), "cli: an unsafe --key is REJECTED, not silently non-deduped");
    r = cli({ SWARM_COORDINATOR: NEW }, "--title");
    ok(r.status === 2, "cli: a flag missing its value ⇒ exit 2");
    const piped = spawnSync(TSX, [path.join(here, "coord-inbox.ts"), "--stdin"], { env: { ...process.env, AH_HOME: h, SWARM_COORDINATOR: NEW }, input: "from stdin\nline 2", encoding: "utf8" });
    ok(piped.status === 0, "cli: --stdin body accepted");
  }
  // ── migrate-coord-inbox ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    const h = home();
    writeInbox(h, OLD, m("unread-1")); writeInbox(h, OLD, m("unread-2"));
    const ob = box(h, OLD);
    mkdirSync(path.join(ob, "processed"), { recursive: true }); writeFileSync(path.join(ob, "processed", "done.json"), JSON.stringify(m("old-processed")));
    writeFileSync(path.join(ob, `0000000000000009-inflight.json.claim-${process.pid}`), JSON.stringify(m("in-flight"))); // a LIVE holder (this test process)
    writeFileSync(path.join(ob, ".wtmp-abc"), "temp");
    writeFileSync(path.join(ob, "0000000000000010-bad.json"), "{not json");
    const dry = migrateCoordInbox(h, OLD, NEW, true);
    ok(dry.moved.length === 2 && pending(h, NEW).length === 0 && pending(h, OLD).length === 3, "migrate --dry: lists, writes nothing");
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(r.moved.length === 2 && r.failed.length === 0, "migrate: the two unread messages moved");
    ok(pending(h, NEW).length === 2 && pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text).sort().join(",") === "unread-1,unread-2", "migrate: they landed intact in the new box");
    ok(existsSync(path.join(ob, "processed", "done.json")), "migrate: processed/ untouched");
    ok(existsSync(path.join(ob, `0000000000000009-inflight.json.claim-${process.pid}`)), "migrate: a LIVE holder's .claim-* (in flight) untouched");
    ok(existsSync(path.join(ob, ".wtmp-abc")), "migrate: temps untouched");
    ok(r.skippedInvalid.includes("0000000000000010-bad.json") && existsSync(path.join(ob, "0000000000000010-bad.json")), "migrate: an invalid message is LEFT in place and reported (never dropped)");
    const again = migrateCoordInbox(h, OLD, NEW);
    ok(again.moved.length === 0 && pending(h, NEW).length === 2, "migrate: re-run after success is a no-op");
  }
  { // CIA-MIGRATION-CLAIM crash: claimed + published, then crashed before removing our claim ⇒ re-run must NOT duplicate
    const h = home();
    writeInbox(h, OLD, m("crash-me"));
    const name = pending(h, OLD)[0]!;
    const { renameSync } = await import("node:fs");
    renameSync(path.join(box(h, OLD), name), path.join(box(h, OLD), `${name}.mig-999999`)); // our crashed run's claim (dead pid)
    writeInbox(h, NEW, m("crash-me"), migrationKeyForMessage(OLD, name, validInboxMsg(m("crash-me"))));  // …it had already published
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(r.moved.length === 1 && pending(h, NEW).length === 1 && pending(h, OLD).length === 0 && !readdirSync(box(h, OLD)).some((x) => x.includes(".mig-") || x.includes(".claim-")), "migrate: crash after publish ⇒ dead claim recovered, re-publish is 'already', ONE copy, source gone");
  }
  { // CIA-MIGRATION-CLAIM race: a competing consumer runs claimInbox INSIDE the migrator's read→publish window. With the claim held
    // first, the competitor finds nothing to take ⇒ exactly ONE copy exists in total (r1 published a second copy here).
    const h = home();
    writeInbox(h, OLD, m("raced"));
    let competitorGot: string[] = [];
    const r = migrateCoordInbox(h, OLD, NEW, false, "mig-test", () => {
      competitorGot = claimInbox(h, [OLD], "competitor").map((c) => c.msg.text); // the original consumer drains the old box now
    });
    const inNew = pending(h, NEW).length;
    ok(competitorGot.length + inNew === 1, `migrate: competing claim inside the window ⇒ ONE copy total (competitor ${competitorGot.length} + new box ${inNew})`);
    ok(r.moved.length === 1 && competitorGot.length === 0, "migrate: the migrator held the claim, so the competitor got nothing and the move completed");
    ok(!readdirSync(box(h, OLD)).some((x) => x.includes(".mig-") || x.includes(".claim-")), "migrate: our claim was cleared after publish");
    // contended: a message a LIVE consumer already holds is never published by us
    writeInbox(h, OLD, m("theirs"));
    const n2 = pending(h, OLD)[0]!;
    const { renameSync } = await import("node:fs");
    renameSync(path.join(box(h, OLD), n2), path.join(box(h, OLD), `${n2}.claim-${process.pid}`));
    const before = pending(h, NEW).length;
    migrateCoordInbox(h, OLD, NEW);
    ok(pending(h, NEW).length === before, "migrate: a message a live consumer already claimed is NOT published to the new box");
  }
  { // CIA-RELEASE-OWN (r3): releasing our claim must NOT overwrite a new message a writer put at the vacated source name
    const h = home();
    writeInbox(h, OLD, m("A-claimed"));
    const name = pending(h, OLD)[0]!;
    mkdirSync(path.join(h, ".agenthop", "inbox"), { recursive: true });
    writeFileSync(path.join(h, ".agenthop", "inbox", NEW), "a FILE where the new box dir should be"); // ⇒ publish into NEW fails
    const r = migrateCoordInbox(h, OLD, NEW, false, "mig-test", () => {
      writeFileSync(path.join(box(h, OLD), name), JSON.stringify(m("B-new-writer"))); // another writer re-creates the vacated name
    });
    const ob = box(h, OLD);
    const bodies = readdirSync(ob).filter((x) => x.startsWith(name)).map((x) => JSON.parse(readFileSync(path.join(ob, x), "utf8")).text).sort();
    ok(bodies.join(",") === "A-claimed,B-new-writer", `release: BOTH bodies survive (A in our kept claim, B at the pending name) — got ${bodies.join(",")}`);
    ok(r.conflict.includes(name) && r.failed.length === 1, "release: reported as conflict (+ the publish failure), not silently resolved");
    rmSync(path.join(h, ".agenthop", "inbox", NEW));
  }
  { // CIA-SHARED-RECOVERY (r5): a REAL migration leaves `source.json = B` + our kept dead claim = A; the box's ORDINARY consumer
    // recovery (bus recoverStaleClaims, run by core/dispatch) must not overwrite B with A. Then a re-run delivers both.
    const h = home();
    writeInbox(h, OLD, m("A-claimed"));
    const name = pending(h, OLD)[0]!;
    mkdirSync(path.join(h, ".agenthop", "inbox"), { recursive: true });
    writeFileSync(path.join(h, ".agenthop", "inbox", NEW), "a FILE where the new box dir should be"); // ⇒ publish into NEW fails
    const r = migrateCoordInbox(h, OLD, NEW, false, "999999", () => { // claimer = a DEAD pid, as after a crash
      writeFileSync(path.join(box(h, OLD), name), JSON.stringify(m("B-new-writer")));
    });
    ok(r.conflict.includes(name), "shared recovery: the real migration produced the conflict state (B pending, A in our kept claim)");
    recoverStaleClaims(h, [OLD]); // the ordinary bus consumer's startup recovery
    const ob = box(h, OLD);
    const bodies = readdirSync(ob).filter((x) => x.startsWith(name)).map((x) => JSON.parse(readFileSync(path.join(ob, x), "utf8")).text).sort();
    ok(bodies.join(",") === "A-claimed,B-new-writer", `shared recovery: ordinary recoverStaleClaims leaves BOTH bodies (got ${bodies.join(",") || "none"})`);
    rmSync(path.join(h, ".agenthop", "inbox", NEW));
    const r2 = migrateCoordInbox(h, OLD, NEW); // B moves now; A is still a conflict (its name is taken by B until B moves)
    const r3 = migrateCoordInbox(h, OLD, NEW);
    const texts = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text).sort();
    ok(texts.join(",") === "A-claimed,B-new-writer" && r2.failed.length + r3.failed.length === 0 && readdirSync(ob).filter((x) => x.startsWith(name)).length === 0, `shared recovery: re-runs deliver both, old box empty (got ${texts.join(",")})`);
  }
  { // r5 scope: a dead BUS consumer's `.claim-<pid>` is the box consumer's to recover — the migrator neither renames nor migrates it
    const h = home();
    mkdirSync(box(h, OLD), { recursive: true });
    writeFileSync(path.join(box(h, OLD), "0000000000000003-z.json.claim-999999"), JSON.stringify(m("bus-dead-claim")));
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(existsSync(path.join(box(h, OLD), "0000000000000003-z.json.claim-999999")) && pending(h, NEW).length === 0 && r.moved.length + r.conflict.length + r.failed.length === 0, "scope: a dead bus .claim-* is left untouched for the box's own consumer");
  }
  { // CIA-RELEASE-OWN for dead-claim recovery: a dead claim whose pending name is taken is kept, not overwritten
    const h = home();
    mkdirSync(box(h, OLD), { recursive: true });
    writeFileSync(path.join(box(h, OLD), "0000000000000001-x.json.mig-999999"), JSON.stringify(m("A-dead-claim")));
    writeFileSync(path.join(box(h, OLD), "0000000000000001-x.json"), JSON.stringify(m("B-same-name")));
    const r = migrateCoordInbox(h, OLD, NEW);
    const kept = existsSync(path.join(box(h, OLD), "0000000000000001-x.json.mig-999999"));
    const texts = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text);
    ok(kept && texts.includes("B-same-name") && r.conflict.includes("0000000000000001-x.json"), "recovery: dead claim kept (A) while the new pending message (B) migrates — both survive");
  }
  { // CIA-CLAIM-ERRNO (r3): a permission fault is FAILED with its errno, not "contended"; the CLI exits non-zero
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!isRoot) {
      const h = home();
      writeInbox(h, OLD, m("stuck-ro"));
      const { chmodSync } = await import("node:fs");
      chmodSync(box(h, OLD), 0o500); // readable, not writable ⇒ the claim rename fails with EACCES
      const r = migrateCoordInbox(h, OLD, NEW);
      const cli = spawnSync(TSX, [path.join(here, "migrate-coord-inbox.ts"), "--from", OLD, "--to", NEW], { env: { ...process.env, AH_HOME: h }, encoding: "utf8" });
      chmodSync(box(h, OLD), 0o700);
      ok(r.contended.length === 0 && r.failed.length === 1 && /EACCES|EPERM/.test(r.failed[0]!.why), `errno: read-only dir ⇒ failed with the errno, not contended (${r.failed[0]?.why ?? "none"})`);
      ok(cli.status !== 0 && !/claimed by another consumer/.test(cli.stdout), "errno: CLI exits non-zero and does not claim another consumer took it");
      ok(pending(h, OLD).length === 1, "errno: the message is still pending in the old box (not lost, not moved)");
    } else console.log("skip  errno test (root bypasses perms)");
  }
  { // CIA-RELEASE-OWN r4: the dead-claim A + same-name B conflict must keep BOTH bodies across a RE-RUN (Second Voice counterexample)
    const h = home();
    mkdirSync(box(h, OLD), { recursive: true });
    writeFileSync(path.join(box(h, OLD), "0000000000000001-x.json.mig-999999"), JSON.stringify(m("A-dead-claim")));
    writeFileSync(path.join(box(h, OLD), "0000000000000001-x.json"), JSON.stringify(m("B-same-name")));
    migrateCoordInbox(h, OLD, NEW);             // run 1: A kept as conflict, B migrated
    const r2 = migrateCoordInbox(h, OLD, NEW);  // run 2: A is now recoverable — it must be DELIVERED, not deleted as "already"
    const texts = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text).sort();
    ok(texts.join(",") === "A-dead-claim,B-same-name", `re-run: BOTH bodies end up delivered (got ${texts.join(",")})`);
    ok(r2.moved.length === 1 && r2.failed.length === 0 && r2.conflict.length === 0, "re-run: run 2 reports A moved, nothing failed");
    ok(pending(h, OLD).length === 0 && !readdirSync(box(h, OLD)).some((x) => x.includes(".mig-") || x.includes(".claim-")), "re-run: old box is empty afterwards");
  }
  { // CIA-SV-P2-2: dead-claim recovery that hits EACCES is FAILED (with errno), the CLI exits non-zero, and the claim is kept
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!isRoot) {
      const h = home();
      mkdirSync(box(h, OLD), { recursive: true });
      writeFileSync(path.join(box(h, OLD), "0000000000000002-y.json.mig-999999"), JSON.stringify(m("dead-only")));
      const { chmodSync } = await import("node:fs");
      chmodSync(box(h, OLD), 0o500);
      const r = migrateCoordInbox(h, OLD, NEW);
      const cli = spawnSync(TSX, [path.join(here, "migrate-coord-inbox.ts"), "--from", OLD, "--to", NEW], { env: { ...process.env, AH_HOME: h }, encoding: "utf8" });
      chmodSync(box(h, OLD), 0o700);
      ok(r.failed.some((f) => /EACCES|EPERM/.test(f.why)), `recovery errno: reported as failed (${r.failed.map((f) => f.why).join("; ") || "none"})`);
      ok(cli.status !== 0, "recovery errno: CLI exits non-zero (not a silent all-zero success)");
      ok(existsSync(path.join(box(h, OLD), "0000000000000002-y.json.mig-999999")), "recovery errno: the dead claim is kept");
      const ok2 = migrateCoordInbox(h, OLD, NEW);
      ok(ok2.moved.length === 1 && pending(h, NEW).length === 1, "recovery errno: once the dir is writable again the same fixture migrates");
    } else console.log("skip  recovery errno test (root bypasses perms)");
  }
  { // CIA-SV-P2-2 release-unlink (r6): recovery links a dead claim back but the claim-name unlink fails ⇒ reported FAILED (not a
    // silent release), and a later FAULT-FREE run (the real CLI) finishes the migration — no nlink=2 strand
    const h = home();
    mkdirSync(box(h, OLD), { recursive: true });
    writeFileSync(path.join(box(h, OLD), "0000000000000004-u.json.mig-999999"), JSON.stringify(m("half-released")));
    setReleaseUnlinkForTest(() => { const e = new Error("EACCES: injected") as NodeJS.ErrnoException; e.code = "EACCES"; throw e; });
    let r;
    try { r = migrateCoordInbox(h, OLD, NEW); } finally { setReleaseUnlinkForTest(undefined); }
    ok(r.failed.some((f) => /unlink EACCES/.test(f.why)) && r.moved.length === 0, `release-unlink: reported as failed with the errno (${r.failed.map((f) => f.why).join("; ") || "none"})`);
    ok(lstatSync(path.join(box(h, OLD), "0000000000000004-u.json")).nlink === 2, "release-unlink: the fixture really is the half-released state (two names, one inode)");
    const cli = spawnSync(TSX, [path.join(here, "migrate-coord-inbox.ts"), "--from", OLD, "--to", NEW], { env: { ...process.env, AH_HOME: h }, encoding: "utf8" });
    const texts = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text);
    ok(cli.status === 0 && texts.join(",") === "half-released" && readdirSync(box(h, OLD)).filter((x) => x.startsWith("0000000000000004-u")).length === 0, `release-unlink: a later fault-free CLI run finishes the migration, old box clear (exit ${cli.status}, got ${texts.join(",") || "none"})`);
  }
  { // r6 scope: an UNRELATED hard link keeps the single-link protection (finishing a half release needs claim + pending as the ONLY two links)
    const h = home();
    mkdirSync(box(h, OLD), { recursive: true });
    const claimP = path.join(box(h, OLD), "0000000000000005-v.json.mig-999999");
    writeFileSync(claimP, JSON.stringify(m("three-links")));
    linkSync(claimP, path.join(box(h, OLD), "0000000000000005-v.json"));
    linkSync(claimP, path.join(h, "outside-link"));
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(existsSync(claimP) && pending(h, NEW).length === 0 && r.skippedNonRegular.length === 2, `scope: claim+pending+an outside link (nlink=3) are left alone and reported (${JSON.stringify(r.skippedNonRegular)})`);
  }
  { // CIA-SV-P2-3: a non-regular `*.json` entry (directory / symlink / hard-linked file) is never claimed or renamed
    const h = home();
    const ob = box(h, OLD); mkdirSync(path.join(ob, "keep.json"), { recursive: true });
    writeFileSync(path.join(ob, "keep.json", "child.txt"), "child");
    writeFileSync(path.join(h, "target.json"), JSON.stringify(m("via-symlink")));
    const { symlinkSync, linkSync: ln } = await import("node:fs");
    symlinkSync(path.join(h, "target.json"), path.join(ob, "link.json"));
    writeFileSync(path.join(ob, "hard.json"), JSON.stringify(m("hardlinked")));
    ln(path.join(ob, "hard.json"), path.join(h, "hard-other-link"));
    writeInbox(h, OLD, m("normal"));
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(existsSync(path.join(ob, "keep.json", "child.txt")) && readFileSync(path.join(ob, "keep.json", "child.txt"), "utf8") === "child", "non-regular: a directory named keep.json keeps its path and contents");
    ok(existsSync(path.join(ob, "link.json")) && existsSync(path.join(ob, "hard.json")), "non-regular: symlink and hard-linked entries are left in place");
    const why = Object.fromEntries(r.skippedNonRegular.map((x) => [x.name, x.why]));
    ok(why["keep.json"] === "directory" && why["link.json"] === "symlink" && /nlink=2/.test(why["hard.json"] ?? ""), `non-regular: each reported with its type (${JSON.stringify(why)})`);
    ok(r.moved.length === 1 && pending(h, NEW).length === 1, "non-regular: the normal message alongside still migrates");
  }
  { // CIA-MIGRATION-KEY: keys are unambiguous over (source box, FULL file name)
    const long = "a".repeat(140);
    ok(migrationKey(OLD, `${long}x.json`, "b") !== migrationKey(OLD, `${long}y.json`, "b"), "key: two long names differing only in the last char ⇒ different keys");
    const OLD2 = "fe0376cd-0000-4000-8000-0000000000aa";
    ok(migrationKey(OLD, "same.json", "b") !== migrationKey(OLD2, "same.json", "b"), "key: same file name in two different old boxes ⇒ different keys");
    ok(migrationKey(OLD, "same.json", "A") !== migrationKey(OLD, "same.json", "B"), "key: same box + same name but a DIFFERENT body ⇒ different keys (r4)");
    ok(migrationKey(OLD, "a.json", "b") === migrationKey(OLD, "a.json", "b") && /^mig-[0-9a-f]{32}$/.test(migrationKey(OLD, "a.json", "b")), "key: deterministic + bounded (rerun hits the same key)");
    // end-to-end: two long-named distinct messages BOTH arrive (the r1 bug kept only one)
    const h = home(); mkdirSync(box(h, OLD), { recursive: true });
    writeFileSync(path.join(box(h, OLD), `${long}1.json`), JSON.stringify(m("first")));
    writeFileSync(path.join(box(h, OLD), `${long}2.json`), JSON.stringify(m("second")));
    const r = migrateCoordInbox(h, OLD, NEW);
    const texts = pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text).sort();
    ok(r.moved.length === 2 && texts.join(",") === "first,second", "key: two long names sharing a 120-char prefix ⇒ BOTH bodies delivered (no silent loss)");
    // cross-box same name, different bodies ⇒ both delivered
    mkdirSync(box(h, OLD2), { recursive: true });
    writeFileSync(path.join(box(h, OLD2), `${long}1.json`), JSON.stringify(m("other-box")));
    migrateCoordInbox(h, OLD2, NEW);
    ok(pending(h, NEW).length === 3, "key: same name from a second old box, different body ⇒ delivered too");
  }
  {
    const h = home();
    let threw = false; try { migrateCoordInbox(h, "../x", NEW); } catch { threw = true; }
    ok(threw, "migrate: unsafe --from rejected");
    threw = false; try { migrateCoordInbox(h, NEW, NEW); } catch { threw = true; }
    ok(threw, "migrate: from == to rejected");
    ok(migrateCoordInbox(h, "a0000000-0000-4000-8000-000000000009", NEW).moved.length === 0, "migrate: a missing old box ⇒ nothing to do");
  }
  console.log(`\nall coord-inbox selftests passed (${n})`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
