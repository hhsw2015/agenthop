import {
  classifyHealth,
  disposition,
  binPack,
  desiredCount,
  forkHealthGate,
  reconcile,
  dedupeById,
  selectBackends,
  loadPlacementSpec,
  buildPlacementSuggestion,
  planPlacementSuggest,
  shouldSuggestPlacement,
  type MachineView,
  type ReconcileConfig,
  type BackendOption,
  type PlacementSpec,
  type Action,
} from "./placement-engine.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- health: liveness != readiness ---
t("non-live", classifyHealth({ live: false, ready: false }) === "non-live");
t("non-live even if 'ready' flag set (dead wins)", classifyHealth({ live: false, ready: true }) === "non-live");
t("live-not-ready", classifyHealth({ live: true, ready: false }) === "live-not-ready");
t("ready", classifyHealth({ live: true, ready: true }) === "ready");
t("disposition: dead->rebuild, booting->wait (not kill), ready->feed",
  disposition("non-live") === "rebuild" && disposition("live-not-ready") === "wait" && disposition("ready") === "feed");

// --- bin-pack: never oversubscribe; shortfall surfaces ---
const pk = binPack(5, [{ id: "a", freeCapacity: 2 }, { id: "b", freeCapacity: 1 }]);
t("binpack fills to capacity, no oversubscribe", pk.assignments["a"] === 2 && pk.assignments["b"] === 1 && pk.placed === 3);
t("binpack shortfall = unplaceable drives spawn", pk.unplaceable === 2);
t("binpack enough capacity -> 0 unplaceable", binPack(2, [{ id: "a", freeCapacity: 5 }]).unplaceable === 0);
t("binpack id can't collide with prototype key", binPack(1, [{ id: "toString", freeCapacity: 1 }]).assignments["toString"] === 1);

// --- desired count: max(board/cap, fanout) ---
t("desired from board work", desiredCount({ boardUnits: 7, fanoutMachines: 0 }, 3) === 3); // ceil(7/3)
t("desired from fanout machines", desiredCount({ boardUnits: 0, fanoutMachines: 5 }, 3) === 5);
t("desired = max of the two", desiredCount({ boardUnits: 7, fanoutMachines: 2 }, 3) === 3);
t("desired zero demand", desiredCount({ boardUnits: 0, fanoutMachines: 0 }, 3) === 0);

// --- Betabrand: fork only from a VERIFIED-healthy template (fail-closed) ---
t("fork gate: verified -> ok", forkHealthGate({ verified: true }) === true);
t("fork gate: unverified -> REFUSE", forkHealthGate({ verified: false }) === false);
t("fork gate: null template -> REFUSE", forkHealthGate(null) === false);

// --- reconcile ---
const CFG: ReconcileConfig = { perMachineCapacity: 2, floor: 1, reclaimIdleSec: 300, expiringSec: 120, minDwellSec: 60 };
const mv = (id: string, o: Partial<MachineView> = {}): MachineView => ({ id, live: true, ready: true, idleSec: 0, remainingSec: null, inFlight: 0, ...o });

// shortfall -> spawn
const r1 = reconcile({ boardUnits: 6, fanoutMachines: 0 }, [mv("a")], CFG, 999); // want=ceil(6/2)=3, healthy=1
t("shortfall -> spawn(want-healthy)", r1.some((a) => a.kind === "spawn" && a.n === 2));
// non-live -> reclaim (heal, ungated) + spawn replaces
const r2 = reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a"), mv("dead", { live: false })], CFG, 999); // want=1
t("non-live -> reclaim (heal)", r2.some((a) => a.kind === "reclaim" && a.id === "dead" && a.reason === "non-live"));
// heal is UNGATED: dead reclaimed even inside min-dwell
t("heal ungated by dwell", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a"), mv("dead", { live: false })], CFG, 0).some((a) => a.kind === "reclaim" && a.reason === "non-live"));
// expiring -> rebuild (snapshot before self-destruct)
t("expiring -> rebuild", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a", { remainingSec: 60 })], CFG, 999).some((a) => a.kind === "rebuild" && a.reason === "expiring"));
// surplus idle -> reclaim (dwell + hysteresis)
const r3 = reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a", { floor: true }), mv("b", { idleSec: 999 })], CFG, 999); // want=max(1,floor1)=1, healthy=2
t("surplus idle+empty -> reclaim non-floor", r3.some((a) => a.kind === "reclaim" && a.id === "b" && a.reason === "surplus"));
t("surplus but busy -> NOT reclaimed (hold)", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a", { floor: true }), mv("b", { idleSec: 999, inFlight: 1 })], CFG, 999).every((a) => a.kind !== "reclaim"));
t("surplus but not idle-long enough -> not reclaimed", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a", { floor: true }), mv("b", { idleSec: 10 })], CFG, 999).every((a) => a.kind !== "reclaim"));
// floor never reclaimed
t("floor machine never reclaimed", reconcile({ boardUnits: 0, fanoutMachines: 0 }, [mv("f", { floor: true, idleSec: 999 })], CFG, 999).every((a) => a.kind !== "reclaim"));
// min-dwell holds SCALE but not heal
t("scale gated by min-dwell", reconcile({ boardUnits: 6, fanoutMachines: 0 }, [mv("a")], CFG, 10).every((a) => a.kind !== "spawn"));
// at desired -> hold
t("at desired -> hold", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a")], CFG, 999).some((a) => a.kind === "hold"));
// idempotent: same inputs -> same actions
const inM = [mv("a"), mv("dead", { live: false })];
t("idempotent (same in -> same out)", JSON.stringify(reconcile({ boardUnits: 2, fanoutMachines: 0 }, inM, CFG, 999)) === JSON.stringify(reconcile({ boardUnits: 2, fanoutMachines: 0 }, inM, CFG, 999)));

// --- PE1: a machine must get ONE consistent action (never both rebuild AND reclaim) ---
{
  const acts = reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("f", { floor: true }), mv("e", { remainingSec: 60, idleSec: 999 })], CFG, 999);
  const eActs = acts.filter((a) => "id" in a && (a as any).id === "e");
  t("PE1: expiring+surplus machine gets exactly ONE action", eActs.length === 1);
  t("PE1: that action is reclaim (surplus wins over rebuild), not both", eActs[0].kind === "reclaim");
}

// --- PE2: a dead NECESSARY machine (below floor) is respawned URGENTLY even inside dwell ---
{
  const acts = reconcile({ boardUnits: 0, fanoutMachines: 0 }, [mv("x", { live: false })], CFG, 0); // floor=1, 0 live, in dwell
  t("PE2: dead reclaimed", acts.some((a) => a.kind === "reclaim" && a.reason === "non-live"));
  t("PE2: urgent spawn restores floor despite dwell", acts.some((a) => a.kind === "spawn" && (a as any).urgent === true && a.n === 1));
}
// --- PE2 (round-3): dead capacity ABOVE floor is urgently replaced; NEW growth stays dwell-gated ---
{
  // floor=1, want=2 (ceil(4/2)), one alive + one dead, in dwell: urgently replace the dead one (n=1), not just to floor.
  const a1 = reconcile({ boardUnits: 4, fanoutMachines: 0 }, [mv("a"), mv("dead", { live: false })], CFG, 0);
  t("PE2b: dead-above-floor urgently replaced in dwell (n=1)", a1.some((x) => x.kind === "spawn" && (x as any).urgent === true && x.n === 1));
  // two dead, want=3, floor=1, in dwell: urgently recover the 2 that died; the 3rd (new growth) waits for dwell.
  const a2 = reconcile({ boardUnits: 6, fanoutMachines: 0 }, [mv("d1", { live: false }), mv("d2", { live: false })], CFG, 0);
  t("PE2b: both dead urgently recovered, growth withheld (n=2)", a2.some((x) => x.kind === "spawn" && (x as any).urgent === true && x.n === 2));
  // pure growth, NO deaths, in dwell: nothing urgent — the scale waits for dwell (regression guard).
  const a3 = reconcile({ boardUnits: 6, fanoutMachines: 0 }, [mv("a"), mv("b")], CFG, 0); // want=3, 2 live, 0 dead
  t("PE2b: pure growth (no deaths) stays dwell-gated", a3.every((x) => x.kind !== "spawn"));
  // demand dropped below the dead count: only `want` replaced, surplus dead NOT replaced.
  const a4 = reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("d1", { live: false }), mv("d2", { live: false })], { ...CFG, floor: 0 }, 0); // want=1
  t("PE2b: demand-drop replaces only want, surplus dead unreplaced (n=1)", a4.some((x) => x.kind === "spawn" && x.n === 1) && !a4.some((x) => x.kind === "spawn" && x.n > 1));
}

// --- PE3: duplicate ids don't double-count / overwrite / fabricate surplus ---
t("PE3: binpack dedupes id (placed == assignment sum)", (() => { const p = binPack(5, [{ id: "a", freeCapacity: 2 }, { id: "a", freeCapacity: 2 }]); return p.placed === 2 && p.assignments["a"] === 2; })());
t("PE3: dedupeById keeps first", dedupeById([{ id: "a", v: 1 }, { id: "a", v: 2 }]).length === 1);
t("PE3: duplicate machine not reclaimed as surplus", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a"), mv("a")], CFG, 999).every((a) => a.kind !== "reclaim"));

// --- PE4: abnormal numbers -> explicit hold (never a fabricated action or false at-desired) ---
t("PE4: infinite demand -> hold (no spawn Infinity)", (() => { const a = reconcile({ boardUnits: Infinity, fanoutMachines: 0 }, [mv("a")], CFG, 999); return a.some((x) => x.kind === "hold") && a.every((x) => x.kind !== "spawn"); })());
t("PE4: NaN demand -> hold (not 'at desired')", reconcile({ boardUnits: NaN, fanoutMachines: 0 }, [mv("a")], CFG, 999).every((x) => x.kind === "hold" && x.reason === "invalid demand"));
t("PE4: floor=1.5 -> hold (non-integer count)", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a")], { ...CFG, floor: 1.5 }, 999).every((x) => x.kind === "hold"));
t("PE4: perMachineCapacity 0 -> hold", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a")], { ...CFG, perMachineCapacity: 0 }, 999).every((x) => x.kind === "hold"));
// desiredCount never fabricates: invalid or overflowing demand -> NaN (never 0, never Infinity).
t("PE4: desiredCount NaN on infinite board", Number.isNaN(desiredCount({ boardUnits: Infinity, fanoutMachines: 0 }, 2)));
t("PE4: desiredCount NaN on finite-input overflow (1e308/1e-308)", Number.isNaN(desiredCount({ boardUnits: 1e308, fanoutMachines: 0 }, 1e-308)));
t("PE4: desiredCount NaN on non-integer fanout (no silent 1.5->1)", Number.isNaN(desiredCount({ boardUnits: 0, fanoutMachines: 1.5 }, 2)));
// --- PE4 (round-3): finite inputs can still overflow; non-integer fanout must not fabricate 'at desired' ---
{
  // board 1e308 / cap 1e-308 overflows the ratio; the old code produced spawn Infinity, now an explicit hold.
  const over = reconcile({ boardUnits: 1e308, fanoutMachines: 0 }, [mv("a")], { ...CFG, perMachineCapacity: 1e-308 }, 999);
  t("PE4b: finite-input overflow -> hold, no spawn Infinity", over.some((x) => x.kind === "hold") && over.every((x) => x.kind !== "spawn"));
  // fanout 1.5 must not be floored to 1 and then reported 'at desired' with one live machine.
  const frac = reconcile({ boardUnits: 0, fanoutMachines: 1.5 }, [mv("a")], CFG, 999);
  t("PE4b: non-integer fanout -> hold 'invalid demand' (not floored, not at-desired)", frac.every((x) => x.kind === "hold" && x.reason === "invalid demand"));
}

// ============================================================================================================
// phase-2b — selectBackends (cost-aware, multi-backend; pure)
// ============================================================================================================
// money is INTEGER micro-USD (1 USD = 1_000_000 µ): $0.01 = 10_000µ, $0.30 = 300_000µ, $1 = 1_000_000µ.
const U = 1_000_000;
const opt = (backend: string, costPerMachineMicroUsd: number, freeSlots: number, priority?: number): BackendOption =>
  ({ backend, costPerMachineMicroUsd, freeSlots, ...(priority !== undefined ? { priority } : {}) });
// the clean partition invariant every outcome must satisfy — all EXACT integer (no epsilon)
const partitions = (want: number, sel: ReturnType<typeof selectBackends>): boolean =>
  sel.funded + sel.unfundedByBudget + sel.unplaceableByCapacity === want &&
  sel.funded === sel.allocation.reduce((s, a) => s + a.count, 0) &&
  sel.allocation.reduce((s, a) => s + a.costMicroUsd, 0) === sel.totalCostMicroUsd && // PE2B-1: reported total == allocation-cost sum (exact integer)
  sel.unfundedByBudget >= 0 && sel.unplaceableByCapacity >= 0;

// cheapest-first: a free tier is exhausted before any paid backend
{
  const s = selectBackends(5, [opt("gha", U / 10, 10), opt("railway", 0, 3)], 100 * U);
  t("2b: cheapest-first — free railway(3) before paid gha(2)", s.allocation[0]!.backend === "railway" && s.allocation[0]!.count === 3 && s.allocation[1]!.backend === "gha" && s.allocation[1]!.count === 2);
  t("2b: funded all 5, no shortfall", s.funded === 5 && s.unfundedByBudget === 0 && s.unplaceableByCapacity === 0 && partitions(5, s));
  t("2b: totalCost = 2 * 100_000µ", s.totalCostMicroUsd === 200_000);
}
// budget-bound: capacity exists, budget does not ⇒ unfundedByBudget (the R16 money-gate face)
{
  const s = selectBackends(10, [opt("gha", 1 * U, 10)], 3 * U);
  t("2b: budget bound — funded 3 within $3", s.funded === 3 && s.allocation[0]!.count === 3);
  t("2b: 7 unfundedByBudget (capacity existed)", s.unfundedByBudget === 7 && s.unplaceableByCapacity === 0 && partitions(10, s));
  t("2b: totalCost never exceeds budget (exact)", s.totalCostMicroUsd <= 3 * U && s.totalCostMicroUsd === 3 * U);
}
// PE2B-1: the reviewer's float-overrun case — in integer micro-USD it is EXACT: 35 * 10_000 = 350_000 == budget (funded 35, no epsilon)
{
  const s = selectBackends(100, [opt("gha", U / 100, 100)], 35 * (U / 100)); // 35 * $0.01 == $0.35 budget exactly
  t("2b PE2B-1: exact budget — 35 fit, totalCost == budget (no float overrun)", s.funded === 35 && s.totalCostMicroUsd === 350_000 && s.totalCostMicroUsd <= 350_000);
  t("2b PE2B-1: allocation cost sum === totalCostMicroUsd (exact)", s.allocation.reduce((a, x) => a + x.costMicroUsd, 0) === s.totalCostMicroUsd && partitions(100, s));
  // one micro-USD short of 35-worth ⇒ only 34 affordable (integer division, exact)
  const s2 = selectBackends(100, [opt("gha", U / 100, 100)], 35 * (U / 100) - 1);
  t("2b PE2B-1: one µUSD short ⇒ 34 funded, total <= budget", s2.funded === 34 && s2.totalCostMicroUsd <= 35 * (U / 100) - 1 && partitions(100, s2));
}
// capacity-bound: no slots at any price ⇒ unplaceableByCapacity
{
  const s = selectBackends(10, [opt("railway", 0, 4)], 1000 * U);
  t("2b: capacity bound — funded 4 (all free slots)", s.funded === 4);
  t("2b: 6 unplaceableByCapacity, 0 budget", s.unplaceableByCapacity === 6 && s.unfundedByBudget === 0 && partitions(10, s));
}
// mixed: both faces partition correctly (want 10, capacity 4, budget affords 2 of them)
{
  const s = selectBackends(10, [opt("gha", 1 * U, 4)], 2 * U);
  t("2b: mixed — funded 2, unfundedByBudget 2, unplaceableByCapacity 6", s.funded === 2 && s.unfundedByBudget === 2 && s.unplaceableByCapacity === 6 && partitions(10, s));
}
// integer floor affordability: 3 at $0.30 within $1.00 (not 4), exact
{
  const s = selectBackends(5, [opt("gha", 3 * (U / 10), 10)], 1 * U);
  t("2b: floor affordability — 3 machines within $1.00 (not 4)", s.funded === 3 && s.totalCostMicroUsd === 900_000 && s.totalCostMicroUsd <= U);
}
// free backend ignores budget (capacity-bound even at budget 0)
t("2b: free backend funds within capacity at budget 0", (() => { const s = selectBackends(3, [opt("railway", 0, 5)], 0); return s.funded === 3 && s.totalCostMicroUsd === 0; })());
// deterministic tiebreak: equal cost -> priority -> name (NO timestamp, FC-6)
{
  const s = selectBackends(1, [opt("zzz", U, 5, 5), opt("aaa", U, 5, 5), opt("mmm", U, 5, 1)], 100 * U);
  t("2b: tie broken by priority then name (mmm prio 1 wins)", s.allocation[0]!.backend === "mmm");
  const s2 = selectBackends(1, [opt("zzz", U, 5), opt("aaa", U, 5)], 100 * U);
  t("2b: equal cost+priority -> backend name asc (aaa)", s2.allocation[0]!.backend === "aaa");
}
// PE2B-3: an invalid (NaN) priority must not reach the comparator — the option is dropped; selection is order-independent
{
  const za = selectBackends(1, [opt("z", U, 5, NaN), opt("a", U, 5)], U);
  const az = selectBackends(1, [opt("a", U, 5), opt("z", U, 5, NaN)], U);
  t("2b PE2B-3: NaN priority dropped -> valid 'a' wins regardless of input order", za.allocation[0]!.backend === "a" && az.allocation[0]!.backend === "a");
  t("2b PE2B-3: NaN-priority option never allocated", !za.allocation.some((x) => x.backend === "z") && !az.allocation.some((x) => x.backend === "z"));
  const z0 = selectBackends(1, [opt("z", U, 5, 0), opt("a", U, 5, 0)], U);
  t("2b PE2B-3: VALID equal priority -> name tiebreak 'a' (both present)", z0.allocation[0]!.backend === "a");
  t("2b PE2B-3: Infinity priority also dropped", !selectBackends(1, [opt("z", U, 5, Infinity), opt("a", U, 5)], U).allocation.some((x) => x.backend === "z"));
}
// PE2B-1: a non-integer (float) cost is an invalid option and is dropped (money must be integer micro-USD)
t("2b PE2B-1: float cost option dropped (money is integer µUSD)", (() => { const s = selectBackends(2, [opt("gha", 0.5, 5), opt("railway", 0, 5)], 100 * U); return s.funded === 2 && s.allocation.every((a) => a.backend === "railway"); })());
// dedupe a repeated backend (first wins; capacity not doubled)
{
  const s = selectBackends(10, [opt("railway", 0, 3), opt("railway", 0, 99)], 100 * U);
  t("2b: duplicate backend deduped (first 3 slots, not 99)", s.funded === 3 && s.allocation.length === 1);
}
// invalid inputs: fail-closed (never fabricate a spawn)
t("2b: want 0 -> empty", selectBackends(0, [opt("railway", 0, 5)], 100 * U).allocation.length === 0);
t("2b: negative want -> empty", selectBackends(-3, [opt("railway", 0, 5)], 100 * U).funded === 0);
t("2b PE2B-2: non-integer want REJECTED (2.9 -> empty, no floor to 2)", (() => { const s = selectBackends(2.9, [opt("railway", 0, 5)], 100 * U); return s.allocation.length === 0 && s.funded === 0; })());
t("2b PE2B-2: Infinity want -> empty", selectBackends(Infinity, [opt("railway", 0, 5)], 100 * U).allocation.length === 0);
t("2b PE2B-2: beyond-safe-integer want -> empty", selectBackends(Number.MAX_SAFE_INTEGER + 2, [opt("railway", 0, 5)], 100 * U).allocation.length === 0);
t("2b: NaN want -> empty", selectBackends(NaN, [opt("railway", 0, 5)], 100 * U).allocation.length === 0);
t("2b: invalid budget (NaN) -> only free backends fund", (() => { const s = selectBackends(3, [opt("gha", U, 5), opt("railway", 0, 5)], NaN); return s.funded === 3 && s.allocation.every((a) => a.backend === "railway"); })());
t("2b: non-integer budget -> treated as 0 (only free)", (() => { const s = selectBackends(3, [opt("gha", U, 5), opt("railway", 0, 5)], 2.5 * U + 0.5); return s.allocation.every((a) => a.backend === "railway"); })());
t("2b: invalid option fields dropped (negative cost)", (() => { const s = selectBackends(2, [{ backend: "bad", costPerMachineMicroUsd: -1, freeSlots: 5 }, opt("railway", 0, 5)], 100 * U); return s.funded === 2 && s.allocation.every((a) => a.backend === "railway"); })());
t("2b: no options -> all unplaceableByCapacity", (() => { const s = selectBackends(4, [], 100 * U); return s.unplaceableByCapacity === 4 && s.funded === 0 && partitions(4, s); })());

// ============================================================================================================
// placement wiring (suggestion mode) — loadPlacementSpec / buildPlacementSuggestion / planPlacementSuggest (pure)
// ============================================================================================================
const specOf = (over: Partial<PlacementSpec> = {}): PlacementSpec => ({
  demand: { boardUnits: 10, fanoutMachines: 0 },
  cfg: { perMachineCapacity: 1, floor: 0, reclaimIdleSec: 60, expiringSec: 30, minDwellSec: 0 },
  backends: [{ backend: "railway", costPerMachineMicroUsd: 0, freeSlots: 3 }, { backend: "gha", costPerMachineMicroUsd: 1_000_000, freeSlots: 100 }],
  budgetMicroUsd: 5_000_000,
  ...over,
});

// --- loadPlacementSpec: validate + rebuild (fail-closed) ---
t("spec: valid -> ok", loadPlacementSpec(specOf()).ok === true);
t("spec: non-object -> reject", loadPlacementSpec(42).ok === false);
t("spec: missing demand -> reject", loadPlacementSpec({ ...specOf(), demand: undefined }).ok === false);
t("spec: negative boardUnits -> reject", loadPlacementSpec({ ...specOf(), demand: { boardUnits: -1, fanoutMachines: 0 } }).ok === false);
t("spec: non-integer fanoutMachines -> reject", loadPlacementSpec({ ...specOf(), demand: { boardUnits: 0, fanoutMachines: 1.5 } }).ok === false);
t("spec: perMachineCapacity 0 -> reject", loadPlacementSpec({ ...specOf(), cfg: { ...specOf().cfg, perMachineCapacity: 0 } }).ok === false);
t("spec: negative minDwellSec -> reject", loadPlacementSpec({ ...specOf(), cfg: { ...specOf().cfg, minDwellSec: -1 } }).ok === false);
t("spec: backends not array -> reject", loadPlacementSpec({ ...specOf(), backends: "x" }).ok === false);
t("spec: FLOAT cost in a backend -> reject (money is integer µUSD)", loadPlacementSpec({ ...specOf(), backends: [{ backend: "x", costPerMachineMicroUsd: 0.5, freeSlots: 1 }] }).ok === false);
t("spec: NaN priority in a backend -> reject", loadPlacementSpec({ ...specOf(), backends: [{ backend: "x", costPerMachineMicroUsd: 0, freeSlots: 1, priority: NaN }] }).ok === false);
t("spec: float budget -> reject", loadPlacementSpec({ ...specOf(), budgetMicroUsd: 1.5 }).ok === false);
t("spec: negative budget -> reject", loadPlacementSpec({ ...specOf(), budgetMicroUsd: -1 }).ok === false);
t("spec: rebuilt from validated reads (extra keys dropped)", (() => {
  const r = loadPlacementSpec({ ...specOf(), evil: 1, demand: { boardUnits: 2, fanoutMachines: 0, extra: 9 } });
  return r.ok && (r.spec as any).evil === undefined && (r.spec.demand as any).extra === undefined && r.spec.demand.boardUnits === 2;
})());

// --- buildPlacementSuggestion: the three spawn faces + reclaim/rebuild advisories ---
{
  const sel = selectBackends(5, [{ backend: "railway", costPerMachineMicroUsd: 0, freeSlots: 5 }], 0);
  const sug = buildPlacementSuggestion([{ kind: "spawn", n: 5 }], sel);
  t("suggest: funded plan -> hasContent + spawnFunded", sug.hasContent && sug.spawnFunded === 5 && /spawn plan/.test(sug.text) && /railway: 5/.test(sug.text));
}
{
  const sel = selectBackends(10, [{ backend: "gha", costPerMachineMicroUsd: 1_000_000, freeSlots: 10 }], 3_000_000);
  const sug = buildPlacementSuggestion([{ kind: "spawn", n: 10 }], sel);
  t("suggest: over-budget -> R16 user money gate line", sug.needUserGate === 7 && /USER MONEY GATE \(R16\)/.test(sug.text));
}
{
  const sel = selectBackends(10, [{ backend: "railway", costPerMachineMicroUsd: 0, freeSlots: 4 }], 0);
  const sug = buildPlacementSuggestion([{ kind: "spawn", n: 10 }], sel);
  t("suggest: capacity gap -> capacity shortfall line", sug.capacityGap === 6 && /capacity shortfall/.test(sug.text));
}
t("suggest: reclaim + rebuild advised (never executed)", (() => {
  const sug = buildPlacementSuggestion([{ kind: "reclaim", id: "m1", reason: "surplus" }, { kind: "rebuild", id: "m2", reason: "expiring" }], null);
  return sug.hasContent && sug.reclaims === 1 && sug.rebuilds === 1 && /advise reclaim m1/.test(sug.text) && /advise rebuild m2/.test(sug.text);
})());
t("suggest: pure hold -> no content (caller sends nothing)", buildPlacementSuggestion([{ kind: "hold", reason: "at desired" }], null).hasContent === false);
t("suggest: SUGGESTION MODE banner always present (never auto-acts)", /SUGGESTION MODE/.test(buildPlacementSuggestion([{ kind: "spawn", n: 1 }], selectBackends(1, [{ backend: "railway", costPerMachineMicroUsd: 0, freeSlots: 1 }], 0)).text));

// --- planPlacementSuggest: the full chain (reconcile -> selectBackends -> fold), empty actual machines ---
t("plan: demand 10, free cap 3 + paid $1 cap 100, budget $7 -> funded 10 (3 free + 7 paid within budget)", (() => {
  const sug = planPlacementSuggest(specOf({ budgetMicroUsd: 7_000_000 }), []);
  return sug.hasContent && sug.spawnFunded === 10 && sug.needUserGate === 0;
})());
t("plan: same but budget $5 -> funded 8 (3 free + 5 paid), 2 need R16 gate", (() => {
  const sug = planPlacementSuggest(specOf(), []); // specOf budget = $5
  return sug.spawnFunded === 8 && sug.needUserGate === 2;
})());
t("plan: demand 10, only paid $1/machine, budget $3 -> 3 funded, 7 need R16 gate", (() => {
  const sug = planPlacementSuggest(specOf({ backends: [{ backend: "gha", costPerMachineMicroUsd: 1_000_000, freeSlots: 100 }], budgetMicroUsd: 3_000_000 }), []);
  return sug.spawnFunded === 3 && sug.needUserGate === 7;
})());
t("plan: demand 10, total capacity 4 -> 6 capacity gap", (() => {
  const sug = planPlacementSuggest(specOf({ backends: [{ backend: "railway", costPerMachineMicroUsd: 0, freeSlots: 4 }] }), []);
  return sug.capacityGap === 6;
})());
t("plan: zero demand + floor 0 + no machines -> pure hold, no content", (() => {
  const sug = planPlacementSuggest(specOf({ demand: { boardUnits: 0, fanoutMachines: 0 }, cfg: { perMachineCapacity: 1, floor: 0, reclaimIdleSec: 60, expiringSec: 30, minDwellSec: 0 } }), []);
  return sug.hasContent === false;
})());
// PW-1: in suggestion mode the plan is ALWAYS the FULL demand — never reconcile's urgent-FLOOR subset (which only exists inside
// an unexpired ACTION dwell). With demand 10 + floor 2 + a HIGH minDwellSec, the advisory is still funded=full (3), not floor=2.
t("PW-1: full demand advised regardless of floor/minDwell (never the floor subset)", (() => {
  const sug = planPlacementSuggest(specOf({ demand: { boardUnits: 10, fanoutMachines: 0 }, cfg: { perMachineCapacity: 1, floor: 2, reclaimIdleSec: 60, expiringSec: 30, minDwellSec: 300 }, backends: [{ backend: "gha", costPerMachineMicroUsd: 1_000_000, freeSlots: 100 }], budgetMicroUsd: 3_000_000 }), []);
  return sug.spawnFunded === 3 && sug.needUserGate === 7; // full demand (want 10): 3 funded + 7 gate — NOT floor 2 / gate 0
})());

// --- shouldSuggestPlacement: the NOTICE dwell (separate clock from reconcile's action dwell) ---
t("notice-dwell: first ever (last 0) fires", shouldSuggestPlacement(1000, 0, 300) === true);
t("notice-dwell: within window throttled", shouldSuggestPlacement(1005, 1000, 300) === false);
t("notice-dwell: at boundary fires (>=)", shouldSuggestPlacement(1300, 1000, 300) === true);
t("notice-dwell: minDwell 0 -> always (no throttle)", shouldSuggestPlacement(1001, 1000, 0) === true);
t("notice-dwell: non-finite clock -> never", shouldSuggestPlacement(NaN, 0, 300) === false);
t("notice-dwell: invalid dwell -> always", shouldSuggestPlacement(1000, 0, NaN) === true && shouldSuggestPlacement(1000, 0, -5) === true);

// PW-1 counterexample PINNED: the reviewer's timeline — a floor advisory must NOT re-fire every notice window and reset `last`,
// starving the full-demand advisory. Simulate the wiring tick (shouldSuggestPlacement gate → plan → deliver → last advances ONLY
// on delivery). Every delivery is the FULL demand (funded 3 / gate 7), and it re-matures exactly every minDwell (300s) — not 61s.
{
  const sim = (floor: number) => {
    const spec = specOf({ demand: { boardUnits: 10, fanoutMachines: 0 }, cfg: { perMachineCapacity: 1, floor, reclaimIdleSec: 60, expiringSec: 30, minDwellSec: 300 }, backends: [{ backend: "gha", costPerMachineMicroUsd: 1_000_000, freeSlots: 100 }], budgetMicroUsd: 3_000_000 });
    let last = 0;
    const delivered: Array<{ now: number; funded: number; gate: number }> = [];
    for (const now of [1000, 1005, 1066, 1127, 1188, 1249, 1300, 1305]) {
      if (!shouldSuggestPlacement(now, last, spec.cfg.minDwellSec)) continue; // notice gate
      const sug = planPlacementSuggest(spec, []);
      if (sug.hasContent) { delivered.push({ now, funded: sug.spawnFunded, gate: sug.needUserGate }); last = now; } // only delivered advances `last`
    }
    return delivered;
  };
  const pos = sim(2); // the PW-1 positive-floor config
  t("PW-1 pinned: positive floor delivers ONLY at t=1000 and t=1300 (not every 61s)", pos.length === 2 && pos[0]!.now === 1000 && pos[1]!.now === 1300);
  t("PW-1 pinned: every delivery is the FULL demand (funded 3 / gate 7), never the floor subset (2 / 0)", pos.every((d) => d.funded === 3 && d.gate === 7));
  const zero = sim(0); // the reviewer's zero-floor control
  t("PW-1 pinned: zero-floor control has the SAME cadence (t=1000, t=1300)", zero.length === 2 && zero[0]!.now === 1000 && zero[1]!.now === 1300 && zero.every((d) => d.funded === 3 && d.gate === 7));
}

console.log("all placement-engine selftests passed");
