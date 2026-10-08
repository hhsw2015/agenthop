import {
  classifyHealth,
  disposition,
  binPack,
  desiredCount,
  forkHealthGate,
  reconcile,
  dedupeById,
  type MachineView,
  type ReconcileConfig,
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

// --- PE3: duplicate ids don't double-count / overwrite / fabricate surplus ---
t("PE3: binpack dedupes id (placed == assignment sum)", (() => { const p = binPack(5, [{ id: "a", freeCapacity: 2 }, { id: "a", freeCapacity: 2 }]); return p.placed === 2 && p.assignments["a"] === 2; })());
t("PE3: dedupeById keeps first", dedupeById([{ id: "a", v: 1 }, { id: "a", v: 2 }]).length === 1);
t("PE3: duplicate machine not reclaimed as surplus", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a"), mv("a")], CFG, 999).every((a) => a.kind !== "reclaim"));

// --- PE4: abnormal numbers -> explicit hold (never a fabricated action or false at-desired) ---
t("PE4: infinite demand -> hold (no spawn Infinity)", (() => { const a = reconcile({ boardUnits: Infinity, fanoutMachines: 0 }, [mv("a")], CFG, 999); return a.some((x) => x.kind === "hold") && a.every((x) => x.kind !== "spawn"); })());
t("PE4: NaN demand -> hold (not 'at desired')", reconcile({ boardUnits: NaN, fanoutMachines: 0 }, [mv("a")], CFG, 999).every((x) => x.kind === "hold" && x.reason === "invalid demand"));
t("PE4: floor=1.5 -> hold (non-integer count)", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a")], { ...CFG, floor: 1.5 }, 999).every((x) => x.kind === "hold"));
t("PE4: perMachineCapacity 0 -> hold", reconcile({ boardUnits: 2, fanoutMachines: 0 }, [mv("a")], { ...CFG, perMachineCapacity: 0 }, 999).every((x) => x.kind === "hold"));
t("PE4: desiredCount never returns Infinity", Number.isFinite(desiredCount({ boardUnits: Infinity, fanoutMachines: 0 }, 2)) && desiredCount({ boardUnits: Infinity, fanoutMachines: 0 }, 2) === 0);

console.log("all placement-engine selftests passed");
