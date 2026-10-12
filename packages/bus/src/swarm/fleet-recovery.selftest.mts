// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/fleet-recovery.selftest.mts
// full-fleet-recovery r3 (codex:Work r2 @040f550: FR-2/3/4 CLOSED, 8 REMAIN on evidence/identity/atomicity). Pins the rebuilt core +
// store + runs the REAL orchestrateRecover with fakes, each test reproducing a reviewer finding:
//  FR-1a execArgv captured · FR-1b scrub keeps the SSH user · FR-5 identity triple (title alone ≠ identity) · FR-7 reuse-incomplete
//  (any age) + unreadable-abort · FR-8 claim≠launch two-phase + report-with-real-results + receipt-in-completion · FR-9 claim leaf
//  CP-3 · FR-10 boardItemId join + inbox three-state. Plus the 3 zero-bug fixture classes over the write faces.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA, scrubValueSecrets, parseDispatcherRecipe, parseFleetSnapshot, snapshotStaleSec,
  dispatcherNeedsRelaunch, dispatcherVerdict, memberVerdict, resolveMemberSid, resolveEpisode, buildBreakpointText,
  grantedItemsForMember, deliveryDischarged, summarizeOutstanding, orchestrateRecover,
  type FleetSnapshot, type DispatcherRecipe, type RecoverDeps, type RecoveryEpisode, type EpisodeRead, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus, type DispatcherLiveness, type RecoveryResult,
} from "./fleet-recovery.js";
import {
  writeFleetSnapshot, readFleetSnapshot, recordDispatcherRecipe, readDispatcherRecipe, writeEpisode, readEpisode,
  claimRecoverLaunch, markLaunchOutcome, liveAttemptsForItems, breakpointFactsFor, writeRecoveryReceipt, readRecoveryReceipt, FLEET_RECEIPT_SCHEMA,
} from "./fleet-recovery-store.js";
import { boardItemId } from "./task-board.js";
import { attemptIdOf, type TaskAttempt } from "./task-state.js";
import { initialLogState } from "./control-log.js";
import { commitControl } from "./control-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "fleet-recovery-r3-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");
const goodRecipe: DispatcherRecipe = { argv: ["/usr/bin/node", "scripts/swarm-dispatch.ts"], cwd: "/repo", env: { SWARM_SELF: "d1", HERDR_ENV: "1" }, source: "self-recorded" };
const goodSnap: FleetSnapshot = { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: 1000, dispatcher: goodRecipe, rosterFile: "/h/roster.json" };

try {
  // ── FR-1b: scrub keeps the SSH user, strips only the password ────────────────────────────────────────────────────
  t("FR-1b: ssh://git@host UNCHANGED (user is a non-secret address part)", scrubValueSecrets("ssh://git@host/repo.git") === "ssh://git@host/repo.git");
  t("FR-1b: https://user:{{PASSWORD_mcu5s9ca}}@host ⇒ https://user@host (keep user, drop password)", scrubValueSecrets("https://user:{{PASSWORD_mcu5s9ca}}@git.example/o/r.git") === "https://user@git.example/o/r.git");
  t("FR-1b: clean URL untouched", scrubValueSecrets("https://git.example/o/r.git") === "https://git.example/o/r.git");

  // ── FR-5: identity triple (SID exact, else title+tool+cwd); a reused title alone is NOT identity ──────────────────
  {
    const member: RosterMemberLike = { member: "SID-A", title: "seat", tool: "claude", cwd: "/repo-A" };
    const peerReusedTitle: PeerLikeMin[] = [{ stableId: "SID-B", title: "seat", tool: "codex", cwd: "/repo-B" }]; // reuses the title, different everything else
    t("FR-5: reused title + different tool/cwd ⇒ ABSENT (not confirmed to the wrong peer)", resolveMemberSid(member, peerReusedTitle).kind === "absent");
    t("FR-5: exact SID match ⇒ resolved", resolveMemberSid({ member: "SID-A" }, [{ stableId: "SID-A", title: "x" }]).kind === "resolved");
    t("FR-5: title+tool+cwd all match ⇒ resolved", (() => { const r = resolveMemberSid(member, [{ stableId: "SID-Z", title: "seat", tool: "claude", cwd: "/repo-A" }]); return r.kind === "resolved" && r.sid === "SID-Z"; })());
    t("FR-5: two peers with matching triple ⇒ ambiguous", resolveMemberSid(member, [{ stableId: "S1", title: "seat", tool: "claude", cwd: "/repo-A" }, { stableId: "S2", title: "seat", tool: "claude", cwd: "/repo-A" }]).kind === "ambiguous");
  }

  // ── FR-7: episode — reuse incomplete ANY age; unreadable ⇒ abort; complete/absent ⇒ new ─────────────────────────
  const mint = () => "ep-NEW";
  t("FR-7: incomplete + VERY old ⇒ REUSE (age is not evidence the launch vanished)", (() => { const r = resolveEpisode({ kind: "present", ep: { episodeId: "ep-1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false } }, mint); return r.action === "reuse" && r.episodeId === "ep-1"; })());
  t("FR-7: unreadable marker ⇒ ABORT (never re-mint over an outstanding recovery)", resolveEpisode({ kind: "unreadable" }, mint).action === "abort");
  t("FR-7: completed ⇒ NEW", resolveEpisode({ kind: "present", ep: { episodeId: "ep-1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: true } }, mint).action === "new");
  t("FR-7: absent ⇒ NEW", resolveEpisode({ kind: "absent" }, mint).action === "new");

  // ── FR-3 (kept) + verdicts + breakpoint ─────────────────────────────────────────────────────────────────────────
  t("FR-3: wake NULL (target env unreadable) ⇒ unknown", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: null }, 120) === "unknown");
  t("verdict confirmed/failed", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" }, 120) === "confirmed" && dispatcherVerdict({ pidAlive: false, heartbeatFreshSec: 1, wakeStatus: "on" }, 120) === "failed");
  t("memberVerdict + dispatcherNeedsRelaunch + snapshotStaleSec", memberVerdict(true, false, false) === "confirmed" && dispatcherNeedsRelaunch(goodSnap, false) && snapshotStaleSec({ capturedAtSec: 1000 }, 1600) === 600);
  t("parseDispatcherRecipe argv with spaces round-trips; parseFleetSnapshot ok", parseDispatcherRecipe({ argv: ["/n", "my file.ts"], cwd: "/r", env: {}, source: "self-recorded" })?.argv[1] === "my file.ts" && parseFleetSnapshot(JSON.stringify(goodSnap)) !== null);
  t("buildBreakpointText unreadable⇒'无法读取'; summarize/discharged", buildBreakpointText({ member: "m", grantedItems: null, liveAttempts: null, unreadInbox: null }, "T").includes("无法读取") && deliveryDischarged("published") && !deliveryDischarged("failed"));

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // FR-8 via REAL orchestrateRecover (fakes): claim≠launch, report-with-real-results, receipt-in-completion
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  type HOpts = Partial<{ episode: EpisodeRead; peersAfter: PeerLikeMin[]; claimReturns: boolean; disp: DispatcherLiveness; writeReceiptOk: boolean; writeEpisodeOk: boolean }>;
  function makeHarness(o: HOpts) {
    const state = { episodeWrites: [] as RecoveryEpisode[], launches: [] as string[], outcomes: [] as { m: string; ok: boolean }[], reportArg: null as RecoveryResult | null, receiptArg: null as RecoveryResult | null };
    const deps: RecoverDeps = {
      now: () => 1000, mintEpisodeId: () => "ep-NEW", heartbeatThresholdSec: 120, breakpointsEnabled: true, recoveredAtIso: "T",
      readEpisode: () => o.episode ?? { kind: "absent" },
      writeEpisode: (ep) => { state.episodeWrites.push(ep); return o.writeEpisodeOk ?? true; },
      dispatcherLive: () => false,
      relaunchDispatcher: () => true,
      verifyDispatcher: () => o.disp ?? { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" },
      peers: () => o.peersAfter ?? [],
      settle: async () => {},
      claimLaunch: () => o.claimReturns ?? true,
      launchMember: async (m) => { state.launches.push(m.member); return { ok: true }; },
      markLaunchOutcome: (m, _ep, ok) => { state.outcomes.push({ m, ok }); },
      breakpointFacts: (sid) => ({ member: sid, grantedItems: [], liveAttempts: [], unreadInbox: 0 }),
      deliverBreakpoint: () => "published",
      deliverReport: (r) => { state.reportArg = r; return "published"; },
      writeReceipt: (r) => { state.receiptArg = r; return o.writeReceiptOk ?? true; },
    };
    return { deps, state };
  }
  const roster: RosterMemberLike[] = [{ member: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }];

  // FR-8 report-with-real-results: dispatcher inert + member absent ⇒ deliverReport MUST receive notConfirmed>0 (not a zeroed placeholder)
  {
    const h = makeHarness({ disp: { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(inert:no-herdr)" }, peersAfter: [] });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: deliverReport got the REAL result (notConfirmed>0), not a zeroed placeholder", h.state.reportArg !== null && h.state.reportArg.notConfirmed >= 2 && h.state.reportArg.outstanding.length >= 2);
    t("FR-8: final result not falsely 'all confirmed'", r.notConfirmed >= 2 && r.outstanding.some((o) => o.startsWith("dispatcher:")));
  }
  // FR-8 receipt-in-completion: writeReceipt false ⇒ outstanding gains receipt:unwritten + episode NOT completed
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], writeReceiptOk: false });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: receipt write refused ⇒ 'receipt:unwritten' outstanding", r.outstanding.includes("receipt:unwritten"));
    t("FR-8: episode NOT marked completed when receipt unwritten", h.state.episodeWrites[h.state.episodeWrites.length - 1]!.completed === false);
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
    t("FR-8: a launched member records its outcome", h.state.launches.length === 1 && h.state.outcomes.length === 1 && h.state.outcomes[0]!.ok === true);
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
  // FR-8 claim two-phase + FR-9 leaf CP-3
  {
    const h = freshHome();
    t("FR-8 claim: none ⇒ true (launch); pending ⇒ false (no double)", claimRecoverLaunch(h, "m", "ep") === true && claimRecoverLaunch(h, "m", "ep") === false);
    markLaunchOutcome(h, "m", "ep", true);
    t("FR-8 claim: launched ⇒ false (awaiting visibility, no double)", claimRecoverLaunch(h, "m", "ep") === false);
    claimRecoverLaunch(h, "m2", "ep"); markLaunchOutcome(h, "m2", "ep", false);
    t("FR-8 claim: failed ⇒ true (explicit not-started ⇒ safe retry)", claimRecoverLaunch(h, "m2", "ep") === true);
  }
  {
    // FR-9: a symlinked recover-launch leaf (swarm itself fine) ⇒ claim refused + no escape
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-rl-"));
    symlinkSync(ext, path.join(swarm(h), "recover-launch"));
    t("FR-9: symlinked recover-launch leaf ⇒ claimRecoverLaunch false", claimRecoverLaunch(h, "m", "ep") === false);
    t("FR-9: no escape claim at the redirect target", !existsSync(path.join(ext, "ep")));
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

  console.log("\nfleet-recovery r3 selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
