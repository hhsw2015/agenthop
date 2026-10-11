// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/attribution-wiring.selftest.mts
//
// Pins the WIRING of the attribution SOURCE tag (SWARM_ATTRIBUTION) into the LIVE control-log task axis:
//  (a) a plan WITH provenance + flag ON  ⇒ the dispatched intent carries `accountable` at the highest-priority level;
//  (b) flag OFF (SWARM_ATTRIBUTION=0)    ⇒ no `accountable` on the intent;
//  (c) a plan WITHOUT provenance         ⇒ no `accountable`;
//  (d) read-side FC-7: a malformed intent.accountable (replayLog) AND a malformed plan.provenance (loadPlan) both parse
//      fine with ONLY the bad field dropped — never a whole reject.
// (e) resolveAccountable itself is BYTE-UNCHANGED — covered by attribution.selftest.mts (run separately).
//
// The attribution math (resolveAccountable) lives in the pure core; this selftest only proves the SEAM: compute-at-caller
// (gated on attributionEnabled), stamp-on-intent, and read-side tolerance.

import {
  commit, entityKeyOf, initialLogState, liveEntities, replayLog,
  type ChangeBody, type LogState, type DispatchIntent, type Change, type CommittedBatch,
} from "./control-log.js";
import { loadPlan, type TaskPlan } from "./task-plan.js";
import { taskPass, type TaskOps } from "./task-pass.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- the real shell's commit stamping (operationId = entityKey#targetRev, expectedEntityRevision = current rev) ---
function stampCommit(state: LogState, bodies: ChangeBody[]): { state: LogState; result: ReturnType<typeof commit>["result"] } {
  const changes: Change[] = bodies.map((b) => {
    const key = entityKeyOf(b);
    const rev = state.revisions[key] ?? 0;
    return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev };
  });
  const r = commit(state, state.seq, changes);
  return { state: r.state, result: r.result };
}

function mkOps(stateRef: { s: LogState }): TaskOps {
  let lid = 0;
  return {
    nowSec: () => 1000, cap: 3, budgetSec: 3480, planCommittedAtSec: 1000, remainingLifeSec: 3000, checkpointBudgetSec: 300,
    handoffMarginSec: 180, tokenMarginSec: 600, jitterSec: () => 0,
    newLaunchId: () => `rw-t${++lid}`,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { const r = stampCommit(state, bodies); stateRef.s = r.state; return r; },
    observeGit: async () => null,
    startTask: async () => ({ alloc: "created", delivered: true }),
    log: () => {},
  };
}

function mkPlan(provenance?: Record<string, unknown>): TaskPlan {
  const res = loadPlan({
    jobId: "job", planRevision: 1,
    nodes: [{ nodeId: "build", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
    ...(provenance !== undefined ? { provenance } : {}),
  });
  if (!res.ok) throw new Error(res.reason);
  return res.plan;
}

function theIntent(state: LogState): DispatchIntent | undefined {
  for (const b of Object.values(liveEntities(state))) if (b.put === "intent") return b.intent;
  return undefined;
}

async function dispatchWith(plan: TaskPlan): Promise<DispatchIntent | undefined> {
  const stateRef = { s: initialLogState() };
  await taskPass(plan, mkOps(stateRef));
  return theIntent(stateRef.s);
}

// save/restore the kill-switch across cases
const savedFlag = process.env.SWARM_ATTRIBUTION;
const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env.SWARM_ATTRIBUTION; else process.env.SWARM_ATTRIBUTION = v; };

try {
  // ---------------- (a) provenance + flag ON ⇒ accountable at the HIGHEST-priority level that resolves ----------------
  setFlag(undefined); // default ON
  {
    // full ladder present ⇒ "direct" wins (highest priority), never a lower level or a clock
    const i = await dispatchWith(mkPlan({ directHuman: "u-direct", delegationOriginHuman: "u-deleg", commentSourceHuman: "u-comment", automationOwnerHuman: "u-auto", fallbackHuman: "u-fb" }));
    t("(a) flag default-ON + full provenance ⇒ intent.accountable = highest level (direct)",
      !!i && !!i.accountable && i.accountable.accountableHuman === "u-direct" && i.accountable.resolutionLevel === "direct");

    // only a lower rung present ⇒ that rung resolves (proves it is not hard-wired to "direct")
    const i2 = await dispatchWith(mkPlan({ automationOwnerHuman: "u-auto", fallbackHuman: "u-fb" }));
    t("(a) partial provenance ⇒ accountable at the first resolving rung (automation-owner)",
      !!i2 && !!i2.accountable && i2.accountable.accountableHuman === "u-auto" && i2.accountable.resolutionLevel === "automation-owner");

    // explicit SWARM_ATTRIBUTION=1 behaves identically
    setFlag("1");
    const i3 = await dispatchWith(mkPlan({ fallbackHuman: "only-fb" }));
    t("(a) SWARM_ATTRIBUTION=1 ⇒ accountable stamped (fallback)",
      !!i3 && !!i3.accountable && i3.accountable.accountableHuman === "only-fb" && i3.accountable.resolutionLevel === "fallback");

    // provenance present but NO level resolves (all whitespace) ⇒ resolveAccountable null ⇒ NO accountable (never invent)
    setFlag(undefined);
    const i4 = await dispatchWith(mkPlan({ directHuman: "   " }));
    t("(a) provenance present but unresolvable (whitespace) ⇒ no accountable (never invent a human)", !!i4 && i4.accountable === undefined);
  }

  // ---------------- (b) flag OFF ⇒ no accountable even with full provenance ----------------
  setFlag("0");
  {
    const i = await dispatchWith(mkPlan({ directHuman: "u-direct", fallbackHuman: "u-fb" }));
    t("(b) SWARM_ATTRIBUTION=0 ⇒ NO accountable on the intent (kill-switch)", !!i && i.accountable === undefined);
  }
  setFlag("false");
  {
    const i = await dispatchWith(mkPlan({ directHuman: "u-direct" }));
    t("(b) SWARM_ATTRIBUTION=false ⇒ NO accountable", !!i && i.accountable === undefined);
  }

  // ---------------- (c) no provenance ⇒ no accountable (flag ON) ----------------
  setFlag(undefined);
  {
    const i = await dispatchWith(mkPlan(undefined));
    t("(c) flag ON but plan has NO provenance ⇒ no accountable", !!i && i.accountable === undefined);
  }

  // ---------------- (d) read-side FC-7 tolerance ----------------
  // (d1) a malformed intent.accountable on the control log ⇒ replayLog drops just that field, projects the intent fine.
  {
    const base: DispatchIntent = {
      intentId: "i1", attemptId: "a1", nodeId: "build", launchId: "rw-1", bindingId: "b1", assignmentDigest: "d",
      allocRequestStartSec: 0, workDeadlineSec: 100, allocOutcome: "created", status: "confirmed",
    };
    const mkBatch = (acc: unknown): CommittedBatch => ({
      seq: 1,
      changes: [{ put: "intent", intent: { ...base, accountable: acc as DispatchIntent["accountable"] }, operationId: "intent:i1#1", expectedEntityRevision: 0 }],
    });
    const projOf = (b: CommittedBatch) => theIntent(replayLog([b]));

    t("(d1) malformed accountable: non-object ⇒ dropped, intent survives", (() => { const i = projOf(mkBatch("nope")); return !!i && i.accountable === undefined && i.intentId === "i1"; })());
    t("(d1) malformed accountable: unknown level ⇒ dropped", (() => { const i = projOf(mkBatch({ accountableHuman: "u", resolutionLevel: "blame" })); return !!i && i.accountable === undefined; })());
    t("(d1) malformed accountable: empty/whitespace human ⇒ dropped", (() => { const i = projOf(mkBatch({ accountableHuman: "   ", resolutionLevel: "direct" })); return !!i && i.accountable === undefined; })());
    t("(d1) malformed accountable: lone half (human, no level) ⇒ dropped", (() => { const i = projOf(mkBatch({ accountableHuman: "u" })); return !!i && i.accountable === undefined; })());
    t("(d1) malformed accountable: non-string human ⇒ dropped", (() => { const i = projOf(mkBatch({ accountableHuman: 7, resolutionLevel: "direct" })); return !!i && i.accountable === undefined; })());
    t("(d1) VALID accountable is kept (and stripped to its two known fields)", (() => {
      const i = projOf(mkBatch({ accountableHuman: "wowdd1", resolutionLevel: "delegated", extra: "junk" }));
      return !!i && !!i.accountable && i.accountable.accountableHuman === "wowdd1" && i.accountable.resolutionLevel === "delegated" && (i.accountable as Record<string, unknown>).extra === undefined;
    })());
    t("(d1) a legacy intent with NO accountable field replays unchanged", (() => {
      const legacy: CommittedBatch = { seq: 1, changes: [{ put: "intent", intent: base, operationId: "intent:i1#1", expectedEntityRevision: 0 }] };
      const i = theIntent(replayLog([legacy]));
      return !!i && i.accountable === undefined && i.allocOutcome === "created";
    })());
  }

  // (d3) AW-1: the read-side tolerance trims the ENTITY VIEW ONLY — the OPERATION digest stays on the committed payload. So a
  // historical record with a malformed/extra accountable still accepts a BYTE-IDENTICAL retry (idempotent replay, NOT a spurious
  // op-conflict), while a genuinely DIFFERENT payload for the same operationId still conflicts. (Regression for the op-identity
  // corruption: trimming the change BEFORE applyChanges recomputed operations[opId] off the cleaned payload.)
  {
    const b9: DispatchIntent = {
      intentId: "i9", attemptId: "a9", nodeId: "build", launchId: "rw-9", bindingId: "b9", assignmentDigest: "d",
      allocRequestStartSec: 0, workDeadlineSec: 100, allocOutcome: "created", status: "confirmed",
    };
    const mkChange = (acc: unknown): Change => ({ put: "intent", intent: { ...b9, accountable: acc as DispatchIntent["accountable"] }, operationId: "intent:i9#1", expectedEntityRevision: 0 });
    for (const [label, acc] of ([["valid+extra", { accountableHuman: "u", resolutionLevel: "direct", extra: "junk" }], ["unknown-level", { accountableHuman: "u", resolutionLevel: "blame" }], ["non-object", "nope"]] as const)) {
      const orig = mkChange(acc);
      const state = replayLog([{ seq: 1, changes: [orig] }]); // the "new reader" folds the historical (tolerated) record
      const retry = commit(state, state.seq, [orig]);          // a byte-identical retry of the ORIGINAL committed payload
      t(`(d3) AW-1: historical ${label} accountable ⇒ byte-identical retry is idempotent (no op-conflict)`, retry.result.ok === true && (retry.result as { replay?: boolean }).replay === true);
    }
    // the entity VIEW is still canonicalized (an extra key dropped) even though the op digest kept the original payload
    const trimmed = theIntent(replayLog([{ seq: 1, changes: [mkChange({ accountableHuman: "u", resolutionLevel: "direct", extra: "junk" })] }]));
    t("(d3) AW-1: entity view trimmed to the canonical pair (extra dropped)", !!trimmed && !!trimmed.accountable && (trimmed.accountable as Record<string, unknown>).extra === undefined);
    // a genuinely DIFFERENT payload for the SAME operationId ⇒ op-conflict STILL enforced (the fix must not weaken this)
    const base9 = replayLog([{ seq: 1, changes: [mkChange({ accountableHuman: "u", resolutionLevel: "direct" })] }]);
    const conflict = commit(base9, base9.seq, [mkChange({ accountableHuman: "SOMEONE-ELSE", resolutionLevel: "direct" })]);
    t("(d3) AW-1: a genuinely different payload for the same op ⇒ op-conflict preserved", conflict.result.ok === false && (conflict.result as { reason?: string }).reason === "op-conflict");
  }

  // (d2) a plan with malformed provenance ⇒ loadPlan OK, provenance dropped; a plan with a valid-but-partial provenance keeps it.
  {
    const withProv = (p: unknown) => loadPlan({
      jobId: "job", planRevision: 1,
      nodes: [{ nodeId: "build", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
      jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
      provenance: p,
    });
    const okPlan = (p: unknown) => { const r = withProv(p); if (!r.ok) throw new Error("loadPlan rejected: " + r.reason); return r.plan; };

    t("(d2) provenance not an object (string) ⇒ plan loads, provenance dropped", okPlan("nope").provenance === undefined);
    t("(d2) provenance null ⇒ plan loads, provenance dropped", okPlan(null).provenance === undefined);
    t("(d2) provenance with ONLY garbage keys ⇒ plan loads, provenance dropped", okPlan({ bogus: "x", directHuman: 7 }).provenance === undefined);
    t("(d2) provenance with mixed good+garbage ⇒ keeps ONLY the known string fields", (() => {
      const p = okPlan({ directHuman: "u-d", bogus: "x", automationOwnerHuman: "u-a", fallbackHuman: 9 }).provenance!;
      return p.directHuman === "u-d" && p.automationOwnerHuman === "u-a"
        && (p as Record<string, unknown>).bogus === undefined && p.fallbackHuman === undefined;
    })());
    t("(d2) a valid partial provenance round-trips through loadPlan", (() => {
      const p = okPlan({ delegationOriginHuman: "boss" }).provenance!;
      return p.delegationOriginHuman === "boss" && Object.keys(p).length === 1;
    })());
    // FC-7: a legacy plan with NO provenance still loads, field absent.
    t("(d2) legacy plan with no provenance ⇒ loads, provenance undefined", mkPlan(undefined).provenance === undefined);
  }

  console.log("\nattribution-wiring self-check OK");
} finally {
  setFlag(savedFlag);
}
