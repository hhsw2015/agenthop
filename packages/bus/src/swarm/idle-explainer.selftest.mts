// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/idle-explainer.selftest.mts
//
// Pins the idle-root-cause explainer (北极星差距审计件①):
//  PURE core (idle-explainer.ts): idleReason wording, the FC-2 r3 anomaly rule (idle + every signal a CONFIRMED zero; a null ⇒
//    NOT an anomaly), the anomaly-onset dedup, buildIdleExplainer shape, the flag.
//  STORE IO (idle-explainer-store.ts): countWorkingWaits distinguishes kind:"wait" (active work) from kind:"approval" (awaiting
//    ruling, NOT counted) and errno-discriminates (ENOENT ⇒ 0, unreadable ⇒ null); readIdleSignals reads the four sources;
//    writeIdleExplainer round-trips the projection and refuses a symlinked console dir (CP-3).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  idleExplainerEnabled, idleReason, isIdleAnomaly, shouldAlertOnset, buildIdleExplainer,
  IDLE_EXPLAINER_SCHEMA, type IdleSignals,
} from "./idle-explainer.js";
import { countWorkingWaits, readIdleSignals, writeIdleExplainer } from "./idle-explainer-store.js";
import { entityKeyOf, initialLogState, type Change, type WaitRecord, type WaitKind, type WaitState } from "./control-log.js";
import { commitControl } from "./control-store.js";
import { openBatch, writeDecisions, consumeDecisions } from "./decision-batch-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "idle-expl-"));
const controlLogDir = (home: string) => path.join(home, ".agenthop", "swarm", "control-log");
const explainerFile = (home: string) => path.join(home, ".agenthop", "swarm", "console", "idle-explainer.json");
const canTestPerms = (process.getuid?.() ?? 0) !== 0;
const S0: IdleSignals = { unclaimedInboxes: 0, reviewQueueDepth: 0, awaitingRuling: 0, userGates: 0 };

// seed one control-log wait of a given kind/state (via the real commitControl, so it lands on disk as countWorkingWaits reads it).
function seedWait(home: string, state0: ReturnType<typeof initialLogState>, waitId: string, kind: WaitKind, state: WaitState): ReturnType<typeof initialLogState> {
  const wait: WaitRecord = { waitId, kind, subject: { jobId: "job" }, state, deadlineSec: 0, owner: "m1", timeoutPolicy: "bypass" };
  const key = entityKeyOf({ put: "wait", wait });
  const change: Change = { put: "wait", wait, operationId: `${key}#1`, expectedEntityRevision: 0 };
  const r = commitControl(controlLogDir(home), state0, [change]);
  if (!r.result.ok) throw new Error("seedWait commit rejected: " + JSON.stringify(r.result));
  return r.state;
}

// =====================================================================================================================
// PURE — flag
// =====================================================================================================================
t("flag default-ON (unset)", idleExplainerEnabled({} as NodeJS.ProcessEnv) === true);
t("flag kill-switch '0'", idleExplainerEnabled({ SWARM_IDLE_EXPLAINER: "0" } as NodeJS.ProcessEnv) === false);
t("flag kill-switch 'off'", idleExplainerEnabled({ SWARM_IDLE_EXPLAINER: "off" } as NodeJS.ProcessEnv) === false);

// =====================================================================================================================
// PURE — idleReason
// =====================================================================================================================
t("reason: not idle ⇒ active", idleReason(false, S0) === "active");
t("reason: awaiting-ruling listed first", idleReason(true, { ...S0, awaitingRuling: 3 }).includes("3 awaiting ruling"));
t("reason: review listed", idleReason(true, { ...S0, reviewQueueDepth: 2 }).includes("2 in review"));
t("reason: unclaimed boxes listed", idleReason(true, { ...S0, unclaimedInboxes: 5 }).includes("5 unclaimed in boxes"));
t("reason: user gate listed", idleReason(true, { ...S0, userGates: 1 }).includes("1 awaiting user"));
t("reason: multiple waits joined", (() => { const r = idleReason(true, { unclaimedInboxes: 1, reviewQueueDepth: 2, awaitingRuling: 3, userGates: 4 }); return r.includes("3 awaiting ruling") && r.includes("2 in review") && r.includes("1 unclaimed") && r.includes("4 awaiting user"); })());
t("reason: all confirmed zero ⇒ genuine stall", idleReason(true, S0).includes("genuine stall"));
t("reason: a null signal ⇒ 'unreadable', NOT genuine stall", (() => { const r = idleReason(true, { ...S0, awaitingRuling: null }); return r.includes("unreadable") && r.includes("ruling") && !r.includes("genuine stall"); })());

// =====================================================================================================================
// PURE — isIdleAnomaly (FC-2 r3)
// =====================================================================================================================
t("anomaly: idle + all confirmed zero ⇒ true", isIdleAnomaly(true, S0) === true);
t("anomaly: idle + a positive signal ⇒ false", isIdleAnomaly(true, { ...S0, awaitingRuling: 1 }) === false);
t("anomaly: idle + a NULL signal ⇒ false (unknown ≠ empty)", isIdleAnomaly(true, { ...S0, unclaimedInboxes: null }) === false);
t("anomaly: NOT idle ⇒ false", isIdleAnomaly(false, S0) === false);

// =====================================================================================================================
// PURE — shouldAlertOnset + buildIdleExplainer
// =====================================================================================================================
t("onset: false→true ⇒ alert", shouldAlertOnset(false, true) === true);
t("onset: true→true ⇒ no re-alert", shouldAlertOnset(true, true) === false);
t("onset: true→false ⇒ no alert", shouldAlertOnset(true, false) === false);
t("onset: false→false ⇒ no alert", shouldAlertOnset(false, false) === false);
{
  const e = buildIdleExplainer({ idle: true, idleSource: "wait-ledger", signals: S0, nowSec: 7 });
  t("build: schema + generatedAtSec + idle + source", e.schema === IDLE_EXPLAINER_SCHEMA && e.generatedAtSec === 7 && e.idle === true && e.idleSource === "wait-ledger");
  t("build: anomaly derived + reason composed", e.anomaly === true && e.reason.includes("genuine stall"));
  const e2 = buildIdleExplainer({ idle: false, idleSource: "none", signals: S0, nowSec: 8 });
  t("build: not-idle ⇒ reason active, anomaly false", e2.reason === "active" && e2.anomaly === false);
}

// =====================================================================================================================
// STORE — countWorkingWaits (kind:"wait" = active; kind:"approval" = awaiting ruling, NOT active; errno-discriminated)
// =====================================================================================================================
{
  const home = tmpHome();
  t("countWorkingWaits: no control-log (ENOENT) ⇒ 0 (confirmed none)", countWorkingWaits(home) === 0);
  let st = initialLogState();
  st = seedWait(home, st, "w1", "wait", "open");
  t("countWorkingWaits: one open kind:wait ⇒ 1", countWorkingWaits(home) === 1);
  st = seedWait(home, st, "a1", "approval", "open");
  t("countWorkingWaits: an open APPROVAL wait is NOT active work ⇒ still 1", countWorkingWaits(home) === 1);
  st = seedWait(home, st, "w2", "wait", "resolved");
  t("countWorkingWaits: a resolved kind:wait is not active ⇒ still 1", countWorkingWaits(home) === 1);
}
{
  // a home with ONLY an approval wait reads as idle-by-work (0 working) — the exact "herdr idle but awaiting ruling" case.
  const home = tmpHome();
  seedWait(home, initialLogState(), "a1", "approval", "open");
  t("countWorkingWaits: only an approval wait ⇒ 0 (idle, but awaiting ruling)", countWorkingWaits(home) === 0);
}
if (canTestPerms) {
  const home = tmpHome();
  seedWait(home, initialLogState(), "w1", "wait", "open");
  chmodSync(controlLogDir(home), 0o000);
  const r = countWorkingWaits(home);
  chmodSync(controlLogDir(home), 0o755);
  t("countWorkingWaits: UNREADABLE control-log ⇒ null (never a false idle)", r === null);
}

// =====================================================================================================================
// STORE — readIdleSignals reads the four sources (inbox / review-queue / awaiting-ruling / user-gates)
// =====================================================================================================================
{
  const home = tmpHome();
  // (a) inbox: two unclaimed messages in one box
  const box = path.join(home, ".agenthop", "inbox", "sid-a");
  mkdirSync(box, { recursive: true });
  writeFileSync(path.join(box, "m1.json"), "{}");
  writeFileSync(path.join(box, "m2.json"), "{}");
  // (b) review-queue: one open + one done (only open counts)
  const rq = path.join(home, ".agenthop", "swarm", "review-queue");
  mkdirSync(rq, { recursive: true });
  writeFileSync(path.join(rq, "t1.s1.json"), "{}");          // open
  writeFileSync(path.join(rq, "t2.s2.done.json"), "{}");     // done
  // (c)+(d) decision batches: one AWAITING with a hardGate item + a non-gate item; one CONSUMED (not awaiting)
  openBatch(home, { owner: "coord", nowSec: 100, items: [
    { id: "i1", kind: "spend", summary: "pay", suggestedAction: "approve", hardGate: true },
    { id: "i2", kind: "merge", summary: "merge", suggestedAction: "approve" },
  ] });
  const b2 = openBatch(home, { owner: "coord", nowSec: 101, items: [{ id: "j1", kind: "merge", summary: "m", suggestedAction: "approve" }] });
  writeDecisions(home, { batchId: b2.batchId, decidedAtSec: 200, decisions: [{ id: "j1", verdict: "approve" }] });
  consumeDecisions(home, b2.batchId);

  const s = readIdleSignals(home);
  t("signals: unclaimedInboxes counts both pending messages", s.unclaimedInboxes === 2);
  t("signals: reviewQueueDepth counts only the open review", s.reviewQueueDepth === 1);
  t("signals: awaitingRuling counts only the un-consumed batch", s.awaitingRuling === 1);
  t("signals: userGates counts the hardGate item in the awaiting batch", s.userGates === 1);
}
{
  // confirmed-empty home: every source ENOENT ⇒ all zero (a true genuine-stall input), not null.
  const home = tmpHome();
  const s = readIdleSignals(home);
  t("signals: empty home ⇒ all confirmed zero", s.unclaimedInboxes === 0 && s.reviewQueueDepth === 0 && s.awaitingRuling === 0 && s.userGates === 0);
  t("signals: empty home ⇒ isIdleAnomaly true when idle", isIdleAnomaly(true, s) === true);
}

// =====================================================================================================================
// STORE — writeIdleExplainer round-trip + CP-3 boundary
// =====================================================================================================================
{
  const home = tmpHome();
  const e = writeIdleExplainer(home, 500, true, "wait-ledger");
  t("write: returns the projection", e !== null && e.idle === true && e.schema === IDLE_EXPLAINER_SCHEMA);
  t("write: file on disk matches", (() => { const d = JSON.parse(readFileSync(explainerFile(home), "utf8")); return d.schema === IDLE_EXPLAINER_SCHEMA && d.generatedAtSec === 500 && d.idle === true && d.reason.includes("genuine stall") && d.anomaly === true; })());
  const e2 = writeIdleExplainer(home, 600, false, "wait-ledger");
  t("write: not-idle ⇒ reason active, anomaly false", e2 !== null && e2.reason === "active" && e2.anomaly === false);
}
{
  // CP-3: a pre-existing symlinked console dir ⇒ refuse (return null, write nothing through the redirect).
  const home = tmpHome();
  const evil = path.join(home, "evil"); mkdirSync(evil, { recursive: true });
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  symlinkSync(evil, path.join(home, ".agenthop", "swarm", "console"));
  t("write: console/ symlink ⇒ SKIPPED (null)", writeIdleExplainer(home, 100, true, "wait-ledger") === null);
  t("write: nothing written into the redirected dir", !existsSync(path.join(evil, "idle-explainer.json")));
}

console.log("\nidle-explainer self-check OK");
