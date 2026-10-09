/**
 * Dual-bandwidth gauge IO layer (T5-2). Reads the swarm's EXISTING durable artifacts — no new hot-path write, no new transport —
 * aggregates them into two timestamp streams + the current backlog, feeds the pure core (dual-bandwidth.ts), and writes a small
 * frozen-schema projection the console (3e097dfe) renders. READ-ONLY on every source: it only reads event timestamps, never
 * mutates a batch (in particular it NEVER calls the mutating consumeDecisions — backlog is derived read-only via resolveBatch).
 *
 * Source (coordinator ruling (3) — decision-batch is the canonical in/out event and the SOLE source of B_cons):
 *   - B_prod: each decision-batch ITEM is a produce event at its batch's createdAtSec. decision-batch items ARE the pending
 *     呈批件 / 并库候选 / 签收确认 / 立项请求 (see decision-batch.ts) already compressed into batches, so counting items is the
 *     canonical, non-double-counting produce measure.
 *   - B_cons: each decision in a CONSUMED batch's claim doc is a consume event at consumed.json's consumedAtMs. Only real
 *     decisions (approve/reject/defer) — chat-room sign-offs are communication, never counted (ruling (3)).
 *   - backlog D: the undecided items of every not-yet-consumed batch (read-only resolveBatch(batch, decisions)).
 *
 * Secondary produce sources (chat-room / inbox raw 呈批/立项 before compression) are NOT wired in v0: a RoomPost is plain text
 * and an InboxMsg has no 呈批/立项 `via` convention, so there is no reliable marker to extract them without a new tagging scheme,
 * and they would double-count the decision-batch items they are later folded into. Left as a documented seam (see the T5-2 contract).
 *
 * ENOENT = absent (skip); any other read error (EACCES/…) PROPAGATES — a read fault is never silently treated as "no events".
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readBatch, readDecisions } from "./decision-batch-store.js";
import { resolveBatch, validDecisionsDoc, type DecisionsDoc } from "./decision-batch.js";
import { computeDualBandwidth, mergeProduceEvents, submitDigest, type DualBandwidthReading, type DualBandwidthConfig } from "./dual-bandwidth.js";
import { listRooms, readPosts } from "./chat-room-store.js";
import { digestOf } from "./digest.js";
import { validInboxMsg } from "../inbox.js";

function batchesDir(home: string): string { return path.join(home, ".agenthop", "console", "decision-batches"); }
function batchJsonPath(home: string, id: string): string { return path.join(batchesDir(home), id, "batch.json"); }
function consumedPath(home: string, id: string): string { return path.join(batchesDir(home), id, "consumed.json"); }
function claimPath(home: string, id: string): string { return path.join(batchesDir(home), id, "decisions-consumed-claim.json"); }
function rejectedClaimPath(home: string, id: string): string { return path.join(batchesDir(home), id, "decisions-rejected-claim.json"); }
function gaugeDir(home: string): string { return path.join(home, ".agenthop", "console", "bandwidth-gauge"); }
function gaugePath(home: string): string { return path.join(gaugeDir(home), "gauge.json"); }

/** Read+parse JSON, distinguishing ENOENT (absent ⇒ null) from any other read error (EACCES/… ⇒ throw). A readable-but-corrupt
 *  file parses to null (the caller skips it — never crashes the whole gauge on one bad file). */
function readJsonOrNull(file: string): unknown {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try { return JSON.parse(raw); } catch { return null; }
}

export type BandwidthEvents = { produceAtSec: number[]; consumeAtSec: number[]; backlog: number; backlogProduceAtSec: number[] };

/** STRICT enumeration of batch ids (T52-P2-1): unlike the lenient listBatches, an access fault (EACCES) on the batches dir or a
 *  sub-dir's batch.json PROPAGATES — it is never folded to "no batches", which would overwrite a RED projection with a false
 *  GREEN. ENOENT (no batches dir yet, or a dir with no batch.json) is a genuine absence and is skipped. */
function listBatchIdsStrict(home: string): string[] {
  let entries;
  try { entries = readdirSync(batchesDir(home), { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const ids: string[] = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    try { statSync(batchJsonPath(home, d.name)); ids.push(d.name); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; } // a sub-dir access fault must NOT silently vanish
  }
  return ids;
}

/** A terminal `consumed.json` only proves THIS batch consumed when it is BOUND to it (batchId === id) and carries a finite
 *  consumedAtMs (T52-P2-2: a wrong-batch receipt proves nothing). */
function boundConsumedAtMs(raw: unknown, id: string): number | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.batchId !== id) return null;
  return typeof r.consumedAtMs === "number" && Number.isFinite(r.consumedAtMs) ? r.consumedAtMs : null;
}

/** A DecisionsDoc at `file` that is valid AND bound to this batch (batchId === id), else null. */
function readBoundDoc(file: string, id: string): DecisionsDoc | null {
  const doc = validDecisionsDoc(readJsonOrNull(file));
  return doc && doc.batchId === id ? doc : null;
}

function inboxRoot(home: string): string { return path.join(home, ".agenthop", "inbox"); }

/** submit-tag dormant gate (SWARM_SUBMIT_TAG, default OFF, dormant-ahead-of-use like SWARM_BOARD_ADMIT). OFF ⇒
 *  collectBandwidthEvents keeps the v0 decision-batch-only behavior byte-for-byte; ON ⇒ the tagged-submit secondary source +
 *  foldedFrom de-dup activate. */
export function submitTagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_SUBMIT_TAG ?? "");
}

/** Scan the swarm's durable append-logs for tagged `submit` posts/messages → de-dup-keyed produce events (submitDigest, atSec).
 *  Chat-room logs are append-only (a reliable early signal); inbox messages are ephemeral (a best-effort early signal — once a
 *  submit is folded into a batch the item's foldedFrom carries the durable count, so nothing is lost after a claim). READ-ONLY.
 *  A corrupt line/file is skipped; an inbox dir ACCESS fault PROPAGATES (same design law as the decision-batch scan — a read
 *  fault is never a silent "no events" that could under-count produce into a false green). `ts` is epoch-ms (÷1000 → seconds). */
function scanSubmits(home: string): { digest: string; atSec: number }[] {
  const out: { digest: string; atSec: number }[] = [];
  for (const roomId of listRooms(home)) {
    for (const post of readPosts(home, roomId)) {
      if (post.intent === "submit") out.push({ digest: submitDigest(post.from, post.text), atSec: post.ts / 1000 }); // ST-P2-3: keep fractional seconds (no floor) so window attribution matches (now-windowSec, now+skew]
    }
  }
  let boxes;
  try { boxes = readdirSync(inboxRoot(home), { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return out; throw e; }
  for (const box of boxes) {
    if (!box.isDirectory()) continue;
    const dir = path.join(inboxRoot(home), box.name);
    let files: string[];
    try { files = readdirSync(dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; } // a box that vanished mid-scan
    for (const f of files) {
      if (!f.endsWith(".json")) continue; // final envelopes only; skip .tmp/.claim-* + the quarantine/ sub-dir
      const msg = validInboxMsg(readJsonOrNull(path.join(dir, f)));
      if (msg && msg.intent === "submit") out.push({ digest: submitDigest(msg.from, msg.text), atSec: msg.ts / 1000 }); // ST-P2-3: keep fractional seconds (no floor)
    }
  }
  return out;
}

/** Scan the decision-batch directory into the pure core's inputs. READ-ONLY (never the mutating consumeDecisions); a per-batch
 *  corrupt/foreign file is skipped, but an ACCESS fault propagates (via listBatchIdsStrict / readBatch / readJsonOrNull). When
 *  SWARM_SUBMIT_TAG is on, B_prod additionally folds in tagged chat-room/inbox submits, de-duped against the decision-batch
 *  items they are compressed into (foldedFrom), each logical submission counted once (B_prod=N). */
export function collectBandwidthEvents(home: string): BandwidthEvents {
  const produceAtSec: number[] = [];
  const consumeAtSec: number[] = [];
  // B6-2: the produce stream for dD/dt, ALWAYS in DECISION-ITEM units (one event per batch item at open) regardless of
  // SWARM_SUBMIT_TAG — so the backlog derivative stays consume/backlog-consistent even when produceAtSec is submission-unit.
  const backlogProduceAtSec: number[] = [];
  let backlog = 0;
  const submitTag = submitTagEnabled();
  const batchItemsForMerge: { digest: string; createdAtSec: number; foldedFrom: readonly string[] }[] = [];
  for (const id of listBatchIdsStrict(home)) {
    const batch = readBatch(home, id); // dir-bound; a foreign/garbled batch.json reads as null (throws on an access fault)
    if (!batch) continue;
    for (let i = 0; i < batch.items.length; i += 1) backlogProduceAtSec.push(batch.createdAtSec); // item-unit, for dD/dt (B6-2)
    if (submitTag) {
      // defer produce to the merge (de-dup): a per-item stable digest (never collides with a submitDigest — different key shape).
      for (const it of batch.items) batchItemsForMerge.push({ digest: digestOf({ batchId: id, itemId: it.id }), createdAtSec: batch.createdAtSec, foldedFrom: it.foldedFrom ?? [] });
    } else {
      for (let i = 0; i < batch.items.length; i += 1) produceAtSec.push(batch.createdAtSec); // v0: one produce event per pending item, at open time
    }
    const consumedAtMs = boundConsumedAtMs(readJsonOrNull(consumedPath(home, id)), id);
    if (consumedAtMs !== null) {
      // CONSUMED (bound terminal): count ONLY decisions that MATCH this batch's items (T52-P2-2) — resolved excludes unknownIds and
      // a wrong-batch claim; approve/reject/defer all count (ruling (3), defer is a real decision). One consume event per match.
      const claim = readBoundDoc(claimPath(home, id), id);
      const matched = claim ? resolveBatch(batch, claim).resolved.length : 0;
      const atSec = consumedAtMs / 1000; // consumedAtMs is epoch MS; the pure core is in seconds
      for (let i = 0; i < matched; i += 1) consumeAtSec.push(atSec);
    } else {
      // NOT consumed: backlog = undecided under the FRESHEST valid verdicts (T52-P2-3) — decisions.json wins, else an in-flight
      // consumed-claim (a consume that claimed but faulted before committing), else a recoverable rejected-claim. Read-only; the
      // priority of a fresh decisions.json is preserved, and a claimed-but-uncommitted verdict is NOT re-counted as backlog.
      const doc: DecisionsDoc =
        readDecisions(home, id) ??
        readBoundDoc(claimPath(home, id), id) ??
        readBoundDoc(rejectedClaimPath(home, id), id) ??
        { batchId: id, decidedAtSec: 0, decisions: [] };
      backlog += resolveBatch(batch, doc).undecided.length;
    }
  }
  if (submitTag) {
    // merge tagged submits with the batch items (de-dup by digest, B_prod=N): a folded submit and the item it was folded into
    // count once; a native item counts as its own digest; an un-folded submit counts at its post time (the early signal).
    const merged = mergeProduceEvents({ batchItems: batchItemsForMerge, submits: scanSubmits(home) });
    for (const atSec of merged) produceAtSec.push(atSec);
  }
  return { produceAtSec, consumeAtSec, backlog, backlogProduceAtSec };
}

/** Compute the current gauge reading from on-disk decision-batch state. Deterministic in `nowSec`. */
export function computeGauge(home: string, nowSec: number, config?: DualBandwidthConfig): DualBandwidthReading {
  const { produceAtSec, consumeAtSec, backlog, backlogProduceAtSec } = collectBandwidthEvents(home);
  return computeDualBandwidth({ nowSec, produceAtSec, consumeAtSec, backlog, backlogProduceAtSec, config });
}

/** The frozen projection schema the console reads (viz frozen-read-contract pattern). Null ratio/drainHours = undefined (no
 *  consumption), never a non-serializable Infinity. */
export type BandwidthProjection = {
  schema: "bandwidth-gauge/v1";
  generatedAtSec: number;
  prod: { ratePerHour: number; sessionTotal: number };
  cons: { ratePerHour: number; sessionTotal: number };
  ratio: number | null;
  backlog: number;
  backlogGrowthPerHour: number;
  drainHours: number | null;
  zone: DualBandwidthReading["zone"];
  windowSec: number;
  thresholds: { amberRatio: number; redRatio: number; backlogSoftCap: number; backlogHardCap: number; tDrainHorizonHours: number };
};

const PROJECTION_DEFAULTS = { windowSec: 3600, amberRatio: 0.8, redRatio: 1.2, backlogSoftCap: 20, backlogHardCap: 50, tDrainHorizonHours: 8 };

function projectionOf(reading: DualBandwidthReading, nowSec: number, config?: DualBandwidthConfig): BandwidthProjection {
  const cfg = { ...PROJECTION_DEFAULTS, ...config };
  return {
    schema: "bandwidth-gauge/v1",
    generatedAtSec: nowSec,
    prod: { ratePerHour: reading.bProd1h, sessionTotal: reading.bProdTotal },
    cons: { ratePerHour: reading.bCons1h, sessionTotal: reading.bConsTotal },
    ratio: reading.ratio,
    backlog: reading.backlog,
    backlogGrowthPerHour: reading.dBacklogDtPerHour,
    drainHours: reading.tDrainHours,
    zone: reading.zone,
    windowSec: cfg.windowSec,
    thresholds: { amberRatio: cfg.amberRatio, redRatio: cfg.redRatio, backlogSoftCap: cfg.backlogSoftCap, backlogHardCap: cfg.backlogHardCap, tDrainHorizonHours: cfg.tDrainHorizonHours },
  };
}

/** Compute the gauge and write the projection atomically (temp + rename) so the console never reads a half-written file.
 *  Returns the reading. */
export function writeBandwidthProjection(home: string, nowSec: number, config?: DualBandwidthConfig): DualBandwidthReading {
  const reading = computeGauge(home, nowSec, config);
  const projection = projectionOf(reading, nowSec, config);
  mkdirSync(gaugeDir(home), { recursive: true, mode: 0o700 });
  const file = gaugePath(home);
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(projection), { mode: 0o600 });
  renameSync(tmp, file);
  return reading;
}

/** Read the current projection (console/tests). ENOENT ⇒ null; other read errors propagate; a corrupt / structurally-or-numerically
 *  INVALID file ⇒ null (T52-P2-5: the schema string alone is not enough — required fields must exist and be finite; ratio/drainHours
 *  may be null but never NaN/Infinity; zone must be a known value). */
export function readBandwidthProjection(home: string): BandwidthProjection | null {
  const raw = readJsonOrNull(gaugePath(home));
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== "bandwidth-gauge/v1") return null;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const pair = (v: unknown): boolean => v !== null && typeof v === "object" && num((v as Record<string, unknown>).ratePerHour) && num((v as Record<string, unknown>).sessionTotal);
  const nullable = (v: unknown): boolean => v === null || num(v);
  if (!num(r.generatedAtSec) || !pair(r.prod) || !pair(r.cons)) return null;
  if (!nullable(r.ratio) || !num(r.backlog) || !num(r.backlogGrowthPerHour) || !nullable(r.drainHours)) return null;
  if (!num(r.windowSec) || (r.zone !== "green" && r.zone !== "amber" && r.zone !== "red")) return null;
  // thresholds is REQUIRED and must carry all five finite numeric fields (T52-P2-5 A) — not merely be present.
  const th = r.thresholds;
  if (th === null || typeof th !== "object") return null;
  const t = th as Record<string, unknown>;
  if (!num(t.amberRatio) || !num(t.redRatio) || !num(t.backlogSoftCap) || !num(t.backlogHardCap) || !num(t.tDrainHorizonHours)) return null;
  return raw as BandwidthProjection;
}
