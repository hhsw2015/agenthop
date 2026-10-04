import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcileIncident, readIncidents, writeIncidents, emptyRegistry, type IncidentRegistry } from "../src/swarm/incident-episode.js";
import type { LivenessVerdict } from "../src/swarm/task-liveness-inv1.js";

/** L1-tail (cluster-liveness §1): STALL ⇒ durable episode + repair-wait; same ongoing stall dedups (lastObservedSeq only);
 *  a verified-live OK closes the episode + resolves the repair-wait; a recurrence AFTER close opens episode+1 (C3). */

const GK = "job-x:no-live-holder";
const stall = (lastObservedSeq: number, why = "every responsibility holder is down"): LivenessVerdict => ({ verdict: "STALL", why, groupKey: GK, lastObservedSeq });
const ok = (): LivenessVerdict => ({ verdict: "OK", coverage: { e: [], w: ["job-x/g"], r: [] } });
const unver = (): LivenessVerdict => ({ verdict: "UNVERIFIABLE", missing: ["sweep-heartbeat@x missing"] });
const cfg = { repairWindowSec: 1800, owner: "disp-1", jobId: "job-x" };

describe("reconcileIncident", () => {
  test("first STALL ⇒ a NEW episode (1) + one repair-wait + a durable open record", () => {
    const r = reconcileIncident(emptyRegistry(), stall(50), 1000, cfg);
    expect(r.openRepairWait).toMatchObject({ waitId: "repair-job-x-ep1", jobId: "job-x", owner: "disp-1", deadlineSec: 1000 + 1800, incidentId: `${GK}:episode-1` });
    expect(r.resolveRepairWait).toBeUndefined();
    expect(r.registry.episodes[GK]).toMatchObject({ episode: 1, open: true, incidentId: `${GK}:episode-1`, openedAtSec: 1000, lastObservedSeq: 50, repairWaitId: "repair-job-x-ep1" });
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
    expect(rec.resolveRepairWait).toMatchObject({ waitId: "repair-job-x-ep1" });
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
    expect(recur.openRepairWait).toMatchObject({ waitId: "repair-job-x-ep2", incidentId: `${GK}:episode-2` });
    expect(recur.registry.episodes[GK]).toMatchObject({ episode: 2, open: true, openedAtSec: 1300, lastObservedSeq: 90 });
  });

  test("OK / UNVERIFIABLE with no open episode ⇒ no-op (no spurious resolve)", () => {
    expect(reconcileIncident(emptyRegistry(), ok(), 1000, cfg)).toEqual({ registry: { episodes: {} } });
    expect(reconcileIncident(emptyRegistry(), unver(), 1000, cfg)).toEqual({ registry: { episodes: {} } });
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
});
