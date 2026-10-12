/**
 * model-staffing selftest (tsx-run). Covers the three pieces:
 *  ① capability-profile cache (model-market.ts / -store.ts): parse+trim, staleness, FC-2 three-state (source unreachable /
 *     parse-fail / empty ⇒ KEEP the last snapshot), the SWARM_MODEL_MARKET flag.
 *  ② pickModel (model-staffing.ts): taskShape→board mapping, cost tiers (light=Pareto/cheapest, standard=balanced, heavy=top),
 *     review heterogeneity (Q6 cross-provider preference + same-provider-different-id fallback records why), CPA constraint +
 *     degrade + the VISIBLE unmappable count (Q1), fail-closed no-staffable, the optional $ budget ceiling (Q5).
 *  ③ projection landing (model-staffing-store.ts): the map reader (home override vs repo seed), the console/model-staffing.json
 *     projection (incl. the no-snapshot "unknown" path), CP-3 boundary guard.
 *  THE THREE ZERO-BUG FIXTURE CLASSES: crash-recovery (torn/partial snapshot + stray temp recover cleanly), restart-idempotency
 *     (re-pull / re-pick same inputs ⇒ same result, no duplicate side-effects), concurrency-race (two near-simultaneous writers
 *     via temp+rename never corrupt the file).
 *
 * No live network: a synthetic/throwing/garbage fetcher is injected throughout.
 * Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/model-staffing.selftest.mts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODEL_MARKET_SCHEMA,
  modelMarketEnabled,
  marketBaseId,
  staleSec,
  parseModelMarket,
  validSnapshot,
  type ModelMarketSnapshot,
} from "./model-market.js";
import { pullModelMarket, readModelMarketSnapshot, type RawFetcher } from "./model-market-store.js";
import {
  modelStaffingEnabled,
  taskShapeOfKind,
  costTierOfNode,
  taskFromNode,
  boardOf,
  countUnmappable,
  pickModel,
  buildStaffingProjection,
  STAFFING_SCHEMA,
  type StaffingSuggestion,
} from "./model-staffing.js";
import { readModelMarketMap, writeStaffingProjection, readStaffingProjection } from "./model-staffing-store.js";
import { pullCpaCatalog, readCatalog, parseCatalogIds, type CatalogFetcher } from "./model-catalog-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "model-staffing-"));
const marketSnapPath = (home: string) => path.join(home, ".agenthop", "swarm", "model-market", "snapshot.json");
const catalogFilePath = (home: string) => path.join(home, ".agenthop", "swarm", "model-market", "catalog.json");
const mapOverrideFile = (home: string) => path.join(home, ".agenthop", "swarm", "roles", "model-market-map.json");
const consoleDir = (home: string) => path.join(home, ".agenthop", "swarm", "console");
const canTestSymlink = (process.getuid?.() ?? 0) !== 0;

/** A synthetic upstream model-market-full.json (the ::<effort> ids + bench + org + score + blended + pareto + deprecated the real
 *  file carries). Values are chosen so every tier / heterogeneity / degrade outcome is deterministic. */
const RAW = {
  updated_at: "2026-10-11T00:00:00Z",
  count: 7,
  models: [
    { id: "alpha-5::max", org: "Anthropic", score: 99, blended: 5.0, bench: { coding: 0.9 }, pareto: false, cheapest: [{ provider: "Anthropic", blended: 5.0, in: 4, out: 20 }] },
    { id: "beta-6::max", org: "OpenAI", score: 97, blended: 2.0, bench: { coding: 0.88 }, pareto: true },
    { id: "gamma-4::max", org: "xAI", score: 90, blended: 1.0, bench: { coding: 0.8 }, pareto: true },
    { id: "delta-3::max", org: "Google", score: 80, blended: 0.5, bench: { coding: 0.7 }, pareto: true },
    { id: "alpha2-5::max", org: "Anthropic", score: 96, blended: 4.0, bench: { coding: 0.86 }, pareto: false },
    { id: "unmapped-x::max", org: "Z", score: 95, blended: 3.0, bench: { coding: 0.85 } }, // NO map entry ⇒ unmappable
    { id: "old-2::max", org: "Anthropic", score: 99, blended: 9.0, bench: { coding: 0.95 }, deprecated: true }, // deprecated ⇒ skipped
  ],
};
/** The Q1 map (market base id → CPA id); unmapped-x deliberately absent, old-2 present but deprecated. */
const MAP: Record<string, string> = { "alpha-5": "alpha-5", "beta-6": "beta-6", "gamma-4": "gamma-4", "delta-3": "delta-3", "alpha2-5": "alpha2-5", "old-2": "old-2" };
const CATALOG_ALL = ["alpha-5", "beta-6", "gamma-4", "delta-3", "alpha2-5", "old-2"];
const SNAP = parseModelMarket(RAW, 1000) as ModelMarketSnapshot;

const okOf = (s: StaffingSuggestion): Extract<StaffingSuggestion, { ok: true }> => {
  if (!s.ok) throw new Error("expected ok suggestion, got no-staffable: " + s.reason);
  return s;
};

// =====================================================================================================================
// Flags: default-ON + kill-switch (freeze Q2)
// =====================================================================================================================
t("market flag default-ON (unset)", modelMarketEnabled({} as NodeJS.ProcessEnv) === true);
t("market flag kill-switch '0'", modelMarketEnabled({ SWARM_MODEL_MARKET: "0" } as NodeJS.ProcessEnv) === false);
t("market flag kill-switch 'off'", modelMarketEnabled({ SWARM_MODEL_MARKET: "off" } as NodeJS.ProcessEnv) === false);
t("staffing flag default-ON (unset)", modelStaffingEnabled({} as NodeJS.ProcessEnv) === true);
t("staffing flag kill-switch 'false'", modelStaffingEnabled({ SWARM_MODEL_STAFFING: "FALSE" } as NodeJS.ProcessEnv) === false);

// =====================================================================================================================
// PURE: parse + trim + helpers
// =====================================================================================================================
t("marketBaseId strips ::effort", marketBaseId("claude-opus-5.5::max") === "claude-opus-5.5");
t("marketBaseId no suffix passthrough", marketBaseId("kimi-k3") === "kimi-k3");
{
  const s = parseModelMarket(RAW, 1234)!;
  t("parse schema", s.schema === MODEL_MARKET_SCHEMA);
  t("parse fetchedAtSec stamped", s.fetchedAtSec === 1234);
  t("parse keeps all id-bearing models", s.models.length === 7);
  const a = s.models.find((m) => m.id === "alpha-5::max")!;
  t("parse derives coding board from bench.coding", a.categoryScores.coding === 0.9);
  t("parse composite from score", a.composite === 99);
  t("parse blended from blended", a.blendedUsdPer1M === 5.0);
  t("parse cheapestOffer trimmed", a.cheapestOffer?.provider === "Anthropic" && a.cheapestOffer?.blendedUsdPer1M === 5.0);
  t("parse pareto flag", s.models.find((m) => m.id === "beta-6::max")!.pareto === true);
  t("parse deprecated flag", s.models.find((m) => m.id === "old-2::max")!.deprecated === true);
}
// cats-over-bench preference (documented fallback chain): cats.coding wins when present
{
  const s = parseModelMarket({ models: [{ id: "x::max", org: "O", score: 10, blended: 1, cats: { coding: 0.99 }, bench: { coding: 0.5 } }] }, 1)!;
  t("parse prefers cats.coding over bench.coding", s.models[0].categoryScores.coding === 0.99);
}
t("parse null on non-object", parseModelMarket(42, 1) === null);
t("parse null on no models array", parseModelMarket({ foo: 1 }, 1) === null);
t("validSnapshot rejects wrong schema", validSnapshot({ schema: "nope", fetchedAtSec: 1, models: [] }) === null);
t("validSnapshot accepts good", validSnapshot({ schema: MODEL_MARKET_SCHEMA, fetchedAtSec: 1, models: [] }) !== null);
t("staleSec = now - fetched", staleSec({ fetchedAtSec: 1000 }, 1600) === 600);
t("staleSec floors at 0", staleSec({ fetchedAtSec: 2000 }, 1000) === 0);
t("staleSec non-finite ⇒ +Infinity", staleSec({ fetchedAtSec: NaN }, 1000) === Number.POSITIVE_INFINITY);

// =====================================================================================================================
// PURE: taskShape / costTier derivation (Q3)
// =====================================================================================================================
t("shape work⇒coding", taskShapeOfKind("work") === "coding");
t("shape repair⇒coding", taskShapeOfKind("repair") === "coding");
t("shape review⇒review", taskShapeOfKind("review") === "review");
t("shape integration⇒agentic", taskShapeOfKind("integration") === "agentic");
t("shape synthesis⇒long_context", taskShapeOfKind("synthesis") === "long_context");
t("shape design⇒science", taskShapeOfKind("design") === "science");
t("board review⇒composite", boardOf("review") === "composite");
t("board coding⇒coding", boardOf("coding") === "coding");
t("costTier base work⇒light", costTierOfNode("work") === "light");
t("costTier base design⇒heavy", costTierOfNode("design") === "heavy");
t("costTier base review⇒standard", costTierOfNode("review") === "standard");
t("costTier resolvedRisk raises one level", costTierOfNode("work", { resolvedRisk: true }) === "standard");
t("costTier criticalPath⇒heavy", costTierOfNode("work", { criticalPath: true }) === "heavy");
t("taskFromNode: planner modelTier is PRIMARY", taskFromNode({ nodeId: "n1", kind: "work", modelTier: "heavy" }).tier === "heavy");
t("taskFromNode: no modelTier ⇒ derived", taskFromNode({ nodeId: "n2", kind: "design" }).tier === "heavy");
t("taskFromNode: shape from kind", taskFromNode({ nodeId: "n3", kind: "review" }).shape === "review");

// =====================================================================================================================
// PURE: pickModel — cost tiers (coding board, full catalog)
// =====================================================================================================================
t("unmappable count = 1 (unmapped-x)", countUnmappable(SNAP, MAP) === 1);
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "heavy", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP }));
  t("heavy ⇒ top capability (alpha-5)", s.suggestedModel === "alpha-5");
  t("heavy evidence board=coding", s.evidence.board === "coding" && s.evidence.score === 0.9);
  t("heavy carries unmappableCount=1 (Q1 visible)", s.unmappableCount === 1);
  t("heavy not degraded (ideal available)", s.degradedFrom === undefined);
}
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP }));
  t("standard ⇒ cheapest in 0.95 band (beta-6)", s.suggestedModel === "beta-6" && s.evidence.blendedUsdPer1M === 2.0);
}
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP }));
  t("light ⇒ Pareto-frontier cheapest (gamma-4)", s.suggestedModel === "gamma-4" && s.evidence.blendedUsdPer1M === 1.0);
}

// =====================================================================================================================
// PURE: CPA constraint + degrade (Q1/§③)
// =====================================================================================================================
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["beta-6", "gamma-4", "delta-3"], snapshot: SNAP, mapTable: MAP }));
  t("degrade: ideal (alpha-5) absent ⇒ nearest available (beta-6)", s.suggestedModel === "beta-6");
  t("degrade: degradedFrom records the ideal marketId", s.degradedFrom?.marketId === "alpha-5::max");
}
// fail-closed: nothing available ⇒ no-staffable (never a weak default)
{
  const empty = pickModel({ taskShape: "coding", costTier: "heavy", catalog: [], snapshot: SNAP, mapTable: MAP });
  t("fail-closed empty catalog ⇒ no-staffable", empty.ok === false);
  t("no-staffable still carries unmappableCount", empty.unmappableCount === 1);
  const none = pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["does-not-exist"], snapshot: SNAP, mapTable: MAP });
  t("fail-closed no catalog match ⇒ no-staffable", none.ok === false);
}

// =====================================================================================================================
// PURE: review heterogeneity (Q6)
// =====================================================================================================================
{
  const s = okOf(pickModel({ taskShape: "review", costTier: "heavy", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, authorModel: "alpha-5" }));
  t("review ⇒ never the author model", s.suggestedModel !== "alpha-5");
  t("review ⇒ cross-provider preferred (beta-6, OpenAI)", s.suggestedModel === "beta-6");
  t("review why records cross-provider", s.why.includes("cross-provider vs author (Anthropic)"));
}
{
  // only the author's provider (Anthropic) is available ⇒ same-provider-different-id fallback, reason recorded
  const s = okOf(pickModel({ taskShape: "review", costTier: "heavy", catalog: ["alpha-5", "alpha2-5"], snapshot: SNAP, mapTable: MAP, authorModel: "alpha-5" }));
  t("review fallback ⇒ different id, same provider (alpha2-5)", s.suggestedModel === "alpha2-5");
  t("review fallback still ≠ author", s.suggestedModel !== "alpha-5");
  t("review why records same-provider fallback", s.why.includes("same-provider different-id fallback"));
}

// =====================================================================================================================
// PURE: optional $ budget ceiling (Q5)
// =====================================================================================================================
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "heavy", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, budgetUsdCeiling: 3.0 }));
  t("budget: ceiling unmet ⇒ flagged overBudget, never weakened below floor", s.suggestedModel === "alpha-5" && s.evidence.overBudget === true);
}
{
  const s = okOf(pickModel({ taskShape: "coding", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, budgetUsdCeiling: 3.0 }));
  t("budget: ceiling met ⇒ narrows within budget (beta-6, no overBudget)", s.suggestedModel === "beta-6" && s.evidence.overBudget === undefined);
}

// =====================================================================================================================
// PURE: projection builder — no-snapshot "unknown" (brief §3)
// =====================================================================================================================
{
  const proj = buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "heavy" }], snapshot: null, mapTable: MAP, catalog: CATALOG_ALL, nowSec: 2000 });
  t("no snapshot ⇒ schema set", proj.schema === STAFFING_SCHEMA);
  t("no snapshot ⇒ snapshotFetchedAtSec null", proj.snapshotFetchedAtSec === null && proj.snapshotStaleSec === null);
  t("no snapshot ⇒ per-task no-staffable (unknown)", proj.tasks[0].suggestion.ok === false);
}
{
  const proj = buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "light" }, { taskId: "t2", shape: "review", tier: "heavy", authorModel: "alpha-5" }], snapshot: SNAP, mapTable: MAP, catalog: CATALOG_ALL, nowSec: 1600 });
  t("projection staleSec computed", proj.snapshotStaleSec === 600 && proj.snapshotFetchedAtSec === 1000);
  t("projection unmappableCount top-level (Q1 visible)", proj.unmappableCount === 1);
  t("projection order preserved", proj.tasks[0].taskId === "t1" && proj.tasks[1].taskId === "t2");
  t("projection t2 review ≠ author", okOf(proj.tasks[1].suggestion).suggestedModel !== "alpha-5");
}

// =====================================================================================================================
// IO: FC-2 three-state cache (injected fetcher — no live network)
// =====================================================================================================================
const okFetcher: RawFetcher = async () => RAW;
const throwFetcher: RawFetcher = async () => { throw new Error("ECONNREFUSED"); };
const garbageFetcher: RawFetcher = async () => ({ not: "a market" });
const emptyFetcher: RawFetcher = async () => ({ models: [] });
{
  const home = tmpHome();
  const r1 = await pullModelMarket(home, 1000, okFetcher);
  t("pull ok ⇒ written", r1.written === true);
  const read1 = readModelMarketSnapshot(home, 1000);
  t("read after pull ⇒ snapshot present", read1 !== null && read1.snapshot.models.length === 7);

  const r2 = await pullModelMarket(home, 2000, throwFetcher);
  t("FC-2: source unreachable ⇒ NOT written", r2.written === false && r2.reason!.startsWith("unreachable"));
  const read2 = readModelMarketSnapshot(home, 2000);
  t("FC-2: unreachable KEEPS last snapshot (not overwritten)", read2 !== null && read2.snapshot.fetchedAtSec === 1000);

  const r3 = await pullModelMarket(home, 3000, garbageFetcher);
  t("FC-2: parse-fail ⇒ NOT written", r3.written === false && r3.reason === "parse-fail/empty");
  t("FC-2: parse-fail KEEPS last snapshot", readModelMarketSnapshot(home, 3000)!.snapshot.fetchedAtSec === 1000);

  const r4 = await pullModelMarket(home, 4000, emptyFetcher);
  t("FC-2: empty models ⇒ NOT written (never a fabricated empty profile)", r4.written === false);
  t("FC-2: empty KEEPS last snapshot", readModelMarketSnapshot(home, 4000)!.snapshot.fetchedAtSec === 1000);

  t("staleness: read at 1600 ⇒ staleSec 600", readModelMarketSnapshot(home, 1600)!.staleSec === 600);
  rmSync(home, { recursive: true, force: true });
}
// no cache at all ⇒ read null (⇒ staffing "unknown")
{
  const home = tmpHome();
  t("no cache ⇒ read null", readModelMarketSnapshot(home, 1) === null);
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// ZERO-BUG FIXTURE CLASS 1 — crash-recovery (torn/partial write + stray temp recover cleanly)
// =====================================================================================================================
{
  const home = tmpHome();
  mkdirSync(path.dirname(marketSnapPath(home)), { recursive: true });
  // (a) a TORN/partial snapshot file (an interrupted write) ⇒ read recovers to null, no throw
  writeFileSync(marketSnapPath(home), '{"schema":"model-market-snapshot/v1","fetchedAtSec":1,"models":[{');
  t("crash-recovery: torn snapshot ⇒ read null (no throw)", readModelMarketSnapshot(home, 1) === null);
  // a good pull then atomically replaces it
  await pullModelMarket(home, 5000, okFetcher);
  t("crash-recovery: good pull overwrites torn file", readModelMarketSnapshot(home, 5000)!.snapshot.fetchedAtSec === 5000);
  // (b) a stray leftover temp (a crashed writer) must not break the reader (it reads snapshot.json only)
  writeFileSync(marketSnapPath(home) + ".tmp-deadbeef", "garbage{");
  t("crash-recovery: stray temp ignored by reader", readModelMarketSnapshot(home, 5000)!.snapshot.models.length === 7);
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// ZERO-BUG FIXTURE CLASS 2 — restart-idempotency (re-run ⇒ same result, no duplicate side-effects)
// =====================================================================================================================
{
  const home = tmpHome();
  await pullModelMarket(home, 7000, okFetcher);
  const after1 = readFileSync(marketSnapPath(home), "utf8");
  await pullModelMarket(home, 7000, okFetcher); // re-pull, same inputs
  const after2 = readFileSync(marketSnapPath(home), "utf8");
  t("idempotency: re-pull (same now) ⇒ byte-identical snapshot", after1 === after2);
  // re-pick the same inputs ⇒ deep-equal suggestion
  const p1 = pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP });
  const p2 = pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP });
  t("idempotency: re-pick ⇒ deep-equal", JSON.stringify(p1) === JSON.stringify(p2));
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// ZERO-BUG FIXTURE CLASS 3 — concurrency-race (two near-simultaneous writers never corrupt the file)
// =====================================================================================================================
{
  const home = tmpHome();
  const bigFetcher: RawFetcher = async () => RAW; // 7 models
  const smallFetcher: RawFetcher = async () => ({ models: [{ id: "solo::max", org: "O", score: 50, blended: 1, bench: { coding: 0.5 } }] }); // 1 model
  await Promise.all([pullModelMarket(home, 9000, bigFetcher), pullModelMarket(home, 9000, smallFetcher)]);
  const read = readModelMarketSnapshot(home, 9000);
  t("concurrency: final file is a COMPLETE valid snapshot (never torn)", read !== null);
  t("concurrency: final models match ONE writer (7 or 1), not interleaved", read!.snapshot.models.length === 7 || read!.snapshot.models.length === 1);
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// IO: map reader (Q1 shared override vs repo seed)
// =====================================================================================================================
{
  const home = tmpHome();
  const seed = readModelMarketMap(home); // no override ⇒ repo seed
  t("map reader: repo seed has claude-opus-5.5", seed["claude-opus-5.5"] === "claude-opus-5-5");
  // a home override REPLACES the seed (prefer override)
  mkdirSync(path.dirname(mapOverrideFile(home)), { recursive: true });
  writeFileSync(mapOverrideFile(home), JSON.stringify({ schema: "model-market-map/v1", map: { "custom-x": "custom-cpa" } }));
  const over = readModelMarketMap(home);
  t("map reader: home override wins", over["custom-x"] === "custom-cpa");
  t("map reader: override replaces seed (no leak)", over["claude-opus-5.5"] === undefined);
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// IO: projection write/read (piece ③a) + CP-3 boundary
// =====================================================================================================================
{
  const home = tmpHome();
  // seed a snapshot + an override map matching the synthetic ids
  await pullModelMarket(home, 1000, okFetcher);
  mkdirSync(path.dirname(mapOverrideFile(home)), { recursive: true });
  writeFileSync(mapOverrideFile(home), JSON.stringify({ schema: "model-market-map/v1", map: MAP }));
  const proj = writeStaffingProjection(home, 1600, { tasks: [{ taskId: "n1", shape: "coding", tier: "heavy" }, { taskId: "n2", shape: "review", tier: "heavy", authorModel: "alpha-5" }], catalog: CATALOG_ALL });
  t("projection write ⇒ returns projection", proj !== null && proj.schema === STAFFING_SCHEMA);
  t("projection write ⇒ unmappableCount visible", proj!.unmappableCount === 1);
  const back = readStaffingProjection(home);
  t("projection read back", back !== null && back.tasks.length === 2);
  t("projection read: n1 heavy ⇒ alpha-5", okOf(back!.tasks[0].suggestion).suggestedModel === "alpha-5");
  t("projection read: n2 review ⇒ cross-provider ≠ author", okOf(back!.tasks[1].suggestion).suggestedModel === "beta-6");
  rmSync(home, { recursive: true, force: true });
}
// no snapshot ⇒ projection still writes, all tasks "unknown"
{
  const home = tmpHome();
  const proj = writeStaffingProjection(home, 2000, { tasks: [{ taskId: "n1", shape: "coding", tier: "heavy" }], catalog: CATALOG_ALL });
  t("projection (no snapshot) ⇒ written with unknown task", proj !== null && proj.tasks[0].suggestion.ok === false && proj.snapshotFetchedAtSec === null);
  rmSync(home, { recursive: true, force: true });
}
// CP-3: a symlinked console dir ⇒ write SKIPPED (returns null)
if (canTestSymlink) {
  const home = tmpHome();
  const elsewhere = tmpHome();
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  symlinkSync(elsewhere, consoleDir(home)); // redirect console/ outside the boundary
  const proj = writeStaffingProjection(home, 1, { tasks: [{ taskId: "n1", shape: "coding", tier: "heavy" }], catalog: CATALOG_ALL });
  t("CP-3: redirected console dir ⇒ write skipped (null)", proj === null);
  t("CP-3: nothing written outside the boundary", !existsSync(path.join(elsewhere, "model-staffing.json")));
  rmSync(home, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

// =====================================================================================================================
// IO: CPA catalog cache (model-catalog-store) — FC-2 three-state (injected fetcher — no live network)
// =====================================================================================================================
const okCat: CatalogFetcher = async () => ({ data: [{ id: "alpha-5" }, { id: "beta-6" }, { id: "gamma-4" }] });
const throwCat: CatalogFetcher = async () => { throw new Error("ECONNREFUSED"); };
const garbageCat: CatalogFetcher = async () => ({ foo: 1 });
const emptyCat: CatalogFetcher = async () => ({ data: [] });
t("parseCatalogIds: data[].id ⇒ strings", JSON.stringify(parseCatalogIds({ data: [{ id: "a" }, { id: 7 }, { id: "b" }] })) === JSON.stringify(["a", "b"]));
t("parseCatalogIds: no data ⇒ []", parseCatalogIds({ x: 1 }).length === 0);
{
  const home = tmpHome();
  const r1 = await pullCpaCatalog(home, 1000, okCat);
  t("catalog pull ok ⇒ written", r1.written === true);
  const read1 = readCatalog(home, 1000);
  t("catalog read after pull ⇒ ids present", read1 !== null && read1.ids.length === 3 && read1.ids[0] === "alpha-5");

  const r2 = await pullCpaCatalog(home, 2000, throwCat);
  t("catalog FC-2: unreachable ⇒ NOT written", r2.written === false && r2.reason!.startsWith("unreachable"));
  t("catalog FC-2: unreachable KEEPS last", readCatalog(home, 2000)!.ids.length === 3);

  const r3 = await pullCpaCatalog(home, 3000, garbageCat);
  t("catalog FC-2: parse-fail ⇒ NOT written", r3.written === false);
  t("catalog FC-2: parse-fail KEEPS last", readCatalog(home, 3000)!.ids.length === 3);

  const r4 = await pullCpaCatalog(home, 4000, emptyCat);
  t("catalog FC-2: empty ids ⇒ NOT written (never overwrite a real catalog with [])", r4.written === false);
  t("catalog FC-2: empty KEEPS last", readCatalog(home, 4000)!.ids.length === 3);

  t("catalog staleness: read at 1600 ⇒ staleSec 600", readCatalog(home, 1600)!.staleSec === 600);
  rmSync(home, { recursive: true, force: true });
}
// no cache ⇒ null
{
  const home = tmpHome();
  t("catalog: no cache ⇒ read null", readCatalog(home, 1) === null);
  rmSync(home, { recursive: true, force: true });
}
// ZERO-BUG 1 — crash-recovery (torn catalog.json ⇒ null; good fetch replaces)
{
  const home = tmpHome();
  mkdirSync(path.dirname(catalogFilePath(home)), { recursive: true });
  writeFileSync(catalogFilePath(home), '{"schema":"model-market-catalog/v1","fetchedAtSec":1,"ids":[');
  t("catalog crash-recovery: torn ⇒ read null (no throw)", readCatalog(home, 1) === null);
  await pullCpaCatalog(home, 5000, okCat);
  t("catalog crash-recovery: good pull overwrites torn file", readCatalog(home, 5000)!.ids.length === 3);
  rmSync(home, { recursive: true, force: true });
}
// ZERO-BUG 2 — restart-idempotency (re-pull same ⇒ byte-identical; unreachable keeps last)
{
  const home = tmpHome();
  await pullCpaCatalog(home, 7000, okCat);
  const a1 = readFileSync(catalogFilePath(home), "utf8");
  await pullCpaCatalog(home, 7000, okCat);
  const a2 = readFileSync(catalogFilePath(home), "utf8");
  t("catalog idempotency: re-pull (same now) ⇒ byte-identical", a1 === a2);
  await pullCpaCatalog(home, 8000, throwCat);
  t("catalog idempotency: unreachable keeps last", readFileSync(catalogFilePath(home), "utf8") === a1);
  rmSync(home, { recursive: true, force: true });
}
// ZERO-BUG 3 — concurrency-race (two temp+rename writers ⇒ one complete file)
{
  const home = tmpHome();
  const threeCat: CatalogFetcher = async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  const oneCat: CatalogFetcher = async () => ({ data: [{ id: "solo" }] });
  await Promise.all([pullCpaCatalog(home, 9000, threeCat), pullCpaCatalog(home, 9000, oneCat)]);
  const read = readCatalog(home, 9000);
  t("catalog concurrency: final file complete + valid (never torn)", read !== null);
  t("catalog concurrency: ids match ONE writer (3 or 1)", read!.ids.length === 3 || read!.ids.length === 1);
  rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
// Producer-level honesty (the live-wiring three-state): no catalog / no plan ⇒ honest, never fabricated
// =====================================================================================================================
{
  // no catalog (ids=[]) with a real snapshot ⇒ EVERY task no-staffable (not a fabricated suggestion)
  const proj = buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "heavy" }, { taskId: "t2", shape: "review", tier: "light" }], snapshot: SNAP, mapTable: MAP, catalog: [], nowSec: 1 });
  t("no catalog ⇒ every task no-staffable (honest)", proj.tasks.every((x) => x.suggestion.ok === false));
}
{
  // no plan ⇒ empty tasks (the wiring maps plan=null → tasks=[]) ⇒ empty, honest projection
  const proj = buildStaffingProjection({ tasks: [], snapshot: SNAP, mapTable: MAP, catalog: CATALOG_ALL, nowSec: 1 });
  t("no plan ⇒ empty tasks (honest empty projection)", proj.tasks.length === 0 && proj.schema === STAFFING_SCHEMA);
}

console.log("\nALL model-staffing selftests passed.");
