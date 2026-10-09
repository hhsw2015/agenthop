import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBatch, writeDecisions, consumeDecisions } from "../src/swarm/decision-batch-store.js";
import { type DecisionItem } from "../src/swarm/decision-batch.js";
import { collectBandwidthEvents, computeGauge, writeBandwidthProjection, readBandwidthProjection, submitTagEnabled, gaugeSamplingEnabled, shouldSampleGauge } from "../src/swarm/dual-bandwidth-store.js";
import { openRoom, appendPost, postToRoom } from "../src/swarm/chat-room-store.js";
import { writeInbox, composeInboxMsg } from "../src/inbox.js";
import { submitDigest } from "../src/swarm/dual-bandwidth.js";

const homes: string[] = [];
const mkHome = (): string => { const h = mkdtempSync(path.join(tmpdir(), "dbw-")); homes.push(h); return h; };
afterEach(() => { while (homes.length) { try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } } });

const items = (n: number): DecisionItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `it${i}`, kind: "pr", summary: `s${i}`, suggestedAction: "merge" }));
const nowSec = () => Math.floor(Date.now() / 1000);
const batchesDir = (h: string) => path.join(h, ".agenthop", "console", "decision-batches");

describe("dual-bandwidth IO store", () => {
  test("empty home ⇒ zero events, zero backlog, green", () => {
    const h = mkHome();
    expect(collectBandwidthEvents(h)).toEqual({ produceAtSec: [], consumeAtSec: [], backlog: 0, backlogProduceAtSec: [] });
    expect(computeGauge(h, nowSec()).zone).toBe("green");
  });

  test("open batch (not consumed): each item is a produce event; undecided items are backlog; zero consume", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { owner: "coord", items: items(3), nowSec: t });
    const ev = collectBandwidthEvents(h);
    expect(ev.produceAtSec).toEqual([t, t, t]); // 3 items at the batch's createdAtSec
    expect(ev.consumeAtSec).toEqual([]);
    expect(ev.backlog).toBe(3); // all 3 undecided
    expect(computeGauge(h, t).zone).toBe("red"); // producing with zero consumption
  });

  test("consumed batch: each claim decision is a consume event at consume time; backlog clears", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(2), nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [{ id: "it0", verdict: "approve" }, { id: "it1", verdict: "reject" }] });
    const res = consumeDecisions(h, "b1");
    expect(res.consumed).toBe(true);
    const ev = collectBandwidthEvents(h);
    expect(ev.produceAtSec.length).toBe(2);
    expect(ev.consumeAtSec.length).toBe(2); // 2 decisions consumed
    expect(ev.backlog).toBe(0); // consumed ⇒ no backlog
    const g = computeGauge(h, nowSec());
    expect(g.ratio).toBe(1);
    expect(g.zone).toBe("amber"); // r = 1.0 ∈ (0.8, 1.2]
  });

  test("defer counts as a real decision (consume), per ruling (3)", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(1), nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [{ id: "it0", verdict: "defer" }] });
    consumeDecisions(h, "b1");
    expect(collectBandwidthEvents(h).consumeAtSec.length).toBe(1);
  });

  test("partially-decided open batch: only undecided items count as backlog", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(3), nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [{ id: "it0", verdict: "approve" }] }); // decided 1, NOT consumed
    const ev = collectBandwidthEvents(h);
    expect(ev.produceAtSec.length).toBe(3);
    expect(ev.consumeAtSec.length).toBe(0); // not consumed yet
    expect(ev.backlog).toBe(2); // it1, it2 still undecided
  });

  test("multiple batches aggregate; a mix of consumed + open", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "open1", owner: "coord", items: items(2), nowSec: t });
    openBatch(h, { batchId: "done1", owner: "coord", items: items(3), nowSec: t });
    writeDecisions(h, { batchId: "done1", decidedAtSec: t, decisions: items(3).map((it) => ({ id: it.id, verdict: "approve" as const })) });
    consumeDecisions(h, "done1");
    const ev = collectBandwidthEvents(h);
    expect(ev.produceAtSec.length).toBe(5); // 2 + 3
    expect(ev.consumeAtSec.length).toBe(3); // done1's 3 decisions
    expect(ev.backlog).toBe(2); // open1's 2 undecided
  });

  test("corrupt batch.json is skipped, never fatal", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "good", owner: "coord", items: items(1), nowSec: t });
    const bad = path.join(batchesDir(h), "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "batch.json"), "{ not json");
    const ev = collectBandwidthEvents(h); // must not throw
    expect(ev.produceAtSec.length).toBe(1); // only the good batch
  });

  test("foreign batch.json (batchId != dir) reads as absent (dir-bound), contributes nothing", () => {
    const h = mkHome();
    const dir = path.join(batchesDir(h), "realdir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "batch.json"), JSON.stringify({ batchId: "OTHER", owner: "coord", createdAtSec: nowSec(), items: items(2) }));
    expect(collectBandwidthEvents(h)).toEqual({ produceAtSec: [], consumeAtSec: [], backlog: 0, backlogProduceAtSec: [] });
  });

  test("projection write is atomic, frozen-schema, and round-trips", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(4), nowSec: t });
    const reading = writeBandwidthProjection(h, t);
    const proj = readBandwidthProjection(h);
    expect(proj).not.toBeNull();
    expect(proj!.schema).toBe("bandwidth-gauge/v1");
    expect(proj!.generatedAtSec).toBe(t);
    expect(proj!.prod.sessionTotal).toBe(4);
    expect(proj!.zone).toBe(reading.zone);
    // no leftover temp files, projection lands under bandwidth-gauge/
    const gaugeDir = path.join(h, ".agenthop", "console", "bandwidth-gauge");
    expect(readdirSync(gaugeDir)).toEqual(["gauge.json"]);
    // JSON is serializable (null, never Infinity, for undefined ratio/drain)
    const parsed = JSON.parse(readFileSync(path.join(gaugeDir, "gauge.json"), "utf8"));
    expect(parsed.ratio).toBeNull(); // no consumption yet
  });

  test("read projection: absent ⇒ null; wrong schema ⇒ null", () => {
    const h = mkHome();
    expect(readBandwidthProjection(h)).toBeNull();
    const gaugeDir = path.join(h, ".agenthop", "console", "bandwidth-gauge");
    mkdirSync(gaugeDir, { recursive: true });
    writeFileSync(path.join(gaugeDir, "gauge.json"), JSON.stringify({ schema: "other" }));
    expect(readBandwidthProjection(h)).toBeNull();
  });

  test("T52-P2-1: a batches-dir access fault propagates (never a false-green all-zero)", () => {
    if (process.getuid && process.getuid() === 0) return; // chmod EACCES injection is a no-op for root
    const h = mkHome();
    openBatch(h, { owner: "coord", items: items(1), nowSec: nowSec() });
    const bdir = batchesDir(h);
    chmodSync(bdir, 0o000);
    try { expect(() => collectBandwidthEvents(h)).toThrow(); } // must NOT swallow EACCES and return all-zero
    finally { chmodSync(bdir, 0o755); }
  });

  test("T52-P2-2: consume counts ONLY decisions matching this batch; unknown ids excluded", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(1), nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [
      { id: "it0", verdict: "approve" }, { id: "ghost1", verdict: "approve" }, { id: "ghost2", verdict: "reject" }, { id: "ghost3", verdict: "defer" },
    ] });
    consumeDecisions(h, "b1");
    expect(collectBandwidthEvents(h).consumeAtSec.length).toBe(1); // only it0 matched; the 3 ghosts are not B_cons
  });

  test("T52-P2-2: a wrong-batch consumed.json does not prove this batch consumed", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(2), nowSec: t });
    writeFileSync(path.join(batchesDir(h), "b1", "consumed.json"), JSON.stringify({ batchId: "OTHER", decidedAtSec: t, consumedAtMs: Date.now(), digest: "x" }));
    const ev = collectBandwidthEvents(h);
    expect(ev.consumeAtSec.length).toBe(0); // foreign receipt ignored
    expect(ev.backlog).toBe(2); // treated as NOT consumed ⇒ its items are backlog
  });

  test("T52-P2-3: a claimed-but-uncommitted verdict is not re-counted as backlog", () => {
    const h = mkHome();
    const t = nowSec();
    openBatch(h, { batchId: "b1", owner: "coord", items: items(3), nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [{ id: "it0", verdict: "approve" }] }); // 1 decided (slot 0) ⇒ backlog 2
    // a decided-but-NOT-consumed batch (a slot published, no consumed.json): the decided item must not count as backlog.
    const ev = collectBandwidthEvents(h);
    expect(ev.consumeAtSec.length).toBe(0); // no consumed.json ⇒ not consumed
    expect(ev.backlog).toBe(2); // it1, it2 undecided; the decided it0 is recognized via readDecisions(slots)
  });

  test("T52-P2-5: reader rejects same-schema objects that are structurally or numerically invalid", () => {
    const h = mkHome();
    const gaugeDir = path.join(h, ".agenthop", "console", "bandwidth-gauge");
    mkdirSync(gaugeDir, { recursive: true });
    const thresholds = { amberRatio: 0.8, redRatio: 1.2, backlogSoftCap: 20, backlogHardCap: 50, tDrainHorizonHours: 8 };
    const full = { schema: "bandwidth-gauge/v1", generatedAtSec: 1, prod: { ratePerHour: 1, sessionTotal: 1 }, cons: { ratePerHour: 1, sessionTotal: 1 }, ratio: null, backlog: 0, backlogGrowthPerHour: 0, drainHours: null, zone: "green", windowSec: 3600, thresholds };
    const w = (o: unknown) => writeFileSync(path.join(gaugeDir, "gauge.json"), JSON.stringify(o));
    w(full); expect(readBandwidthProjection(h)).not.toBeNull(); // the valid baseline
    w({ ...full, cons: undefined }); expect(readBandwidthProjection(h)).toBeNull(); // missing required pair
    w({ ...full, zone: "purple" }); expect(readBandwidthProjection(h)).toBeNull(); // bad zone
    w({ ...full, prod: { ratePerHour: null, sessionTotal: 1 } }); expect(readBandwidthProjection(h)).toBeNull(); // non-finite rate (a serialized NaN)
    w({ ...full, backlog: "x" }); expect(readBandwidthProjection(h)).toBeNull(); // wrong type
  });

  test("T52-P2-5 A: thresholds is required and all five fields must be finite numbers", () => {
    const h = mkHome();
    const gaugeDir = path.join(h, ".agenthop", "console", "bandwidth-gauge");
    mkdirSync(gaugeDir, { recursive: true });
    const thresholds = { amberRatio: 0.8, redRatio: 1.2, backlogSoftCap: 20, backlogHardCap: 50, tDrainHorizonHours: 8 };
    const full = { schema: "bandwidth-gauge/v1", generatedAtSec: 1, prod: { ratePerHour: 1, sessionTotal: 1 }, cons: { ratePerHour: 1, sessionTotal: 1 }, ratio: null, backlog: 0, backlogGrowthPerHour: 0, drainHours: null, zone: "green", windowSec: 3600, thresholds };
    const w = (o: unknown) => writeFileSync(path.join(gaugeDir, "gauge.json"), JSON.stringify(o));
    w({ ...full, thresholds: undefined }); expect(readBandwidthProjection(h)).toBeNull(); // missing entirely
    w({ ...full, thresholds: null }); expect(readBandwidthProjection(h)).toBeNull();
    w({ ...full, thresholds: {} }); expect(readBandwidthProjection(h)).toBeNull(); // empty object
    w({ ...full, thresholds: "x" }); expect(readBandwidthProjection(h)).toBeNull(); // wrong type
    w({ ...full, thresholds: { ...thresholds, tDrainHorizonHours: undefined } }); expect(readBandwidthProjection(h)).toBeNull(); // one field missing
    w({ ...full, thresholds: { ...thresholds, redRatio: "1.2" } }); expect(readBandwidthProjection(h)).toBeNull(); // numeric string, not a number
  });
});

describe("dual-bandwidth IO store — submit-tag secondary source (SWARM_SUBMIT_TAG)", () => {
  const withTag = (on: boolean, fn: () => void): void => {
    const prev = process.env.SWARM_SUBMIT_TAG;
    process.env.SWARM_SUBMIT_TAG = on ? "1" : "";
    try { fn(); } finally { if (prev === undefined) delete process.env.SWARM_SUBMIT_TAG; else process.env.SWARM_SUBMIT_TAG = prev; }
  };

  test("default OFF: tagged submits are IGNORED (v0 decision-batch-only behavior unchanged)", () => {
    const h = mkHome(); const t = nowSec();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", nowSec: t });
    appendPost(h, "r1", { from: "alice", fromLabel: "alice", text: "呈批 ship", intent: "submit" }, t);
    openBatch(h, { batchId: "b1", owner: "coord", items: items(2), nowSec: t });
    expect(submitTagEnabled({})).toBe(false);
    withTag(false, () => { expect(collectBandwidthEvents(h).produceAtSec.length).toBe(2); }); // only the 2 batch items
  });

  test("ON: a chat-room `submit` post is a produce event; report/fyi/untagged are ignored", () => {
    const h = mkHome(); const t = nowSec();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", nowSec: t });
    appendPost(h, "r1", { from: "a", fromLabel: "a", text: "呈批 1", intent: "submit" }, t);
    appendPost(h, "r1", { from: "a", fromLabel: "a", text: "fyi note", intent: "fyi" }, t);
    appendPost(h, "r1", { from: "a", fromLabel: "a", text: "status", intent: "report" }, t);
    appendPost(h, "r1", { from: "a", fromLabel: "a", text: "chatter" }, t); // untagged
    withTag(true, () => { expect(collectBandwidthEvents(h).produceAtSec.length).toBe(1); });
  });

  test("ON: an inbox `submit` message is counted; fyi ignored", () => {
    const h = mkHome(); const t = nowSec();
    const box = "01a0ff49-7a50-7393-9737-2402e68e4649";
    writeInbox(h, box, composeInboxMsg({ from: "a", fromLabel: "a", text: "呈批 via inbox", ts: t * 1000, intent: "submit" }));
    writeInbox(h, box, composeInboxMsg({ from: "a", fromLabel: "a", text: "just fyi", ts: t * 1000, intent: "fyi" }));
    withTag(true, () => { expect(collectBandwidthEvents(h).produceAtSec.length).toBe(1); });
  });

  test("ON: a submit folded into a batch item counts ONCE (de-dup); a native item still counts", () => {
    const h = mkHome(); const t = nowSec();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", nowSec: t });
    appendPost(h, "r1", { from: "alice", fromLabel: "alice", text: "ship it", intent: "submit" }, t);
    const d = submitDigest("alice", "ship it");
    openBatch(h, { batchId: "b1", owner: "coord", items: [
      { id: "A", kind: "pr", summary: "folded", suggestedAction: "merge", foldedFrom: [d] },
      { id: "B", kind: "pr", summary: "native", suggestedAction: "merge" },
    ], nowSec: t });
    // submit(alice/"ship it") === item A's fold ⇒ once; item B native ⇒ once ⇒ 2 total (NOT 3 — no double-count)
    withTag(true, () => { expect(collectBandwidthEvents(h).produceAtSec.length).toBe(2); });
  });

  test("ST-P2-1: chat-room fan-out preserves intent; the post + its inbox copies count ONCE (same digest)", () => {
    const h = mkHome(); const t = nowSec();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", roster: ["coord", "alice", "bob"], nowSec: t });
    const res = postToRoom(h, "r1", { from: "alice", fromLabel: "alice", text: "呈批 ship", intent: "submit" }, t);
    if (!("post" in res)) throw new Error("unexpected throttle (no limiter supplied)");
    expect(res.post.intent).toBe("submit");
    const bobBox = path.join(h, ".agenthop", "inbox", "bob");
    const copy = JSON.parse(readFileSync(path.join(bobBox, readdirSync(bobBox).filter((f) => f.endsWith(".json"))[0]!), "utf8"));
    expect(copy.intent).toBe("submit"); // fan-out carried intent (was dropped before the fix)
    expect(copy.from).toBe("alice"); expect(copy.text).toBe("呈批 ship"); // same from/text ⇒ same submitDigest
    // room post + coord's copy + bob's copy all share (from,text,ts) ⇒ ONE produce
    withTag(true, () => { expect(collectBandwidthEvents(h).produceAtSec.length).toBe(1); });
  });

  test("ST-P2-3: a fractional-ms submit keeps window attribution (floor would drop a just-inside submit)", () => {
    const h = mkHome();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", nowSec: 1 });
    // 100500ms = 100.5s. At now=3700,windowSec=3600,skew=0 the window is (100,3700]: 100.5 is IN, but floor(100.5)=100 is OUT.
    appendPost(h, "r1", { from: "a", fromLabel: "a", text: "near-lower", ts: 100500, intent: "submit" }, 1);
    withTag(true, () => { expect(computeGauge(h, 3700, { windowSec: 3600, skewToleranceSec: 0 }).bProd1h).toBe(1); });
  });

  test("ON: an inbox access fault during the submit scan propagates (never a silent under-count)", () => {
    if (process.getuid && process.getuid() === 0) return;
    const h = mkHome();
    const box = path.join(h, ".agenthop", "inbox", "01a0ff49-7a50-7393-9737-2402e68e4649");
    mkdirSync(box, { recursive: true });
    writeFileSync(path.join(box, "x.json"), "{}");
    chmodSync(box, 0o000);
    try { withTag(true, () => { expect(() => collectBandwidthEvents(h)).toThrow(); }); }
    finally { chmodSync(box, 0o755); }
  });

  test("B6-2: 5 submits folded into 1 approved item ⇒ backlogGrowth 0 (item-unit), B_prod=5 (submission-unit)", () => {
    const h = mkHome(); const t = nowSec();
    openRoom(h, { roomId: "r1", topic: "x", owner: "coord", nowSec: t });
    const digests: string[] = [];
    for (let i = 0; i < 5; i += 1) { const text = `ship ${i}`; appendPost(h, "r1", { from: "alice", fromLabel: "alice", text, intent: "submit" }, t); digests.push(submitDigest("alice", text)); }
    openBatch(h, { batchId: "b1", owner: "coord", items: [{ id: "A", kind: "pr", summary: "folded", suggestedAction: "merge", foldedFrom: digests }], nowSec: t });
    writeDecisions(h, { batchId: "b1", decidedAtSec: t, decisions: [{ id: "A", verdict: "approve" }] });
    expect(consumeDecisions(h, "b1").consumed).toBe(true);
    withTag(true, () => {
      const ev = collectBandwidthEvents(h);
      expect(ev.backlogProduceAtSec.length).toBe(1); // ONE decision item (item-unit, the dD/dt base)
      expect(ev.produceAtSec.length).toBe(5);        // 5 logical submissions (B_prod=N, submission-unit)
      expect(ev.consumeAtSec.length).toBe(1);        // the 1 item consumed
      expect(ev.backlog).toBe(0);                    // D 0->1->0: nothing undecided
      const g = computeGauge(h, nowSec());
      expect(g.dBacklogDtPerHour).toBe(0);           // B6-2 fix: item-consistent (was bProd-bCons = 5-1 = 4)
      expect(g.bProd1h).toBe(5);                     // B_prod=N preserved (the ruled contract)
    });
  });

  describe("T5-2 gauge timed-sampling seam (gaugeSamplingEnabled + shouldSampleGauge)", () => {
    test("gaugeSamplingEnabled default OFF; truthy words ON", () => {
      expect(gaugeSamplingEnabled({})).toBe(false);
      expect(gaugeSamplingEnabled({ SWARM_GAUGE_SAMPLING: "0" })).toBe(false);
      for (const on of ["1", "true", "yes", "on", "YES"]) expect(gaugeSamplingEnabled({ SWARM_GAUGE_SAMPLING: on })).toBe(true);
    });
    test("shouldSampleGauge: first sample fires, then throttles until the interval elapses (>= boundary)", () => {
      expect(shouldSampleGauge(1_000_000, 0, 60)).toBe(true);        // first ever (last=0) ⇒ sample
      expect(shouldSampleGauge(1_000_030, 1_000_000, 60)).toBe(false); // 30s < 60s ⇒ throttled
      expect(shouldSampleGauge(1_000_059, 1_000_000, 60)).toBe(false); // 59s < 60s ⇒ throttled
      expect(shouldSampleGauge(1_000_060, 1_000_000, 60)).toBe(true);  // exactly 60s ⇒ sample (>= boundary)
      expect(shouldSampleGauge(1_000_120, 1_000_000, 60)).toBe(true);  // well past ⇒ sample
    });
    test("shouldSampleGauge fail-soft on misconfig: no clock ⇒ never; bad interval ⇒ always (never wedge to never)", () => {
      expect(shouldSampleGauge(NaN, 0, 60)).toBe(false);            // non-finite now ⇒ no write
      expect(shouldSampleGauge(1_000_000, 0, NaN)).toBe(true);      // non-finite interval ⇒ sample every call
      expect(shouldSampleGauge(1_000_000, 0, 0)).toBe(true);        // zero interval ⇒ always
      expect(shouldSampleGauge(1_000_000, 0, -5)).toBe(true);       // negative interval ⇒ always
    });
    test("a sampled write lands a readable fresh projection (what the sampler calls each interval)", () => {
      const h = mkHome(); const t = nowSec();
      openBatch(h, { batchId: "b1", owner: "coord", items: items(3), nowSec: t });
      writeBandwidthProjection(h, t); // what runGaugeSampling() invokes
      const proj = readBandwidthProjection(h);
      expect(proj?.schema).toBe("bandwidth-gauge/v1");
      expect(proj?.generatedAtSec).toBe(t);
    });
  });
});
