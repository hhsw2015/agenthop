import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcileIncident, reconcileIncidentCore, reconcileRegistryWithControl, readIncidents, writeIncidents, emptyRegistry, type IncidentRegistry, type IncidentSignal } from "../src/swarm/incident-episode.js";
import { makeRepairWaitId, isRepairWaitId } from "../src/swarm/repair-wait-id.js";
import type { LivenessVerdict } from "../src/swarm/task-liveness-inv1.js";

/** L1-tail (cluster-liveness §1): STALL ⇒ durable episode + repair-wait; same ongoing stall dedups (lastObservedSeq only);
 *  a verified-live OK closes the episode + resolves the repair-wait; a recurrence AFTER close opens episode+1 (C3). */

const GK = "job-x:no-live-holder";
const rwid = (n: number): string => makeRepairWaitId(GK, n); // liveness repair-wait id = derived from the groupKey (P2-1), not jobId
const stall = (lastObservedSeq: number, why = "every responsibility holder is down"): LivenessVerdict => ({ verdict: "STALL", why, groupKey: GK, lastObservedSeq });
const ok = (): LivenessVerdict => ({ verdict: "OK", coverage: { e: [], w: ["job-x/g"], r: [] } });
const unver = (): LivenessVerdict => ({ verdict: "UNVERIFIABLE", missing: ["sweep-heartbeat@x missing"] });
const cfg = { repairWindowSec: 1800, owner: "disp-1", jobId: "job-x" };

describe("reconcileIncident", () => {
  test("first STALL ⇒ a NEW episode (1) + one repair-wait + a durable open record (category=liveness)", () => {
    const r = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    expect(r.openRepairWait).toMatchObject({ waitId: rwid(1), jobId: "job-x", owner: "disp-1", deadlineSec: 1000 + 1800, incidentId: `${GK}:episode-1` });
    expect(r.resolveRepairWait).toBeUndefined();
    expect(r.registry.episodes[GK]).toMatchObject({ category: "liveness", episode: 1, open: true, incidentId: `${GK}:episode-1`, openedAtSec: 1000, lastObservedSeq: 50, repairWaitId: rwid(1) });
  });

  test("same ongoing STALL ⇒ DEDUP: lastObservedSeq advances, NO new episode, NO new repair-wait", () => {
    const first = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    const again = reconcileIncident(first.registry, stall(77), 1100, cfg);
    expect(again.openRepairWait).toBeUndefined();        // not a per-tick new incident
    expect(again.resolveRepairWait).toBeUndefined();
    expect(again.registry.episodes[GK]).toMatchObject({ episode: 1, open: true, lastObservedSeq: 77 }); // only the observation version moved
    expect(again.registry.episodes[GK]!.openedAtSec).toBe(1000); // identity (openedAt) unchanged
  });

  test("a verified-live OK after STALL ⇒ RECOVERY: episode closed + repair-wait resolved", () => {
    const first = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    const rec = reconcileIncident(first.registry, ok(), 1200, cfg);
    expect(rec.resolveRepairWait).toMatchObject({ waitId: rwid(1) });
    expect(rec.openRepairWait).toBeUndefined();
    expect(rec.registry.episodes[GK]).toMatchObject({ episode: 1, open: false, closedAtSec: 1200 });
  });

  test("UNVERIFIABLE is NOT recovery — an open episode stays open, no action, lastObservedSeq untouched", () => {
    const first = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    const u = reconcileIncident(first.registry, unver(), 1100, cfg);
    expect(u.openRepairWait).toBeUndefined();
    expect(u.resolveRepairWait).toBeUndefined();
    expect(u.registry.episodes[GK]).toMatchObject({ episode: 1, open: true, lastObservedSeq: 50 }); // unchanged (no guess)
  });

  test("a recurrence AFTER a close ⇒ a NEW episode (2), only after the prior episode was closed (C3)", () => {
    const first = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    const closed = reconcileIncident(first.registry, ok(), 1200, cfg);
    const recur = reconcileIncident(closed.registry, stall(90), 1300, cfg);
    expect(recur.openRepairWait).toMatchObject({ waitId: rwid(2), incidentId: `${GK}:episode-2` });
    expect(recur.registry.episodes[GK]).toMatchObject({ episode: 2, open: true, openedAtSec: 1300, lastObservedSeq: 90 });
  });

  test("OK / UNVERIFIABLE with no open episode ⇒ no-op (no spurious resolve)", () => {
    expect(reconcileIncident(emptyRegistry(), ok(), 1000, cfg)).toEqual({ registry: { episodes: {} } });
    expect(reconcileIncident(emptyRegistry(), unver(), 1000, cfg)).toEqual({ registry: { episodes: {} } });
  });

  test("P2-3: the repair-wait id is INJECTIVE in jobId — 'job:a' and 'job-a' do NOT collide to one wait", () => {
    const a = reconcileIncident(emptyRegistry(), { verdict: "STALL", why: "x", groupKey: "job:a:no-live-holder", lastObservedSeq: 1 }, 1000, { repairWindowSec: 1800, owner: "o", jobId: "job:a" });
    const b = reconcileIncident(emptyRegistry(), { verdict: "STALL", why: "x", groupKey: "job-a:no-live-holder", lastObservedSeq: 1 }, 1000, { repairWindowSec: 1800, owner: "o", jobId: "job-a" });
    expect(a.openRepairWait!.waitId).not.toBe(b.openRepairWait!.waitId);                 // distinct ids ⇒ no overwrite
    expect(a.openRepairWait!.waitId).toBe(makeRepairWaitId("job:a:no-live-holder", 1));  // id derived from the FULL groupKey
    expect(makeRepairWaitId("k", 1)).toBe("repair-k-ep1");                               // safe key = readable identity
    expect(isRepairWaitId("repair-k-ep1")).toBe(true);
    expect(isRepairWaitId("coord-x")).toBe(false);
  });

  test("19152aa-P1-3 floor: a new episode is bumped past any CONTROL-committed (even resolved) repair-wait id", () => {
    const r = reconcileIncident(emptyRegistry(), stall(50), 1000, { ...cfg, controlEpisodeFloor: 5 });
    expect(r.openRepairWait!.waitId).toBe(rwid(6)); // 5 (floor) + 1 — never reuses a committed id
    expect(r.registry.episodes[GK].episode).toBe(6);
  });
});

describe("reconcileIncidentCore — generic (category-tagged) incident lifecycle", () => {
  const routeCfg = { repairWindowSec: 300, owner: "claude:agenthop-fe0376cd" };
  const RGK = "routing:claude:A->codex:B";
  const rrwid = makeRepairWaitId(RGK, 1); // routing repair-wait id = derived from the full groupKey (P2-1, collision-free)
  const sig = (kind: IncidentSignal["kind"], lastObservedSeq = 0): IncidentSignal => ({ kind, groupKey: RGK, category: "routing", why: "3 dead-letters in 120s", lastObservedSeq, subjectJobId: "swarm-routing" });

  test("active ⇒ a new episode + repair-wait tagged with the category; a synthetic subjectJobId is used; id from groupKey", () => {
    const r = reconcileIncidentCore(emptyRegistry(), sig("active", 5), 2000, routeCfg);
    expect(r.registry.episodes[RGK]).toMatchObject({ category: "routing", episode: 1, open: true });
    expect(r.openRepairWait).toMatchObject({ waitId: rrwid, jobId: "swarm-routing", owner: "claude:agenthop-fe0376cd", deadlineSec: 2300 });
  });

  test("active again ⇒ dedup (lastObservedSeq only); recovered ⇒ close + resolve; none ⇒ no-op", () => {
    const first = reconcileIncidentCore(emptyRegistry(), sig("active", 5), 2000, routeCfg);
    const again = reconcileIncidentCore(first.registry, sig("active", 9), 2100, routeCfg);
    expect(again.openRepairWait).toBeUndefined();
    expect(again.registry.episodes[RGK]).toMatchObject({ episode: 1, open: true, lastObservedSeq: 9 });
    const rec = reconcileIncidentCore(again.registry, sig("recovered"), 2200, routeCfg);
    expect(rec.resolveRepairWait).toMatchObject({ waitId: rrwid });
    expect(rec.registry.episodes[RGK]).toMatchObject({ open: false, closedAtSec: 2200 });
    expect(reconcileIncidentCore(rec.registry, sig("none"), 2300, routeCfg).openRepairWait).toBeUndefined();
  });

  test("P2-1: two DIFFERENT groupKeys never share a repair-wait id (id is from the full identity)", () => {
    const a = reconcileIncidentCore(emptyRegistry(), { kind: "active", groupKey: "routing:X", category: "routing", why: "w", lastObservedSeq: 1, subjectJobId: "swarm-routing" }, 2000, routeCfg);
    const b = reconcileIncidentCore(emptyRegistry(), { kind: "active", groupKey: "liveness:X", category: "liveness", why: "w", lastObservedSeq: 1, subjectJobId: "swarm-routing" }, 2000, routeCfg);
    expect(a.openRepairWait!.waitId).not.toBe(b.openRepairWait!.waitId); // same subjectJobId, different groupKey ⇒ distinct ids
  });
});

describe("reconcileRegistryWithControl — durable-backstop reconciliation (19152aa-P1-3)", () => {
  const rw = (ep: number, state: string) => ({ waitId: rwid(ep), state });

  test("case A: a LIVE CONTROL repair-wait the registry lost is ADOPTED (open-write gap) ⇒ next STALL dedups, no duplicate", () => {
    const sync = reconcileRegistryWithControl(emptyRegistry(), "job-x:no-live-holder", "liveness", [rw(1, "open")], 1000);
    expect(sync.controlEpisodeFloor).toBe(1);
    expect(sync.registry.episodes[GK]).toMatchObject({ episode: 1, open: true, repairWaitId: rwid(1) });
    const r = reconcileIncident(sync.registry, stall(60), 1100, { ...cfg, controlEpisodeFloor: sync.controlEpisodeFloor });
    expect(r.openRepairWait).toBeUndefined();                               // dedup into the adopted live wait — no second wait
    expect(r.registry.episodes[GK]).toMatchObject({ episode: 1, open: true, lastObservedSeq: 60 });
  });

  test("case B: registry OPEN but CONTROL wait RESOLVED (close-write gap) ⇒ sync closes it; a recurrence opens a FRESH episode", () => {
    const reg1 = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg).registry; // registry: ep1 open
    const sync = reconcileRegistryWithControl(reg1, "job-x:no-live-holder", "liveness", [rw(1, "resolved")], 1200);
    expect(sync.registry.episodes[GK]).toMatchObject({ episode: 1, open: false, closedAtSec: 1200 }); // synced closed
    const recur = reconcileIncident(sync.registry, stall(90), 1300, { ...cfg, controlEpisodeFloor: sync.controlEpisodeFloor });
    expect(recur.openRepairWait!.waitId).toBe(rwid(2)); // a NEW armed repair-wait, not a dedup into stale-open ep1
  });

  test("6b766e3-P2-1: group-scoped — a SIBLING group's live/resolved wait (same list) doesn't hijack adopt or block close", () => {
    const aLive = { waitId: makeRepairWaitId("routing:A", 1), state: "open" };       // a different group's wait, ordered FIRST
    const bLive = { waitId: makeRepairWaitId("routing:B", 1), state: "open" };
    // adopt: registry lost B, CONTROL has A-live (first) + B-live ⇒ must adopt B's wait, not be hijacked by A
    const adopt = reconcileRegistryWithControl(emptyRegistry(), "routing:B", "routing", [aLive, bLive], 3000);
    expect(adopt.registry.episodes["routing:B"]).toMatchObject({ episode: 1, open: true, repairWaitId: makeRepairWaitId("routing:B", 1) });
    expect(adopt.controlEpisodeFloor).toBe(1); // floor from B's waits only
    // close: registry has B open, CONTROL has A-live (first) + B-RESOLVED ⇒ must sync-close B (A-live must not block it)
    const regBopen = reconcileIncidentCore(emptyRegistry(), { kind: "active", groupKey: "routing:B", category: "routing", why: "w", lastObservedSeq: 1, subjectJobId: "swarm-routing" }, 2900, { repairWindowSec: 300, owner: "o" }).registry;
    const close = reconcileRegistryWithControl(regBopen, "routing:B", "routing", [aLive, { waitId: makeRepairWaitId("routing:B", 1), state: "resolved" }], 3100);
    expect(close.registry.episodes["routing:B"]).toMatchObject({ open: false, closedAtSec: 3100 });
  });

  test("no divergence ⇒ registry returned unchanged (identity), floor reflects CONTROL", () => {
    const reg1 = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg).registry;
    const sync = reconcileRegistryWithControl(reg1, "job-x:no-live-holder", "liveness", [rw(1, "open")], 1200); // CONTROL live ep1 matches registry open ep1
    expect(sync.registry).toBe(reg1);          // unchanged (same reference)
    expect(sync.controlEpisodeFloor).toBe(1);
  });
});

describe("readIncidents / writeIncidents", () => {
  test("round-trips atomically; a missing file ⇒ empty registry; a corrupt file throws (never silent reset)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inc-"));
    const file = path.join(dir, "incidents.json");
    expect(readIncidents(file)).toEqual({ episodes: {} }); // ENOENT ⇒ empty
    const reg: IncidentRegistry = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg).registry;
    writeIncidents(file, reg);
    expect(existsSync(file)).toBe(true);
    expect(readIncidents(file)).toEqual(reg);
    expect(JSON.parse(readFileSync(file, "utf8")).episodes[GK].incidentId).toBe(`${GK}:episode-1`);
    writeFileSync(file, "{ not json");
    expect(() => readIncidents(file)).toThrow(); // corrupt ⇒ throw, not a silent empty reset
  });

  test("P2-2: a pre-3a registry (episodes without `category`) is migrated on read — category backfilled to 'liveness'", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inc-mig-"));
    const file = path.join(dir, "incidents.json");
    // an episode shaped like the pre-generalization format (no `category` field)
    writeFileSync(file, JSON.stringify({ episodes: { [GK]: { groupKey: GK, episode: 3, open: true, incidentId: `${GK}:episode-3`, why: "old", openedAtSec: 1, lastObservedSeq: 9, repairWaitId: rwid(3) } } }));
    const reg = readIncidents(file);
    expect(reg.episodes[GK]!.category).toBe("liveness"); // backfilled — the new path never propagates a category-less record
    expect(reg.episodes[GK]!.episode).toBe(3);           // other fields intact
  });
});
