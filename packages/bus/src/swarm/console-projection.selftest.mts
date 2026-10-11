/**
 * console-projection selftest (tsx-run). Covers the two read-only producers:
 *  ① decisions mirror shape == decision-batch-v1 batch.json (from a real store fixture), consumed batches excluded + pruned.
 *  ② roster payload derives {sid,tool,pane,alive,inflight} incl. FC-2 r3 three-state (a read-errored seat ⇒ "unknown", never
 *     a false "dead").
 *  - the SWARM_CONSOLE flag: default-ON + kill-switch (=0 / off).
 *  - fail-soft: a throwing liveness probe ⇒ no crash; the combined writer on an empty home ⇒ no crash.
 *  - the throttle (shouldWriteConsole).
 *
 * Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/console-projection.selftest.mts
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consoleProjectionEnabled,
  shouldWriteConsole,
  buildDecisionMirror,
  buildRosterProjection,
  seatAliveOf,
  CONSOLE_DECISIONS_SCHEMA,
  CONSOLE_ROSTER_SCHEMA,
  type RosterSeat,
} from "./console-projection.js";
import {
  assembleRosterSeats,
  writeDecisionMirrors,
  writeRosterProjection,
  writeConsoleProjection,
  type RosterFacts,
} from "./console-projection-store.js";
import { openBatch, writeDecisions, consumeDecisions } from "./decision-batch-store.js";
import type { DecisionBatch } from "./decision-batch.js";
import type { RosterMember } from "./resume.js";
import type { Liveness } from "./task-liveness.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "console-proj-"));
const consoleDecisionsDir = (home: string) => path.join(home, ".agenthop", "swarm", "console", "decisions");
const rosterFile = (home: string) => path.join(home, ".agenthop", "swarm", "console", "roster.json");
const rosterSnap = (home: string) => path.join(home, ".agenthop", "swarm", "roster-snapshot.json");
const batchesStoreDir = (home: string) => path.join(home, ".agenthop", "console", "decision-batches");
// chmod-based fault injection is meaningless under root (root bypasses the permission bits) — skip those cases there.
const canTestPerms = (process.getuid?.() ?? 0) !== 0;

// =====================================================================================================================
// Flag: default-ON + kill-switch
// =====================================================================================================================
t("flag default-ON (unset)", consoleProjectionEnabled({} as NodeJS.ProcessEnv) === true);
t("flag default-ON (empty)", consoleProjectionEnabled({ SWARM_CONSOLE: "" } as NodeJS.ProcessEnv) === true);
t("flag ON for '1'", consoleProjectionEnabled({ SWARM_CONSOLE: "1" } as NodeJS.ProcessEnv) === true);
t("flag kill-switch '0'", consoleProjectionEnabled({ SWARM_CONSOLE: "0" } as NodeJS.ProcessEnv) === false);
t("flag kill-switch 'off'", consoleProjectionEnabled({ SWARM_CONSOLE: "off" } as NodeJS.ProcessEnv) === false);
t("flag kill-switch 'false'", consoleProjectionEnabled({ SWARM_CONSOLE: "FALSE" } as NodeJS.ProcessEnv) === false);

// =====================================================================================================================
// Throttle (shouldWriteConsole)
// =====================================================================================================================
t("throttle: elapsed >= interval ⇒ write", shouldWriteConsole(1000, 900, 60) === true);
t("throttle: not elapsed ⇒ skip", shouldWriteConsole(910, 900, 60) === false);
t("throttle: non-finite now ⇒ never", shouldWriteConsole(NaN, 0, 60) === false);
t("throttle: non-positive interval ⇒ every call", shouldWriteConsole(5, 5, 0) === true);

// =====================================================================================================================
// seatAliveOf — FC-2 r3 mapping (pure)
// =====================================================================================================================
t("seatAliveOf alive ⇒ alive", seatAliveOf("alive") === "alive");
t("seatAliveOf dead ⇒ dead", seatAliveOf("dead") === "dead");
t("seatAliveOf suspected ⇒ unknown (never false dead)", seatAliveOf("suspected") === "unknown");
t("seatAliveOf unexpected ⇒ unknown", seatAliveOf("garbage" as unknown as Liveness) === "unknown");

// =====================================================================================================================
// buildDecisionMirror — shape == decision-batch-v1 batch.json
// =====================================================================================================================
{
  const batch: DecisionBatch = {
    batchId: "batch-abc",
    owner: "coord-sid",
    createdAtSec: 123,
    items: [
      { id: "i1", kind: "merge", summary: "merge PR #1", suggestedAction: "approve", evidenceRef: "pr:1" },
      { id: "i2", kind: "spend", summary: "pay invoice", suggestedAction: "reject", hardGate: true },
    ],
  };
  const m = buildDecisionMirror(batch, 999);
  t("mirror schema", m.schema === CONSOLE_DECISIONS_SCHEMA);
  t("mirror generatedAtSec", m.generatedAtSec === 999);
  t("mirror batch.batchId", m.batch.batchId === "batch-abc");
  t("mirror batch.owner", m.batch.owner === "coord-sid");
  t("mirror batch.createdAtSec", m.batch.createdAtSec === 123);
  t("mirror item order + fields (v1)", m.batch.items.length === 2 && m.batch.items[0]!.id === "i1" && m.batch.items[0]!.evidenceRef === "pr:1" && m.batch.items[0]!.suggestedAction === "approve");
  t("mirror hardGate preserved", m.batch.items[1]!.hardGate === true);
  t("mirror omits evidenceRef when absent", m.batch.items[1]!.evidenceRef === undefined);
  // v1 batch.json top-level keys only (batchId/owner/createdAtSec/items) — no store-internal leaks.
  t("mirror batch has exactly v1 keys", JSON.stringify(Object.keys(m.batch).sort()) === JSON.stringify(["batchId", "createdAtSec", "items", "owner"]));
}

// =====================================================================================================================
// buildRosterProjection — dedupe + sort + normalize (pure)
// =====================================================================================================================
{
  const seats: RosterSeat[] = [
    { sid: "s-b", tool: "codex", pane: "Work-b", alive: "dead", inflight: 0 },
    { sid: "s-a", tool: "claude", pane: "Work-a", alive: "alive", inflight: 2 },
    { sid: "s-a", tool: "DUP", pane: "x", alive: "unknown", inflight: 9 }, // dupe ⇒ ignored (first wins)
    { sid: "", tool: "noid", pane: null, alive: "alive", inflight: 1 },     // no sid ⇒ dropped
    { sid: "s-c", tool: "opencode", pane: null, alive: "bogus" as unknown as RosterSeat["alive"], inflight: -5 }, // normalize
  ];
  const p = buildRosterProjection(seats, 42);
  t("roster schema", p.schema === CONSOLE_ROSTER_SCHEMA);
  t("roster generatedAtSec", p.generatedAtSec === 42);
  t("roster drops empty-sid + dedupes", p.seats.length === 3);
  t("roster sorted by sid", p.seats.map((s) => s.sid).join(",") === "s-a,s-b,s-c");
  t("roster dedupe keeps first", p.seats[0]!.tool === "claude" && p.seats[0]!.inflight === 2);
  t("roster normalize bad alive ⇒ unknown", p.seats[2]!.alive === "unknown");
  t("roster normalize negative inflight ⇒ 0", p.seats[2]!.inflight === 0);
}

// =====================================================================================================================
// assembleRosterSeats — derive {sid,tool,pane,alive,inflight} from roster+presence facts, incl. FC-2 r3 + fail-soft
// =====================================================================================================================
{
  const members: RosterMember[] = [
    { member: "sid-a", tool: "claude", cwd: "/w", role: null, title: "Work-a" },
    { member: "sid-b", tool: "codex", cwd: "/w", role: null, title: "Work-b" },
    { member: "sid-c", tool: "claude", cwd: "/w", role: null, title: "Work-c" }, // liveness probe THROWS ⇒ unknown
    { member: "sid-d", tool: "claude", cwd: "/w", role: null }, // no title ⇒ pane falls back to member id
  ];
  const facts: RosterFacts = {
    members,
    resolveSid: (id) => id,
    livenessOf: (sid) => {
      if (sid === "sid-a") return "alive";
      if (sid === "sid-b") return "dead";
      if (sid === "sid-c") throw new Error("boom: presence dir EACCES"); // FC-2 r3
      return "suspected"; // sid-d: absent/unreadable ⇒ unknown
    },
    inflightOf: (sid) => (sid === "sid-a" ? 3 : 0),
    paneOf: (m) => m.title ?? m.member ?? null,
  };
  const proj = buildRosterProjection(assembleRosterSeats(facts), 7);
  const bySid = Object.fromEntries(proj.seats.map((s) => [s.sid, s]));
  t("seat a alive + inflight + pane + tool", bySid["sid-a"]!.alive === "alive" && bySid["sid-a"]!.inflight === 3 && bySid["sid-a"]!.pane === "Work-a" && bySid["sid-a"]!.tool === "claude");
  t("seat b dead", bySid["sid-b"]!.alive === "dead" && bySid["sid-b"]!.inflight === 0);
  t("seat c THROWING probe ⇒ unknown (never false dead)", bySid["sid-c"]!.alive === "unknown");
  t("seat d suspected ⇒ unknown", bySid["sid-d"]!.alive === "unknown");
  t("seat d pane falls back to member id", bySid["sid-d"]!.pane === "sid-d");
}

// =====================================================================================================================
// IO ① — decisions mirror from a real store fixture (writeDecisionMirrors), excludes consumed + prunes
// =====================================================================================================================
{
  const home = tmpHome();
  const b1 = openBatch(home, { owner: "coord", items: [{ id: "x1", kind: "merge", summary: "s1", suggestedAction: "approve" }], nowSec: 100 });
  const b2 = openBatch(home, { owner: "coord", items: [{ id: "y1", kind: "signoff", summary: "s2", suggestedAction: "approve" }], nowSec: 101 });

  const r1 = writeDecisionMirrors(home, 500);
  t("IO①: both awaiting batches mirrored", r1.written.length === 2 && r1.written.includes(b1.batchId) && r1.written.includes(b2.batchId));
  const f1 = path.join(consoleDecisionsDir(home), `${b1.batchId}.json`);
  t("IO①: per-batch file exists keyed by id", existsSync(f1));
  const parsed = JSON.parse(readFileSync(f1, "utf8"));
  t("IO①: file is console-decisions/v1 with verbatim v1 batch", parsed.schema === CONSOLE_DECISIONS_SCHEMA && parsed.batch.batchId === b1.batchId && parsed.batch.items[0].id === "x1");

  // Consume b2 ⇒ it becomes terminal (consumed.json). Next write must EXCLUDE it and PRUNE its mirror file.
  writeDecisions(home, { batchId: b2.batchId, decidedAtSec: 200, decisions: [{ id: "y1", verdict: "approve" }] });
  const consumed = consumeDecisions(home, b2.batchId);
  t("IO①: fixture consume succeeded", consumed.consumed === true);
  const r2 = writeDecisionMirrors(home, 600);
  t("IO①: consumed batch excluded from mirror", r2.written.length === 1 && r2.written[0] === b1.batchId);
  t("IO①: consumed batch mirror file pruned", !existsSync(path.join(consoleDecisionsDir(home), `${b2.batchId}.json`)));
  t("IO①: awaiting batch mirror file kept", existsSync(f1));
  t("IO①: READ-ONLY (store dir untouched by prune)", existsSync(path.join(home, ".agenthop", "console", "decision-batches", b1.batchId, "batch.json")));
}

// =====================================================================================================================
// IO ② — roster.json from a real snapshot fixture (default facts), FC-2 r3 (no presence ⇒ unknown, not dead)
// =====================================================================================================================
{
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(
    path.join(home, ".agenthop", "swarm", "roster-snapshot.json"),
    JSON.stringify({ version: 2, capturedAtSec: 1, members: [
      { member: "sid-1", tool: "claude", cwd: "/w", role: null, title: "Work-1" },
      { member: "sid-2", tool: "codex", cwd: "/w", role: null, title: "Work-2" },
    ] }),
  );
  const proj = writeRosterProjection(home, 777);
  t("IO②: roster.json written", existsSync(rosterFile(home)));
  const onDisk = JSON.parse(readFileSync(rosterFile(home), "utf8"));
  t("IO②: schema + generatedAtSec", onDisk.schema === CONSOLE_ROSTER_SCHEMA && onDisk.generatedAtSec === 777);
  t("IO②: two seats sorted", onDisk.seats.length === 2 && onDisk.seats[0].sid === "sid-1");
  t("IO②: fields present", onDisk.seats[0].tool === "claude" && onDisk.seats[0].pane === "Work-1" && typeof onDisk.seats[0].inflight === "number");
  t("IO②: no presence pid ⇒ alive UNKNOWN (never false dead)", onDisk.seats.every((s: { alive: string }) => s.alive === "unknown"));
  t("IO②: inflight 0 with no control-log", onDisk.seats.every((s: { inflight: number }) => s.inflight === 0));
  t("IO②: proj return matches disk", proj !== null && proj.seats.length === onDisk.seats.length);
}

// =====================================================================================================================
// Fail-soft — a throwing liveness probe through the IO writer ⇒ no crash, seat is unknown
// =====================================================================================================================
{
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  const proj = writeRosterProjection(home, 1, {
    members: [{ member: "sid-x", tool: "claude", cwd: "/w", role: null, title: "px" }],
    livenessOf: () => { throw new Error("probe exploded"); },
  });
  t("fail-soft: throwing probe ⇒ seat unknown, no crash", proj !== null && proj.seats.length === 1 && proj.seats[0]!.alive === "unknown");
}

// =====================================================================================================================
// Fail-soft — combined writer on an empty home (no store, no snapshot) ⇒ no throw
// =====================================================================================================================
{
  const home = tmpHome();
  let threw = false;
  try { writeConsoleProjection(home, 1); } catch { threw = true; }
  t("fail-soft: combined writer on empty home does not throw", threw === false);
  t("fail-soft: empty home roster.json still written (0 seats)", existsSync(rosterFile(home)) && JSON.parse(readFileSync(rosterFile(home), "utf8")).seats.length === 0);
  t("fail-soft: empty home decisions dir created", existsSync(consoleDecisionsDir(home)) && readdirSync(consoleDecisionsDir(home)).filter((f) => f.endsWith(".json")).length === 0);
}

// =====================================================================================================================
// CP-1 (FC-2 r3) — read/enumerate UNCERTAINTY keeps old mirrors; only CONFIRMED terminal/vanished is pruned
// =====================================================================================================================
{
  const home = tmpHome();
  const b1 = openBatch(home, { owner: "coord", items: [{ id: "x1", kind: "merge", summary: "s", suggestedAction: "approve" }], nowSec: 100 });
  const b2 = openBatch(home, { owner: "coord", items: [{ id: "y1", kind: "merge", summary: "s", suggestedAction: "approve" }], nowSec: 101 });
  writeDecisionMirrors(home, 500);
  const f1 = path.join(consoleDecisionsDir(home), `${b1.batchId}.json`);
  const f2 = path.join(consoleDecisionsDir(home), `${b2.batchId}.json`);
  t("CP-1 setup: both mirrors written", existsSync(f1) && existsSync(f2));
  // CONFIRMED-vanished: remove b2's store dir ⇒ absent from a SUCCESSFUL enumeration ⇒ its mirror is pruned; b1 kept.
  rmSync(path.join(batchesStoreDir(home), b2.batchId), { recursive: true, force: true });
  const rv = writeDecisionMirrors(home, 510);
  t("CP-1: a CONFIRMED-vanished batch ⇒ mirror pruned", !existsSync(f2));
  t("CP-1: the still-awaiting batch ⇒ mirror kept + re-written", existsSync(f1) && rv.written.includes(b1.batchId));
  if (canTestPerms) {
    // GLOBAL enumerate fault: make the store batches dir unreadable ⇒ listBatchesStrict throws ⇒ SKIP (keep ALL mirrors).
    chmodSync(batchesStoreDir(home), 0o000);
    const rs = writeDecisionMirrors(home, 520);
    chmodSync(batchesStoreDir(home), 0o755); // restore so the batch stays readable (cleanup)
    t("CP-1: a GLOBAL enumerate fault ⇒ skipped, old mirror NOT pruned (never a false prune)", rs.skipped === true && existsSync(f1));
  }
}

// =====================================================================================================================
// CP-2 (FC-2 r3) — an UNREADABLE roster/control source SKIPS the publish (keeps last), never a fresh false-empty
// =====================================================================================================================
{
  // CONFIRMED-empty (swarm dir exists, snapshot ENOENT) ⇒ still publishes an empty roster — NOT a skip.
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  const p = writeRosterProjection(home, 1);
  t("CP-2: CONFIRMED-empty roster (ENOENT) ⇒ still publishes an empty roster (not a skip)", p !== null && p.seats.length === 0);
}
if (canTestPerms) {
  // (2a) roster snapshot readable ⇒ 1 seat; then UNREADABLE ⇒ skip (null), prior roster.json untouched.
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(rosterSnap(home), JSON.stringify({ version: 2, members: [{ member: "sid-1", tool: "claude", cwd: "/w", role: null, title: "W1" }] }));
  const first = writeRosterProjection(home, 100);
  t("CP-2 setup: readable roster ⇒ 1 seat", first !== null && first.seats.length === 1);
  const before = readFileSync(rosterFile(home), "utf8");
  chmodSync(rosterSnap(home), 0o000);
  const skipped = writeRosterProjection(home, 200);
  chmodSync(rosterSnap(home), 0o644);
  t("CP-2: UNREADABLE roster snapshot ⇒ publish SKIPPED (null)", skipped === null);
  t("CP-2: the last roster.json is untouched on skip (no false-empty overwrite)", readFileSync(rosterFile(home), "utf8") === before);

  // (2b) control-log present but UNREADABLE ⇒ skip (not a false zero-inflight).
  const home2 = tmpHome();
  mkdirSync(path.join(home2, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(rosterSnap(home2), JSON.stringify({ version: 2, members: [{ member: "sid-1", tool: "claude", cwd: "/w", role: null }] }));
  const cdir = path.join(home2, ".agenthop", "swarm", "control-log");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(path.join(cdir, "1.json"), JSON.stringify({ seq: 1, changes: [] }));
  t("CP-2 setup: readable control-log ⇒ written", writeRosterProjection(home2, 100) !== null);
  chmodSync(cdir, 0o000);
  const skipped2 = writeRosterProjection(home2, 200);
  chmodSync(cdir, 0o755);
  t("CP-2: UNREADABLE control-log ⇒ publish SKIPPED (null)", skipped2 === null);
}

// =====================================================================================================================
// CP-2 r2 — an UNRECOGNIZED roster SHAPE (not just torn JSON) is unknown ⇒ SKIP, never a false confirmed-empty
// =====================================================================================================================
{
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(rosterSnap(home), JSON.stringify({ version: 2, members: [{ member: "sid-1", tool: "claude", cwd: "/w", role: null, title: "W1" }] }));
  const first = writeRosterProjection(home, 100);
  t("CP-2 r2 setup: valid roster ⇒ 1 seat", first !== null && first.seats.length === 1);
  const before = readFileSync(rosterFile(home), "utf8");
  for (const [label, body] of [
    ["null", "null"],
    ["non-object number", "7"],
    ["{} (members absent)", "{}"],
    ["members:7 (non-array)", JSON.stringify({ members: 7 })],
    ["members:{} (non-array object)", JSON.stringify({ members: {} })],
  ] as const) {
    writeFileSync(rosterSnap(home), body);
    t(`CP-2 r2: unrecognized roster shape (${label}) ⇒ publish SKIPPED (null)`, writeRosterProjection(home, 200) === null);
  }
  t("CP-2 r2: the last roster.json is untouched across every bad shape (no false-empty overwrite)", readFileSync(rosterFile(home), "utf8") === before);
  // a STRUCTURALLY-VALID empty roster (members:[]) is a CONFIRMED empty ⇒ still publishes 0 seats.
  writeFileSync(rosterSnap(home), JSON.stringify({ version: 2, members: [] }));
  const empt = writeRosterProjection(home, 300);
  t("CP-2 r2: a valid empty roster (members:[]) ⇒ publishes 0 seats (confirmed empty, not a skip)", empt !== null && empt.seats.length === 0);
}

// =====================================================================================================================
// CP-2 r2 — a CONFIRMED-absent control-log (ENOENT) is empty (0 inflight), NOT a skip; the statSync errno-discrimination
// (not loadControlLog's existsSync, which folds an access fault to "absent") decides empty-vs-unknown.
// =====================================================================================================================
{
  const home = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(rosterSnap(home), JSON.stringify({ version: 2, members: [{ member: "sid-1", tool: "claude", cwd: "/w", role: null }] }));
  // no control-log dir at all (ENOENT) ⇒ confirmed no waits ⇒ publishes with inflight 0 (NOT a skip).
  const p = writeRosterProjection(home, 100);
  t("CP-2 r2: ENOENT control-log ⇒ publishes (confirmed empty), 1 seat inflight 0", p !== null && p.seats.length === 1 && p.seats[0]!.inflight === 0);
}

// =====================================================================================================================
// CP-3 — a pre-existing symlink on the output dir chain is REFUSED (no write/prune outside the console boundary)
// =====================================================================================================================
{
  // decisions/ is a symlink into a private dir with a victim file ⇒ writeDecisionMirrors refuses; the victim is untouched.
  const home = tmpHome();
  const evil = path.join(home, "evil"); mkdirSync(evil, { recursive: true });
  const victim = path.join(evil, "victim.json"); writeFileSync(victim, JSON.stringify({ sensitive: true }));
  mkdirSync(path.join(home, ".agenthop", "swarm", "console"), { recursive: true });
  symlinkSync(evil, path.join(home, ".agenthop", "swarm", "console", "decisions"));
  const rs = writeDecisionMirrors(home, 100);
  t("CP-3: decisions/ symlink ⇒ writeDecisionMirrors SKIPPED", rs.skipped === true);
  t("CP-3: the victim file OUTSIDE the boundary is untouched", existsSync(victim));

  // console/ itself is a symlink ⇒ writeRosterProjection refuses; nothing lands in the redirected dir.
  const home2 = tmpHome();
  const evil2 = path.join(home2, "evil2"); mkdirSync(evil2, { recursive: true });
  mkdirSync(path.join(home2, ".agenthop", "swarm"), { recursive: true });
  symlinkSync(evil2, path.join(home2, ".agenthop", "swarm", "console"));
  const rp = writeRosterProjection(home2, 100);
  t("CP-3: console/ symlink ⇒ writeRosterProjection SKIPPED (null)", rp === null);
  t("CP-3: nothing written into the redirected console dir", !existsSync(path.join(evil2, "roster.json")));
}

console.log("all console-projection selftests passed");
