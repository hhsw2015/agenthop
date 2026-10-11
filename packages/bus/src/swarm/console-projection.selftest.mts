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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
  t("IO②: proj return matches disk", proj.seats.length === onDisk.seats.length);
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
  t("fail-soft: throwing probe ⇒ seat unknown, no crash", proj.seats.length === 1 && proj.seats[0]!.alive === "unknown");
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

console.log("all console-projection selftests passed");
