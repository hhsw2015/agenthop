/**
 * fleet-recovery — IO layer (brief §5; r2 after codex:Work @29bd0e1). The dispatcher SELF-RECORDS its exact launch recipe (argv
 * array + env object + cwd) at startup — the ONLY lossless source on macOS, where ps display strings cannot round-trip spaces
 * (FR-1). recover reads that recipe (falling back to a clearly-marked lossy ps capture only when it is absent), reads/writes the
 * fleet-snapshot + recovery receipt + episode marker atomically behind an ANCESTOR-CHAIN CP-3 guard (FR-9), and supplies the
 * durable facts the orchestrator verifies against (dispatcher pid/heartbeat/TARGET-only wake env FR-3, granted board items + live
 * control-log attempts FR-10). FC-2 throughout: ENOENT ⇒ null, corrupt ⇒ null via the pure parser, any OTHER read fault propagates.
 *
 * Secret discipline (Q1/FR-2): the env subset is name-allowlisted AND value-credential-scrubbed by the pure filterCaptureEnv; at
 * relaunch the shell merges it OVER the live shell env so profile secrets come from the canonical shell.
 */
import { cleanTernEnv } from "./tern-env.js";
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, lstatSync, existsSync, readlinkSync, openSync, closeSync, fstatSync, ftruncateSync, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA,
  DISPATCHER_RECIPE_SCHEMA,
  parseFleetSnapshot,
  parseDispatcherRecipe,
  filterCaptureEnv,
  grantedItemsForMember,
  type FleetSnapshot,
  type DispatcherRecipe,
  type RecoveryEpisode,
  type EpisodeRead,
  type MemberBreakpointFacts,
} from "./fleet-recovery.js";
import { parseBoardItemName, boardItemId } from "./task-board.js";
import { type LockSite } from "./holder-lock.js"; // FR-6 (r6): the recover lock reuses the shared sole-occupancy primitive
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { inboxDirName } from "../inbox.js";

// --- paths -----------------------------------------------------------------------------------------------------------
function agenthopDir(home: string): string { return path.join(home, ".agenthop"); }
function swarmDir(home: string): string { return path.join(agenthopDir(home), "swarm"); }
function consoleDir(home: string): string { return path.join(swarmDir(home), "console"); }
function snapshotPath(home: string): string { return path.join(swarmDir(home), "fleet-snapshot.json"); }
function recipePath(home: string): string { return path.join(swarmDir(home), "dispatcher-recipe.json"); }
function episodePath(home: string): string { return path.join(swarmDir(home), "recovery-episode.json"); }
function dispatcherLockPath(home: string): string { return path.join(swarmDir(home), "dispatcher.lock"); }
function heartbeatPath(home: string): string { return path.join(swarmDir(home), "heartbeat.json"); }
function boardDir(home: string): string { return path.join(swarmDir(home), "board"); }
function controlLogDir(home: string): string { return path.join(swarmDir(home), "control-log"); }
function cpaConfigPath(home: string): string { return path.join(agenthopDir(home), "cpa.json"); }
function receiptPath(home: string): string { return path.join(consoleDir(home), "fleet-recovery.json"); }
export const ROSTER_SNAPSHOT_FILE = "roster-snapshot.json";

/** FR-9 / CP-3 — EVERY component of the target dir chain from `.agenthop` down must be a REAL owned directory, never redirected by
 *  a pre-existing symlink at ANY level (a symlinked `swarm/` ancestor would land the write outside the boundary even when the leaf
 *  is a real dir). lstat (NO-follow) each: a symlink / non-dir ⇒ REFUSE; ENOENT ⇒ safe (the rest doesn't exist ⇒ our mkdir makes
 *  real dirs); any other stat fault ⇒ refuse. `leaf` is the full target dir; its ancestors up to home are all checked. */
function boundaryOk(home: string, leaf: string): boolean {
  const rel = path.relative(home, leaf);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false; // leaf must be under home
  let p = home;
  for (const seg of rel.split(path.sep)) {
    p = path.join(p, seg);
    let st;
    try { st = lstatSync(p); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; return false; }
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** Atomic JSON write (temp + rename). 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// --- dispatcher pid / liveness --------------------------------------------------------------------------------------

export function dispatcherPid(home: string): number | null {
  let raw: string;
  try { raw = readFileSync(dispatcherLockPath(home), "utf8"); }
  catch { return null; }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function dispatcherLive(home: string): boolean {
  const pid = dispatcherPid(home);
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Age (seconds) of heartbeat.json's most recent tick, or null (absent / unreadable / no tick / corrupt). Never fabricated. */
export function heartbeatFreshSec(home: string, nowSec: number): number | null {
  let raw: string;
  try { raw = readFileSync(heartbeatPath(home), "utf8"); }
  catch { return null; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const tick = (sec: unknown): number | null => {
    if (!sec || typeof sec !== "object") return null;
    const t = (sec as { lastTickSec?: unknown }).lastTickSec;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };
  const ticks = [tick(r.pass), tick(r.sweep)].filter((t): t is number => t !== null);
  if (ticks.length === 0 || !Number.isFinite(nowSec)) return null;
  return Math.max(0, Math.floor(nowSec - Math.max(...ticks)));
}

// --- env / cwd capture (platform-aware) — the LOSSY ps fallback for FR-1 ---------------------------------------------

/** Capture a pid's environ into the allowlisted+scrubbed subset. Linux: /proc/<pid>/environ (NUL-separated, exact). macOS/others:
 *  `ps eww` (space-separated — LOSSY for values with spaces, hence only a fallback). {} + ok:false when nothing could be read. */
export function captureEnvForPid(pid: number): { env: Record<string, string>; ok: boolean } {
  const procEnviron = `/proc/${pid}/environ`;
  if (existsSync(procEnviron)) {
    try {
      const raw = readFileSync(procEnviron, "utf8");
      const out: Record<string, string> = {};
      for (const kv of raw.split("\0")) { const eq = kv.indexOf("="); if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1); }
      return { env: filterCaptureEnv(out), ok: Object.keys(out).length > 0 };
    } catch { /* fall through */ }
  }
  try {
    const stdout = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 8000, maxBuffer: 1 << 22 });
    const out: Record<string, string> = {};
    for (const tok of stdout.trim().split(/\s+/)) { const eq = tok.indexOf("="); if (eq > 0) { const k = tok.slice(0, eq); if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = tok.slice(eq + 1); } }
    return { env: filterCaptureEnv(out), ok: Object.keys(out).length > 0 };
  } catch { return { env: {}, ok: false }; }
}

function cwdForPid(pid: number): string | null {
  const procCwd = `/proc/${pid}/cwd`;
  try { if (existsSync(procCwd)) return readlinkSync(procCwd) || null; } catch { /* not linux */ }
  try {
    const stdout = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 8000 });
    for (const line of stdout.split("\n")) if (line.startsWith("n")) return line.slice(1).trim() || null;
  } catch { /* lsof unavailable */ }
  return null;
}

// --- FR-1: the dispatcher SELF-RECORD (lossless) --------------------------------------------------------------------

/**
 * FR-1 — the dispatcher records its OWN exact launch recipe at startup: process.argv (lossless array), cwd, and the allowlisted+
 * scrubbed env. This is the ONLY lossless source (a ps display string cannot round-trip spaces). Called from the dispatcher's
 * startup (fail-soft; a record fault never blocks the dispatcher). CP-3 guarded. Returns whether it wrote.
 */
export function recordDispatcherRecipe(home: string, nowSec: number): boolean {
  if (!boundaryOk(home, swarmDir(home))) return false; // CP-3
  const recipe: DispatcherRecipe & { schema: typeof DISPATCHER_RECIPE_SCHEMA; recordedAtSec: number } = {
    schema: DISPATCHER_RECIPE_SCHEMA,
    recordedAtSec: Number.isFinite(nowSec) ? Math.floor(nowSec) : 0,
    // FR-1a: include process.execArgv (the node flags Node strips out of argv — e.g. tsx's --require/--import loader). Without them a
    // normally-tsx-launched `.ts` dispatcher relaunches as `node script.ts` ⇒ ERR_UNKNOWN_FILE_EXTENSION. Full argv = node + execArgv + script+args.
    argv: [process.argv[0]!, ...process.execArgv, ...process.argv.slice(1)],
    cwd: process.cwd(),
    env: filterCaptureEnv(cleanTernEnv(process.env)), // L3: never replay the pane this dispatcher happened to start in
    source: "self-recorded",
  };
  writeJsonAtomic(recipePath(home), recipe);
  return true;
}

/** Read the self-recorded recipe (lossless). ENOENT ⇒ null; corrupt / wrong-shape ⇒ null via the pure parser. Other faults propagate. */
export function readDispatcherRecipe(home: string): DispatcherRecipe | null {
  let raw: string;
  try { raw = readFileSync(recipePath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || (o as { schema?: unknown }).schema !== DISPATCHER_RECIPE_SCHEMA) return null;
  return parseDispatcherRecipe(o);
}

/**
 * Capture the dispatcher's launch recipe for the snapshot (FR-1). PREFER the lossless self-record; only when it is absent fall back
 * to a ps capture, marked `source:"ps-fallback"` (LOSSY — the orchestrator warns and the operator should restart the dispatcher
 * once to self-record). null when no dispatcher is live AND no self-record exists. `fallbackCwd` = recover's cwd (the repo).
 */
export function captureDispatcherRecipe(home: string, fallbackCwd: string): DispatcherRecipe | null {
  const self = readDispatcherRecipe(home);
  if (self !== null) return self; // lossless — preferred
  const pid = dispatcherPid(home);
  if (pid === null || !dispatcherLive(home)) return null;
  let argv: string[];
  try {
    const stdout = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 8000 });
    const line = stdout.trim();
    if (line.length === 0) return null;
    argv = line.split(/\s+/); // LOSSY: spaces in a path/arg are not recoverable — marked ps-fallback below
  } catch { return null; }
  const { env } = captureEnvForPid(pid);
  return { argv, cwd: cwdForPid(pid) ?? fallbackCwd, env, source: "ps-fallback" };
}

// --- snapshot read / write -------------------------------------------------------------------------------------------

export function writeFleetSnapshot(home: string, recipe: DispatcherRecipe | null, nowSec: number): boolean {
  if (!boundaryOk(home, swarmDir(home))) return false; // FR-9 CP-3 (ancestor chain)
  const snap: FleetSnapshot = {
    schema: FLEET_SNAPSHOT_SCHEMA,
    capturedAtSec: Number.isFinite(nowSec) ? Math.floor(nowSec) : 0,
    dispatcher: recipe,
    rosterFile: path.join(swarmDir(home), ROSTER_SNAPSHOT_FILE),
  };
  writeJsonAtomic(snapshotPath(home), snap);
  return true;
}

export function readFleetSnapshot(home: string): FleetSnapshot | null {
  let raw: string;
  try { raw = readFileSync(snapshotPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  return parseFleetSnapshot(raw);
}

// --- FR-4: roster three-state (absent / corrupt / ok) ---------------------------------------------------------------

export type RosterReadResult =
  | { kind: "ok"; members: { member: string; title?: string; tool?: string; cwd?: string }[] }
  | { kind: "absent" }   // no roster file (ENOENT) — recover must refuse (never a 0/0 "all confirmed")
  | { kind: "corrupt" }; // present but unparseable / other read fault — refuse

/** Read the roster snapshot with FR-4 three-state. A VALID roster (even members:[]) ⇒ ok (confirmed-empty is distinct from
 *  missing/corrupt). ENOENT ⇒ absent; parse/shape failure / other read fault ⇒ corrupt. parseFn is the resume parser (injected to
 *  keep this store decoupled from scripts/). */
export function readRosterStrict(home: string, parseFn: (text: string) => { members: { member?: unknown; title?: unknown; tool?: unknown; cwd?: unknown }[] } | null): RosterReadResult {
  let raw: string;
  try { raw = readFileSync(path.join(swarmDir(home), ROSTER_SNAPSHOT_FILE), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "corrupt" }; }
  const snap = parseFn(raw);
  if (snap === null || !Array.isArray(snap.members)) return { kind: "corrupt" };
  const members = snap.members.map((m) => ({
    member: typeof m.member === "string" ? m.member : "",
    ...(typeof m.title === "string" ? { title: m.title } : {}),
    ...(typeof m.tool === "string" ? { tool: m.tool } : {}),
    ...(typeof m.cwd === "string" ? { cwd: m.cwd } : {}),
  })).filter((m) => m.member.length > 0);
  return { kind: "ok", members };
}

// --- FR-10: breakpoint facts (granted board items + live attempts + unread), three-state ----------------------------

export function readBoardFileNames(home: string): string[] | null {
  try { return readdirSync(boardDir(home)); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null; } // ENOENT ⇒ no board ⇒ []; other ⇒ unknown (null)
}

/** Control-log attempt ids RUNNING/RESULT_PENDING_VALIDATION whose nodeId is in `itemIds`. null ⇒ control-log unreadable/corrupt
 *  (FR-10: unknown, never "none"). []  ⇒ readable, no live attempt for those items. */
export function liveAttemptsForItems(home: string, itemIds: readonly string[]): string[] | null {
  if (itemIds.length === 0) return [];
  let state;
  try { state = loadControlLog(controlLogDir(home)); }
  catch { return null; } // corrupt/unreadable control-log ⇒ unknown
  const want = new Set(itemIds); // these are board item ids = boardItemId(jobId, nodeId) = SHA256, NOT raw node names
  const out: string[] = [];
  for (const [key, cb] of Object.entries(liveEntities(state))) {
    if (!key.startsWith("attempt:")) continue;
    const c = cb as { put?: string; attempt?: { attemptId?: string; nodeId?: string; status?: string } };
    const a = c.attempt;
    if (!(c.put === "attempt" && a && (a.status === "RUNNING" || a.status === "RESULT_PENDING_VALIDATION") && typeof a.nodeId === "string" && typeof a.attemptId === "string")) continue;
    // FR-10: an attemptId is `${jobId}/${nodeId}/a${n}`; a granted board item is boardItemId(jobId, nodeId). Join via the CANONICAL
    // board id, NOT the raw nodeId (the r2 bug compared the hashed itemId against a raw node name and found nothing).
    const jobId = a.attemptId.split("/")[0];
    if (jobId && want.has(boardItemId(jobId, a.nodeId))) out.push(a.attemptId);
  }
  return out;
}

/** Assemble the breakpoint facts for a resolved member SID (FR-10): granted items (canonical full-SID parser) + their live
 *  attempts + unread inbox, each three-state (unreadable ⇒ null). */
export function breakpointFactsFor(home: string, sid: string): MemberBreakpointFacts {
  const boardNames = readBoardFileNames(home);
  const grantedItems = boardNames === null ? null : grantedItemsForMember(sid, boardNames, parseBoardItemName);
  const liveAttempts = grantedItems === null ? null : liveAttemptsForItems(home, grantedItems);
  // FR-10 (r4): derive unread from a SINGLE strict readdir — scanUnclaimedInbox swallows an EACCES to {count:0}, and a probe-then-scan
  // leaves a race (EACCES between the two reads ⇒ a false 0, the exact r3 gap). ENOENT ⇒ 0 (genuine empty); any other fault ⇒ null
  // (unknown). The `.json` filter matches scanUnclaimedInbox's own count (claim/sidecar names don't end in .json).
  let unreadInbox: number | null;
  try { unreadInbox = readdirSync(path.join(home, ".agenthop", "inbox", inboxDirName(sid))).filter((n) => n.endsWith(".json")).length; }
  catch (e) { unreadInbox = (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  return { member: sid, grantedItems, liveAttempts, unreadInbox };
}

// --- FR-7: recovery episode marker ----------------------------------------------------------------------------------

export function readEpisode(home: string): EpisodeRead {
  let raw: string;
  // FR-7: ENOENT ⇒ absent (genuinely no episode); a NON-ENOENT read fault (EACCES) ⇒ unreadable (NOT absent — never re-mint over it).
  try { raw = readFileSync(episodePath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { kind: "unreadable" }; } // a present-but-corrupt marker is unreadable, not absent
  if (!o || typeof o !== "object") return { kind: "unreadable" };
  const r = o as Record<string, unknown>;
  if (typeof r.episodeId !== "string" || typeof r.startedAtSec !== "number" || !Number.isFinite(r.startedAtSec)) return { kind: "unreadable" };
  return { kind: "present", ep: { episodeId: r.episodeId, startedAtSec: r.startedAtSec, snapshotCapturedAtSec: typeof r.snapshotCapturedAtSec === "number" ? r.snapshotCapturedAtSec : 0, completed: r.completed === true } };
}

export function writeEpisode(home: string, ep: RecoveryEpisode): boolean {
  if (!boundaryOk(home, swarmDir(home))) return false; // CP-3 ancestor chain
  writeJsonAtomic(episodePath(home), ep);
  return true;
}

/** FR-6 launch ownership: atomically claim the launch of `memberKey` within `episodeId`. O_EXCL create of a per-(episode,member)
 *  marker: returns true iff THIS call created it (won the launch), false if it already existed (a prior attempt THIS episode already
 *  launched it ⇒ don't double-launch while it is not yet bus-visible) or on any store fault (fail-closed toward NOT launching — a
 *  spurious extra window is worse than a missed re-try, which the next verify+re-run covers). The marker is scoped by episode so a
 *  NEW recovery event (new episodeId) re-claims cleanly. */
function claimLaunchDir(home: string, episodeId: string): string {
  return path.join(swarmDir(home), "recover-launch", episodeId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64));
}
function claimLaunchFile(home: string, episodeId: string, memberKey: string): string {
  return path.join(claimLaunchDir(home, episodeId), `${createHash("sha256").update(memberKey).digest("hex").slice(0, 32)}.claim`);
}

/**
 * FR-8 two-phase launch ownership + FR-9 CP-3. Decide whether to LAUNCH this member now, by the claim file's STATE:
 *   - no claim        ⇒ create it "pending", return true  (launch now; markLaunchOutcome records the result)
 *   - "failed"        ⇒ reset to "pending", return true   (a prior EXPLICIT not-started ⇒ safe to retry — it definitely didn't start)
 *   - "pending:<ts>"  ⇒ retry only when STALE (older than grace = a prior run crashed BEFORE attempting the launch); else false
 *   - "unknown:<ts>"  ⇒ false ALWAYS (launch was SENT, outcome indeterminate ⇒ may be running; FR-8 r5: never a time-based blind retry)
 *   - "launched"      ⇒ false  (launchMember returned ok but not yet bus-visible ⇒ awaiting, never a double)
 *   - unreadable/CP-3 ⇒ false  (fail-closed toward NOT launching)
 * FR-9: the CP-3 guard checks the ACTUAL write leaf (recover-launch/<episode>/); the leaf itself is opened O_NOFOLLOW (no symlink).
 */
// FR-9 (r5): bind IO to the ACTUAL opened object, not a path re-checked then re-opened. A lstat-then-readFileSync/writeFileSync pair is
// a TOCTOU — the leaf can be swapped to a symlink between the check and the IO, and the subsequent path write follows it out of bounds.
// O_NOFOLLOW makes the OPEN itself refuse a symlink leaf and returns an fd bound to that inode; every read/write then targets the fd,
// never the path a second time.
type ClaimRead = { ok: true; state: string } | { ok: false; reason: "absent" | "refuse" };
function readClaimNoFollow(file: string): ClaimRead {
  let fd: number;
  // FR-9 (r6): O_NONBLOCK so a FIFO/device leaf does NOT block the open (O_RDONLY on a FIFO otherwise waits for a writer); O_NOFOLLOW so
  // a symlink leaf is refused. The fstat then REQUIRES a regular file — a FIFO opens non-blocking but is not a claim ⇒ refuse.
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { ok: false, reason: "absent" } : { ok: false, reason: "refuse" }; } // ELOOP(symlink)/EACCES/ENXIO ⇒ refuse
  try { if (!fstatSync(fd).isFile()) return { ok: false, reason: "refuse" }; return { ok: true, state: readFileSync(fd, "utf8").trim() }; }
  catch { return { ok: false, reason: "refuse" }; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}
/** Overwrite an EXISTING claim, bound to the opened fd. FR-9 (r6): O_NONBLOCK (a FIFO O_WRONLY would block for a reader, or we'd write
 *  the outcome INTO a pipe) + O_NOFOLLOW (no symlink) + NO O_TRUNC at open — we fstat-verify a REGULAR file FIRST, then ftruncate+write
 *  to the bound fd. No O_CREAT ⇒ nothing to overwrite if absent. Returns true on success. */
function overwriteClaimNoFollow(file: string, content: string): boolean {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600); } catch { return false; } // ELOOP/absent/EACCES/ENXIO(FIFO no-reader) ⇒ refuse
  try {
    if (!fstatSync(fd).isFile()) return false; // a FIFO/device/non-regular leaf ⇒ refuse (never truncate or write through it)
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
    return true;
  } catch { return false; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}

export function claimRecoverLaunch(home: string, memberKey: string, episodeId: string, nowSec: number, graceSec: number): boolean {
  const dir = claimLaunchDir(home, episodeId);
  if (!boundaryOk(home, dir)) return false; // FR-9: guard the real dir chain
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  const file = claimLaunchFile(home, episodeId, memberKey);
  const read = readClaimNoFollow(file); // FR-9 (r5): O_NOFOLLOW — a symlinked / unreadable leaf ⇒ refuse (never read or write through it)
  if (!read.ok && read.reason === "refuse") return false;
  if (!read.ok) { try { writeFileSync(file, `pending:${Math.floor(nowSec)}`, { flag: "wx", mode: 0o600 }); return true; } catch { return false; } } // O_EXCL birth (also won't follow a symlink)
  const state = read.state;
  if (state === "failed") return overwriteClaimNoFollow(file, `pending:${Math.floor(nowSec)}`); // explicit not-started ⇒ safe retry
  if (state.startsWith("pending:")) {
    // STALE pending (claim acquired, launch not yet ATTEMPTED): under the single-flight recover lock there is no concurrent holder, and
    // this member is ABSENT (caller only claims absent members), so a pending older than grace = a prior run that crashed BEFORE the
    // launch ⇒ safe to retry. A RECENT pending (incl. this run's own) ⇒ never a blind double.
    const ts = Number(state.slice("pending:".length));
    if (Number.isFinite(ts) && Number.isFinite(nowSec) && nowSec - ts >= graceSec) return overwriteClaimNoFollow(file, `pending:${Math.floor(nowSec)}`);
    return false;
  }
  // FR-8 (r5): "unknown:<ts>" (launch SENT, outcome indeterminate) ⇒ NEVER auto-retry — a sent launch may be running; absence + elapsed
  //   time is NOT proof it did not start (that needs ESRCH evidence of the launched process, which we do not hold). The member stays
  //   outstanding and is reported to the coordinator for a human decision. "launched" ⇒ never a double; anything else ⇒ refuse.
  //   (ponytail: safe auto-retry of an unknown needs a verifiable launch identity / idempotent accept token — not age.)
  return false;
}

/** FR-8 (r5): record the launch outcome so the claim's state reflects reality — "launched" ⇒ done; "failed" (EXPLICIT not-started) ⇒
 *  retryable; "unknown" (SENT, indeterminate) ⇒ a DISTINCT `unknown:<ts>` marker that claimRecoverLaunch NEVER auto-retries (vs a
 *  `pending:` pre-launch crash, which it retries after grace). FR-9: the write is through an O_NOFOLLOW fd — never a path re-write that
 *  could follow a swapped symlink leaf. No O_CREAT ⇒ nothing to mark if the claim is absent/symlinked (fail-soft: prior state stands). */
export function markLaunchOutcome(home: string, memberKey: string, episodeId: string, outcome: "launched" | "failed" | "unknown"): void {
  if (!boundaryOk(home, claimLaunchDir(home, episodeId))) return;
  const file = claimLaunchFile(home, episodeId, memberKey);
  const content = outcome === "launched" ? "launched" : outcome === "failed" ? "failed" : `unknown:${Math.floor(Date.now() / 1000)}`;
  overwriteClaimNoFollow(file, content);
}

/** FR-8 (r6): record the DURABLE "launch sink entered" state BEFORE the launch side effect, so a crash between it and markLaunchOutcome
 *  leaves `launching:<ts>` — which claimRecoverLaunch NEVER auto-retries (the launch MAY have dispatched; absence + time is not proof it
 *  did not). Only a `pending:` (claim acquired, sink NOT yet entered) remains a retryable pre-launch crash. FR-9: O_NOFOLLOW fd write.
 *  FR-8 (r7): returns true IFF the write durably succeeded — the caller MUST NOT launch when it returns false (a failed mark leaves a
 *  retryable `pending:`, so launching anyway would re-create the crash-window double on a later recover). */
export function markLaunching(home: string, memberKey: string, episodeId: string): boolean {
  if (!boundaryOk(home, claimLaunchDir(home, episodeId))) return false;
  return overwriteClaimNoFollow(claimLaunchFile(home, episodeId, memberKey), `launching:${Math.floor(Date.now() / 1000)}`); // FR-8 (r7): the caller must NOT launch unless this durably succeeded
}

/**
 * FR-6 (r6): the recover single-flight REUSES the shared sole-occupancy primitive acquireHolderLock (holder-lock.ts) — the coordinator
 * ruling "two tickets, one lock semantic". That primitive is the proven DA2-R6/DB-R7/SB1 lock: ownership is established INSIDE an atomic
 * mkdir, holder identity is the `<pid>.<nonce>` FILENAME (reclaim is structurally race-free — no compare-then-unlink double-hold), only a
 * DEFINITELY-dead (ESRCH) holder is reclaimed (EIO/EPERM/unknown => contend, never steal), and a pre-mkdir hold-intent protects the empty
 * mkdir->publish window. This closes the r5 recover-local races (two-racer double-hold + EIO-as-dead) by NOT hand-rolling a second lock.
 * single-flight.ts and holder-lock.ts are BOTH left byte-unchanged here (f32a0507 owns single-flight; SUCC-1 owns any holder-lock change).
 */
export function recoverLockSite(home: string): LockSite {
  const d = path.join(swarmDir(home), "recover-lock.d");
  return { lockDir: path.join(d, "lock"), intentDir: d, intentPrefix: "hold." };
}
// --- recovery receipt projection ------------------------------------------------------------------------------------

// v2 (FR-8 r10): the receipt is a WORK SNAPSHOT, not a completion record. Every receipt self-identifies its scope + names the
// authoritative completion source, so a human reading the raw JSON can never mistake `final:true` for "episode committed".
export const FLEET_RECEIPT_SCHEMA = "console-fleet-recovery/v2" as const;
export const FLEET_RECEIPT_SCOPE = "work-snapshot" as const;
export const FLEET_RECEIPT_COMPLETION_AUTHORITY = "episode-marker (recovery-episode.json): `final:true` means recovery WORK finalized, NOT that the episode is committed — read the episode marker for commit status" as const;

export function writeRecoveryReceipt(home: string, receipt: Record<string, unknown>): boolean {
  if (!boundaryOk(home, consoleDir(home))) return false; // FR-9 CP-3 (ancestor chain: .agenthop/swarm/console)
  // scope + completionAuthority stamped at the write PRIMITIVE (not the caller) so EVERY receipt carries the contract (r10).
  writeJsonAtomic(receiptPath(home), { schema: FLEET_RECEIPT_SCHEMA, scope: FLEET_RECEIPT_SCOPE, completionAuthority: FLEET_RECEIPT_COMPLETION_AUTHORITY, ...receipt });
  return true;
}

export function readRecoveryReceipt(home: string): Record<string, unknown> | null {
  let raw: string;
  try { raw = readFileSync(receiptPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || (o as { schema?: unknown }).schema !== FLEET_RECEIPT_SCHEMA) return null;
  return o as Record<string, unknown>;
}

/** CPA config base URL, FR-9 sibling of MS-P2-6: ENOENT ⇒ no override here (recover does not need it). Exposed for completeness. */
export function cpaConfigExists(home: string): boolean { return existsSync(cpaConfigPath(home)); }
