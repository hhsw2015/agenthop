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
import { makeRepairWaitId, repairEpisodeOf } from "./repair-wait-id.js";

/** One incident episode (the durable record). Keyed in the registry by groupKey; lastObservedSeq lives HERE (not on the
 *  WaitRecord, which the pure layer owns and cannot carry incident fields). */
export type IncidentEpisode = {
  groupKey: string;
  category: string;       // "liveness" | "routing" | … — the incident family (so a consumer can filter/route by kind)
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

/** A category-tagged, kernel-agnostic incident signal — the generic input the episode lifecycle folds (liveness STALL/OK and
 *  routing dead-letter bursts both map to this). `active` = the incident condition holds now; `recovered` = it cleared; `none`
 *  = cannot tell (no-op). The repair-wait id is derived from the FULL incident identity (groupKey), so distinct incidents never
 *  share a repair-wait id (review 8ecf04d-P2-1 — a separate subjectKey could collide across groupKeys). subjectJobId is the
 *  repair-wait's WaitSubject.jobId (a synthetic domain id is fine when the incident has no real job, e.g. "swarm-routing"). */
export type IncidentSignal = {
  kind: "active" | "recovered" | "none";
  groupKey: string; category: string; why: string; lastObservedSeq: number; subjectJobId: string;
};

/** Pure generic core: fold ONE incident signal into the episode registry, emitting the repair-wait action (if any). IO (file +
 *  control-log commit) is the caller's; apply the action FIRST, then persist the returned registry, so the registry never claims
 *  an episode open before its repair-wait exists. `active` with no open episode ⇒ a NEW episode (number beyond the registry's
 *  last AND any CONTROL-committed one via controlEpisodeFloor, so a lost counter never reuses an id — review 19152aa-P1-3) +
 *  its repair-wait; `active` with an open episode ⇒ DEDUP (advance only lastObservedSeq, C3); `recovered` ⇒ close + resolve. */
export function reconcileIncidentCore(
  reg: IncidentRegistry, sig: IncidentSignal, nowSec: number,
  cfg: { repairWindowSec: number; owner: string; controlEpisodeFloor?: number },
): IncidentReconcile {
  const episodes = { ...reg.episodes };
  if (sig.kind === "active") {
    const existing = episodes[sig.groupKey];
    if (existing !== undefined && existing.open) {
      episodes[sig.groupKey] = { ...existing, lastObservedSeq: sig.lastObservedSeq, why: sig.why }; // dedup — same ongoing incident (C3)
      return { registry: { episodes } };
    }
    const episode = Math.max(existing?.episode ?? 0, cfg.controlEpisodeFloor ?? 0) + 1;
    const incidentId = `${sig.groupKey}:episode-${episode}`;
    const rwId = makeRepairWaitId(sig.groupKey, episode); // id from the FULL incident identity ⇒ collision-free across incidents (P2-1)
    episodes[sig.groupKey] = {
      groupKey: sig.groupKey, category: sig.category, episode, open: true, incidentId, why: sig.why,
      openedAtSec: nowSec, lastObservedSeq: sig.lastObservedSeq, repairWaitId: rwId,
    };
    return { registry: { episodes }, openRepairWait: { waitId: rwId, jobId: sig.subjectJobId, deadlineSec: nowSec + cfg.repairWindowSec, owner: cfg.owner, incidentId, why: sig.why } };
  }
  if (sig.kind === "recovered") {
    const existing = episodes[sig.groupKey];
    if (existing !== undefined && existing.open) {
      episodes[sig.groupKey] = { ...existing, open: false, closedAtSec: nowSec };
      return { registry: { episodes }, resolveRepairWait: { waitId: existing.repairWaitId, reason: `recovered: ${sig.why} (episode ${existing.episode})` } };
    }
  }
  return { registry: { episodes } }; // none / nothing-to-change
}

/** Liveness incident reconcile — maps the INV-1 verdict to a generic signal + folds it (category="liveness"). STALL ⇒ active;
 *  OK ⇒ recovered (a verified-live holder; the kernel's groupKey is `${jobId}:no-live-holder`); UNVERIFIABLE ⇒ no-op (cannot
 *  confirm, never "recovered"). The subject key/jobId is the job itself. Behavior is unchanged from before the generic extract. */
export function reconcileIncident(
  reg: IncidentRegistry, verdict: LivenessVerdict, nowSec: number,
  cfg: { repairWindowSec: number; owner: string; jobId: string; controlEpisodeFloor?: number },
): IncidentReconcile {
  const base = { category: "liveness", subjectJobId: cfg.jobId };
  if (verdict.verdict === "STALL")
    return reconcileIncidentCore(reg, { kind: "active", groupKey: verdict.groupKey, why: verdict.why, lastObservedSeq: verdict.lastObservedSeq, ...base }, nowSec, cfg);
  if (verdict.verdict === "OK")
    return reconcileIncidentCore(reg, { kind: "recovered", groupKey: `${cfg.jobId}:no-live-holder`, why: "live holder verified at seq-cut", lastObservedSeq: 0, ...base }, nowSec, cfg);
  return { registry: { episodes: { ...reg.episodes } } }; // UNVERIFIABLE — leave any open episode open
}

/** Reconcile the registry against CONTROL (the durable backstop) BEFORE folding the verdict — CONTROL's committed repair-wait
 *  facts win over a registry whose open/close write was lost (review 19152aa-P1-3). Both resolved-gap edges:
 *   - A: CONTROL has a LIVE (non-resolved) repair-wait the registry doesn't record as its open episode ⇒ ADOPT it (the open
 *     write was lost), so the next tick dedups into that live obligation rather than re-opening / resurrecting a resolved id.
 *   - B: the registry records an open episode but CONTROL has NO live repair-wait for it (resolved/absent) ⇒ the close write
 *     was lost; sync the episode CLOSED, so a fresh stall opens a NEW episode instead of dedup'ing into one with no live wait.
 *  Returns controlEpisodeFloor (max episode among this job's CONTROL repair-waits, resolved or not) so a newly opened episode
 *  never reuses an already-committed id. Pass ONLY this job's repair-waits. Pure; the caller supplies the CONTROL facts + persists. */
export function reconcileRegistryWithControl(
  reg: IncidentRegistry, groupKey: string, category: string,
  controlRepairWaits: ReadonlyArray<{ waitId: string; state: string }>, nowSec: number,
): { registry: IncidentRegistry; controlEpisodeFloor: number } {
  const episodes = { ...reg.episodes };
  const live = controlRepairWaits.find((w) => w.state !== "resolved");
  let floor = 0;
  for (const w of controlRepairWaits) { const n = repairEpisodeOf(w.waitId, groupKey); if (n !== null && n > floor) floor = n; }
  const ep = episodes[groupKey];
  if (live !== undefined) {
    const liveEp = repairEpisodeOf(live.waitId, groupKey);
    if (liveEp !== null && (ep === undefined || !ep.open || ep.repairWaitId !== live.waitId)) {
      episodes[groupKey] = { // adopt the committed live repair-wait as the open episode (its registry open-write was lost) — case A
        groupKey, category: ep?.category ?? category, episode: liveEp, open: true, incidentId: `${groupKey}:episode-${liveEp}`,
        why: ep?.why ?? "adopted from CONTROL live repair-wait", openedAtSec: ep?.openedAtSec ?? nowSec,
        lastObservedSeq: ep?.lastObservedSeq ?? 0, repairWaitId: live.waitId,
      };
    }
  } else if (ep !== undefined && ep.open) {
    episodes[groupKey] = { ...ep, open: false, closedAtSec: nowSec }; // CONTROL has no live wait (close-write lost) ⇒ sync closed — case B
  }
  const changed = JSON.stringify(episodes) !== JSON.stringify(reg.episodes);
  return { registry: changed ? { episodes } : reg, controlEpisodeFloor: floor };
}

/** Read the durable registry. A missing file ⇒ empty (first run). A corrupt/unreadable file THROWS — the caller is fail-soft
 *  (logs + skips this tick's reconcile), so a transient read error never silently resets the incident history to empty. */
export function readIncidents(file: string): IncidentRegistry {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry(); throw e; }
  const parsed = JSON.parse(raw) as IncidentRegistry;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.episodes !== "object" || parsed.episodes === null) throw new Error("incidents: malformed registry");
  // Migrate a pre-3a registry: episodes written before `category` existed were all liveness — backfill it so the new
  // read/dedup/backstop/write path never propagates a category-less record (review 8ecf04d-P2-2).
  for (const ep of Object.values(parsed.episodes)) if (ep !== null && typeof ep === "object" && (ep as IncidentEpisode).category === undefined) (ep as IncidentEpisode).category = "liveness";
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
