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
  grantedItemsForMember, deliveryDischarged, summarizeOutstanding, orchestrateRecover, classifyLaunchError,
  type FleetSnapshot, type DispatcherRecipe, type RecoverDeps, type RecoveryEpisode, type EpisodeRead, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus, type DispatcherLiveness, type RecoveryResult, type LaunchOutcome,
} from "./fleet-recovery.js";
import {
  writeFleetSnapshot, readFleetSnapshot, recordDispatcherRecipe, readDispatcherRecipe, writeEpisode, readEpisode,
  claimRecoverLaunch, markLaunchOutcome, liveAttemptsForItems, breakpointFactsFor, writeRecoveryReceipt, readRecoveryReceipt, FLEET_RECEIPT_SCHEMA,
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
  t("verdict confirmed/failed", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" }, 120) === "confirmed" && dispatcherVerdict({ pidAlive: false, heartbeatFreshSec: 1, wakeStatus: "on" }, 120) === "failed");
  t("memberVerdict + dispatcherNeedsRelaunch + snapshotStaleSec", memberVerdict(true, false, false) === "confirmed" && dispatcherNeedsRelaunch(goodSnap, false) && snapshotStaleSec({ capturedAtSec: 1000 }, 1600) === 600);
  t("parseDispatcherRecipe argv with spaces round-trips; parseFleetSnapshot ok", parseDispatcherRecipe({ argv: ["/n", "my file.ts"], cwd: "/r", env: {}, source: "self-recorded" })?.argv[1] === "my file.ts" && parseFleetSnapshot(JSON.stringify(goodSnap)) !== null);
  t("buildBreakpointText unreadable⇒'无法读取'; summarize/discharged", buildBreakpointText({ member: "m", grantedItems: null, liveAttempts: null, unreadInbox: null }, "T").includes("无法读取") && deliveryDischarged("published") && !deliveryDischarged("failed"));

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // FR-8 via REAL orchestrateRecover (fakes): claim≠launch, report-with-real-results, receipt-in-completion
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  type HOpts = Partial<{ episode: EpisodeRead; peersAfter: PeerLikeMin[]; claimReturns: boolean; launchOutcome: LaunchOutcome; disp: DispatcherLiveness; writeReceiptOk: boolean; writeEpisodeOk: boolean; failWriteEpisodeAfter: number }>;
  function makeHarness(o: HOpts) {
    const state = { episodeWrites: [] as RecoveryEpisode[], launches: [] as string[], launchings: [] as string[], outcomes: [] as { m: string; outcome: LaunchOutcome }[], reportArg: null as RecoveryResult | null, receiptArg: null as RecoveryResult | null };
    const deps: RecoverDeps = {
      now: () => 1000, mintEpisodeId: () => "ep-NEW", heartbeatThresholdSec: 120, breakpointsEnabled: true, recoveredAtIso: "T",
      readEpisode: () => o.episode ?? { kind: "absent" },
      writeEpisode: (ep) => { state.episodeWrites.push(ep); if (o.failWriteEpisodeAfter !== undefined && state.episodeWrites.length > o.failWriteEpisodeAfter) return false; return o.writeEpisodeOk ?? true; },
      dispatcherLive: () => false,
      relaunchDispatcher: () => true,
      verifyDispatcher: () => o.disp ?? { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" },
      peers: () => o.peersAfter ?? [],
      settle: async () => {},
      claimLaunch: () => o.claimReturns ?? true,
      launchMember: async (m) => { state.launches.push(m.member); return { outcome: o.launchOutcome ?? "launched" }; },
      markLaunching: (m) => { state.launchings.push(m); },
      markLaunchOutcome: (m, _ep, outcome) => { state.outcomes.push({ m, outcome }); },
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
  // FR-8 receipt-in-completion: writeReceipt false ⇒ outstanding gains receipt:unwritten
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], writeReceiptOk: false });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8: receipt write refused ⇒ 'receipt:unwritten' outstanding", r.outstanding.includes("receipt:unwritten"));
    // FR-8 (r6) window-2: a receipt-write failure must REVERT the episode marker to incomplete — else resolveEpisode mints a NEW
    // episode on re-run and re-delivers breakpoints (dup). The LAST episode write is the compensating completed=false revert.
    t("FR-8 r6 window2: receipt fail ⇒ episode marker REVERTED to completed=false (re-run reuses, no dup breakpoint)", h.state.episodeWrites[h.state.episodeWrites.length - 1]!.completed === false);
  }
  // FR-8 r5 seam3 + facet-3: the FINAL writeEpisode failing ⇒ 'episode-final:unwritten' outstanding AND the durable receipt (written
  // AFTER the episode marker) reflects that settled outstanding — it can NEVER claim outstanding:[] while the marker is incomplete.
  {
    const h = makeHarness({ peersAfter: [{ stableId: "m1", title: "Work-m1", tool: "claude", cwd: "/r1" }], failWriteEpisodeAfter: 1 });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("FR-8 seam3: final writeEpisode false ⇒ 'episode-final:unwritten' outstanding (exit≠0)", r.outstanding.includes("episode-final:unwritten"));
    t("FR-8 r5 facet-3: the receipt reflects the final outstanding (episode-final:unwritten), never a false zero", h.state.receiptArg !== null && h.state.receiptArg.outstanding.includes("episode-final:unwritten"));
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
