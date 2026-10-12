#!/usr/bin/env tsx
/**
 * swarm-recover — ONE command to bring the whole swarm back after a reboot (full-fleet-recovery, brief docs/swarm/full-fleet-recovery-brief.md
 * FROZEN @cf7a6e2; author 90b58f9c). F36 `swarm-resume` already relaunches each agent WINDOW; this is the layer around it that also
 * brings back the DISPATCHER (a background process, not a window, so resume never touched it), with its captured SWARM_/HERDR_ env
 * (Q2/F54: without HERDR_* the recovered dispatcher's inbox-wake goes INERT), VERIFIES with durable evidence that each piece really
 * came back (F53 verifyOpsAction; a launch return is never proof), injects a one-line BREAKPOINT re-pointer so a recovered session
 * resumes its in-flight work instead of idling (Q3), and dual-reports the outcome to the coordinator.
 *
 *   tsx scripts/swarm-recover.ts --snapshot   # capture fleet-snapshot.json (dispatcher recipe) + the roster (delegates to swarm-resume)
 *   tsx scripts/swarm-recover.ts --dry        # show what would relaunch + verify, take NO action
 *   tsx scripts/swarm-recover.ts              # recover: dispatcher -> members -> verify -> breakpoint -> report
 *
 * Member relaunch is DELEGATED to scripts/swarm-resume.ts verbatim (its tested herdr/Ghostty + count-idempotency path), never copied.
 * The pure decisions (env allowlist, verdicts, breakpoint) live in packages/bus/src/swarm/fleet-recovery.ts; the IO in -store.ts.
 */
import { execFileSync, spawn } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startBusCore } from "../packages/bus/src/core.js";
import { writeInbox, composeInboxMsg, scanUnclaimedInbox } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import { inboxWakeStatus } from "../packages/bus/src/swarm/inbox-wake.js";
import { parseSnapshot, planResume, type PeerLike } from "../packages/bus/src/swarm/resume.js";
import {
  dispatcherNeedsRelaunch,
  dispatcherVerdict,
  memberVerdict,
  shouldInjectBreakpoint,
  breakpointInjectionEnabled,
  buildBreakpointText,
  claimedItemsForMember,
  snapshotStaleSec,
  type OpsVerdict,
} from "../packages/bus/src/swarm/fleet-recovery.js";
import {
  captureDispatcherRecipe,
  dispatcherLive,
  dispatcherPid,
  heartbeatFreshSec,
  captureEnvForPid,
  writeFleetSnapshot,
  readFleetSnapshot,
  readBoardFileNames,
  writeRecoveryReceipt,
} from "../packages/bus/src/swarm/fleet-recovery-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
/** A safe writeInbox idempotency key (/^[A-Za-z0-9._-]{1,120}$/). */
const epKey = (...parts: (string | number)[]) => `fr-${parts.map(String).join("-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 110)}`;
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function home(): string { return process.env.AH_HOME ?? homedir(); }

/** Relaunch the dispatcher from its captured recipe: run the command verbatim, cwd = recipe.cwd, env = the CURRENT shell env (profile
 *  secrets) MERGED with the captured allowlisted non-secret vars taking precedence (Q1). Detached + unref'd so it outlives recover;
 *  stdout/stderr appended to the swarm dispatcher.log. envSource "unavailable" ⇒ warn (we run with the current env, never fabricated). */
function relaunchDispatcher(recipe: { command: string; cwd: string; env: Record<string, string>; envSource: string }, log: (s: string) => void): void {
  if (recipe.envSource === "unavailable") {
    log(`  WARN dispatcher env was UNAVAILABLE at capture — relaunching with the current shell env only; verify its SWARM_/HERDR_ flags by hand.`);
  }
  const logDir = path.join(home(), ".agenthop", "swarm");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const fd = openSync(path.join(logDir, "dispatcher.log"), "a");
  const env = { ...process.env, ...recipe.env }; // profile secrets from the live shell; captured identity/flags/herdr win
  // The recipe.command is a full argv string ("node --require ... scripts/swarm-dispatch.ts"); run it via the shell so the exact
  // string re-executes, cwd-anchored so a relative script path resolves.
  const child = spawn("/bin/sh", ["-c", recipe.command], { cwd: recipe.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  log(`  launched dispatcher (pid ${child.pid}) cwd ${recipe.cwd}  [${recipe.command}]`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const log = (s: string) => console.log(s);
  const H = home();

  // --- --snapshot: capture the dispatcher recipe + the roster (delegate roster to swarm-resume) -----------------------
  if (flag("--snapshot")) {
    const recipe = captureDispatcherRecipe(H, REPO);
    const wrote = writeFleetSnapshot(H, recipe, nowSec());
    if (!wrote) { console.error("fleet snapshot SKIPPED (CP-3: swarm dir is a symlink/not a dir)"); process.exit(1); }
    log(recipe ? `captured dispatcher recipe (env ${recipe.envSource}, ${Object.keys(recipe.env).length} vars) -> fleet-snapshot.json` : `no live dispatcher at capture; wrote fleet-snapshot.json with roster pointer only`);
    // delegate the roster capture to swarm-resume (single source of the F36 roster logic)
    try { execFileSync("npx", ["tsx", path.join(HERE, "swarm-resume.ts"), "--snapshot"], { cwd: REPO, stdio: "inherit" }); }
    catch (e) { console.error(`roster snapshot (swarm-resume) failed: ${(e as Error).message}`); process.exit(1); }
    return;
  }

  // --- read the fleet snapshot (absent / corrupt ⇒ refuse; never guess a fleet) --------------------------------------
  const snap = readFleetSnapshot(H);
  if (!snap) { console.error(`no usable fleet-snapshot.json at ${path.join(H, ".agenthop/swarm/fleet-snapshot.json")}. Capture one first:  tsx scripts/swarm-recover.ts --snapshot`); process.exit(1); }
  const stale = snapshotStaleSec(snap, nowSec());
  if (stale > 24 * 3600) log(`NOTE: fleet snapshot is ${(stale / 3600).toFixed(1)}h old — relaunching from a possibly outdated roster.`);

  const isDry = flag("--dry");
  const dispLive = dispatcherLive(H);
  const needDisp = dispatcherNeedsRelaunch(snap, dispLive);

  // --- plan the members ourselves (for verify + breakpoint targets); swarm-resume does the actual launching ----------
  let rosterPeers: PeerLike[] = [];
  const core = startBusCore({ home: H });
  try {
    await sleep(1200); // let the broker/relay announce before reading peers
    rosterPeers = core.peers() as PeerLike[];
  } finally { await core.close(); }
  const rosterSnap = readRosterSnapshot(H);
  const plan = rosterSnap ? planResume(rosterSnap, rosterPeers) : { launch: [], skip: [] };

  log(`fleet: dispatcher ${dispLive ? "LIVE (skip)" : needDisp ? "down -> relaunch" : "down, NO recipe (report only)"} · members ${plan.skip.length} live · ${plan.launch.length} to relaunch${isDry ? "  [DRY]" : ""}`);

  if (isDry) {
    if (needDisp && snap.dispatcher) log(`  would relaunch dispatcher: ${snap.dispatcher.command}  (env ${snap.dispatcher.envSource})`);
    try { execFileSync("npx", ["tsx", path.join(HERE, "swarm-resume.ts"), "--dry"], { cwd: REPO, stdio: "inherit" }); } catch { /* resume --dry is informational */ }
    log(`[DRY] no action taken.`);
    return;
  }

  // --- 1) dispatcher FIRST (it is the brain; members self-report to it) ----------------------------------------------
  if (needDisp && snap.dispatcher) relaunchDispatcher(snap.dispatcher, log);
  else if (dispLive) log(`  dispatcher already live (pid ${dispatcherPid(H)}) — skip.`);
  else log(`  dispatcher down and NO recipe captured — cannot relaunch; will report.`);

  // --- 2) members: delegate to swarm-resume (its tested idempotent launch path) --------------------------------------
  try { execFileSync("npx", ["tsx", path.join(HERE, "swarm-resume.ts")], { cwd: REPO, stdio: "inherit" }); }
  catch (e) { log(`  swarm-resume (member relaunch) reported failures: ${(e as Error).message}`); }

  // --- 3) settle, then VERIFY with durable evidence (F53) ------------------------------------------------------------
  await sleep(5000); // give relaunched sessions time to join the bus before we gather evidence
  const core2 = startBusCore({ home: H });
  let livePeers: PeerLike[] = [];
  try { await sleep(1200); livePeers = core2.peers() as PeerLike[]; } finally { await core2.close(); }
  const visible = new Set<string>();
  for (const p of livePeers) { if (p.stableId) visible.add(p.stableId); if (p.id) visible.add(p.id); if (p.title) visible.add(p.title); }

  // dispatcher verdict: read the RELAUNCHED process's actual env so the wake-health check is honest (HERDR_* really landed, not just
  // what we intended). pid may differ post-relaunch; read whatever dispatcher.lock now points at.
  const newPid = dispatcherPid(H);
  const dispEnv = newPid ? captureEnvForPid(newPid).env : {};
  const dispWake = inboxWakeStatus({ ...process.env, ...dispEnv } as NodeJS.ProcessEnv);
  const dispV: OpsVerdict = dispatcherVerdict({ pidAlive: dispatcherLive(H), heartbeatFreshSec: heartbeatFreshSec(H, nowSec()), wakeStatus: dispWake }, 120);
  log(`  dispatcher verdict: ${dispV}  (wake=${dispWake}${dispV === "unknown" && dispWake !== "on" ? " — F54 INERT escalation" : ""})`);

  // member verdicts (spawn evidence = bus-visible); breakpoint the CONFIRMED ones.
  const bpOn = breakpointInjectionEnabled();
  const boardNames = readBoardFileNames(H);
  const recoveredIso = new Date().toISOString();
  const memberResults: { member: string; verdict: OpsVerdict; breakpoint: string }[] = [];
  const allMembers = [...(rosterSnap?.members ?? [])];
  for (const m of allMembers) {
    const busVisible = visible.has(m.member) || (m.title ? visible.has(m.title) : false);
    const v = memberVerdict(busVisible, false, false);
    let bp = "skip";
    if (shouldInjectBreakpoint(v, bpOn)) {
      const claims = claimedItemsForMember(m.member, boardNames);
      const unread = scanUnclaimedInbox(H, m.member).count;
      const text = buildBreakpointText({ member: m.member, boardClaims: claims, unreadInbox: unread }, recoveredIso);
      try {
        const msg = composeInboxMsg({ from: "fleet-recovery", fromLabel: "swarm-recover", text, via: "fleet-recovery", intent: "fyi" });
        const r = writeInbox(H, m.member, msg, epKey("bp", snap.capturedAtSec, shortHash(m.member)));
        bp = r; // published | already | ...
      } catch (e) { bp = `error:${(e as Error).message}`; }
    }
    memberResults.push({ member: m.title ?? m.member, verdict: v, breakpoint: bp });
  }

  // --- 4) dual report: durable receipt projection + a coordinator summary (S19 when anything is not confirmed) -------
  const notConfirmed = memberResults.filter((r) => r.verdict !== "confirmed").length + (dispV !== "confirmed" ? 1 : 0);
  const receipt = {
    recoveredAtSec: nowSec(), snapshotCapturedAtSec: snap.capturedAtSec, staleSec: stale,
    dispatcher: { verdict: dispV, wakeStatus: dispWake, relaunched: needDisp },
    members: memberResults,
    notConfirmed,
  };
  const wroteReceipt = writeRecoveryReceipt(H, receipt);
  log(`  receipt ${wroteReceipt ? "written -> console/fleet-recovery.json" : "SKIPPED (CP-3)"}`);

  const coordRef = opt("--coordinator") ?? process.env.SWARM_COORDINATOR ?? "";
  if (coordRef) {
    const coordSid = resolveSession(coordRef, listSessions(H)) || coordRef;
    const confirmedMembers = memberResults.filter((r) => r.verdict === "confirmed").length;
    const summary = [
      `[fleet-recovery] 舰队恢复完成 @ ${recoveredIso}。`,
      `调度器=${dispV}(wake=${dispWake}${needDisp ? ",已重启" : ",本就在跑"})。`,
      `成员:${confirmedMembers}/${memberResults.length} confirmed,${plan.launch.length} 本轮重启。`,
      notConfirmed > 0 ? `⚠ ${notConfirmed} 项未 confirmed(含 dispatcher inert?)需核实/重做(F53 unknown=按失败重做)。` : `全部 confirmed。`,
      `快照龄 ${(stale / 3600).toFixed(1)}h;详见 console/fleet-recovery.json。`,
    ].join(" ");
    try {
      const msg = composeInboxMsg({ from: "fleet-recovery", fromLabel: "swarm-recover", text: summary, via: "fleet-recovery", intent: notConfirmed > 0 ? "report" : "fyi" });
      const r = writeInbox(H, coordSid, msg, epKey("report", snap.capturedAtSec));
      log(`  coordinator report: ${r} -> ${coordSid}`);
    } catch (e) { log(`  coordinator report FAILED: ${(e as Error).message}`); }
  } else {
    log(`  SWARM_COORDINATOR unset and --coordinator not given — report written to disk only.`);
  }

  log(`done: dispatcher ${dispV}, ${memberResults.filter((r) => r.verdict === "confirmed").length}/${memberResults.length} members confirmed, ${notConfirmed} not-confirmed.`);
  if (notConfirmed > 0) process.exitCode = 1;
}

/** Read the roster snapshot (F36 resume's file) tolerantly; null when absent/corrupt. */
function readRosterSnapshot(h: string): ReturnType<typeof parseSnapshot> {
  try { return parseSnapshot(readFileSync(path.join(h, ".agenthop", "swarm", "roster-snapshot.json"), "utf8")); }
  catch { return null; }
}

// Guard so the module can be imported without running (msglog P1 lesson).
if (process.argv[1] && /(^|\/)swarm-recover\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
