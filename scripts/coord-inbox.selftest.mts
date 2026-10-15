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
import { writeInbox } from "../packages/bus/src/inbox.js";
import { migrateCoordInbox } from "./migrate-coord-inbox.js";

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
    writeFileSync(path.join(ob, "0000000000000009-inflight.json.claim-12345"), JSON.stringify(m("in-flight")));
    writeFileSync(path.join(ob, ".wtmp-abc"), "temp");
    writeFileSync(path.join(ob, "0000000000000010-bad.json"), "{not json");
    const dry = migrateCoordInbox(h, OLD, NEW, true);
    ok(dry.moved.length === 2 && pending(h, NEW).length === 0 && pending(h, OLD).length === 3, "migrate --dry: lists, writes nothing");
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(r.moved.length === 2 && r.failed.length === 0, "migrate: the two unread messages moved");
    ok(pending(h, NEW).length === 2 && pending(h, NEW).map((f) => JSON.parse(readFileSync(path.join(box(h, NEW), f), "utf8")).text).sort().join(",") === "unread-1,unread-2", "migrate: they landed intact in the new box");
    ok(existsSync(path.join(ob, "processed", "done.json")), "migrate: processed/ untouched");
    ok(existsSync(path.join(ob, "0000000000000009-inflight.json.claim-12345")), "migrate: a .claim-* (in-flight/stranded) untouched");
    ok(existsSync(path.join(ob, ".wtmp-abc")), "migrate: temps untouched");
    ok(r.skippedInvalid.includes("0000000000000010-bad.json") && existsSync(path.join(ob, "0000000000000010-bad.json")), "migrate: an invalid message is LEFT in place and reported (never dropped)");
    const again = migrateCoordInbox(h, OLD, NEW);
    ok(again.moved.length === 0 && pending(h, NEW).length === 2, "migrate: re-run after success is a no-op");
  }
  { // crash between publish and source removal ⇒ the re-run must NOT duplicate
    const h = home();
    writeInbox(h, OLD, m("crash-me"));
    const name = pending(h, OLD)[0]!;
    writeInbox(h, NEW, m("crash-me"), `mig-${name.replace(/\.json$/, "")}`); // simulate: step 1 done, crashed before step 2
    const r = migrateCoordInbox(h, OLD, NEW);
    ok(r.moved.length === 1 && pending(h, NEW).length === 1 && pending(h, OLD).length === 0, "migrate: crash between publish and unlink ⇒ re-run publishes at most once (already) and finishes the move");
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
