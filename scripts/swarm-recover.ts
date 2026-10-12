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
  orchestrateRecover, snapshotStaleSec, breakpointInjectionEnabled, dispatcherNeedsRelaunch,
  type RecoverDeps, type RecoveryResult, type DispatcherRecipe, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus,
} from "../packages/bus/src/swarm/fleet-recovery.js";
import {
  captureDispatcherRecipe, dispatcherLive, dispatcherPid, heartbeatFreshSec, captureEnvForPid,
  writeFleetSnapshot, readFleetSnapshot, readEpisode, writeEpisode, claimRecoverLaunch, markLaunchOutcome, breakpointFactsFor,
  writeRecoveryReceipt,
} from "../packages/bus/src/swarm/fleet-recovery-store.js";
import { acquireSingleFlight } from "../packages/bus/src/swarm/single-flight.js";

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
async function launchOneMember(full: RosterMember, useHerdr: boolean, taken: Set<string>): Promise<{ ok: boolean; error?: string }> {
  const cmd = resumeCommandForMember(full);
  try {
    const sc = splitCommand(cmd);
    if (useHerdr && sc.balanced) {
      const name = herdrAgentName(full.title ?? full.member, taken); taken.add(name);
      const r = await herdrLaunch({ name, kind: sc.kind, cwd: full.cwd, args: sc.args });
      if (r.state === "started" || r.state === "unconfirmed") { log(`  launched[herdr] ${full.title ?? full.member} (${r.state})`); return { ok: true }; }
      log(`  herdr not-started (${r.note}); Ghostty fallback for ${full.title ?? full.member}`);
    }
    await pexec("osascript", ["-e", buildAppleScript({ command: cmd, cwd: full.cwd, env: [] })], { timeout: 15000 });
    log(`  launched ${full.title ?? full.member} ${full.cwd}`);
    return { ok: true };
  } catch (e) { const msg = (e as Error).message; log(`  FAILED to launch ${full.title ?? full.member}: ${msg}`); return { ok: false, error: msg }; }
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
  // FR-6: serialize recover with a single-flight lock — a SECOND concurrent recover exits cleanly, so two processes can never mint
  // rival episodes and double-launch the same member (episode identity is established single-threaded under this lock).
  const releaseLock = acquireSingleFlight(path.join(H, ".agenthop", "swarm", "recover.lock"));
  if (!releaseLock) { log(`recover: another recover is already running (single-flight) — exiting.`); return; }

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
      let wakeStatus: "off" | "on" | "on(inert:no-herdr)" | null = null;
      if (pid !== null) { const { env, ok } = captureEnvForPid(pid); if (ok) wakeStatus = inboxWakeStatus(env as NodeJS.ProcessEnv); } // FR-3: TARGET env ONLY
      return { pidAlive: dispatcherLive(H), heartbeatFreshSec: heartbeatFreshSec(H, nowSec()), wakeStatus };
    },
    peers: () => core.peers().map(toMin),
    settle: () => sleep(5000),
    claimLaunch: (memberKey, episodeId) => claimRecoverLaunch(H, memberKey, episodeId),
    launchMember: async (m) => { const full = fullByMember.get(m.member); if (!full) return { ok: false, error: "no roster entry" }; return launchOneMember(full, useHerdr, taken); },
    markLaunchOutcome: (memberKey, episodeId, ok) => markLaunchOutcome(H, memberKey, episodeId, ok), // FR-8: record outcome (pending→launched|failed)
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
    // FR-8: the durable receipt is part of the completion criteria — a refused write ⇒ orchestrateRecover adds it to outstanding (exit≠0).
    writeReceipt: (result) => writeRecoveryReceipt(H, {
      episodeId: result.episodeId, recoveredAtSec: nowSec(), snapshotCapturedAtSec: snap.capturedAtSec, staleSec: stale,
      dispatcher: result.dispatcher, members: result.members, reportDelivery: result.reportDelivery,
      outstanding: result.outstanding, notConfirmed: result.notConfirmed,
    }),
  };

  let result: RecoveryResult;
  try { result = await orchestrateRecover(snap, rosterLike, deps); }
  finally { await core.close(); releaseLock(); } // FR-6: always release the single-flight lock

  // --- outcome (FR-8: the durable receipt is written INSIDE orchestrateRecover via the writeReceipt dep, as part of the completion
  //     criteria; a refused write shows up as the "receipt:unwritten" outstanding obligation below, never a silent exit0) ----------
  log(`receipt: ${result.outstanding.includes("receipt:unwritten") ? "UNWRITTEN (CP-3) — outstanding" : "written -> console/fleet-recovery.json"}`);
  const confirmed = result.members.filter((m) => m.verdict === "confirmed").length;
  log(`done: episode ${result.episodeId}; dispatcher ${result.dispatcher.verdict} (wake=${result.dispatcher.wakeStatus ?? "unknown"}); members ${confirmed}/${result.members.length} confirmed; report ${result.reportDelivery}; ${result.outstanding.length} outstanding.`);
  if (result.outstanding.length > 0) { log(`OUTSTANDING (re-run to retry): ${result.outstanding.join("; ")}`); process.exitCode = 1; }
}

/** The coordinator report text — honest about dispatcher wake + outstanding obligations (FR-8). */
function reportText(r: RecoveryResult, stale: number, iso: string): string {
  const confirmed = r.members.filter((m) => m.verdict === "confirmed").length;
  return [
    `[fleet-recovery] 舰队恢复 @ ${iso} (episode ${r.episodeId})。`,
    `调度器=${r.dispatcher.verdict}(wake=${r.dispatcher.wakeStatus ?? "unknown"}${r.dispatcher.relaunched ? ",已重启" : ""})。`,
    `成员:${confirmed}/${r.members.length} confirmed。`,
    r.outstanding.length > 0 ? `⚠ 未完成(需重做/重跑):${r.outstanding.join("; ")}。` : `全部 confirmed,无未完成项。`,
    `快照龄 ${(stale / 3600).toFixed(1)}h;详见 console/fleet-recovery.json。`,
  ].join(" ");
}

if (process.argv[1] && /(^|\/)swarm-recover\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
