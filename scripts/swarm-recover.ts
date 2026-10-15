#!/usr/bin/env tsx
/**
 * swarm-recover — ONE command to bring the whole swarm back after a reboot (full-fleet-recovery, brief @cf7a6e2; r2 after
 * codex:Work @29bd0e1). Thin IO shell: it wires REAL deps (bus peers, dispatcher spawn, per-member launch, inbox delivery) into the
 * dep-injected orchestration (orchestrateRecover in fleet-recovery.ts) — so the real recovery flow is the SAME code the selftest
 * drives with fakes (FR-11). Member launch reuses the F36 resume core (resumeCommandForMember + planResume + splitCommand) but is
 * driven PER-MEMBER here so each launch is under a per-episode ownership claim (FR-6).
 *
 *   tsx scripts/swarm-recover.ts --snapshot   # capture fleet-snapshot.json (self-recorded dispatcher recipe) + the roster
 *   tsx scripts/swarm-recover.ts --dry        # show what would relaunch, take NO action
 *   tsx scripts/swarm-recover.ts              # recover: dispatcher -> members -> verify -> breakpoint -> report
 */
import { execFileSync, spawn } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { startBusCore } from "../packages/bus/src/core.js";
import { writeInbox, composeInboxMsg } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import { inboxWakeStatus } from "../packages/bus/src/swarm/inbox-wake.js";
import { buildAppleScript } from "../packages/bus/src/spawn.js";
import { herdrAgentName, herdrAgentStates, herdrLaunch, herdrServerReachable, herdrSpawnable, splitCommand } from "../packages/bus/src/swarm/herdr.js";
import { parseSnapshot, planResume, resumeCommandForMember, type RosterMember, type PeerLike } from "../packages/bus/src/swarm/resume.js";
import {
  orchestrateRecover, snapshotStaleSec, breakpointInjectionEnabled, dispatcherNeedsRelaunch, classifyLaunchError,
  deriveRecoveryDisplay,
  type RecoverDeps, type RecoveryResult, type DispatcherRecipe, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus, type LaunchOutcome,
} from "../packages/bus/src/swarm/fleet-recovery.js";
import {
  captureDispatcherRecipe, dispatcherLive, dispatcherPid, heartbeatFreshSec, captureEnvForPid,
  writeFleetSnapshot, readFleetSnapshot, readEpisode, writeEpisode, claimRecoverLaunch, markLaunching, markLaunchOutcome, breakpointFactsFor,
  writeRecoveryReceipt, readRecoveryReceipt, recoverLockSite,
} from "../packages/bus/src/swarm/fleet-recovery-store.js";
import { acquireHolderLock, releaseHolderLock } from "../packages/bus/src/swarm/holder-lock.js";

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const log = (s: string) => console.log(s);
function home(): string { return process.env.AH_HOME ?? homedir(); }
function rosterFilePath(h: string): string { return path.join(h, ".agenthop", "swarm", "roster-snapshot.json"); }
const toMin = (p: PeerLike): PeerLikeMin => ({ ...(p.id ? { id: p.id } : {}), ...(p.stableId ? { stableId: p.stableId } : {}), ...(p.title ? { title: p.title } : {}), ...(p.tool ? { tool: p.tool } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) }); // FR-5: carry tool/cwd for the identity triple

/** Launch ONE member via the F36 resume core (herdr when reachable + the command tokenizes cleanly, else Ghostty). Async; returns
 *  {ok}. Mirrors swarm-resume's launch branch, driven per-member so the caller can claim ownership first (FR-6). */
async function launchOneMember(full: RosterMember, useHerdr: boolean, taken: Set<string>): Promise<{ outcome: LaunchOutcome; error?: string }> {
  const cmd = resumeCommandForMember(full);
  try {
    const sc = splitCommand(cmd);
    if (useHerdr && sc.balanced) {
      const name = herdrAgentName(full.title ?? full.member, taken); taken.add(name);
      const r = await herdrLaunch({ name, kind: sc.kind, cwd: full.cwd, args: sc.args });
      if (r.state === "started") { log(`  launched[herdr] ${full.title ?? full.member}`); return { outcome: "launched" }; }
      if (r.state === "unconfirmed") { log(`  herdr UNCONFIRMED ${full.title ?? full.member} (${r.note}) — outcome unknown, not retried`); return { outcome: "unknown" }; } // FR-8: sent, result indeterminate
      log(`  herdr not-started (${r.note}); Ghostty fallback for ${full.title ?? full.member}`);
    }
    await pexec("osascript", ["-e", buildAppleScript({ command: cmd, cwd: full.cwd, env: [] })], { timeout: 15000 });
    log(`  launched ${full.title ?? full.member} ${full.cwd}`);
    return { outcome: "launched" };
  } catch (e) {
    // FR-8 (r5): classifyLaunchError (pure core) — only an EXPLICIT not-started error (ENOENT/EACCES: the launcher binary could not be
    // spawned) is a retryable "failed"; a timeout or any other post-dispatch error is indeterminate ⇒ "unknown" (never a blind retry).
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    const outcome = classifyLaunchError(err);
    log(`  launch ${outcome === "failed" ? "FAILED (not started)" : "UNKNOWN (sent, result indeterminate)"} ${full.title ?? full.member}: ${err.message}`);
    return { outcome, error: err.message };
  }
}

/** Relaunch the dispatcher from its recipe — spawn argv[0] with argv.slice(1) DIRECTLY (FR-1: no shell re-split, spaces safe), env
 *  = live shell (profile secrets) merged with the captured allowlisted+scrubbed vars. Fail-soft incl. the async spawn 'error' (FR-8:
 *  never an unhandled crash). Returns false on a sync fault. */
function relaunchDispatcher(recipe: DispatcherRecipe): boolean {
  if (recipe.source === "ps-fallback") log(`  WARN dispatcher recipe is ps-fallback (LOSSY — spaces not recoverable); restart the dispatcher once so it self-records a lossless recipe.`);
  try {
    const logDir = path.join(home(), ".agenthop", "swarm");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const fd = openSync(path.join(logDir, "dispatcher.log"), "a");
    const env = { ...process.env, ...recipe.env };
    const child = spawn(recipe.argv[0]!, recipe.argv.slice(1), { cwd: recipe.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    child.on("error", (e) => log(`  dispatcher relaunch spawn error (isolated, FR-8): ${e.message}`)); // no unhandled crash
    child.unref();
    log(`  launched dispatcher (pid ${child.pid}) cwd ${recipe.cwd}`);
    return true;
  } catch (e) { log(`  dispatcher relaunch FAILED (sync): ${(e as Error).message}`); return false; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const H = home();

  // --- --snapshot: capture the (self-recorded, lossless) dispatcher recipe + the roster ------------------------------
  if (flag("--snapshot")) {
    const recipe = captureDispatcherRecipe(H, REPO);
    if (!writeFleetSnapshot(H, recipe, nowSec())) { console.error("fleet snapshot SKIPPED (CP-3: dir chain redirected)"); process.exit(1); }
    log(recipe ? `captured dispatcher recipe (${recipe.source}, ${recipe.argv.length} argv, ${Object.keys(recipe.env).length} env) -> fleet-snapshot.json` : `no dispatcher recipe (none live, none self-recorded); wrote roster pointer only`);
    try { execFileSync("npx", ["tsx", path.join(HERE, "swarm-resume.ts"), "--snapshot"], { cwd: REPO, stdio: "inherit" }); }
    catch (e) { console.error(`roster snapshot failed: ${(e as Error).message}`); process.exit(1); }
    return;
  }

  // --- read + VALIDATE the fleet snapshot (absent/corrupt ⇒ refuse) --------------------------------------------------
  const snap = readFleetSnapshot(H);
  if (!snap) { console.error(`no usable fleet-snapshot.json. Capture one first: tsx scripts/swarm-recover.ts --snapshot`); process.exit(1); }
  const stale = snapshotStaleSec(snap, nowSec());
  if (stale > 24 * 3600) log(`NOTE: fleet snapshot is ${(stale / 3600).toFixed(1)}h old.`);

  // --- FR-4: read + VALIDATE the roster (absent/corrupt ⇒ REFUSE; a valid members:[] is distinct = nothing to recover) ---
  let rosterText: string;
  try { rosterText = readFileSync(rosterFilePath(H), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") console.error(`FR-4: roster snapshot ABSENT at ${rosterFilePath(H)} — refusing (never recover an empty fleet). Capture: tsx scripts/swarm-recover.ts --snapshot`);
    else console.error(`FR-4: roster snapshot UNREADABLE (${(e as Error).message}) — refusing.`);
    process.exit(1);
  }
  const rosterSnap = parseSnapshot(rosterText);
  if (!rosterSnap) { console.error(`FR-4: roster snapshot CORRUPT — refusing (never guess a fleet).`); process.exit(1); }
  const fullMembers = rosterSnap.members; // RosterMember[] (carry resumeCmd for launch)
  const fullByMember = new Map(fullMembers.map((m) => [m.member, m] as const));
  const rosterLike: RosterMemberLike[] = fullMembers.map((m) => ({ member: m.member, ...(m.title ? { title: m.title } : {}), tool: m.tool, cwd: m.cwd }));

  if (flag("--dry")) {
    const needDisp = dispatcherNeedsRelaunch(snap, dispatcherLive(H));
    log(`[DRY] dispatcher ${dispatcherLive(H) ? "LIVE (skip)" : needDisp ? "down -> would relaunch" : "down, no recipe"}; roster ${fullMembers.length} member(s).`);
    if (needDisp && snap.dispatcher) log(`[DRY] dispatcher argv: ${snap.dispatcher.argv.join(" ")} (${snap.dispatcher.source})`);
    try { execFileSync("npx", ["tsx", path.join(HERE, "swarm-resume.ts"), "--dry"], { cwd: REPO, stdio: "inherit" }); } catch { /* informational */ }
    return;
  }

  // --- wire real deps + run the orchestration -----------------------------------------------------------------------
  // FR-6 (r6): serialize recover with the SHARED sole-occupancy primitive acquireHolderLock (holder-lock.ts) — one lock semantic across
  // SUCC-1/FR-6/TGP-11 (coordinator ruling). A SECOND concurrent recover gets null and exits cleanly, so two processes can never mint
  // rival episodes and double-launch the same member. ESRCH-only reclaim + identity-in-filename ⇒ no stale/double-hold; a hold-intent
  // protects the empty mkdir→publish window; any read fault ⇒ contend (never steal).
  const lockSite = recoverLockSite(H);
  mkdirSync(lockSite.intentDir, { recursive: true, mode: 0o700 }); // holder-lock requires the intent dir to exist before acquiring
  const lockToken = acquireHolderLock(lockSite);
  if (lockToken === null) { log(`recover: another recover holds the single-flight lock (or it is unverifiable) — HOLDING (exiting).`); return; }
  const releaseLock = () => releaseHolderLock(lockSite, lockToken);

  const core = startBusCore({ home: H });
  await sleep(1200); // let the broker/relay announce before the first peer read
  const useHerdr = herdrSpawnable(process.env) && (await herdrServerReachable());
  const taken = useHerdr ? new Set((await herdrAgentStates()).map((a) => a.name)) : new Set<string>();
  const recoveredIso = new Date().toISOString();
  const coordRef = opt("--coordinator") ?? process.env.SWARM_COORDINATOR ?? "";

  const deps: RecoverDeps = {
    now: nowSec,
    mintEpisodeId: () => `ep-${nowSec()}-${randomBytes(3).toString("hex")}`,
    heartbeatThresholdSec: 120,
    breakpointsEnabled: breakpointInjectionEnabled(),
    recoveredAtIso: recoveredIso,
    readEpisode: () => readEpisode(H),
    writeEpisode: (ep) => writeEpisode(H, ep), // FR-8: returns success (not swallowed)
    dispatcherLive: () => dispatcherLive(H),
    relaunchDispatcher,
    verifyDispatcher: () => {
      const pid = dispatcherPid(H);
      let wakeStatus: ReturnType<typeof inboxWakeStatus> | null = null;
      if (pid !== null) { const { env, ok } = captureEnvForPid(pid); if (ok) wakeStatus = inboxWakeStatus(env as NodeJS.ProcessEnv); } // FR-3: TARGET env ONLY
      return { pidAlive: dispatcherLive(H), heartbeatFreshSec: heartbeatFreshSec(H, nowSec()), wakeStatus };
    },
    peers: () => core.peers().map(toMin),
    settle: () => sleep(5000),
    claimLaunch: (memberKey, episodeId) => claimRecoverLaunch(H, memberKey, episodeId, nowSec(), 300), // FR-8: 300s grace for a stale-pending safe retry
    launchMember: async (m) => { const full = fullByMember.get(m.member); if (!full) return { outcome: "failed" as LaunchOutcome, error: "no roster entry" }; return launchOneMember(full, useHerdr, taken); },
    markLaunching: (memberKey, episodeId) => markLaunching(H, memberKey, episodeId), // FR-8 (r6): durable "launch sink entered" BEFORE the side effect
    markLaunchOutcome: (memberKey, episodeId, outcome) => markLaunchOutcome(H, memberKey, episodeId, outcome), // FR-8: launched|failed|unknown
    breakpointFacts: (sid) => breakpointFactsFor(H, sid),
    deliverBreakpoint: (sid, text, episodeId) => {
      try { const msg = composeInboxMsg({ from: "fleet-recovery", fromLabel: "swarm-recover", text, via: "fleet-recovery", intent: "fyi" }); return writeInbox(H, sid, msg, `fr-bp-${episodeId}-${shortHash(sid)}`) as DeliveryStatus; }
      catch { return "failed"; }
    },
    deliverReport: (result, episodeId) => {
      if (!coordRef) { log(`  SWARM_COORDINATOR unset — report to disk only.`); return "skipped"; }
      const coordSid = resolveSession(coordRef, listSessions(H));
      if (!coordSid) { log(`  FR-5: coordinator '${coordRef}' did not resolve to a live SID — NOT writing to a bare handle box; report on disk only.`); return "failed"; }
      const text = reportText(result, stale, recoveredIso); // FR-8: the REAL result (real outstanding/notConfirmed), never a zeroed placeholder
      try { const msg = composeInboxMsg({ from: "fleet-recovery", fromLabel: "swarm-recover", text, via: "fleet-recovery", intent: result.notConfirmed > 0 ? "report" : "fyi" }); return writeInbox(H, coordSid, msg, `fr-report-${episodeId}`) as DeliveryStatus; }
      catch { return "failed"; }
    },
    // FR-8 (r9): the durable receipt is part of the completion criteria — a refused write ⇒ orchestrateRecover adds it to outstanding
    //   (exit≠0). TWO-PHASE: a "provisional" receipt lands final:false + an explicit finalization:pending obligation so a receipt-only read
    //   can never mistake an unfinalized recovery for a clean completion; the "final" phase rewrites it final:true with the settled
    //   outstanding. The episode marker (written last) remains the AUTHORITATIVE completion/rerun criterion.
    writeReceipt: (result, phase) => writeRecoveryReceipt(H, {
      episodeId: result.episodeId, recoveredAtSec: nowSec(), snapshotCapturedAtSec: snap.capturedAtSec, staleSec: stale,
      dispatcher: result.dispatcher, members: result.members, reportDelivery: result.reportDelivery,
      final: phase === "final",
      outstanding: phase === "final" ? result.outstanding : [...result.outstanding, "finalization:pending"],
      notConfirmed: result.notConfirmed,
    }),
  };

  let result: RecoveryResult;
  try { result = await orchestrateRecover(snap, rosterLike, deps); }
  finally { await core.close(); releaseLock(); } // FR-6: always release the single-flight lock

  // --- outcome. The receipt is a WORK SNAPSHOT (r10); the AUTHORITATIVE status is derived through the READ PATH from the marker FOR
  //     THIS run's episode (r11: bound to result.episodeId — a STALE marker from a prior completed episode must NOT read "completed" for
  //     this run). We re-read the marker + the receipt off disk and bind BOTH to result.episodeId, so the exact path a later reader/rerun
  //     would take is the one that produces the displayed verdict. ------------------------------------------------------------------------
  log(`receipt: ${result.outstanding.includes("receipt:unwritten") ? "UNWRITTEN (CP-3) — outstanding" : "written (work snapshot) -> console/fleet-recovery.json"}`);
  // r11b (FR-8-GATE): the display adapter takes THIS run's `result` and binds the status to result.episodeId INTERNALLY — the caller
  //   cannot pass a mismatched identity (the r10/caller-regression surface is gone), and the binding is covered by a submission gate that
  //   runs this exact read path. The marker + receipt are read through the real store readers here.
  const disp = deriveRecoveryDisplay(
    result,
    () => readEpisode(H),
    () => { const rc = readRecoveryReceipt(H); return rc && typeof rc.final === "boolean" && typeof rc.episodeId === "string" ? { episodeId: rc.episodeId as string, final: rc.final as boolean } : null; },
  );
  const staleMarkerNote = disp.staleMarkerEpisodeId ? ` (on-disk marker belongs to a DIFFERENT episode ${disp.staleMarkerEpisodeId}; this run's episode is not established there)` : "";
  log(`status (authoritative = this episode's marker): ${disp.line}${staleMarkerNote}`);
  const confirmed = result.members.filter((m) => m.verdict === "confirmed").length;
  log(`done: episode ${result.episodeId}; dispatcher ${result.dispatcher.verdict} (wake=${result.dispatcher.wakeStatus ?? "unknown"}); members ${confirmed}/${result.members.length} confirmed; report ${result.reportDelivery}; ${result.outstanding.length} outstanding.`);
  if (result.outstanding.length > 0) { log(`OUTSTANDING (re-run to retry): ${result.outstanding.join("; ")}`); process.exitCode = 1; }
}

/** The coordinator report text — honest about dispatcher wake + outstanding obligations (FR-8). It is delivered MID-FLIGHT (before the
 *  episode marker is written), so it deliberately makes NO completion claim: the AUTHORITATIVE committed status is the episode marker
 *  (recovery-episode.json), finalized after this report, and the receipt is only a WORK snapshot (r10 — final:true ≠ committed). */
function reportText(r: RecoveryResult, stale: number, iso: string): string {
  const confirmed = r.members.filter((m) => m.verdict === "confirmed").length;
  return [
    `[fleet-recovery] 舰队恢复 @ ${iso} (episode ${r.episodeId})。`,
    `调度器=${r.dispatcher.verdict}(wake=${r.dispatcher.wakeStatus ?? "unknown"}${r.dispatcher.relaunched ? ",已重启" : ""})。`,
    `成员:${confirmed}/${r.members.length} confirmed。`,
    r.outstanding.length > 0 ? `⚠ 未完成(需重做/重跑):${r.outstanding.join("; ")}。` : `全部 confirmed,无未完成项。`,
    `提交态=权威 episode marker(recovery-episode.json);收据 console/fleet-recovery.json 仅工作快照(final:true≠已提交)。`,
    `快照龄 ${(stale / 3600).toFixed(1)}h。`,
  ].join(" ");
}

if (process.argv[1] && /(^|\/)swarm-recover\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
