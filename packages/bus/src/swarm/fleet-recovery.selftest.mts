// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/fleet-recovery.selftest.mts
// full-fleet-recovery r4 (codex:Work r3 @040f550: FR-2/3/4 CLOSED, 8 REMAIN on evidence/identity/atomicity). Pins the rebuilt core +
// store + runs the REAL orchestrateRecover with fakes, each test reproducing a reviewer finding:
//  FR-1a execArgv captured · FR-1b scrub keeps the SSH user · FR-5 identity triple (title alone ≠ identity) · FR-7 reuse-incomplete
//  (any age) + unreadable-abort · FR-8 claim≠launch two-phase + report-with-real-results + receipt-in-completion · FR-9 claim leaf
//  CP-3 · FR-10 boardItemId join + inbox three-state. Plus the 3 zero-bug fixture classes over the write faces.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA, scrubValueSecrets, parseDispatcherRecipe, parseFleetSnapshot, snapshotStaleSec,
  dispatcherNeedsRelaunch, dispatcherVerdict, memberVerdict, resolveMemberSid, resolveEpisode, buildBreakpointText,
  grantedItemsForMember, deliveryDischarged, summarizeOutstanding, orchestrateRecover, classifyLaunchError, publicRecoveryStatus, recoveryStatusLine, deriveRecoveryDisplay,
  type FleetSnapshot, type DispatcherRecipe, type RecoverDeps, type RecoveryEpisode, type EpisodeRead, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus, type DispatcherLiveness, type RecoveryResult, type LaunchOutcome,
} from "./fleet-recovery.js";
import {
  writeFleetSnapshot, readFleetSnapshot, recordDispatcherRecipe, readDispatcherRecipe, writeEpisode, readEpisode,
  claimRecoverLaunch, markLaunchOutcome, liveAttemptsForItems, breakpointFactsFor, writeRecoveryReceipt, readRecoveryReceipt, FLEET_RECEIPT_SCHEMA, FLEET_RECEIPT_SCOPE,
  recoverLockSite, markLaunching,
} from "./fleet-recovery-store.js";
import { acquireHolderLock, releaseHolderLock } from "./holder-lock.js";
import { boardItemId } from "./task-board.js";
import { attemptIdOf, type TaskAttempt } from "./task-state.js";
import { initialLogState } from "./control-log.js";
import { commitControl } from "./control-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "fleet-recovery-r4-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");
const goodRecipe: DispatcherRecipe = { argv: ["/usr/bin/node", "scripts/swarm-dispatch.ts"], cwd: "/repo", env: { SWARM_SELF: "d1", HERDR_ENV: "1" }, source: "self-recorded" };
const goodSnap: FleetSnapshot = { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: 1000, dispatcher: goodRecipe, rosterFile: "/h/roster.json" };

try {
  // ── FR-2 (r4): per-scheme scrub — ssh keeps the user; http(s) strips the WHOLE userinfo (username may be a token) ────
  t("FR-2: ssh://git@host UNCHANGED (user is a non-secret address part)", scrubValueSecrets("ssh://git@host/repo.git") === "ssh://git@host/repo.git");
  t("FR-2: ssh://git:{{PASSWORD_4hw6k5rz}}@host ⇒ ssh://git@host (keep user, drop password)", scrubValueSecrets("ssh://git:{{PASSWORD_4hw6k5rz}}@host/r.git") === "ssh://git@host/r.git");
  t("FR-2: https://TOKEN@host ⇒ https://host (whole userinfo stripped — username may be a credential)", scrubValueSecrets("https://ghp_tok@git.example/o/r.git") === "https://git.example/o/r.git");
  t("FR-2: https://user:{{PASSWORD_mcu5s9ca}}@host ⇒ https://host (whole userinfo stripped)", scrubValueSecrets("https://user:{{PASSWORD_mcu5s9ca}}@git.example/o/r.git") === "https://git.example/o/r.git");
  t("FR-2: clean URL untouched", scrubValueSecrets("https://git.example/o/r.git") === "https://git.example/o/r.git");

  // ── FR-5 (r4): identity is the SID ALONE; tool/cwd/title are NOT identity ─────────────────────────────────────────
  {
    const member: RosterMemberLike = { member: "SID-A", title: "seat", tool: "claude", cwd: "/repo-A" };
    t("FR-5: exact SID match ⇒ resolved", resolveMemberSid({ member: "SID-A" }, [{ stableId: "SID-A", title: "x" }]).kind === "resolved");
    t("FR-5: SAME tool+cwd+title but DIFFERENT SID ⇒ ABSENT (not the same member, no guess)", resolveMemberSid(member, [{ stableId: "SID-B", title: "seat", tool: "claude", cwd: "/repo-A" }]).kind === "absent");
    t("FR-5: no SID match at all ⇒ absent", resolveMemberSid(member, [{ stableId: "SID-OTHER", title: "other", tool: "codex", cwd: "/x" }]).kind === "absent");
    t("FR-5: >1 peer with the SAME sid ⇒ ambiguous", resolveMemberSid({ member: "SID-A" }, [{ stableId: "SID-A", title: "a" }, { id: "SID-A", title: "b" }]).kind === "ambiguous");
  }

  // ── FR-7: episode — reuse incomplete ANY age; unreadable ⇒ abort; complete/absent ⇒ new ─────────────────────────
  const mint = () => "ep-NEW";
  t("FR-7: incomplete + VERY old ⇒ REUSE (age is not evidence the launch vanished)", (() => { const r = resolveEpisode({ kind: "present", ep: { episodeId: "ep-1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false } }, mint); return r.action === "reuse" && r.episodeId === "ep-1"; })());
  t("FR-7: unreadable marker ⇒ ABORT (never re-mint over an outstanding recovery)", resolveEpisode({ kind: "unreadable" }, mint).action === "abort");
  t("FR-7: completed ⇒ NEW", resolveEpisode({ kind: "present", ep: { episodeId: "ep-1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: true } }, mint).action === "new");
  t("FR-7: absent ⇒ NEW", resolveEpisode({ kind: "absent" }, mint).action === "new");

  // ── FR-3 (kept) + verdicts + breakpoint ─────────────────────────────────────────────────────────────────────────
  t("FR-3: wake NULL (target env unreadable) ⇒ unknown", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: null }, 120) === "unknown");
  t("verdict confirmed/failed", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(herdr)" }, 120) === "confirmed" && dispatcherVerdict({ pidAlive: false, heartbeatFreshSec: 1, wakeStatus: "on(herdr)" }, 120) === "failed");
  t("memberVerdict + dispatcherNeedsRelaunch + snapshotStaleSec", memberVerdict(true, false, false) === "confirmed" && dispatcherNeedsRelaunch(goodSnap, false) && snapshotStaleSec({ capturedAtSec: 1000 }, 1600) === 600);
  t("parseDispatcherRecipe argv with spaces round-trips; parseFleetSnapshot ok", parseDispatcherRecipe({ argv: ["/n", "my file.ts"], cwd: "/r", env: {}, source: "self-recorded" })?.argv[1] === "my file.ts" && parseFleetSnapshot(JSON.stringify(goodSnap)) !== null);
  t("buildBreakpointText unreadable⇒'无法读取'; summarize/discharged", buildBreakpointText({ member: "m", grantedItems: null, liveAttempts: null, unreadInbox: null }, "T").includes("无法读取") && deliveryDischarged("published") && !deliveryDischarged("failed"));

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // FR-8 via REAL orchestrateRecover (fakes): claim≠launch, report-with-real-results, receipt-in-completion
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  type HOpts = Partial<{ episode: EpisodeRead; peersAfter: PeerLikeMin[]; claimReturns: boolean; launchOutcome: LaunchOutcome; disp: DispatcherLiveness; writeReceiptOk: boolean; writeReceiptFailPhases: ("provisional" | "final")[]; writeEpisodeOk: boolean; failWriteEpisodeAfter: number; markLaunchingOk: boolean }>;
  function makeHarness(o: HOpts) {
    const state = { episodeWrites: [] as RecoveryEpisode[], writeOrder: [] as string[], launches: [] as string[], launchings: [] as string[], outcomes: [] as { m: string; outcome: LaunchOutcome }[], reportArg: null as RecoveryResult | null, receiptArg: null as RecoveryResult | null, receipts: [] as { phase: "provisional" | "final"; result: RecoveryResult }[] };
    const deps: RecoverDeps = {
      now: () => 1000, mintEpisodeId: () => "ep-NEW", heartbeatThresholdSec: 120, breakpointsEnabled: true, recoveredAtIso: "T",
      readEpisode: () => o.episode ?? { kind: "absent" },
      writeEpisode: (ep) => { state.episodeWrites.push(ep); state.writeOrder.push("episode"); if (o.failWriteEpisodeAfter !== undefined && state.episodeWrites.length > o.failWriteEpisodeAfter) return false; return o.writeEpisodeOk ?? true; },
      dispatcherLive: () => false,
      relaunchDispatcher: () => true,
      verifyDispatcher: () => o.disp ?? { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(herdr)" as const },
      peers: () => o.peersAfter ?? [],
      settle: async () => {},
      claimLaunch: () => o.claimReturns ?? true,
      launchMember: async (m) => { state.launches.push(m.member); return { outcome: o.launchOutcome ?? "launched" }; },
      markLaunching: (m) => { state.launchings.push(m); return o.markLaunchingOk ?? true; },
      markLaunchOutcome: (m, _ep, outcome) => { state.outcomes.push({ m, outcome }); },
      breakpointFacts: (sid) => ({ member: sid, grantedItems: [], liveAttempts: [], unreadInbox: 0 }),
      deliverBreakpoint: () => "published",
      deliverReport: (r) => { state.reportArg = r; return "published"; },
      writeReceipt: (r, phase) => { state.receiptArg = r; state.receipts.push({ phase, result: r }); state.writeOrder.push(`receipt:${phase}`); if (o.writeReceiptFailPhases?.includes(phase)) return false; return o.writeReceiptOk ?? true; },
    };
    return { deps, state };
  }
  const roster: RosterMemberLike[] = [{ member: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }];

  // FR-8 report-with-real-results: dispatcher inert + member absent ⇒ deliverReport MUST receive notConfirmed>0 (not a zeroed placeholder)
  {
    const h = makeHarness({ disp: { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(inert:no-transport)" }, peersAfter: [] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: deliverReport got the REAL result (notConfirmed>0), not a zeroed placeholder", h.state.reportArg !== null && h.state.reportArg.notConfirmed >= 2 && h.state.reportArg.outstanding.length >= 2);
    t("FR-8: final result not falsely 'all confirmed'", r.notConfirmed >= 2 && r.outstanding.some((o) => o.startsWith("dispatcher:")));
  }
  // FR-8 (r9): TWO-PHASE receipt + marker-LAST. A refused receipt (both phases) ⇒ receipt:unwritten + receipt-final:unwritten; the final
  // episode marker is completed=false (a re-run REUSES this episode, publishOnce-deduped ⇒ no dup breakpoint). The marker is the LAST write,
  // AFTER both receipt phases — so a completed marker can never coexist with a provisional receipt.
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], writeReceiptOk: false });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 r9: provisional receipt refused ⇒ 'receipt:unwritten' outstanding", r.outstanding.includes("receipt:unwritten"));
    t("FR-8 r9: final receipt refused ⇒ 'receipt-final:unwritten' outstanding", r.outstanding.includes("receipt-final:unwritten"));
    t("FR-8 r9: receipt fail ⇒ final episode marker completed=false (re-run reuses, no dup breakpoint)", h.state.episodeWrites[h.state.episodeWrites.length - 1]!.completed === false);
    t("FR-8 r9: episode marker written LAST, after BOTH receipt phases (no completed-marker beside a provisional receipt)", (() => { const o = h.state.writeOrder; const le = o.lastIndexOf("episode"); const ip = o.indexOf("receipt:provisional"); const iff = o.indexOf("receipt:final"); return ip >= 0 && iff > ip && iff < le && le === o.length - 1; })());
  }
  // FR-8 (r9) marker-LAST, seam3: the final episode marker write is refused ⇒ 'episode-final:unwritten' outstanding (exit≠0) and the marker
  // on disk stays INCOMPLETE ⇒ resolveEpisode REUSES this episode on a re-run (publishOnce-deduped, no dup). The recovery WORK is honestly
  // clean, so the FINAL receipt (written BEFORE the marker) is final:true — the authoritative "not committed" record is the incomplete
  // marker, NOT a doctored receipt (the "equivalent authoritative-commit" the review allows). A receipt-only reader still never sees a false
  // all-clear during an INTERRUPTED finalize because the PROVISIONAL phase carries final:false + finalization:pending (durable block below).
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], failWriteEpisodeAfter: 1 });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 r9 seam3: final writeEpisode false ⇒ 'episode-final:unwritten' outstanding (exit≠0)", r.outstanding.includes("episode-final:unwritten"));
    t("FR-8 r9: both receipt phases written BEFORE the (failed) final marker", (() => { const o = h.state.writeOrder; const le = o.lastIndexOf("episode"); return o.indexOf("receipt:provisional") < le && o.indexOf("receipt:final") < le && le === o.length - 1; })());
    t("FR-8 r9: authoritative criterion = incomplete marker ⇒ resolveEpisode REUSES (no dup)", resolveEpisode({ kind: "present", ep: { episodeId: r.episodeId, startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false } }, () => "ep-NEW").action === "reuse");
  }
  // FR-8 (r9) INTERRUPT-before-finalize: the provisional landed but the final write never committed (SIGKILL / refused final phase). The
  // orchestrator must mark BOTH the final-receipt and the marker obligations outstanding, and the marker stays INCOMPLETE ⇒ safe re-run.
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], writeReceiptFailPhases: ["final"] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 r9 interrupt: provisional OK + final refused ⇒ 'receipt-final:unwritten' outstanding, NOT 'receipt:unwritten'", r.outstanding.includes("receipt-final:unwritten") && !r.outstanding.includes("receipt:unwritten"));
    t("FR-8 r9 interrupt: a provisional receipt WAS written (final:false phase) before the refused final", h.state.receipts.some((x) => x.phase === "provisional") && h.state.receipts.some((x) => x.phase === "final"));
    t("FR-8 r9 interrupt: final episode marker completed=false (re-run reuses)", h.state.episodeWrites[h.state.episodeWrites.length - 1]!.completed === false);
  }
  // FR-8 (r9/r10) DURABLE phase semantics — the on-disk BYTES, not a comment, distinguish provisional from final; and (r10) the receipt
  // SELF-IDENTIFIES as a WORK SNAPSHOT so `final:true` can never be read as "episode committed".
  {
    const dh = freshHome();
    writeRecoveryReceipt(dh, { episodeId: "ep-x", final: false, outstanding: ["finalization:pending"], members: [], reportDelivery: "skipped", notConfirmed: 0 });
    const prov = readRecoveryReceipt(dh)!;
    t("FR-8 r9 durable: PROVISIONAL receipt is identifiable (final===false + finalization:pending ⇒ never a clean all-clear)", prov.final === false && (prov.outstanding as string[]).includes("finalization:pending"));
    writeRecoveryReceipt(dh, { episodeId: "ep-x", final: true, outstanding: [], members: [], reportDelivery: "skipped", notConfirmed: 0 });
    const fin = readRecoveryReceipt(dh)!;
    // r10: `final:true` means WORK finalized, NOT episode committed — the receipt self-identifies its scope + names the authoritative source.
    t("FR-8 r10 durable: the receipt self-identifies as a WORK SNAPSHOT (scope + completionAuthority stamped at the write primitive)", fin.scope === FLEET_RECEIPT_SCOPE && typeof fin.completionAuthority === "string" && /episode-marker/.test(fin.completionAuthority as string));
    t("FR-8 r10 durable: final===true = work finalized; it is NOT an independent completion claim (scope says so)", fin.final === true && fin.scope === "work-snapshot");
  }
  // FR-8 (r10/r11) PUBLIC completion criterion — the ONE criterion, derived from the authoritative episode MARKER bound to THIS run's
  // episodeId. Closes the r9 receipt-only split AND the r10 cross-episode display bug (a stale prior-episode marker reading "completed").
  {
    const ep = (episodeId: string, completed: boolean): EpisodeRead => ({ kind: "present", ep: { episodeId, startedAtSec: 1, snapshotCapturedAtSec: 1, completed } });
    const rcpt = (episodeId: string, final: boolean) => ({ episodeId, final });
    const THIS = "ep-this";
    t("FR-8 r10 public: normal full commit (marker completed=true, SAME episode) ⇒ 'completed'", publicRecoveryStatus(ep(THIS, true), rcpt(THIS, true), THIS) === "completed");
    t("FR-8 r10 public: final-marker-refusal (marker incomplete, receipt final:true) ⇒ 'pending-commit'", publicRecoveryStatus(ep(THIS, false), rcpt(THIS, true), THIS) === "pending-commit");
    t("FR-8 r10 public: SIGKILL-before-marker (marker absent, receipt final:true) ⇒ 'pending-commit'", publicRecoveryStatus({ kind: "absent" }, rcpt(THIS, true), THIS) === "pending-commit");
    t("FR-8 r10 public: interrupt-before-finalize (marker incomplete, receipt final:false) ⇒ 'pending-work'", publicRecoveryStatus(ep(THIS, false), rcpt(THIS, false), THIS) === "pending-work");
    t("FR-8 r10 public: final-receipt-refused ⇒ no final receipt for THIS run ⇒ 'pending-work'", publicRecoveryStatus(ep(THIS, false), null, THIS) === "pending-work");
    t("FR-8 r10 public: marker unreadable ⇒ 'unknown' (FC-2, never guess)", publicRecoveryStatus({ kind: "unreadable" }, rcpt(THIS, true), THIS) === "unknown");
    // r11 OWNERSHIP — the actual r10 bug: a STALE prior-episode marker (completed=true) must NOT read 'completed' for THIS run.
    t("FR-8 r11 OWNERSHIP: stale PRIOR-episode marker completed=true ⇒ THIS run NOT 'completed' (bound to thisEpisodeId)", publicRecoveryStatus(ep("ep-OLD", true), rcpt("ep-OLD", true), THIS) === "pending-work");
    t("FR-8 r11 OWNERSHIP: stale marker + THIS run's final receipt ⇒ 'pending-commit' (this run's work, not the old marker's completed)", publicRecoveryStatus(ep("ep-OLD", true), rcpt(THIS, true), THIS) === "pending-commit");
    t("FR-8 r11 OWNERSHIP: a receipt from a DIFFERENT episode does not refine THIS run to pending-commit", publicRecoveryStatus(ep(THIS, false), rcpt("ep-OLD", true), THIS) === "pending-work");
    // r11 wording: unknown must NOT be suffixed "not committed / re-run finalizes"; pending lines must say "NOT yet committed".
    t("FR-8 r11 wording: unknown says CANNOT be confirmed, NOT 'not committed'/'finalizes the same episode'", (() => { const l = recoveryStatusLine("unknown"); return /CANNOT be confirmed/i.test(l) && !/NOT yet committed/i.test(l) && !/finalizes the same episode/i.test(l); })());
    t("FR-8 r11 wording: pending-commit/pending-work DO say 'NOT yet committed'", /NOT yet committed/i.test(recoveryStatusLine("pending-commit")) && /NOT yet committed/i.test(recoveryStatusLine("pending-work")));
  }
  // FR-8-GATE (r12) — the LINK gate: pins that the CALLER binds to result.episodeId, not the on-disk marker's id (a pure-helper test with
  // matching params would NOT catch the r10 caller-variant). A prior episode's COMPLETED marker + receipt sit on disk; THIS run's result
  // carries a NEW id (its own initial marker write was refused ⇒ not on disk). deriveRecoveryDisplay — the ONE adapter the shell calls —
  // is run over the SAME real store readers (readEpisode / readRecoveryReceipt). If the binding regressed to the marker's id, this FAILS.
  {
    const rcptReader = (hh: string) => () => { const rc = readRecoveryReceipt(hh); return rc && typeof rc.final === "boolean" && typeof rc.episodeId === "string" ? { episodeId: rc.episodeId as string, final: rc.final as boolean } : null; };
    const h = freshHome();
    writeEpisode(h, { episodeId: "ep-OLD", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: true });            // a PRIOR episode committed
    writeRecoveryReceipt(h, { episodeId: "ep-OLD", final: true, outstanding: [], members: [], reportDelivery: "skipped", notConfirmed: 0 });
    const disp = deriveRecoveryDisplay({ episodeId: "ep-NEW" }, () => readEpisode(h), rcptReader(h));                 // THIS run's new episode, marker not on disk
    t("FR-8-GATE: over the REAL read path, a stale OLD completed marker ⇒ pending-work (NOT completed) — caller bound to result.episodeId", disp.status === "pending-work" && disp.line.startsWith("pending-work"));
    t("FR-8-GATE: the stale marker's foreign episode id is surfaced, not adopted as this run's", disp.staleMarkerEpisodeId === "ep-OLD");
    const h2 = freshHome(); // positive control — this run's OWN completed marker ⇒ completed (the gate is not vacuously true)
    writeEpisode(h2, { episodeId: "ep-NEW", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: true });
    writeRecoveryReceipt(h2, { episodeId: "ep-NEW", final: true, outstanding: [], members: [], reportDelivery: "skipped", notConfirmed: 0 });
    const ok = deriveRecoveryDisplay({ episodeId: "ep-NEW" }, () => readEpisode(h2), rcptReader(h2));
    t("FR-8-GATE: positive control — THIS run's own completed marker ⇒ completed", ok.status === "completed" && ok.staleMarkerEpisodeId === null);
  }
  // FR-8 r4: an 'unknown' launch outcome is recorded as unknown (not failed) ⇒ never a blind retry
  {
    const h = makeHarness({ peersAfter: [], claimReturns: true, launchOutcome: "unknown" });
    await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 seam2: a launch 'unknown' outcome is recorded unknown (not failed)", h.state.outcomes.length === 1 && h.state.outcomes[0]!.outcome === "unknown");
  }
  // FR-8 claim≠launch: claimLaunch false (pending/launched) ⇒ member NOT launched
  {
    const h = makeHarness({ peersAfter: [], claimReturns: false });
    await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: claimLaunch=false ⇒ member NOT launched (no blind double)", h.state.launches.length === 0);
  }
  // FR-8 markLaunchOutcome recorded on a real launch
  {
    const h = makeHarness({ peersAfter: [], claimReturns: true });
    await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: a launched member records its outcome", h.state.launches.length === 1 && h.state.outcomes.length === 1 && h.state.outcomes[0]!.outcome === "launched");
    t("FR-8 r6: markLaunching ran BEFORE launchMember (durable launch-sink state precedes the side effect)", h.state.launchings.length === 1 && h.state.launchings[0] === "m1");
  }
  // FR-8 (r7): markLaunching write failure (e.g. EACCES) MUST block the launch — launching on a failed mark re-opens the crash-window double.
  {
    const h = makeHarness({ peersAfter: [], claimReturns: true, markLaunchingOk: false });
    await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 r7: markLaunching fails ⇒ launchMember NOT called (no launch on an unconfirmed launch-sink marker)", h.state.launches.length === 0 && h.state.launchings.length === 1);
  }
  // FR-7 reuse in orchestrate: an incomplete episode marker ⇒ reuse its id
  {
    const h = makeHarness({ episode: { kind: "present", ep: { episodeId: "ep-REUSE", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false } }, peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-7: orchestrate reuses an incomplete episode id", r.episodeId === "ep-REUSE");
  }
  // FR-7 abort: unreadable episode ⇒ abort, no launches
  {
    const h = makeHarness({ episode: { kind: "unreadable" }, peersAfter: [] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-7: unreadable episode ⇒ abort (outstanding episode:*, 0 launches)", r.outstanding.some((o) => o.startsWith("episode:")) && h.state.launches.length === 0);
  }
  // FR-8 episode-marker unwritten ⇒ abort
  {
    const h = makeHarness({ peersAfter: [], writeEpisodeOk: false });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: episode-marker write refused ⇒ abort (outstanding episode-marker:unwritten, 0 launches)", r.outstanding.includes("episode-marker:unwritten") && h.state.launches.length === 0);
  }
  // happy path: all confirmed ⇒ outstanding empty + episode completed
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("happy: all confirmed ⇒ 0 outstanding + episode completed", r.outstanding.length === 0 && h.state.episodeWrites[h.state.episodeWrites.length - 1]!.completed === true);
  }

  // FR-8 (r5) facet-2: classifyLaunchError — only an EXPLICIT not-started (ENOENT/EACCES) ⇒ "failed"; timeout OR any other error ⇒ "unknown"
  t("FR-8 r5: classifyLaunchError timeout/killed/text ⇒ unknown", classifyLaunchError({ code: "ETIMEDOUT" }) === "unknown" && classifyLaunchError({ killed: true }) === "unknown" && classifyLaunchError({ message: "timed out" }) === "unknown");
  t("FR-8 r5: classifyLaunchError ENOENT/EACCES ⇒ failed (explicit not-started)", classifyLaunchError({ code: "ENOENT" }) === "failed" && classifyLaunchError({ code: "EACCES" }) === "failed");
  t("FR-8 r5: classifyLaunchError other non-timeout reply error ⇒ unknown (sent, indeterminate)", classifyLaunchError({ code: "1", message: "Connection is invalid. (-609)" }) === "unknown" && classifyLaunchError({ message: "boom" }) === "unknown");

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // STORE (real FS): FR-1a execArgv · FR-7 readEpisode three-state · FR-8 claim two-phase · FR-9 claim leaf CP-3 · FR-10
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // FR-1a: the recorded recipe includes process.execArgv (the tsx loader flags) between node and the script
  {
    const h = freshHome(); recordDispatcherRecipe(h, 1);
    const rec = readDispatcherRecipe(h);
    t("FR-1a: recipe argv includes process.execArgv (loader flags preserved)", rec !== null && process.execArgv.every((f) => rec.argv.includes(f)) && rec.argv[0] === process.argv[0]);
  }
  // FR-7: readEpisode three-state
  {
    const h = freshHome();
    t("store: readEpisode absent ⇒ absent", readEpisode(h).kind === "absent");
    mkdirSync(swarm(h), { recursive: true });
    writeEpisode(h, { episodeId: "e1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false });
    t("store: readEpisode present", readEpisode(h).kind === "present");
    writeFileSync(path.join(swarm(h), "recovery-episode.json"), "{corrupt");
    t("store: readEpisode corrupt ⇒ unreadable", readEpisode(h).kind === "unreadable");
  }
  // FR-8 claim two-phase (now + grace) + FR-9 leaf CP-3
  {
    const h = freshHome();
    t("FR-8 claim: none ⇒ true (launch); recent pending ⇒ false (no double)", claimRecoverLaunch(h, "m", "ep", 1000, 300) === true && claimRecoverLaunch(h, "m", "ep", 1000, 300) === false);
    markLaunchOutcome(h, "m", "ep", "launched");
    t("FR-8 claim: launched ⇒ false (awaiting visibility, no double)", claimRecoverLaunch(h, "m", "ep", 1000, 300) === false);
    claimRecoverLaunch(h, "m2", "ep", 1000, 300); markLaunchOutcome(h, "m2", "ep", "failed");
    t("FR-8 claim: failed ⇒ true (explicit not-started ⇒ safe retry)", claimRecoverLaunch(h, "m2", "ep", 1000, 300) === true);
    // FR-8: a STALE pending (claim acquired, launch not attempted, older than grace) ⇒ safe retry.
    claimRecoverLaunch(h, "m3", "ep", 1000, 300); // pending:1000
    t("FR-8 claim: stale pending (> grace) ⇒ true (safe retry)", claimRecoverLaunch(h, "m3", "ep", 1000 + 301, 300) === true);
    // FR-8 (r5) facet-1: an UNKNOWN outcome (launch SENT, indeterminate) is a DISTINCT `unknown:<ts>` marker — NEVER auto-retried, even
    // long after grace (that would need ESRCH proof of the launched process, not elapsed time). This is the r4 regression.
    claimRecoverLaunch(h, "m4", "ep", 2000, 300); markLaunchOutcome(h, "m4", "ep", "unknown"); // unknown:<now>
    t("FR-8 r5: unknown outcome ⇒ false immediately (no double)", claimRecoverLaunch(h, "m4", "ep", 2000, 300) === false);
    t("FR-8 r5: unknown outcome ⇒ NEVER auto-retried, even far past grace", claimRecoverLaunch(h, "m4", "ep", 2000 + 100000, 300) === false);
  }
  {
    // FR-9: a symlinked recover-launch DIR ⇒ claim refused + no escape
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-rl-"));
    symlinkSync(ext, path.join(swarm(h), "recover-launch"));
    t("FR-9: symlinked recover-launch dir ⇒ claimRecoverLaunch false", claimRecoverLaunch(h, "m", "ep", 1000, 300) === false);
    t("FR-9: no escape claim at the redirect target", !existsSync(path.join(ext, "ep")));
  }
  {
    // FR-9 r4: a symlinked claim-FILE leaf (dir chain fine) ⇒ the failed→pending / markLaunchOutcome rewrite must NOT follow it.
    const h = freshHome(); const ep = "ep"; const dir = path.join(swarm(h), "recover-launch", ep);
    mkdirSync(dir, { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-leaf-"));
    const target = path.join(ext, "outside.txt"); writeFileSync(target, "failed"); // pretend a prior failed claim, but the leaf is a symlink
    // the claim filename is sha256(memberKey).slice(0,32)+".claim"; compute it to plant the symlink
    const leaf = path.join(dir, `${createHash("sha256").update("mX").digest("hex").slice(0, 32)}.claim`);
    symlinkSync(target, leaf);
    t("FR-9 r4: symlinked claim-file leaf ⇒ claimRecoverLaunch refused (no follow)", claimRecoverLaunch(h, "mX", ep, 1000, 300) === false);
    t("FR-9 r4: the symlink target is NOT overwritten through the leaf", readFileSync(target, "utf8") === "failed");
    // FR-9 (r5): markLaunchOutcome writes through an O_NOFOLLOW fd too ⇒ it must not overwrite the target through the symlinked leaf.
    markLaunchOutcome(h, "mX", ep, "launched");
    t("FR-9 r5: markLaunchOutcome does NOT overwrite the symlink target through the leaf", readFileSync(target, "utf8") === "failed");
  }
  // FR-6 (r6): the recover lock REUSES the shared acquireHolderLock (holder-lock.ts) — "one lock semantic" (coordinator ruling). Its
  // internals (ESRCH-only reclaim, identity-in-filename no-double-hold, EIO=contend, hold-intent window) are covered by holder-lock's
  // own selftest; here we verify the recover SITE wiring gives sole-occupancy.
  {
    const h = freshHome();
    const site = recoverLockSite(h);
    mkdirSync(site.intentDir, { recursive: true, mode: 0o700 });
    const tok = acquireHolderLock(site);
    t("FR-6 r6: recover lock acquires via recoverLockSite (holder-lock reuse) ⇒ token", typeof tok === "string");
    releaseHolderLock(site, tok!);
    const tok2 = acquireHolderLock(site);
    t("FR-6 r6: recover lock re-acquires after release", typeof tok2 === "string");
    if (tok2) releaseHolderLock(site, tok2);
    // NB: cross-process sole-occupancy (a FOREIGN live pid ⇒ contend; ESRCH-only reclaim; no double-hold; EIO=contend) is holder-lock's
    // own contract + selftest — a same-PID second acquire here intentionally reclaims our own residue (SB1), so it is NOT retested here.
  }
  {
    // FR-6 (r7, rebased onto batch-20 converged holder-lock): the r6 finding — an EXTERNAL prepublish-dead empty lock dir (a recover
    // child SIGKILLed after mkdir but before publishing its identity, leaving an empty lockDir + a DEAD hold-intent) left 3 fresh PIDs at
    // 0 progress on the OLD holder-lock. The converged holder-lock reclaims an empty dir (rmdir-if-empty + fresh mkdir; it contends ONLY
    // on a LIVE foreign intent), so the recover path (reusing acquireHolderLock) now RECOVERS it. This verifies FR-6 auto-closes post-rebase.
    const h = freshHome();
    const site = recoverLockSite(h);
    mkdirSync(site.intentDir, { recursive: true, mode: 0o700 });
    mkdirSync(site.lockDir, { recursive: true, mode: 0o700 });               // prepublish death: empty lock dir, no identity published
    writeFileSync(path.join(site.intentDir, `${site.intentPrefix}999999.deadnonce`), ""); // the dead child's stranded hold-intent (dead pid)
    const tok = acquireHolderLock(site);
    t("FR-6 r7: external prepublish-dead empty lock ⇒ RECOVERED via converged holder-lock (not 0 progress)", typeof tok === "string");
    if (tok) releaseHolderLock(site, tok);
  }
  // FR-8 (r6) window-1: markLaunching writes the durable "launching:" state; claimRecoverLaunch NEVER auto-retries it (a crash after a
  // successful launch but before markLaunchOutcome leaves "launching:" — the launch MAY have dispatched, never a blind double).
  {
    const h = freshHome();
    claimRecoverLaunch(h, "mL", "ep", 1000, 300); // pending:1000
    markLaunching(h, "mL", "ep");                  // launching:<now>
    t("FR-8 r6 window1: after markLaunching ⇒ immediate re-claim false", claimRecoverLaunch(h, "mL", "ep", 1000, 300) === false);
    t("FR-8 r6 window1: launching ⇒ NEVER auto-retried, even far past grace", claimRecoverLaunch(h, "mL", "ep", 1000 + 100000, 300) === false);
  }
  // FR-9 (r6): a FIFO claim leaf must NOT block the open NOR be written through — O_NONBLOCK + fstat-regular refuses it.
  {
    const h = freshHome(); const ep = "ep"; const dir = path.join(swarm(h), "recover-launch", ep);
    mkdirSync(dir, { recursive: true });
    const leaf = path.join(dir, `${createHash("sha256").update("mF").digest("hex").slice(0, 32)}.claim`);
    execFileSync("mkfifo", [leaf]);
    const start = Date.now();
    const claimed = claimRecoverLaunch(h, "mF", ep, 1000, 300);
    t("FR-9 r6: FIFO claim leaf ⇒ claimRecoverLaunch refused + non-blocking", claimed === false && Date.now() - start < 2000);
    markLaunchOutcome(h, "mF", ep, "launched"); // must also not block nor write the outcome INTO the pipe
    t("FR-9 r6: markLaunchOutcome on a FIFO leaf ⇒ no-op, non-blocking", Date.now() - start < 2000);
  }
  // FR-10: boardItemId join (granted itemId = boardItemId(jobId,nodeId), attempt has raw nodeId)
  {
    const h = freshHome();
    const attempt: TaskAttempt = { attemptId: attemptIdOf("job1", "build", 0), jobId: "job1", planRevision: 1, nodeId: "build", status: "RUNNING", inputBindings: [], inputBindingDigest: "d", specDigest: "d", executionBindings: [], retriesUsed: 0, createdAtSeq: 1 };
    commitControl(path.join(swarm(h), "control-log"), initialLogState(), [{ put: "attempt", attempt, operationId: "op1", expectedEntityRevision: 0 }]);
    const itemId = boardItemId("job1", "build");
    t("FR-10: liveAttemptsForItems joins via boardItemId (not raw nodeId)", (() => { const a = liveAttemptsForItems(h, [itemId]); return a !== null && a.includes("job1/build/a0"); })());
    t("FR-10: the RAW nodeId does NOT match (proves the hashed join)", (() => { const a = liveAttemptsForItems(h, ["build"]); return a !== null && a.length === 0; })());
    t("FR-10: corrupt control-log ⇒ null (unknown)", (() => { writeFileSync(path.join(swarm(h), "control-log", "99.json"), "{torn"); return liveAttemptsForItems(h, [itemId]) === null; })());
  }
  // FR-10: breakpointFactsFor inbox three-state — a non-dir inbox path ⇒ unreadInbox null (not 0)
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop", "inbox"), { recursive: true });
    writeFileSync(path.join(h, ".agenthop", "inbox", "SID-X"), "not a dir"); // inboxDirName("SID-X")="SID-X" ⇒ readdir ENOTDIR
    t("FR-10: unreadable inbox (ENOTDIR) ⇒ unreadInbox null (not 0)", breakpointFactsFor(h, "SID-X").unreadInbox === null);
    t("FR-10: absent inbox ⇒ unreadInbox 0", breakpointFactsFor(freshHome(), "SID-Y").unreadInbox === 0);
  }

  // ── grantedItemsForMember (canonical parser, full SID) ──────────────────────────────────────────────────────────
  t("grantedItemsForMember: granted (not claimed), full-SID who", (() => {
    const parse = (name: string) => { const p = name.endsWith(".json") ? name.slice(0, -5).split(".") : []; return p.length >= 3 ? { itemId: p.slice(0, -2).join("."), state: p[p.length - 2]!, who: p[p.length - 1]! } : null; };
    return grantedItemsForMember("sid-uuid", ["hashid.granted.sid-uuid.json", "x.claimed.sid-uuid.json"], parse).join() === "hashid";
  })());

  // ── ZERO-BUG FIXTURES (write faces) ─────────────────────────────────────────────────────────────────────────────
  // crash-recovery: torn snapshot ⇒ null; good write recovers
  {
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    writeFileSync(path.join(swarm(h), "fleet-snapshot.json"), '{"schema":"fleet-recovery-snapshot/v1","capturedAtSec":1,');
    t("fixture[crash]: torn snapshot ⇒ null", readFleetSnapshot(h) === null);
    t("fixture[crash]: good write recovers", writeFleetSnapshot(h, goodRecipe, 9) && readFleetSnapshot(h)?.capturedAtSec === 9);
  }
  // restart-idempotency: receipt + episode last-wins
  {
    const h = freshHome();
    writeRecoveryReceipt(h, { pass: 1 }); writeRecoveryReceipt(h, { pass: 2 });
    t("fixture[idem]: receipt last-wins + schema", (readRecoveryReceipt(h) as { pass?: number })?.pass === 2 && readRecoveryReceipt(h)?.schema === FLEET_RECEIPT_SCHEMA);
    writeEpisode(h, { episodeId: "e", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false });
    writeEpisode(h, { episodeId: "e", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: true });
    t("fixture[idem]: episode last-wins", (() => { const r = readEpisode(h); return r.kind === "present" && r.ep.completed === true; })());
  }
  // concurrency-race: CP-3 ancestor symlink refuses every write face + no escape
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-anc-"));
    mkdirSync(path.join(ext, "console"), { recursive: true });
    symlinkSync(ext, swarm(h));
    t("fixture[race]: symlinked swarm ⇒ writeFleetSnapshot refused", writeFleetSnapshot(h, goodRecipe, 1) === false);
    t("fixture[race]: symlinked swarm ⇒ writeEpisode refused", writeEpisode(h, { episodeId: "e", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false }) === false);
    t("fixture[race]: symlinked swarm ⇒ writeRecoveryReceipt refused", writeRecoveryReceipt(h, { x: 1 }) === false);
    t("fixture[race]: symlinked swarm ⇒ recordDispatcherRecipe refused", recordDispatcherRecipe(h, 1) === false);
    t("fixture[race]: NO escape at the redirect target", !existsSync(path.join(ext, "fleet-snapshot.json")) && !existsSync(path.join(ext, "recovery-episode.json")) && !existsSync(path.join(ext, "console", "fleet-recovery.json")));
  }

  console.log("\nfleet-recovery r4 selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
