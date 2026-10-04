/**
 * Incident-episode registry (cluster-liveness L1-tail, design §1 "STALL ⇒ 写耐久事故记录 + 开 repair-wait"). The IO half of
 * the STALL disposition: a PURE reconcile over a durable episode registry (this module) + the control-log repair-wait + the
 * verdict's incidentId (the kernel builds it from the episode WE assign, C3). Kept out of the pure control-log layer — the
 * registry is an IO-owned file (like heartbeat.json / projection), NOT a new control-log entity type (that is f32a0507's).
 *
 * C3 incident identity = (affected subject + failure category + EPISODE), seq-INDEPENDENT. The kernel emits a stable groupKey
 * (subject + category); THIS layer owns the episode:
 *  - a STALL with no OPEN episode for its groupKey ⇒ a NEW episode (episode = prev + 1), one durable incident record + one
 *    repair-wait. Re-detecting the SAME ongoing stall is a dedup no-op that only advances lastObservedSeq (never a per-tick
 *    new incident — seq is an observation version, not an identity).
 *  - recovery EVIDENCE (a verified-live OK) closes the open episode + resolves its repair-wait. Only AFTER a close may a
 *    recurrence open a new episode (episode + 1). UNVERIFIABLE is NOT recovery — it leaves the episode open (no guess).
 *  - the repair-wait's existence never impersonates the gap being resolved; it is the supervised "someone must fix this"
 *    obligation the sweep then escalates.
 */

import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { LivenessVerdict } from "./task-liveness-inv1.js";

/** One incident episode (the durable record). Keyed in the registry by groupKey; lastObservedSeq lives HERE (not on the
 *  WaitRecord, which the pure layer owns and cannot carry incident fields). */
export type IncidentEpisode = {
  groupKey: string;
  episode: number;        // 1-based; monotonic per groupKey (a recurrence after close is episode+1)
  open: boolean;          // true = unresolved; false = recovered/closed (a new recurrence may then open episode+1)
  incidentId: string;     // `${groupKey}:episode-${episode}` — the full C3 identity
  why: string;
  openedAtSec: number;
  lastObservedSeq: number; // the control-cut seq this episode was last observed at (dedup updates this, not identity)
  repairWaitId: string;
  closedAtSec?: number;
};

export type IncidentRegistry = { episodes: Record<string, IncidentEpisode> }; // keyed by groupKey
export const emptyRegistry = (): IncidentRegistry => ({ episodes: {} });

/** A repair-wait to OPEN in the control-log (a normal supervised WaitRecord the sweep escalates). */
export type RepairWaitSpec = { waitId: string; jobId: string; deadlineSec: number; owner: string; incidentId: string; why: string };

export type IncidentReconcile = {
  registry: IncidentRegistry;                                   // the next registry (write it only after the action commits)
  openRepairWait?: RepairWaitSpec;                              // a NEW episode just opened — open this repair-wait
  resolveRepairWait?: { waitId: string; reason: string };      // a recovery closed an episode — resolve this repair-wait
};

/** A repair-wait id is a flat, path-safe, collision-free token (the projection filename encoder is lossless, but a dash form
 *  keeps the id readable and free of the groupKey's ':'). Non-[A-Za-z0-9._-] ⇒ '-'. */
const safeToken = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-");

/** Pure: fold THIS tick's verdict into the episode registry, emitting the repair-wait action (if any). IO (file + control-log
 *  commit) is the caller's; apply the action FIRST, then persist the returned registry, so the registry never claims an
 *  episode open before its repair-wait exists. The kernel ONLY emits groupKey `${jobId}:no-live-holder` (one category), so
 *  recovery is matched on that groupKey; this stays correct if the kernel later adds categories keyed by the same subject. */
export function reconcileIncident(
  reg: IncidentRegistry, verdict: LivenessVerdict, nowSec: number,
  cfg: { repairWindowSec: number; owner: string; jobId: string },
): IncidentReconcile {
  const episodes = { ...reg.episodes };

  if (verdict.verdict === "STALL") {
    const existing = episodes[verdict.groupKey];
    if (existing !== undefined && existing.open) {
      // dedup: the SAME ongoing stall — advance only the observation version, never a new incident/wait/episode (C3).
      episodes[verdict.groupKey] = { ...existing, lastObservedSeq: verdict.lastObservedSeq, why: verdict.why };
      return { registry: { episodes } };
    }
    // a new episode: first detection, OR a recurrence AFTER the prior episode was closed (episode = prev + 1).
    const episode = (existing?.episode ?? 0) + 1;
    const incidentId = `${verdict.groupKey}:episode-${episode}`;
    const repairWaitId = `repair-${safeToken(cfg.jobId)}-ep${episode}`;
    episodes[verdict.groupKey] = {
      groupKey: verdict.groupKey, episode, open: true, incidentId, why: verdict.why,
      openedAtSec: nowSec, lastObservedSeq: verdict.lastObservedSeq, repairWaitId,
    };
    return {
      registry: { episodes },
      openRepairWait: { waitId: repairWaitId, jobId: cfg.jobId, deadlineSec: nowSec + cfg.repairWindowSec, owner: cfg.owner, incidentId, why: verdict.why },
    };
  }

  if (verdict.verdict === "OK") {
    // recovery evidence (a verified-live holder, INV-1 satisfied) closes the open episode + resolves its repair-wait. Only
    // an OK closes — UNVERIFIABLE is "cannot confirm", never "recovered". The kernel's groupKey for this job:
    const gk = `${cfg.jobId}:no-live-holder`;
    const existing = episodes[gk];
    if (existing !== undefined && existing.open) {
      episodes[gk] = { ...existing, open: false, closedAtSec: nowSec };
      return { registry: { episodes }, resolveRepairWait: { waitId: existing.repairWaitId, reason: `recovered: live holder verified at seq-cut (episode ${existing.episode})` } };
    }
  }

  // UNVERIFIABLE (no recovery evidence — leave any open episode open), or OK/STALL with nothing to change.
  return { registry: { episodes } };
}

/** Read the durable registry. A missing file ⇒ empty (first run). A corrupt/unreadable file THROWS — the caller is fail-soft
 *  (logs + skips this tick's reconcile), so a transient read error never silently resets the incident history to empty. */
export function readIncidents(file: string): IncidentRegistry {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry(); throw e; }
  const parsed = JSON.parse(raw) as IncidentRegistry;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.episodes !== "object" || parsed.episodes === null) throw new Error("incidents: malformed registry");
  return parsed;
}

/** Write the registry atomically (unique temp + exclusive create + rename, mirroring the projection writer's symlink-safe
 *  temp). The caller persists this AFTER the repair-wait action commits, so the registry never leads its control-log state. */
export function writeIncidents(file: string, reg: IncidentRegistry): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o644, flag: "wx" });
  renameSync(tmp, file);
}
