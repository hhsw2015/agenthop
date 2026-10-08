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

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { listBatches, readBatch, readDecisions } from "./decision-batch-store.js";
import { resolveBatch, validDecisionsDoc, type DecisionsDoc } from "./decision-batch.js";
import { computeDualBandwidth, type DualBandwidthReading, type DualBandwidthConfig } from "./dual-bandwidth.js";

function batchesDir(home: string): string { return path.join(home, ".agenthop", "console", "decision-batches"); }
function consumedPath(home: string, id: string): string { return path.join(batchesDir(home), id, "consumed.json"); }
function claimPath(home: string, id: string): string { return path.join(batchesDir(home), id, "decisions-consumed-claim.json"); }
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

export type BandwidthEvents = { produceAtSec: number[]; consumeAtSec: number[]; backlog: number };

/** Scan the decision-batch directory into the pure core's inputs. Read-only; a per-batch corrupt/absent file is skipped, not fatal. */
export function collectBandwidthEvents(home: string): BandwidthEvents {
  const produceAtSec: number[] = [];
  const consumeAtSec: number[] = [];
  let backlog = 0;
  for (const id of listBatches(home)) {
    const batch = readBatch(home, id); // dir-bound; a foreign/garbled batch.json reads as null
    if (!batch) continue;
    for (let i = 0; i < batch.items.length; i += 1) produceAtSec.push(batch.createdAtSec); // one produce event per pending item, at open time
    const consumed = readJsonOrNull(consumedPath(home, id)) as { consumedAtMs?: unknown } | null;
    if (consumed && typeof consumed.consumedAtMs === "number" && Number.isFinite(consumed.consumedAtMs)) {
      // CONSUMED: each decision in the claim doc is a consume event at the consume time.
      const claim = validDecisionsDoc(readJsonOrNull(claimPath(home, id)));
      const n = claim && claim.batchId === id ? claim.decisions.length : 0;
      const atSec = consumed.consumedAtMs / 1000; // consumedAtMs is epoch MS; the pure core is in seconds
      for (let i = 0; i < n; i += 1) consumeAtSec.push(atSec);
    } else {
      // NOT consumed: its undecided items are current backlog (read-only; never calls the mutating consumeDecisions).
      const doc: DecisionsDoc = readDecisions(home, id) ?? { batchId: id, decidedAtSec: 0, decisions: [] };
      backlog += resolveBatch(batch, doc).undecided.length;
    }
  }
  return { produceAtSec, consumeAtSec, backlog };
}

/** Compute the current gauge reading from on-disk decision-batch state. Deterministic in `nowSec`. */
export function computeGauge(home: string, nowSec: number, config?: DualBandwidthConfig): DualBandwidthReading {
  const { produceAtSec, consumeAtSec, backlog } = collectBandwidthEvents(home);
  return computeDualBandwidth({ nowSec, produceAtSec, consumeAtSec, backlog, config });
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

/** Read the current projection (console/tests). ENOENT ⇒ null; other read errors propagate; a corrupt file ⇒ null. */
export function readBandwidthProjection(home: string): BandwidthProjection | null {
  const raw = readJsonOrNull(gaugePath(home));
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return r.schema === "bandwidth-gauge/v1" ? (raw as BandwidthProjection) : null;
}
