// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/idle-explainer.selftest.mts
//
// Pins the idle-root-cause explainer (北极星差距审计件①) after the codex:Work IE-1..4 review:
//  IE-1 — idle = RUNNING/RPV attempts (active execution), NOT waits; query-waits (kind:wait) + approval-waits (kind:approval) are
//    REASONS (awaitingInput / awaitingRuling), not activity; control-log unreadable ⇒ idleSource "unknown", never "active".
//  IE-2 — FC-2 r3: a per-item read fault (an unreadable inbox box / an unreadable-or-corrupt decision batch) ⇒ the WHOLE signal is
//    null, never a lower-bound zero.
//  anomaly — requires idle AND an ESTABLISHED swarm (>=1 member) AND every signal a CONFIRMED zero (a null never fires it).
//  (IE-3 recoverable deliver-then-mark + IE-4 self-notice exclusion live in the dispatcher closure; the pure onset helper +
//   the coordinator-box exclusion are pinned here via shouldAlertOnset + readIdleSignals' excludeBoxNames.)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  idleExplainerEnabled, idleReason, isIdleAnomaly, shouldAlertOnset, recoveryConfirmed, buildIdleExplainer,
  IDLE_EXPLAINER_SCHEMA, type IdleSignals,
} from "./idle-explainer.js";
import { readControlLogSignals, countRosterMembers, readIdleSignals, writeIdleExplainer } from "./idle-explainer-store.js";
import { entityKeyOf, initialLogState, type Change, type WaitRecord, type WaitKind, type WaitState } from "./control-log.js";
import type { TaskAttempt } from "./task-state.js";
import { commitControl } from "./control-store.js";
import { openBatch, writeDecisions, consumeDecisions } from "./decision-batch-store.js";
import { inboxDirName } from "../inbox.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "idle-expl-"));
const controlLogDir = (home: string) => path.join(home, ".agenthop", "swarm", "control-log");
const rosterSnap = (home: string) => path.join(home, ".agenthop", "swarm", "roster-snapshot.json");
const explainerFile = (home: string) => path.join(home, ".agenthop", "swarm", "console", "idle-explainer.json");
const inboxBox = (home: string, name: string) => path.join(home, ".agenthop", "inbox", name);
const canTestPerms = (process.getuid?.() ?? 0) !== 0;
const S0: IdleSignals = { unclaimedInboxes: 0, reviewQueueDepth: 0, awaitingRuling: 0, awaitingInput: 0, userGates: 0 };

function mkAttempt(attemptId: string, status: string): Change {
  const attempt = { attemptId, status } as unknown as TaskAttempt;
  const key = entityKeyOf({ put: "attempt", attempt });
  return { put: "attempt", attempt, operationId: `${key}#1`, expectedEntityRevision: 0 };
}
function mkWait(waitId: string, kind: WaitKind, state: WaitState): Change {
  const wait: WaitRecord = { waitId, kind, subject: { jobId: "job" }, state, deadlineSec: 0, owner: "m1", timeoutPolicy: "bypass" };
  const key = entityKeyOf({ put: "wait", wait });
  return { put: "wait", wait, operationId: `${key}#1`, expectedEntityRevision: 0 };
}
function seed(home: string, changes: Change[]): void {
  const r = commitControl(controlLogDir(home), initialLogState(), changes);
  if (!r.result.ok) throw new Error("seed commit rejected: " + JSON.stringify(r.result));
}

// =====================================================================================================================
// PURE
// =====================================================================================================================
t("flag default-ON (unset)", idleExplainerEnabled({} as NodeJS.ProcessEnv) === true);
t("flag kill-switch '0'", idleExplainerEnabled({ SWARM_IDLE_EXPLAINER: "0" } as NodeJS.ProcessEnv) === false);

// idleReason
t("reason: unknown source ⇒ 'activity unknown', NEVER active", (() => { const r = idleReason(false, "unknown", S0); return r.includes("activity unknown") && !r.includes("active"); })());
t("reason: not idle ⇒ active", idleReason(false, "ledger", S0) === "active (work running)");
t("reason: awaiting-ruling first", idleReason(true, "ledger", { ...S0, awaitingRuling: 3 }).includes("3 awaiting ruling"));
t("reason: awaiting-input listed (query/approval are reasons, not work)", idleReason(true, "ledger", { ...S0, awaitingInput: 2 }).includes("2 awaiting input"));
t("reason: unclaimed MEMBER boxes", idleReason(true, "ledger", { ...S0, unclaimedInboxes: 4 }).includes("4 unclaimed in member boxes"));
t("reason: all confirmed zero ⇒ unexplained-idle verify (not 'proven stall')", (() => { const r = idleReason(true, "ledger", S0); return r.includes("verify") && r.includes("stalled") && !r.includes("proven"); })());
t("reason: a null signal ⇒ unreadable, cannot confirm", (() => { const r = idleReason(true, "ledger", { ...S0, awaitingRuling: null }); return r.includes("unreadable") && r.includes("ruling") && !r.includes("verify the swarm"); })());

// isIdleAnomaly
t("anomaly: idle + established + all zero ⇒ true", isIdleAnomaly(true, true, S0) === true);
t("anomaly: NOT established (empty swarm) ⇒ false", isIdleAnomaly(true, false, S0) === false);
t("anomaly: idle + a positive signal ⇒ false", isIdleAnomaly(true, true, { ...S0, awaitingInput: 1 }) === false);
t("anomaly: idle + a NULL signal ⇒ false (unknown ≠ empty)", isIdleAnomaly(true, true, { ...S0, unclaimedInboxes: null }) === false);
t("anomaly: NOT idle ⇒ false", isIdleAnomaly(false, true, S0) === false);

// shouldAlertOnset + buildIdleExplainer
t("onset: false→true ⇒ alert", shouldAlertOnset(false, true) === true);
t("onset: true→true ⇒ no re-alert", shouldAlertOnset(true, true) === false);
{
  const e = buildIdleExplainer({ idle: true, idleSource: "ledger", swarmEstablished: true, signals: S0, nowSec: 7 });
  t("build: schema/ts/idle/source", e.schema === IDLE_EXPLAINER_SCHEMA && e.generatedAtSec === 7 && e.idle === true && e.idleSource === "ledger");
  t("build: anomaly + reason", e.anomaly === true && e.reason.includes("verify"));
  const e2 = buildIdleExplainer({ idle: false, idleSource: "unknown", swarmEstablished: true, signals: S0, nowSec: 8 });
  t("build: unknown source ⇒ reason 'activity unknown', anomaly false", e2.reason.includes("activity unknown") && e2.anomaly === false);
}

// =====================================================================================================================
// STORE — readControlLogSignals (IE-1: RUNNING/RPV attempts = activity; waits = reasons; errno three-state)
// =====================================================================================================================
{
  const home = tmpHome();
  const cl0 = readControlLogSignals(home);
  t("control-log ENOENT ⇒ all confirmed zero", cl0.running === 0 && cl0.approvalWaits === 0 && cl0.inputWaits === 0);
  seed(home, [
    mkAttempt("r1", "RUNNING"), mkAttempt("r2", "RESULT_PENDING_VALIDATION"), mkAttempt("s1", "SUCCEEDED"),
    mkWait("a1", "approval", "open"), mkWait("w1", "wait", "open"), mkWait("w2", "wait", "resolved"),
  ]);
  const cl = readControlLogSignals(home);
  t("running = RUNNING + RPV (SUCCEEDED excluded)", cl.running === 2);
  t("approvalWaits = open kind:approval (a ruling reason, not activity)", cl.approvalWaits === 1);
  t("inputWaits = open kind:wait (an input reason, not activity); resolved excluded", cl.inputWaits === 1);
}
if (canTestPerms) {
  const home = tmpHome();
  seed(home, [mkAttempt("r1", "RUNNING")]);
  chmodSync(controlLogDir(home), 0o000);
  const cl = readControlLogSignals(home);
  chmodSync(controlLogDir(home), 0o755);
  t("control-log UNREADABLE ⇒ all null (never a false idle/zero)", cl.running === null && cl.approvalWaits === null && cl.inputWaits === null);
}

// =====================================================================================================================
// STORE — countRosterMembers
// =====================================================================================================================
{
  const home = tmpHome();
  t("roster ENOENT ⇒ 0", countRosterMembers(home) === 0);
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  // IE-1: a valid member needs tool+cwd (member is optional via the legacy fallback identity).
  writeFileSync(rosterSnap(home), JSON.stringify({ members: [{ member: "m1", tool: "claude", cwd: "/a" }, { tool: "codex", cwd: "/b" }] }));
  t("roster: 2 valid members (1 explicit + 1 legacy tool/cwd fallback) ⇒ 2", countRosterMembers(home) === 2);
  // IE-1: malformed entries are NOT valid members ⇒ 0 (not an established swarm) — the exact S19-false-positive repros.
  for (const [label, body] of [
    ["members:[null]", JSON.stringify({ members: [null] })],
    ["members:[42]", JSON.stringify({ members: [42] })],
    ["members:[{}]", JSON.stringify({ members: [{}] })],
    ["members:[{member only, no tool/cwd}]", JSON.stringify({ members: [{ member: "m1" }] })],
    ["members:[]", JSON.stringify({ members: [] })],
  ] as const) {
    writeFileSync(rosterSnap(home), body);
    t(`IE-1: ${label} ⇒ 0 valid members (not established)`, countRosterMembers(home) === 0);
  }
  writeFileSync(rosterSnap(home), "{not json");
  t("roster corrupt JSON ⇒ null (unreadable)", countRosterMembers(home) === null);
}

// =====================================================================================================================
// IE-4 — recoveryConfirmed: separate a CONFIRMED recovery (re-arm) from an UNCERTAIN tick (retain episode)
// =====================================================================================================================
{
  const base = { idle: false, idleSource: "ledger" as const, swarmEstablished: true, signals: S0, running: 0 as number | null, coordResolvable: true };
  t("recovery: work resumed (running>0, ledger) ⇒ confirmed", recoveryConfirmed({ ...base, running: 2 }) === true);
  t("recovery: idle + a confirmed reason (established, no null, coord resolvable) ⇒ confirmed", recoveryConfirmed({ ...base, idle: true, signals: { ...S0, awaitingRuling: 1 } }) === true);
  t("recovery: idle + reason but coordinator UNRESOLVABLE ⇒ NOT confirmed (inbox signal untrusted)", recoveryConfirmed({ ...base, idle: true, signals: { ...S0, awaitingRuling: 1 }, coordResolvable: false }) === false);
  t("recovery: idle + reason but a NULL signal ⇒ NOT confirmed (uncertain)", recoveryConfirmed({ ...base, idle: true, signals: { ...S0, awaitingRuling: 1, unclaimedInboxes: null } }) === false);
  t("recovery: unknown activity (idleSource unknown, running null) ⇒ NOT confirmed (retain)", recoveryConfirmed({ ...base, idleSource: "unknown", running: null }) === false);
  t("recovery: not established + reason ⇒ NOT confirmed", recoveryConfirmed({ ...base, idle: true, swarmEstablished: false, signals: { ...S0, awaitingRuling: 1 } }) === false);
  t("recovery: idle + all zero (that is an anomaly, not a recovery) ⇒ NOT confirmed", recoveryConfirmed({ ...base, idle: true }) === false);
}

// =====================================================================================================================
// STORE — readIdleSignals: member-box inbox (coordinator EXCLUDED, IE-4), review, awaitingRuling = batch + approval-waits, etc.
// =====================================================================================================================
{
  const home = tmpHome();
  // member boxes (counted) + coordinator box (EXCLUDED)
  const coordSid = "coord-sid";
  mkdirSync(inboxBox(home, inboxDirName("m1")), { recursive: true }); writeFileSync(path.join(inboxBox(home, inboxDirName("m1")), "x.json"), "{}");
  mkdirSync(inboxBox(home, inboxDirName("m2")), { recursive: true }); writeFileSync(path.join(inboxBox(home, inboxDirName("m2")), "y.json"), "{}");
  mkdirSync(inboxBox(home, inboxDirName(coordSid)), { recursive: true }); writeFileSync(path.join(inboxBox(home, inboxDirName(coordSid)), "idle-anomaly.json"), "{}");
  // review-queue: 1 open
  mkdirSync(path.join(home, ".agenthop", "swarm", "review-queue"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "swarm", "review-queue", "t1.s1.json"), "{}");
  // decision batch: awaiting + 1 hardGate
  openBatch(home, { owner: "coord", nowSec: 100, items: [{ id: "i1", kind: "spend", summary: "s", suggestedAction: "approve", hardGate: true }, { id: "i2", kind: "merge", summary: "m", suggestedAction: "approve" }] });
  // control-log: 1 approval-wait + 1 input-wait
  seed(home, [mkWait("a1", "approval", "open"), mkWait("w1", "wait", "open")]);

  const cl = readControlLogSignals(home);
  const exclude = new Set<string>([inboxDirName(coordSid)]); // IE-4: coordinator notice box excluded
  const s = readIdleSignals(home, exclude, cl);
  t("IE-4: unclaimedInboxes counts member boxes, EXCLUDES the coordinator box", s.unclaimedInboxes === 2);
  t("reviewQueueDepth = 1 open", s.reviewQueueDepth === 1);
  t("awaitingRuling = decision-batch-awaiting (1) + approval-waits (1) = 2", s.awaitingRuling === 2);
  t("awaitingInput = input-waits (1)", s.awaitingInput === 1);
  t("userGates = hardGate item (1)", s.userGates === 1);
}
{
  // confirmed-empty home ⇒ every signal a confirmed zero (a true anomaly input)
  const home = tmpHome();
  const s = readIdleSignals(home, new Set(), readControlLogSignals(home));
  t("empty home ⇒ all signals confirmed zero", s.unclaimedInboxes === 0 && s.reviewQueueDepth === 0 && s.awaitingRuling === 0 && s.awaitingInput === 0 && s.userGates === 0);
}

// =====================================================================================================================
// STORE — IE-2 FC-2 r3: a per-item read fault ⇒ the WHOLE signal null (never a lower-bound zero)
// =====================================================================================================================
if (canTestPerms) {
  // (a) an UNREADABLE member box ⇒ unclaimedInboxes null
  const home = tmpHome();
  mkdirSync(inboxBox(home, inboxDirName("m1")), { recursive: true }); writeFileSync(path.join(inboxBox(home, inboxDirName("m1")), "x.json"), "{}");
  chmodSync(inboxBox(home, inboxDirName("m1")), 0o000);
  const s = readIdleSignals(home, new Set(), readControlLogSignals(home));
  chmodSync(inboxBox(home, inboxDirName("m1")), 0o755);
  t("IE-2: an unreadable member box ⇒ unclaimedInboxes null (not a lower-bound zero)", s.unclaimedInboxes === null);

  // (b) an UNREADABLE decision batch ⇒ awaitingRuling + userGates null
  const home2 = tmpHome();
  const b = openBatch(home2, { owner: "coord", nowSec: 100, items: [{ id: "i1", kind: "spend", summary: "s", suggestedAction: "approve", hardGate: true }] });
  const batchDir = path.join(home2, ".agenthop", "console", "decision-batches", b.batchId);
  chmodSync(batchDir, 0o000);
  const s2 = readIdleSignals(home2, new Set(), readControlLogSignals(home2));
  chmodSync(batchDir, 0o755);
  t("IE-2: an unreadable decision batch ⇒ awaitingRuling null", s2.awaitingRuling === null);
  t("IE-2: an unreadable decision batch ⇒ userGates null", s2.userGates === null);
}

// =====================================================================================================================
// STORE — writeIdleExplainer round-trip + CP-3 boundary
// =====================================================================================================================
{
  const home = tmpHome();
  const e = writeIdleExplainer(home, 500, true, "ledger", true, S0);
  t("write: returns projection", e !== null && e.idle === true && e.anomaly === true);
  t("write: file matches", (() => { const d = JSON.parse(readFileSync(explainerFile(home), "utf8")); return d.schema === IDLE_EXPLAINER_SCHEMA && d.generatedAtSec === 500 && d.reason.includes("verify") && d.anomaly === true; })());
}
{
  const home = tmpHome();
  const evil = path.join(home, "evil"); mkdirSync(evil, { recursive: true });
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  symlinkSync(evil, path.join(home, ".agenthop", "swarm", "console"));
  t("write: console/ symlink ⇒ SKIPPED (null)", writeIdleExplainer(home, 100, true, "ledger", true, S0) === null);
  t("write: nothing in the redirected dir", !existsSync(path.join(evil, "idle-explainer.json")));
}

console.log("\nidle-explainer self-check OK");
