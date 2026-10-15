// Run: packages/bus/node_modules/.bin/tsx scripts/coord-inbox.selftest.mts
// #1032 B gates: resolveCoordinatorInbox (resolve or a clear error — never guess), the coord-inbox CLI (one-line send, no write on a
// resolution failure, idempotent --key, unsafe key rejected), and migrate-coord-inbox (top-level unread only; processed/, claims and
// temps untouched; invalid left in place; idempotent incl. a crash between publish and source removal).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCoordinatorInbox, CoordinatorInboxError } from "../packages/bus/src/swarm/coord-inbox.js";
import { writeInbox, claimInbox } from "../packages/bus/src/inbox.js";
import { migrateCoordInbox, migrationKey } from "./migrate-coord-inbox.js";

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
    renameSync(path.join(box(h, OLD), name), path.join(box(h, OLD), `${name}.claim-999999`)); // our crashed run's claim (dead pid)
    writeInbox(h, NEW, m("crash-me"), migrationKey(OLD, name));                               // …it had already published
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(r.moved.length === 1 && pending(h, NEW).length === 1 && pending(h, OLD).length === 0 && !readdirSync(box(h, OLD)).some((x) => x.includes(".claim-")), "migrate: crash after publish ⇒ dead claim recovered, re-publish is 'already', ONE copy, source gone");
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
    ok(!readdirSync(box(h, OLD)).some((x) => x.includes(".claim-")), "migrate: our claim was cleared after publish");
    // contended: a message a LIVE consumer already holds is never published by us
    writeInbox(h, OLD, m("theirs"));
    const n2 = pending(h, OLD)[0]!;
    const { renameSync } = await import("node:fs");
    renameSync(path.join(box(h, OLD), n2), path.join(box(h, OLD), `${n2}.claim-${process.pid}`));
    const before = pending(h, NEW).length;
    migrateCoordInbox(h, OLD, NEW);
    ok(pending(h, NEW).length === before, "migrate: a message a live consumer already claimed is NOT published to the new box");
  }
  { // CIA-MIGRATION-KEY: keys are unambiguous over (source box, FULL file name)
    const long = "a".repeat(140);
    ok(migrationKey(OLD, `${long}x.json`) !== migrationKey(OLD, `${long}y.json`), "key: two long names differing only in the last char ⇒ different keys");
    const OLD2 = "fe0376cd-0000-4000-8000-0000000000aa";
    ok(migrationKey(OLD, "same.json") !== migrationKey(OLD2, "same.json"), "key: same file name in two different old boxes ⇒ different keys");
    ok(migrationKey(OLD, "a.json") === migrationKey(OLD, "a.json") && /^mig-[0-9a-f]{32}$/.test(migrationKey(OLD, "a.json")), "key: deterministic + bounded (rerun hits the same key)");
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
