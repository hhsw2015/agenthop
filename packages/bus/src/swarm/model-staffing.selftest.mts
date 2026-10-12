/**
 * model-staffing selftest (tsx-run). r2 after happycapy @e00ec6a (7 P2 + 1 P3). Covers the rebuilt pieces + each finding:
 *  MS-P2-1 catalog bound to its ENDPOINT · MS-P2-2 unsatisfiable capability/budget ⇒ no-staffable (never a weak default) ·
 *  MS-P2-3 the suggestion is the REAL callable catalog id (not the map alias) · MS-P2-4 review with no author ⇒ no-staffable ·
 *  MS-P2-5 missing/corrupt score or price ⇒ not a candidate (never fabricated) · MS-P2-6 config read error ⇒ unreadable, never a
 *  silent default · MS-P2-7 CP-3 checks the whole dir chain · MS-P3-1 honest `why` + rank/cheapestOffer evidence.
 *  Plus the three zero-bug fixture classes (crash-recovery / restart-idempotency / concurrency-race).
 * No live network: injected fetchers throughout. Run: packages/bus/node_modules/.bin/tsx .../model-staffing.selftest.mts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_MARKET_SCHEMA, modelMarketEnabled, marketBaseId, staleSec, parseModelMarket, validSnapshot, type ModelMarketSnapshot } from "./model-market.js";
import { pullModelMarket, readModelMarketSnapshot, type RawFetcher } from "./model-market-store.js";
import { modelStaffingEnabled, taskShapeOfKind, costTierOfNode, taskFromNode, boardOf, countUnmappable, pickModel, buildStaffingProjection, STAFFING_SCHEMA, type StaffingSuggestion } from "./model-staffing.js";
import { readModelMarketMap, writeStaffingProjection, readStaffingProjection } from "./model-staffing-store.js";
import { pullCpaCatalog, readCatalog, parseCatalogIds, cpaBaseUrl, type CatalogFetcher } from "./model-catalog-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "model-staffing-"));
const marketSnapPath = (h: string) => path.join(h, ".agenthop", "swarm", "model-market", "snapshot.json");
const catalogFilePath = (h: string) => path.join(h, ".agenthop", "swarm", "model-market", "catalog.json");
const cpaConfigFile = (h: string) => path.join(h, ".agenthop", "cpa.json");
const mapOverrideFile = (h: string) => path.join(h, ".agenthop", "swarm", "roles", "model-market-map.json");
const consoleDir = (h: string) => path.join(h, ".agenthop", "swarm", "console");
const swarmDir = (h: string) => path.join(h, ".agenthop", "swarm");
const canSymlink = (process.getuid?.() ?? 0) !== 0;
const envSave = { CPA_BASE_URL: process.env.CPA_BASE_URL, CPA_API_KEY: process.env.CPA_API_KEY };

const RAW = {
  models: [
    { id: "alpha-5::max", org: "Anthropic", score: 99, blended: 5.0, bench: { coding: 0.9 }, pareto: false, cheapest: [{ provider: "Anthropic", blended: 5.0 }] },
    { id: "beta-6::max", org: "OpenAI", score: 97, blended: 2.0, bench: { coding: 0.88 }, pareto: true },
    { id: "gamma-4::max", org: "xAI", score: 90, blended: 1.0, bench: { coding: 0.8 }, pareto: true },
    { id: "delta-3::max", org: "Google", score: 80, blended: 0.5, bench: { coding: 0.7 }, pareto: true },
    { id: "alpha2-5::max", org: "Anthropic", score: 96, blended: 4.0, bench: { coding: 0.86 }, pareto: false },
    { id: "unmapped-x::max", org: "Z", score: 95, blended: 3.0, bench: { coding: 0.85 } }, // NO map entry ⇒ unmappable
    { id: "old-2::max", org: "Anthropic", score: 99, blended: 9.0, bench: { coding: 0.95 }, deprecated: true }, // deprecated ⇒ skipped
  ],
};
const MAP: Record<string, string> = { "alpha-5": "alpha-5", "beta-6": "beta-6", "gamma-4": "gamma-4", "delta-3": "delta-3", "alpha2-5": "alpha2-5", "old-2": "old-2" };
const CATALOG_ALL = ["alpha-5", "beta-6", "gamma-4", "delta-3", "alpha2-5", "old-2"];
const SNAP = parseModelMarket(RAW, 1000) as ModelMarketSnapshot;
const okOf = (s: StaffingSuggestion): Extract<StaffingSuggestion, { ok: true }> => { if (!s.ok) throw new Error("expected ok, got no-staffable: " + s.reason); return s; };

try {
  // ── flags + pure parse ──────────────────────────────────────────────────────────────────────────────────────────
  t("flags default-ON + kill-switch", modelMarketEnabled({}) && !modelMarketEnabled({ SWARM_MODEL_MARKET: "0" }) && modelStaffingEnabled({}) && !modelStaffingEnabled({ SWARM_MODEL_STAFFING: "off" }));
  t("marketBaseId strips ::effort", marketBaseId("x::max") === "x" && marketBaseId("y") === "y");
  t("parse keeps id-bearing models + derives board", SNAP.models.length === 7 && SNAP.models.find((m) => m.id === "alpha-5::max")!.categoryScores.coding === 0.9);
  t("staleSec", staleSec({ fetchedAtSec: 1000 }, 1600) === 600 && staleSec({ fetchedAtSec: NaN }, 1) === Number.POSITIVE_INFINITY);

  // ── MS-P2-5: missing/corrupt score or price ⇒ NOT a candidate; validSnapshot sanitizes a corrupt disk record ────────
  t("parse: missing composite/price left ABSENT (not fabricated 0)", (() => {
    const s = parseModelMarket({ models: [{ id: "np::max", org: "O", bench: { coding: 0.5 } }] }, 1)!; // no score, no blended
    return s.models[0].composite === undefined && s.models[0].blendedUsdPer1M === undefined;
  })());
  t("pick: a model with a score but NO price is not staffable (MS-P2-5)", (() => {
    const snap = parseModelMarket({ models: [{ id: "np::max", org: "O", bench: { coding: 0.9 } }] }, 1)!;
    return pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["np"], snapshot: snap, mapTable: { "np": "np" } }).ok === false;
  })());
  t("validSnapshot: a string score / composite on disk is DROPPED (MS-P2-5), not trusted", (() => {
    const v = validSnapshot({ schema: MODEL_MARKET_SCHEMA, fetchedAtSec: 1, models: [{ id: "x", categoryScores: { coding: "high" }, composite: "big", blendedUsdPer1M: 5 }] });
    return v !== null && v.models[0]!.categoryScores.coding === undefined && v.models[0]!.composite === undefined && v.models[0]!.blendedUsdPer1M === 5;
  })());
  t("pick: a corrupt-score disk snapshot ⇒ that model is no-candidate ⇒ no-staffable", (() => {
    const v = validSnapshot({ schema: MODEL_MARKET_SCHEMA, fetchedAtSec: 1, models: [{ id: "x", categoryScores: { coding: "high" }, blendedUsdPer1M: 5 }] })!;
    return pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["x"], snapshot: v, mapTable: { "x": "x" } }).ok === false;
  })());

  // ── pickModel cost tiers (coding board) ─────────────────────────────────────────────────────────────────────────
  t("unmappable count = 1 (unmapped-x)", countUnmappable(SNAP, MAP) === 1);
  t("heavy ⇒ top (alpha-5) + rank 1 + cheapestOffer evidence (MS-P3-1)", (() => {
    const s = okOf(pickModel({ taskShape: "coding", costTier: "heavy", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP }));
    return s.suggestedModel === "alpha-5" && s.unmappableCount === 1 && s.evidence.rank === 1 && s.evidence.cheapestOffer?.provider === "Anthropic";
  })());
  t("standard ⇒ cheapest in 0.95 band (beta-6)", okOf(pickModel({ taskShape: "coding", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP })).suggestedModel === "beta-6");
  t("light ⇒ Pareto cheapest (gamma-4)", okOf(pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP })).suggestedModel === "gamma-4");

  // ── MS-P2-3: the suggestion is the REAL dated catalog id, not the map alias ──────────────────────────────────────
  t("MS-P2-3: a dated catalog id is returned as the actual callable id", (() => {
    const s = okOf(pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["alpha-5-20261001"], snapshot: SNAP, mapTable: { "alpha-5": "alpha-5" } }));
    return s.suggestedModel === "alpha-5-20261001";
  })());

  // ── MS-P2-2: capability floor unmet ⇒ no-staffable (NOT a degrade to all available) ──────────────────────────────
  t("MS-P2-2: heavy + top NOT in catalog ⇒ NO-STAFFABLE (no model clears floor)", pickModel({ taskShape: "coding", costTier: "heavy", catalog: ["beta-6", "gamma-4"], snapshot: SNAP, mapTable: MAP }).ok === false);
  t("MS-P2-2: empty catalog ⇒ no-staffable, carries unmappableCount", (() => { const e = pickModel({ taskShape: "coding", costTier: "heavy", catalog: [], snapshot: SNAP, mapTable: MAP }); return e.ok === false && e.unmappableCount === 1; })());
  // a LEGIT degrade (standard: ideal cheapest not in catalog, another band model is) records degradedFrom with the ideal marketId
  t("degrade: standard, ideal (beta) absent but alpha2 in-band ⇒ pick alpha2 + degradedFrom beta", (() => {
    const s = okOf(pickModel({ taskShape: "coding", costTier: "standard", catalog: ["alpha-5", "alpha2-5"], snapshot: SNAP, mapTable: MAP }));
    return s.suggestedModel === "alpha2-5" && s.degradedFrom?.marketId === "beta-6::max";
  })());

  // ── MS-P2-2: budget ceiling unmet ⇒ no-staffable (not an over-budget "ok") ───────────────────────────────────────
  t("MS-P2-2: heavy coding + $3 ceiling (top is $5) ⇒ NO-STAFFABLE", pickModel({ taskShape: "coding", costTier: "heavy", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, budgetUsdCeiling: 3.0 }).ok === false);
  t("budget met ⇒ narrows within budget (standard $3 ⇒ beta-6)", okOf(pickModel({ taskShape: "coding", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, budgetUsdCeiling: 3.0 })).suggestedModel === "beta-6");

  // ── MS-P2-4 + Q6 review heterogeneity + MS-P3-1 honest why ───────────────────────────────────────────────────────
  t("MS-P2-4: review with NO author ⇒ no-staffable (cannot prove Q6)", pickModel({ taskShape: "review", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP }).ok === false);
  t("review standard ⇒ cross-provider (beta-6) + honest why", (() => {
    const s = okOf(pickModel({ taskShape: "review", costTier: "standard", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP, authorModel: "alpha-5" }));
    return s.suggestedModel === "beta-6" && s.why.includes("cross-provider vs author (Anthropic)");
  })());
  t("review fallback ⇒ same-provider different-id (alpha2-5), why records it", (() => {
    const s = okOf(pickModel({ taskShape: "review", costTier: "standard", catalog: ["alpha-5", "alpha2-5"], snapshot: SNAP, mapTable: MAP, authorModel: "alpha-5" }));
    return s.suggestedModel === "alpha2-5" && s.why.includes("same-provider (Anthropic)");
  })());
  t("MS-P3-1: an UNKNOWN-provider candidate is NOT claimed cross-provider", (() => {
    // snapshot where the only non-author in-band model has an empty provider ⇒ cannot be cross; why must not assert cross-provider.
    const snap = parseModelMarket({ models: [{ id: "au::max", org: "Anthropic", score: 99, blended: 5, bench: { coding: 0.9 } }, { id: "nop::max", org: "", score: 98, blended: 2, bench: { coding: 0.9 } }] }, 1)!;
    const s = okOf(pickModel({ taskShape: "review", costTier: "standard", catalog: ["au", "nop"], snapshot: snap, mapTable: { "au": "au", "nop": "nop" }, authorModel: "au" }));
    return s.suggestedModel === "nop" && !s.why.includes("cross-provider vs author") && s.why.includes("UNVERIFIED");
  })());

  // ── projection builder ──────────────────────────────────────────────────────────────────────────────────────────
  t("no snapshot ⇒ per-task unknown + null snapshot fields", (() => {
    const p = buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "heavy" }], snapshot: null, mapTable: MAP, catalog: CATALOG_ALL, nowSec: 2000 });
    return p.schema === STAFFING_SCHEMA && p.snapshotFetchedAtSec === null && p.tasks[0]!.suggestion.ok === false;
  })());
  t("projection: order preserved + unmappable top-level + review(no author)=no-staffable", (() => {
    const p = buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "light" }, { taskId: "t2", shape: "review", tier: "standard" }], snapshot: SNAP, mapTable: MAP, catalog: CATALOG_ALL, nowSec: 1600 });
    return p.snapshotStaleSec === 600 && p.unmappableCount === 1 && p.tasks[0]!.taskId === "t1" && p.tasks[1]!.suggestion.ok === false;
  })());

  // ── FC-2 three-state market cache (injected fetcher) ────────────────────────────────────────────────────────────
  const okFetcher: RawFetcher = async () => RAW;
  const throwFetcher: RawFetcher = async () => { throw new Error("ECONNREFUSED"); };
  {
    const home = tmpHome();
    t("pull ok ⇒ written + read", (await pullModelMarket(home, 1000, okFetcher)).written === true && readModelMarketSnapshot(home, 1000)!.snapshot.models.length === 7);
    t("FC-2 unreachable ⇒ keep last", (await pullModelMarket(home, 2000, throwFetcher)).written === false && readModelMarketSnapshot(home, 2000)!.snapshot.fetchedAtSec === 1000);
    rmSync(home, { recursive: true, force: true });
  }

  // ── MS-P2-6: readModelMarketMap three-state ─────────────────────────────────────────────────────────────────────
  {
    const home = tmpHome();
    t("map: no override ⇒ repo seed (non-null)", (() => { const m = readModelMarketMap(home); return m !== null && m["claude-opus-5.5"] === "claude-opus-5-5"; })());
    mkdirSync(path.dirname(mapOverrideFile(home)), { recursive: true });
    writeFileSync(mapOverrideFile(home), JSON.stringify({ map: { "custom-x": "custom-cpa" } }));
    t("map: valid override wins + replaces seed", (() => { const m = readModelMarketMap(home); return m !== null && m["custom-x"] === "custom-cpa" && m["claude-opus-5.5"] === undefined; })());
    writeFileSync(mapOverrideFile(home), "{not json");
    t("MS-P2-6: corrupt override ⇒ null (never silently falls to seed)", readModelMarketMap(home) === null);
    rmSync(mapOverrideFile(home), { force: true }); mkdirSync(mapOverrideFile(home), { recursive: true }); // dir at the path ⇒ EISDIR read
    t("MS-P2-6: unreadable (EISDIR) override ⇒ null", readModelMarketMap(home) === null);
    rmSync(mapOverrideFile(home), { recursive: true, force: true });
    // MS-P2-6 r2: a parsed-but-MALFORMED map (array) is unreadable, NOT a valid/empty/index-keyed map.
    writeFileSync(mapOverrideFile(home), JSON.stringify({ map: [] }));
    t("MS-P2-6 r2: map:[] (array) ⇒ null (not a silent empty map)", readModelMarketMap(home) === null);
    writeFileSync(mapOverrideFile(home), JSON.stringify({ map: ["fixture-model"] }));
    t("MS-P2-6 r2: map:['x'] (array) ⇒ null (not an index-keyed {0:'x'})", readModelMarketMap(home) === null);
    writeFileSync(mapOverrideFile(home), JSON.stringify([{ map: {} }]));
    t("MS-P2-6 r2: bare-array doc ⇒ null", readModelMarketMap(home) === null);
    writeFileSync(mapOverrideFile(home), JSON.stringify({ map: {} }));
    t("MS-P2-6 r2: map:{} (object) stays a valid EMPTY map (not null) — contrast", (() => { const m = readModelMarketMap(home); return m !== null && Object.keys(m).length === 0; })());
    rmSync(home, { recursive: true, force: true });
  }

  // ── MS-P2-6: cpaBaseUrl ENOENT vs unreadable ────────────────────────────────────────────────────────────────────
  {
    delete process.env.CPA_BASE_URL;
    const home = tmpHome();
    t("cpaBaseUrl: no config (ENOENT) ⇒ local default", cpaBaseUrl(home) === "http://127.0.0.1:8787/v1");
    mkdirSync(path.dirname(cpaConfigFile(home)), { recursive: true });
    writeFileSync(cpaConfigFile(home), "{not json");
    t("MS-P2-6: corrupt cpa.json ⇒ null (never silent default)", cpaBaseUrl(home) === null);
    // MS-P2-6 r2: a parsed-but-MALFORMED config (wrong baseUrl type / array doc) is UNREADABLE, never the local default.
    writeFileSync(cpaConfigFile(home), JSON.stringify({ baseUrl: 17 }));
    t("MS-P2-6 r2: numeric baseUrl ⇒ null (declared-but-malformed, not default)", cpaBaseUrl(home) === null);
    writeFileSync(cpaConfigFile(home), JSON.stringify([]));
    t("MS-P2-6 r2: array config doc ⇒ null (not default)", cpaBaseUrl(home) === null);
    writeFileSync(cpaConfigFile(home), JSON.stringify({ baseUrl: "" }));
    t("MS-P2-6 r2: empty-string baseUrl ⇒ null", cpaBaseUrl(home) === null);
    writeFileSync(cpaConfigFile(home), JSON.stringify({ someOther: 1 }));
    t("MS-P2-6 r2: valid object with NO baseUrl ⇒ local default (a real config, no override) — contrast", cpaBaseUrl(home) === "http://127.0.0.1:8787/v1");
    writeFileSync(cpaConfigFile(home), JSON.stringify({ baseUrl: "http://custom:9/v1" }));
    t("cpaBaseUrl: valid config baseUrl", cpaBaseUrl(home) === "http://custom:9/v1");
    process.env.CPA_BASE_URL = "http://env-wins/v1";
    t("cpaBaseUrl: env overrides config", cpaBaseUrl(home) === "http://env-wins/v1");
    delete process.env.CPA_BASE_URL;
    rmSync(home, { recursive: true, force: true });
  }

  // ── MS-P2-1: catalog bound to its endpoint ──────────────────────────────────────────────────────────────────────
  const okCat: CatalogFetcher = async () => ({ data: [{ id: "alpha-5" }, { id: "beta-6" }] });
  t("parseCatalogIds", JSON.stringify(parseCatalogIds({ data: [{ id: "a" }, { id: 7 }, { id: "b" }] })) === JSON.stringify(["a", "b"]));
  {
    const home = tmpHome();
    process.env.CPA_BASE_URL = "http://endpoint-A/v1";
    t("catalog pull A ⇒ written + readable under A", (await pullCpaCatalog(home, 1000, okCat)).written === true && readCatalog(home, 1000)!.ids.length === 2);
    process.env.CPA_BASE_URL = "http://endpoint-B/v1";
    t("MS-P2-1: read under a DIFFERENT endpoint ⇒ null (never trust A's set for B)", readCatalog(home, 1000) === null);
    process.env.CPA_BASE_URL = "http://endpoint-A/v1";
    t("MS-P2-1: read back under A ⇒ ids again", readCatalog(home, 1000)!.ids.length === 2);
    delete process.env.CPA_BASE_URL;
    rmSync(home, { recursive: true, force: true });
  }

  // ── ZERO-BUG FIXTURES: crash-recovery / restart-idempotency / concurrency-race (both caches) ─────────────────────
  {
    const home = tmpHome(); mkdirSync(path.dirname(marketSnapPath(home)), { recursive: true });
    writeFileSync(marketSnapPath(home), '{"schema":"model-market-snapshot/v1","fetchedAtSec":1,"models":[{');
    t("crash: torn market snapshot ⇒ null", readModelMarketSnapshot(home, 1) === null);
    await pullModelMarket(home, 5000, okFetcher);
    writeFileSync(marketSnapPath(home) + ".tmp-dead", "garbage");
    t("crash: good pull overwrites torn; stray tmp ignored", readModelMarketSnapshot(home, 5000)!.snapshot.fetchedAtSec === 5000);
    rmSync(home, { recursive: true, force: true });
  }
  {
    const home = tmpHome();
    await pullModelMarket(home, 7000, okFetcher); const a1 = readFileSync(marketSnapPath(home), "utf8");
    await pullModelMarket(home, 7000, okFetcher); const a2 = readFileSync(marketSnapPath(home), "utf8");
    t("idempotency: re-pull same ⇒ byte-identical", a1 === a2);
    t("idempotency: re-pick ⇒ deep-equal", JSON.stringify(pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP })) === JSON.stringify(pickModel({ taskShape: "coding", costTier: "light", catalog: CATALOG_ALL, snapshot: SNAP, mapTable: MAP })));
    rmSync(home, { recursive: true, force: true });
  }
  {
    const home = tmpHome();
    const big: RawFetcher = async () => RAW;
    const small: RawFetcher = async () => ({ models: [{ id: "solo::max", org: "O", score: 50, blended: 1, bench: { coding: 0.5 } }] });
    await Promise.all([pullModelMarket(home, 9000, big), pullModelMarket(home, 9000, small)]);
    const r = readModelMarketSnapshot(home, 9000);
    t("concurrency: final market file complete + from ONE writer", r !== null && (r.snapshot.models.length === 7 || r.snapshot.models.length === 1));
    rmSync(home, { recursive: true, force: true });
  }
  {
    const home = tmpHome(); process.env.CPA_BASE_URL = "http://e/v1"; mkdirSync(path.dirname(catalogFilePath(home)), { recursive: true });
    writeFileSync(catalogFilePath(home), '{"schema":"model-market-catalog/v1","fetchedAtSec":1,"ids":[');
    t("catalog crash: torn ⇒ null", readCatalog(home, 1) === null);
    await pullCpaCatalog(home, 5000, okCat);
    t("catalog crash: good pull overwrites", readCatalog(home, 5000)!.ids.length === 2);
    const c1 = readFileSync(catalogFilePath(home), "utf8"); await pullCpaCatalog(home, 5000, okCat);
    t("catalog idempotency: re-pull same ⇒ byte-identical", readFileSync(catalogFilePath(home), "utf8") === c1);
    const three: CatalogFetcher = async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const one: CatalogFetcher = async () => ({ data: [{ id: "solo" }] });
    await Promise.all([pullCpaCatalog(home, 9000, three), pullCpaCatalog(home, 9000, one)]);
    const rc = readCatalog(home, 9000);
    t("catalog concurrency: complete + from ONE writer", rc !== null && (rc.ids.length === 3 || rc.ids.length === 1));
    delete process.env.CPA_BASE_URL; rmSync(home, { recursive: true, force: true });
  }

  // ── projection write/read + MS-P2-7 ancestor CP-3 ───────────────────────────────────────────────────────────────
  {
    const home = tmpHome();
    await pullModelMarket(home, 1000, okFetcher);
    mkdirSync(path.dirname(mapOverrideFile(home)), { recursive: true });
    writeFileSync(mapOverrideFile(home), JSON.stringify({ map: MAP }));
    const proj = writeStaffingProjection(home, 1600, { tasks: [{ taskId: "n1", shape: "coding", tier: "heavy" }, { taskId: "n2", shape: "review", tier: "standard", authorModel: "alpha-5" }], catalog: CATALOG_ALL });
    t("projection write+read: n1 heavy⇒alpha-5, n2 review⇒beta-6, unmappable visible", (() => {
      const b = readStaffingProjection(home);
      return proj !== null && b !== null && b.unmappableCount === 1 && okOf(b.tasks[0]!.suggestion).suggestedModel === "alpha-5" && okOf(b.tasks[1]!.suggestion).suggestedModel === "beta-6";
    })());
    rmSync(home, { recursive: true, force: true });
  }
  if (canSymlink) {
    // MS-P2-7: a symlinked SWARM ancestor (leaf dirs real underneath) must refuse all three stores' writes + no escape.
    const home = tmpHome(); const ext = tmpHome();
    mkdirSync(path.join(ext, "console"), { recursive: true });
    mkdirSync(path.join(ext, "model-market"), { recursive: true });
    mkdirSync(path.join(ext, "roles"), { recursive: true });
    mkdirSync(path.join(home, ".agenthop"), { recursive: true });
    symlinkSync(ext, swarmDir(home)); // .agenthop/swarm -> ext
    process.env.CPA_BASE_URL = "http://e/v1";
    t("MS-P2-7: symlinked swarm ancestor ⇒ writeStaffingProjection refused", writeStaffingProjection(home, 1, { tasks: [{ taskId: "n1", shape: "coding", tier: "heavy" }], catalog: CATALOG_ALL }) === null);
    t("MS-P2-7: symlinked swarm ancestor ⇒ pullModelMarket refused", (await pullModelMarket(home, 1, okFetcher)).written === false);
    t("MS-P2-7: symlinked swarm ancestor ⇒ pullCpaCatalog refused", (await pullCpaCatalog(home, 1, okCat)).written === false);
    t("MS-P2-7: NO escape writes at the redirect target", !existsSync(path.join(ext, "console", "model-staffing.json")) && !existsSync(path.join(ext, "model-market", "snapshot.json")) && !existsSync(path.join(ext, "model-market", "catalog.json")));
    delete process.env.CPA_BASE_URL;
    rmSync(home, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true });
  }

  // ── producer honesty ────────────────────────────────────────────────────────────────────────────────────────────
  t("no catalog ⇒ every task no-staffable", buildStaffingProjection({ tasks: [{ taskId: "t1", shape: "coding", tier: "heavy" }], snapshot: SNAP, mapTable: MAP, catalog: [], nowSec: 1 }).tasks.every((x) => x.suggestion.ok === false));

  console.log("\nmodel-staffing r2 selftest: ALL PASS");
} finally {
  if (envSave.CPA_BASE_URL === undefined) delete process.env.CPA_BASE_URL; else process.env.CPA_BASE_URL = envSave.CPA_BASE_URL;
  if (envSave.CPA_API_KEY === undefined) delete process.env.CPA_API_KEY; else process.env.CPA_API_KEY = envSave.CPA_API_KEY;
}
