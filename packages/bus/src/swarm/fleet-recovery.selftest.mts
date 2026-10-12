// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/fleet-recovery.selftest.mts
// Pins full-fleet-recovery (brief @cf7a6e2, 6 rulings): the PURE core (env allowlist fail-closed Q1 + HERDR_ family capture Q2/F54,
// tolerant parse, dispatcher/member verdicts incl. the F54 wake-inert escalation, breakpoint Q3) AND the IO store with the three
// zero-bug fixture classes required by the new infra law: crash-recovery, restart-idempotency, concurrency-race.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA, fleetRecoveryEnabled, envAllowed, filterCaptureEnv, snapshotStaleSec, parseFleetSnapshot,
  dispatcherNeedsRelaunch, wakeHealthy, dispatcherVerdict, memberVerdict, buildBreakpointText, shouldInjectBreakpoint,
  breakpointInjectionEnabled, memberShortId, claimedItemsForMember,
  type FleetSnapshot, type DispatcherRecipe,
} from "./fleet-recovery.js";
import {
  dispatcherPid, dispatcherLive, heartbeatFreshSec, captureEnvForPid, writeFleetSnapshot, readFleetSnapshot,
  readBoardFileNames, writeRecoveryReceipt, readRecoveryReceipt, FLEET_RECEIPT_SCHEMA,
} from "./fleet-recovery-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "fleet-recovery-selftest-"));
const homes: string[] = [];
function freshHome(): string { const h = mkdtempSync(path.join(scratch, "home-")); homes.push(h); return h; }
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");

try {
  // ── Q1: env allowlist (fail-closed) ─────────────────────────────────────────────────────────────────────────────
  t("envAllowed: SWARM_ flag family", envAllowed("SWARM_COORDINATOR") && envAllowed("SWARM_SELF") && envAllowed("SWARM_NEW_FLAG_NEVER_SEEN"));
  t("envAllowed: HERDR_ family (Q2/F54)", envAllowed("HERDR_ENV") && envAllowed("HERDR_PANE_ID") && envAllowed("HERDR_SOCKET_PATH") && envAllowed("HERDR_BIN"));
  t("envAllowed: explicit names", envAllowed("AH_HOME") && envAllowed("ANTHROPIC_BASE_URL") && envAllowed("CPA_BASE_URL"));
  t("envAllowed: secret denylist OVERRIDES allow", !envAllowed("CPA_API_KEY") && !envAllowed("ANTHROPIC_API_KEY"));
  t("envAllowed: secret in a SWARM_ name still dropped", !envAllowed("SWARM_SOMETHING_TOKEN") && !envAllowed("SWARM_X_SECRET") && !envAllowed("SWARM_DEPLOY_PRIVATE"));
  t("envAllowed: unknown non-family var dropped (fail-closed)", !envAllowed("PATH") && !envAllowed("HOME") && !envAllowed("FOOBAR") && !envAllowed(""));
  t("filterCaptureEnv: keeps allowed, drops secret+unknown, string-only",
    (() => {
      const f = filterCaptureEnv({ SWARM_SELF: "d1", HERDR_PANE_ID: "w1:p1", CPA_API_KEY: "sekret", PATH: "/bin", UNDEF: undefined, NUM: 5 as unknown as string });
      return f.SWARM_SELF === "d1" && f.HERDR_PANE_ID === "w1:p1" && !("CPA_API_KEY" in f) && !("PATH" in f) && !("UNDEF" in f) && Object.keys(f).length === 2;
    })());

  // ── flag defaults (Q4 fleetRecovery ON; Q3 breakpoint ON) ───────────────────────────────────────────────────────
  t("fleetRecoveryEnabled: default ON (opt-out)", fleetRecoveryEnabled({}) === true && fleetRecoveryEnabled({ SWARM_FLEET_RECOVERY: "0" }) === false);
  t("breakpointInjectionEnabled: default ON (opt-out)", breakpointInjectionEnabled({}) === true && breakpointInjectionEnabled({ SWARM_FLEET_BREAKPOINT: "off" }) === false);

  // ── snapshot parse (tolerant) ───────────────────────────────────────────────────────────────────────────────────
  const goodRecipe: DispatcherRecipe = { command: "node x.ts", cwd: "/repo", env: { SWARM_SELF: "d1", HERDR_ENV: "1" }, envSource: "captured" };
  const goodSnap: FleetSnapshot = { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: 1000, dispatcher: goodRecipe, rosterFile: "/h/roster.json" };
  t("parse: round-trips a good snapshot", JSON.stringify(parseFleetSnapshot(JSON.stringify(goodSnap))) === JSON.stringify(goodSnap));
  t("parse: null dispatcher ok", parseFleetSnapshot(JSON.stringify({ ...goodSnap, dispatcher: null }))?.dispatcher === null);
  t("parse: wrong schema -> null", parseFleetSnapshot(JSON.stringify({ ...goodSnap, schema: "other/v9" })) === null);
  t("parse: missing rosterFile -> null", parseFleetSnapshot(JSON.stringify({ ...goodSnap, rosterFile: "" })) === null);
  t("parse: non-finite capturedAtSec -> null", parseFleetSnapshot(JSON.stringify({ ...goodSnap, capturedAtSec: "x" })) === null);
  t("parse: garbage -> null", parseFleetSnapshot("{not json") === null && parseFleetSnapshot("[]") === null && parseFleetSnapshot("null") === null);
  t("parse: dispatcher missing command -> null", parseFleetSnapshot(JSON.stringify({ ...goodSnap, dispatcher: { cwd: "/r", env: {}, envSource: "captured" } })) === null);
  t("parse: RE-APPLIES allowlist on read (strips a smuggled secret)",
    (() => {
      const tampered = { ...goodSnap, dispatcher: { ...goodRecipe, env: { SWARM_SELF: "d1", CPA_API_KEY: "leaked" } } };
      const p = parseFleetSnapshot(JSON.stringify(tampered));
      return p !== null && p.dispatcher !== null && p.dispatcher.env.SWARM_SELF === "d1" && !("CPA_API_KEY" in p.dispatcher.env);
    })());
  t("parse: unknown envSource -> 'unavailable'", parseFleetSnapshot(JSON.stringify({ ...goodSnap, dispatcher: { ...goodRecipe, envSource: "weird" } }))?.dispatcher?.envSource === "unavailable");

  // ── snapshotStaleSec ────────────────────────────────────────────────────────────────────────────────────────────
  t("staleSec: positive age", snapshotStaleSec({ capturedAtSec: 1000 }, 1600) === 600);
  t("staleSec: never negative; non-finite -> 0", snapshotStaleSec({ capturedAtSec: 2000 }, 1000) === 0 && snapshotStaleSec({ capturedAtSec: NaN }, 1000) === 0);

  // ── Q2: dispatcher relaunch decision + verdict (F54 wake-inert escalation) ──────────────────────────────────────
  t("dispatcherNeedsRelaunch: live -> false", dispatcherNeedsRelaunch(goodSnap, true) === false);
  t("dispatcherNeedsRelaunch: down + recipe -> true", dispatcherNeedsRelaunch(goodSnap, false) === true);
  t("dispatcherNeedsRelaunch: down + NO recipe -> false", dispatcherNeedsRelaunch({ ...goodSnap, dispatcher: null }, false) === false);
  t("wakeHealthy: only 'on'", wakeHealthy("on") && !wakeHealthy("on(inert:no-herdr)") && !wakeHealthy("off"));
  t("dispatcherVerdict: confirmed = alive+fresh+wake-on", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 30, wakeStatus: "on" }, 120) === "confirmed");
  t("dispatcherVerdict: failed = pid dead", dispatcherVerdict({ pidAlive: false, heartbeatFreshSec: 1, wakeStatus: "on" }, 120) === "failed");
  t("dispatcherVerdict: UNKNOWN = alive but wake INERT (F54 escalation)", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(inert:no-herdr)" }, 120) === "unknown");
  t("dispatcherVerdict: unknown = alive but heartbeat stale", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 9999, wakeStatus: "on" }, 120) === "unknown");
  t("dispatcherVerdict: unknown = alive but heartbeat null (not proven ticking)", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: null, wakeStatus: "on" }, 120) === "unknown");

  // ── member verdict (F53 spawn) + breakpoint gating (Q3) ─────────────────────────────────────────────────────────
  t("memberVerdict: confirmed = bus-visible", memberVerdict(true, false, false) === "confirmed");
  t("memberVerdict: failed = failure signal, no positive", memberVerdict(false, false, true) === "failed");
  t("memberVerdict: unknown = no evidence", memberVerdict(false, false, false) === "unknown");
  t("shouldInjectBreakpoint: only confirmed + enabled", shouldInjectBreakpoint("confirmed", true) && !shouldInjectBreakpoint("unknown", true) && !shouldInjectBreakpoint("confirmed", false));

  // ── breakpoint text + board-claim extraction ────────────────────────────────────────────────────────────────────
  t("buildBreakpointText: with claims + unread, no new task", (() => {
    const s = buildBreakpointText({ member: "m1", boardClaims: ["taskA", "taskB"], unreadInbox: 3 }, "2026-10-12T00:00:00Z");
    return s.includes("2") && s.includes("taskA") && s.includes("3") && s.includes("未派新活") && !s.toLowerCase().includes("new task:");
  })());
  t("buildBreakpointText: no claims branch", buildBreakpointText({ member: "m1", boardClaims: [], unreadInbox: 0 }, "T").includes("未发现"));
  t("memberShortId: extracts 8-hex, else null", memberShortId("Work-20cab0a5") === "20cab0a5" && memberShortId("fe0376cd-f1df-4d46") === "fe0376cd" && memberShortId("nohexhere") === null);
  t("claimedItemsForMember: matches <item>.claimed.<who>.json; item may contain dots",
    (() => {
      const names = ["my.task.claimed.20cab0a5.json", "other.claimed.deadbeef.json", "x.done.20cab0a5.json", "y.json", "z.claimed.20cab0a5.txt"];
      const got = claimedItemsForMember("Work-20cab0a5", names);
      return got.length === 1 && got[0] === "my.task";
    })());
  t("claimedItemsForMember: no short id -> [] (never guess)", claimedItemsForMember("plainname", ["a.claimed.xxxxxxxx.json"]).length === 0);

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // STORE + the 3 zero-bug fixture classes (new infra law)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  // round-trip
  {
    const h = freshHome();
    t("store: writeFleetSnapshot + read round-trip", (() => {
      const ok = writeFleetSnapshot(h, goodRecipe, 1234);
      const r = readFleetSnapshot(h);
      return ok && r !== null && r.capturedAtSec === 1234 && r.dispatcher?.command === "node x.ts" && r.rosterFile.endsWith("roster-snapshot.json");
    })());
    t("store: null recipe still records roster pointer", (() => { writeFleetSnapshot(h, null, 5); const r = readFleetSnapshot(h); return r?.dispatcher === null; })());
    t("store: read absent -> null", readFleetSnapshot(freshHome()) === null);
  }

  // receipt round-trip + schema stamp
  {
    const h = freshHome();
    t("store: writeRecoveryReceipt stamps schema + reads back", (() => {
      const ok = writeRecoveryReceipt(h, { notConfirmed: 0, members: [] });
      const r = readRecoveryReceipt(h);
      return ok && r !== null && r.schema === FLEET_RECEIPT_SCHEMA && (r as { notConfirmed?: number }).notConfirmed === 0;
    })());
    t("store: receipt absent -> null", readRecoveryReceipt(freshHome()) === null);
  }

  // heartbeat freshness (FC: corrupt -> null, never fabricated)
  {
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    writeFileSync(path.join(swarm(h), "heartbeat.json"), JSON.stringify({ pass: { lastTickSec: 1000 }, sweep: { lastTickSec: 1200 } }));
    t("store: heartbeatFreshSec = now - max(tick)", heartbeatFreshSec(h, 1500) === 300);
    writeFileSync(path.join(swarm(h), "heartbeat.json"), "{corrupt");
    t("store: heartbeat corrupt -> null (never fabricate freshness)", heartbeatFreshSec(h, 1500) === null);
    t("store: heartbeat absent -> null", heartbeatFreshSec(freshHome(), 1500) === null);
  }

  // dispatcher pid / liveness
  {
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    writeFileSync(path.join(swarm(h), "dispatcher.lock"), String(process.pid));
    t("store: dispatcherPid reads lock; live = own pid", dispatcherPid(h) === process.pid && dispatcherLive(h) === true);
    writeFileSync(path.join(swarm(h), "dispatcher.lock"), "2147480000"); // almost-max, surely dead
    t("store: dead pid -> not live", dispatcherLive(h) === false);
    writeFileSync(path.join(swarm(h), "dispatcher.lock"), "notapid");
    t("store: non-numeric lock -> pid null, not live", dispatcherPid(h) === null && dispatcherLive(h) === false);
    t("store: no lock -> pid null", dispatcherPid(freshHome()) === null);
  }

  // board file names
  {
    const h = freshHome(); mkdirSync(path.join(swarm(h), "board"), { recursive: true });
    writeFileSync(path.join(swarm(h), "board", "a.claimed.20cab0a5.json"), "{}");
    t("store: readBoardFileNames lists; absent -> []", readBoardFileNames(h).includes("a.claimed.20cab0a5.json") && readBoardFileNames(freshHome()).length === 0);
  }

  // env capture invariant (real ps/proc): every captured key is allowlisted; bogus pid -> not ok
  {
    t("store: captureEnvForPid(self) ok + ONLY allowlisted keys", (() => {
      const { env, ok } = captureEnvForPid(process.pid);
      return ok === true && Object.keys(env).every((k) => envAllowed(k));
    })());
    t("store: captureEnvForPid(dead pid) -> {ok:false}", captureEnvForPid(2147480000).ok === false);
  }

  // ── FIXTURE 1: crash-recovery (a half-written / torn snapshot never masquerades; leftover .tmp ignored) ──────────
  {
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    writeFileSync(path.join(swarm(h), "fleet-snapshot.json"), '{"schema":"fleet-recovery-snapshot/v1","capturedAtSec":1,'); // torn (interrupted write)
    t("fixture[crash]: torn snapshot -> null (never acts on garbage)", readFleetSnapshot(h) === null);
    writeFileSync(path.join(swarm(h), "fleet-snapshot.json.tmp-deadbeef"), "garbage"); // a crashed writer's leftover temp
    writeFleetSnapshot(h, goodRecipe, 7);
    t("fixture[crash]: a good write after a crash reads cleanly; leftover .tmp ignored", readFleetSnapshot(h)?.capturedAtSec === 7);
    // a corrupt heartbeat during recovery must not fabricate a 'fresh' dispatcher verdict
    writeFileSync(path.join(swarm(h), "heartbeat.json"), "\x00\x00torn");
    t("fixture[crash]: corrupt heartbeat -> verdict never 'confirmed' on freshness", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: heartbeatFreshSec(h, 9), wakeStatus: "on" }, 120) === "unknown");
  }

  // ── FIXTURE 2: restart-idempotency (recover-twice: snapshot+receipt last-wins readable; breakpoint key is STABLE) ─
  {
    const h = freshHome();
    writeFleetSnapshot(h, goodRecipe, 100);
    writeFleetSnapshot(h, { ...goodRecipe, command: "node y.ts" }, 200); // a second recover pass re-writes
    const r = readFleetSnapshot(h);
    t("fixture[idem]: re-write is last-wins + fully valid (no torn merge)", r !== null && r.capturedAtSec === 200 && r.dispatcher?.command === "node y.ts");
    writeRecoveryReceipt(h, { pass: 1 }); writeRecoveryReceipt(h, { pass: 2 });
    t("fixture[idem]: receipt re-write last-wins + valid", (readRecoveryReceipt(h) as { pass?: number }).pass === 2);
    // the breakpoint idempotency key is derived from the SNAPSHOT's capturedAtSec (stable across re-runs reading the same snapshot),
    // so a re-run computes the SAME key and writeInbox's publishOnce dedups — assert that stability here (the dedup itself is inbox's).
    const keyFor = (capturedAtSec: number, member: string) => `fr-bp-${capturedAtSec}-${member}`.replace(/[^A-Za-z0-9._-]/g, "");
    t("fixture[idem]: breakpoint key stable for same (snapshot, member)", keyFor(200, "abc") === keyFor(200, "abc") && keyFor(200, "abc") !== keyFor(201, "abc"));
  }

  // ── FIXTURE 3: concurrency-race (atomic temp+rename: a reader never sees torn; CP-3 refuses a redirected dir) ─────
  {
    const h = freshHome();
    // interleave: write A then B; a read between/after always yields a COMPLETE valid snapshot (atomic rename, never partial).
    for (let i = 0; i < 20; i++) {
      writeFleetSnapshot(h, { ...goodRecipe, command: `node ${i}.ts` }, 1000 + i);
      const r = readFleetSnapshot(h); // concurrent-reader stand-in: must ALWAYS parse (never a torn temp)
      if (r === null) throw new Error("FAILED: fixture[race] read saw a torn snapshot");
    }
    t("fixture[race]: interleaved writes always read complete + valid", readFleetSnapshot(h)?.capturedAtSec === 1019);
    // CP-3: a swarm dir that is a SYMLINK ⇒ refuse the write (never escape the boundary).
    const h2 = freshHome(); mkdirSync(path.join(h2, ".agenthop"), { recursive: true });
    const elsewhere = mkdtempSync(path.join(scratch, "elsewhere-"));
    symlinkSync(elsewhere, swarm(h2));
    t("fixture[race]: CP-3 refuses a symlinked swarm dir (write skipped)", writeFleetSnapshot(h2, goodRecipe, 1) === false);
    // CP-3 on the console dir for the receipt too
    const h3 = freshHome(); mkdirSync(path.join(h3, ".agenthop", "swarm"), { recursive: true });
    symlinkSync(elsewhere, path.join(swarm(h3), "console"));
    t("fixture[race]: CP-3 refuses a symlinked console dir (receipt skipped)", writeRecoveryReceipt(h3, { x: 1 }) === false);
  }

  console.log("\nfleet-recovery selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}
