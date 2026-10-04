/**
 * Durable-state observer (cluster-liveness L2-struct, design §2b-c / §2c + the coordinator's watch-list expansion, user+F25).
 * The one place that turns "a durable surface changed but nobody was told" into a pushed event — F22/F25 same-family root-fix.
 * It watches:
 *   1. completion-slot locators (§2c): for each PRODUCTION-phase delegation, poll its locator; a discovered artifact becomes a
 *      Candidate the caller verifies via observeCandidate (independent of the producer messaging anyone — the F22 root-fix).
 *   2. the work board ~/.agenthop/swarm/board/ (.claimed./.done. renames) + PROGRESS.md (mtime): a change is itself an event —
 *      pushed to the coordinator inbox immediately, not left for the next patrol tick.
 *
 * Pure here (scan/diff over injected reads); the IO (fs scan + hashing + the wait commits + the coordinator inbox write) is the
 * dispatcher wiring. The snapshot is an IO-owned file, so events fire only on CHANGE (not every tick).
 */

import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DelegationRegistry, Candidate, CompletionRecord } from "./delegation-envelope.js";

/** What the IO reader returns for a locator that currently holds an artifact: its content digest + the completion record the
 *  artifact self-declares (§2b). null = nothing there yet. The reader (fs + hash + parse) is the dispatcher's; injected for tests. */
export type ArtifactRead = { observedDigest: string; record: CompletionRecord } | null;
export type ReadArtifact = (locator: string) => ArtifactRead;

/** Scan every PRODUCTION-phase delegation's completion-slot locator; emit a Candidate for each locator that currently holds an
 *  artifact. The caller verifies each via observeCandidate (locator + targetDigest + record identity) before closing anything. */
export function scanCompletionSlots(reg: DelegationRegistry, read: ReadArtifact): Candidate[] {
  const out: Candidate[] = [];
  for (const env of Object.values(reg.envelopes)) {
    if (env.phase !== "production") continue;
    const a = read(env.completionSlot.locator);
    if (a === null) continue;
    out.push({ observedLocator: env.completionSlot.locator, observedDigest: a.observedDigest, record: a.record });
  }
  return out;
}

/** Parse a completion-record artifact (v1 lightweight adapter, §2c). The record DECLARES its WORK TARGET (the commit/spec it
 *  produced); observedDigest = that declared workTarget, in the SAME domain as the completion-slot's targetDigest — a file-content
 *  hash is NOT the work target and never equals a commit SHA (review f0a999f-P1-1: comparing domains ⇒ a legit result never
 *  verifies). NULL-SAFE: a null / non-object / field-incomplete record ⇒ null, never a throw (review f0a999f-P2-1: one bad
 *  artifact must not abort the scan or the board watch). v1's target fact is the record's self-declared workTarget; INDEPENDENT
 *  resolution (git rev-parse) + content integrity are the deferred real-adapter acceptance (documented, not faked). */
export function parseCompletionArtifact(raw: string): ArtifactRead {
  let rec: unknown;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (rec === null || typeof rec !== "object") return null;
  const r = rec as { requestId?: unknown; payloadDigest?: unknown; workTarget?: unknown; subject?: unknown };
  if (typeof r.requestId !== "string" || typeof r.payloadDigest !== "string" || typeof r.workTarget !== "string") return null;
  if (r.subject === null || typeof r.subject !== "object") return null;
  const s = r.subject as { jobId?: unknown; revision?: unknown };
  if (typeof s.jobId !== "string") return null;
  return { observedDigest: r.workTarget, record: { requestId: r.requestId, payloadDigest: r.payloadDigest, subject: { jobId: s.jobId, ...(typeof s.revision === "number" ? { revision: s.revision } : {}) } } };
}

/** A board-file name parses to {item, state, who}. Convention: `<item>.<state>.<who>.json` (state ∈ claimed/done) or
 *  `<item>.json` (posted/unclaimed). Items are kebab-case (no dots); the LAST two dot-segments are state+who. */
export function parseBoardFile(file: string): { item: string; state: string; who: string } | null {
  if (!file.endsWith(".json")) return null;
  const name = file.slice(0, -".json".length);
  const segs = name.split(".");
  if (segs.length === 1) return { item: segs[0]!, state: "posted", who: "" };
  if (segs.length >= 3) return { item: segs.slice(0, segs.length - 2).join("."), state: segs[segs.length - 2]!, who: segs[segs.length - 1]! };
  return { item: segs[0]!, state: segs[1]!, who: "" }; // 2 segments: <item>.<state>
}

/** The watched durable surfaces at one instant: the set of board file names + PROGRESS.md's mtime. */
export type WatchSnapshot = { boardFiles: string[]; progressMtimeMs: number };
export const emptyWatchSnapshot = (): WatchSnapshot => ({ boardFiles: [], progressMtimeMs: 0 });

export type WatchEvent =
  | { kind: "board"; file: string; item: string; state: string; who: string }
  | { kind: "progress"; mtimeMs: number };

/** Diff two snapshots into events. A board file PRESENT in curr but not prev is a change (a rename lands as a new name — the new
 *  name carries the new state, so one event per newly-seen file suffices; a vanished old name needs no separate event). A changed
 *  PROGRESS mtime is one event. Pure; the caller pushes each event to the coordinator inbox and persists curr. */
export function detectWatchEvents(prev: WatchSnapshot, curr: WatchSnapshot): WatchEvent[] {
  const events: WatchEvent[] = [];
  const prevSet = new Set(prev.boardFiles);
  for (const f of curr.boardFiles) {
    if (prevSet.has(f)) continue;
    const p = parseBoardFile(f);
    if (p !== null) events.push({ kind: "board", file: f, item: p.item, state: p.state, who: p.who });
  }
  if (curr.progressMtimeMs !== prev.progressMtimeMs && prev.progressMtimeMs !== 0) events.push({ kind: "progress", mtimeMs: curr.progressMtimeMs });
  return events;
}

/** Read the durable snapshot. Missing ⇒ empty (first run); corrupt ⇒ THROWS (caller is fail-soft + skips — a transient read
 *  error must not reset the snapshot to empty and re-fire every board file as "new"). */
export function readWatchSnapshot(file: string): WatchSnapshot {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyWatchSnapshot(); throw e; }
  const parsed = JSON.parse(raw) as WatchSnapshot;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.boardFiles) || typeof parsed.progressMtimeMs !== "number") throw new Error("watch snapshot: malformed");
  return parsed;
}

/** Write the snapshot atomically (unique temp + exclusive create + rename). Persist AFTER the events are pushed, so a push
 *  failure re-fires next tick rather than being dropped. */
export function writeWatchSnapshot(file: string, snap: WatchSnapshot): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o644, flag: "wx" });
  renameSync(tmp, file);
}
