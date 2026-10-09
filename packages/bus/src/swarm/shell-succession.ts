/**
 * shell-succession — a restarted shell proving it is the CONTINUATION of a stable swarm identity, so it may re-take that
 * identity's presence binding + durable-inbox scan instead of coming up as a stranger (F45 ①).
 *
 * The incident: the user restarts the coordinator; the new shell gets a fresh native session id and does NOT inherit the
 * stable sid's presence binding (`presence/<stableSid>.pid`). Every `resolveSession(COORDINATOR, …)` then returns null, so
 * the dispatcher's STALL notices fall to a log nobody reads — a DEAF coordinator (see coordinator-report for the other half).
 *
 * The fix is an ADOPTION decision, same family as the decision-batch empty-lock adoption: a new shell may take over the
 * stable sid's presence slot ONLY after proving continuity (same machine + same cwd + same tool + the roster's resumeCmd +
 * an inherited herdr pane when both are known) AND only when the incumbent is NOT a live OTHER process. On adoption it
 * REUSES the recorded bus-identity mintedId (identity continuity — never mints a fresh one, which would orphan every cap
 * HMAC and alias the roster). Fail-closed: anything short of proof ⇒ "fresh" (come up as a new identity, never hijack the
 * stable slot); a live other incumbent ⇒ "reject" (two live claimants must never both bind the one identity).
 *
 * Pure core below (selftested); the IO shell that gathers the attestation + rewrites the presence pid is dormant
 * (`SWARM_SUCCESSION` off).
 */

// ============================================================================================================
// Pure core (selftested in shell-succession.selftest.mts)
// ============================================================================================================

/** The restarting shell's self-attestation — everything it can prove about itself at startup. */
export interface Attestation {
  machine: string;        // host / machine id (same-machine is a precondition: presence + inbox are a LOCAL fs)
  cwd: string;            // working directory the shell came up in
  tool: string;           // agent family (claude / codex / …)
  resumeCmd: string;      // the launch command — INFORMATIONAL ONLY (logging); NOT used for binding (free text, F45-P1-1)
  resumeTargetSid?: string; // F45-P1-1: the EXACT sid the IO parsed from the real `--resume`/`resume` argv token (a verified
                            //           structured credential). Binding uses THIS, never a substring of resumeCmd.
  herdrPane?: string | null; // the herdr pane it inherited, when known
  newPid: number;         // this process's pid (what the presence slot would be rebound to)
  newNativeSid: string;   // this process's OWN native session id (usually != stableSid after a restart)
}

/** The stable identity's recorded binding (from the roster snapshot + presence pid liveness). */
export interface IncumbentBinding {
  stableSid: string;                 // the durable sid whose presence slot + inbox we may adopt
  mintedId?: string | null;          // the bus-identity minted id to REUSE on adoption (never re-mint)
  recordedMachine: string;
  recordedCwd: string;
  recordedTool: string;
  recordedResumeCmd?: string | null; // roster member resumeCmd (v2 snapshot); absent on an old v1 roster
  recordedHerdrPane?: string | null;
  incumbentPid?: number | null;      // the pid currently in presence/<stableSid>.pid, or null if absent
  incumbentLiveness: "alive" | "dead" | "absent"; // signal-0 on incumbentPid (absent = no presence pid at all)
}

export interface RebindPlan {
  stableSid: string;
  pid: number;              // write this into presence/<stableSid>.pid
  mintedId: string | null;  // reuse (null only if the incumbent never recorded one)
}

export type SuccessionAction = "adopt" | "reject" | "fresh";
export interface SuccessionResult {
  action: SuccessionAction;
  reason: string;
  rebind?: RebindPlan; // present iff action === "adopt"
}

/**
 * Continuity proof (F45-P1-1 hardened). TWO things must both hold:
 *  (1) ENVIRONMENT matches — same machine AND cwd AND tool. This is NECESSARY but NOT sufficient: same environment only
 *      says "a shell like it could run here", not "it is THIS identity". Any credential PRESENT on both sides must agree
 *      (a conflict is disqualifying).
 *  (2) At least ONE credential positively BINDS this shell to THIS specific stableSid:
 *      - resumeBinds: the roster's recorded resumeCmd matches AND that command names the stableSid (so a bare, identity-
 *        agnostic template does NOT bind — it would match many identities);
 *      - paneBinds: an inherited herdr pane recorded for this stableSid matches (a pane belongs to one session);
 *      - sidBinds: the shell already carries the stable native sid.
 * Empty fields prove nothing, and "same machine/cwd/tool" alone never proves identity, so without (2) ⇒ not a continuation.
 * Pure. */
export function provesContinuity(att: Attestation, inc: IncumbentBinding): boolean {
  // (1) F45-P1-1: the environment must be KNOWN (non-empty) AND equal. Empty fields prove nothing — two empty strings are
  //     not "the same environment". (A recorded field must also be non-empty, which follows from equality to a non-empty att.)
  if (!att.machine || !att.cwd || !att.tool) return false;
  if (att.machine !== inc.recordedMachine || att.cwd !== inc.recordedCwd || att.tool !== inc.recordedTool) return false;
  // (2) a PRESENT credential naming a DIFFERENT identity disqualifies: a shell launched to resume A cannot be the
  //     continuation of B, and an inherited pane recorded for another session cannot be ours.
  if (att.resumeTargetSid != null && att.resumeTargetSid !== inc.stableSid) return false;
  if (att.herdrPane != null && att.herdrPane !== "" && inc.recordedHerdrPane != null && inc.recordedHerdrPane !== "" && att.herdrPane !== inc.recordedHerdrPane) return false;
  // (3) at least ONE credential must BIND to THIS stableSid from a VERIFIED STRUCTURED source (never free text, F45-P1-1):
  //     the exact resume-target sid, an inherited herdr pane recorded for this session, or the shell already holding the sid.
  const resumeBinds = att.resumeTargetSid != null && att.resumeTargetSid === inc.stableSid;
  const paneBinds = att.herdrPane != null && att.herdrPane !== "" && inc.recordedHerdrPane != null && inc.recordedHerdrPane !== "" && att.herdrPane === inc.recordedHerdrPane;
  const sidBinds = att.newNativeSid === inc.stableSid;
  return resumeBinds || paneBinds || sidBinds;
}

/** F45-P1-1 (round-5): extract the EXACT resume-target sid from a real argv array — RECOGNIZED entrypoint only, no option
 *  guessing. The ONLY entrypoint whose resume target lives in argv is CODEX, whose form is fixed: argv[0] basename EXACTLY
 *  `codex` (not `codex-inspector`, not `node …`), `resume` EXACTLY at argv[1], target at argv[2]. Anything else ⇒ null.
 *
 *  CLAUDE is deliberately NOT parsed: a resumed claude KEEPS its native session id (verified live — a restarted coordinator
 *  reappeared under the SAME agent_session.value), so its continuity is proven by sidBinds (native-sid match) or an
 *  inherited pane, never by scanning a flag soup whose unknown value-options (`--name`, `-n`, `--debug-file`, …) could make
 *  the parser mistake an option VALUE for the resume target. Unprovable ⇒ null ⇒ no resume binding (fail-closed: at worst a
 *  missed adoption → the shell comes up fresh, never a WRONG adoption). Pure. */
export function parseResumeTargetFromArgv(argv: readonly string[]): string | null {
  if (argv.length < 3) return null;
  const tool = argv[0].split("/").pop() || argv[0];
  if (tool !== "codex") return null;          // recognized entrypoint only (exact basename — no substring, no wrappers)
  if (argv[1] !== "resume") return null;      // the resume subcommand must be EXACTLY the first argument
  const target = argv[2];
  return target && !target.startsWith("-") ? target : null;
}

/**
 * Decide a restarting shell's fate against a stable identity's recorded binding. Fail-closed:
 *  - incumbent is a LIVE OTHER process ⇒ "reject" (never steal a live slot; the restart is spurious / the old shell is up).
 *  - incumbent is the SAME process (pid matches) ⇒ "adopt" idempotently (already bound; rebind is a no-op rewrite).
 *  - incumbent dead/absent + continuity PROVEN ⇒ "adopt" (rebind the presence slot to our pid, REUSE the mintedId).
 *  - otherwise ⇒ "fresh" (continuity not proven ⇒ come up as a new identity; never hijack the stable slot).
 * Pure. */
export function successionVerdict(att: Attestation, inc: IncumbentBinding): SuccessionResult {
  const adopt = (reason: string): SuccessionResult => ({ action: "adopt", reason, rebind: { stableSid: inc.stableSid, pid: att.newPid, mintedId: inc.mintedId ?? null } });
  const proven = provesContinuity(att, inc);
  if (inc.incumbentLiveness === "alive") {
    // Never steal a LIVE slot. Adopt (idempotent) only if this is provably the same shell: same pid AND proven continuity.
    // F45-P1-1: a matching pid ALONE does not exempt the continuity check — pids are reused across time and processes.
    if (inc.incumbentPid != null && inc.incumbentPid === att.newPid && proven) return adopt("incumbent is this same process (idempotent rebind)");
    return { action: "reject", reason: "a live incumbent holds the stable identity and this shell is not provably it — not stealing a live slot" };
  }
  if (!proven) return { action: "fresh", reason: "continuity not proven — no credential binds this shell to the stable identity (same machine/cwd/tool is not identity) — coming up fresh, not hijacking the stable slot" };
  return adopt(`continuity proven and incumbent ${inc.incumbentLiveness} — adopting the stable presence slot, reusing mintedId`);
}

/** The presence pid path (relative to the agenthop home) the IO shell rewrites on adoption. Pure. */
export function presencePidRelPath(stableSid: string): string {
  return `presence/${stableSid}.pid`;
}

// ============================================================================================================
// IO shell — gather the attestation + rewrite the presence pid (dormant: SWARM_SUCCESSION off; exercised by live runs)
// ============================================================================================================

/** shell-succession wiring flip, default OFF (dormant-ahead-of-use). */
export function successionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_SUCCESSION ?? "");
}

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROSTER_FILE, type RosterMember } from "./resume.js";
import { makeFileLiveness, probeSessionLiveness } from "./task-liveness.js";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";

export interface IncumbentLiveness { pid: number | null; liveness: "alive" | "dead" | "absent"; }

/** Normalize a cwd for comparison (strip trailing slashes). SP2: an UNKNOWN/empty cwd stays "" — it is NEVER normalized to
 *  root, so a record with no cwd can't accidentally match a shell whose cwd is "/". A real "/" (or all-slashes) stays "/". */
function normCwd(cwd: string): string {
  if (!cwd) return "";                  // unknown/empty ⇒ empty (not "/"): the caller rejects it (SP2)
  const n = cwd.replace(/\/+$/, "");
  return n === "" ? "/" : n;            // "/" or "///" ⇒ "/"; "/w/" ⇒ "/w" (trailing-slash equivalence preserved)
}

/**
 * PURE succession plan against a roster snapshot. Choose a prior stable identity this restarting shell might continue —
 * a snapshot member on THIS machine (the snapshot lives in this home) with the SAME tool+cwd whose sid is NOT this shell's
 * own native sid (a DIFFERENT prior identity worth adopting) — build its IncumbentBinding (liveness injected) and apply the
 * full continuity proof via successionVerdict. Fail-closed "fresh" when nothing matches. `incumbentOf` is injected so the
 * decision is unit-tested without fs. NOTE (consumption-point caveat, surfaced to the coordinator): the binding credential
 * must come from the shell's OWN launch context (resumeTargetSid from `codex resume <sid>` argv, or an inherited pane); a
 * detached presence daemon rarely carries one, so this adopts only when such a credential is genuinely present. */
export async function planSuccession(att: Attestation, members: readonly RosterMember[], incumbentOf: (stableSid: string) => Promise<IncumbentLiveness>): Promise<SuccessionResult> {
  // Normalize the cwd on BOTH sides consistently — the candidate filter AND the continuity proof must agree, so a trailing
  // slash never makes provesContinuity (which compares att.cwd to recordedCwd) reject a real match the filter accepted.
  const attN: Attestation = { ...att, cwd: normCwd(att.cwd) };
  if (attN.cwd === "") return { action: "fresh", reason: "unknown/empty cwd — environment cannot be proven, coming up fresh" }; // SP2
  // SP1: select the UNIQUE candidate by the IDENTITY CREDENTIAL — the resume target (codex), else the shell's OWN native sid
  // (the Claude same-sid fix). NOT by roster order: a bare tool/cwd `find` picks an arbitrary first entry and ignores which sid
  // the shell actually continues. The same-sid case is KEPT (not excluded) so a Claude restart that lost its PID binding can
  // re-take its own slot. A credential with no matching member ⇒ fresh (fail-closed).
  const credentialSid = att.resumeTargetSid || att.newNativeSid;
  if (!credentialSid) return { action: "fresh", reason: "no identity credential (no resume target, no native sid) — coming up fresh" };
  const cand = members.find((m) => m.member === credentialSid && m.tool === attN.tool && normCwd(m.cwd) === attN.cwd);
  if (!cand) return { action: "fresh", reason: `no roster member matches the credential identity ${credentialSid} with this tool+cwd — coming up fresh` };
  const live = await incumbentOf(cand.member);
  const inc: IncumbentBinding = {
    stableSid: cand.member,
    mintedId: null,                // the roster snapshot carries no mintedId (bus-identity supplies it in future); null ⇒ no reuse
    recordedMachine: attN.machine, // same machine by construction (the snapshot lives in THIS home)
    recordedCwd: normCwd(cand.cwd),
    recordedTool: cand.tool,
    recordedResumeCmd: cand.resumeCmd ?? null,
    recordedHerdrPane: null,       // the snapshot records no herdr pane
    incumbentPid: live.pid,
    incumbentLiveness: live.liveness,
  };
  return successionVerdict(attN, inc);
}

/** Read roster-snapshot members from <home>/.agenthop/swarm/roster-snapshot.json (empty on any fault). */
export function readRosterMembers(home: string): RosterMember[] {
  try {
    const snap = JSON.parse(readFileSync(path.join(home, ".agenthop", "swarm", ROSTER_FILE), "utf8"));
    const ms = Array.isArray(snap?.members) ? snap.members : [];
    return ms.filter((m: unknown): m is RosterMember => !!m && typeof (m as RosterMember).member === "string" && typeof (m as RosterMember).tool === "string" && typeof (m as RosterMember).cwd === "string");
  } catch { return []; }
}

/** Read presence/<sid>.pid with ERRNO detail — distinguish a truly-ABSENT file (adoptable) from an UNREADABLE one (EACCES,
 *  SU1: unreadable metadata must NEVER authorize takeover). makeFileLiveness.readPid collapses both to null, which is the bug. */
function readPidDetailed(home: string, sid: string): { kind: "missing" | "unreadable" | "ok"; pid: number | null } {
  try {
    const raw = readFileSync(path.join(home, ".agenthop", presencePidRelPath(sid)), "utf8").trim();
    const n = Number(raw);
    return { kind: "ok", pid: Number.isInteger(n) && n > 0 ? n : null };
  } catch (e) {
    return { kind: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", pid: null };
  }
}

/** SU1: the WINDOW-FREE live liveness SOCKET is the occupancy authority. If the sid's socket answers (and proves it owns the
 *  sid, via the F45 full-SID back-verify in probeSessionAlive), the incumbent is ALIVE regardless of PID-file readability — a
 *  shell can never adopt a live identity by deleting/locking its PID metadata. Only when NO live socket answers do we consult
 *  the PID file: ABSENT (ENOENT) ⇒ adoptable; UNREADABLE (EACCES) ⇒ "alive" (never authorize on unreadable, SU1); a readable
 *  DEAD pid ⇒ dead (adoptable); a readable LIVE pid with no socket ⇒ conservatively "alive" (don't steal a maybe-live slot). */
export function incumbentLivenessOf(home: string): (stableSid: string) => Promise<IncumbentLiveness> {
  const io = makeFileLiveness(home);
  return async (sid) => {
    // SU1 (r4): ONE tri-state enumerate-and-probe — the dir is listed once and every candidate it lists is probed in that SAME
    // pass, so there is no stitching of a failed probe's empty view onto a separate, later readdir whose listed sockets were never
    // probed (the r3 residue: a listener appearing between a real EACCES and a permission-recovered enumeration was listed but not
    // probed, then consumed as absent). "unknown" (dir unenumerable) ⇒ the incumbent might still be live ⇒ "alive" (never adopt on
    // an uncertain observation). Only a successfully enumerated-AND-probed dir with no live socket proceeds to the PID check.
    const probe = await probeSessionLiveness(home, sid);
    if (probe === "alive") return { pid: readPidDetailed(home, sid).pid, liveness: "alive" };
    if (probe === "unknown") return { pid: null, liveness: "alive" }; // SU1: enumeration uncertain ⇒ not adoptable
    const d = readPidDetailed(home, sid); // probe === "no-socket": enumerated + probed, no live owner of this sid
    if (d.kind === "missing") return { pid: null, liveness: "absent" }; // enumerable dir + no live socket + no pid ⇒ confirmed absent
    if (d.kind === "unreadable" || d.pid === null) return { pid: d.pid, liveness: "alive" }; // SU1: unreadable/unparseable ⇒ do not authorize
    return { pid: d.pid, liveness: io.procAlive(d.pid) === "dead" ? "dead" : "alive" };
  };
}

/** Read a process's argv via `ps -o args= -p <pid>` — the AGENT's OWN launch command, read straight from the OS (the truest
 *  credential source; not a relayable file, coordinator ruling a). A bus process's own `process.argv` is `node presence.mjs` /
 *  `agenthop mcp`, never the resume command, so the resume target must come from the HOST (agent) process. Split on whitespace
 *  (resume sids/paths rarely contain spaces; mirrors resume.ts's capture). Empty on any fault. */
/** SP3 (r4): parse a Linux /proc/<pid>/cmdline buffer into the EXACT argv. Args are NUL-separated AND each is NUL-terminated, so
 *  the buffer ends with a trailing terminator and a zero-length arg is legal at ANY position. Remove ONLY that single trailing
 *  terminator — never interior or trailing empty REAL args. `.filter(Boolean)` (the r3 residue) dropped every empty, shifting the
 *  remaining args left, which could move a non-target into the resume-target slot and FABRICATE a credential (false adopt). Empty
 *  buffer (zombie/kernel thread) ⇒ []. Pure, so the boundary contract is unit-tested without /proc. */
export function argvFromCmdline(raw: string): string[] {
  if (raw === "") return [];
  const parts = raw.split("\0");
  if (parts[parts.length - 1] === "") parts.pop(); // drop ONLY the final NUL terminator's empty; keep every real (incl. empty) arg
  return parts;
}

export function readHostArgv(hostPid: number | undefined): string[] {
  if (!hostPid || !Number.isInteger(hostPid) || hostPid <= 1) return [];
  // SP3: the ONLY source that preserves argument boundaries is /proc/<pid>/cmdline (NUL-separated argv — a program path AND any
  // argument with spaces survive exactly). Linux only.
  try {
    const argv = argvFromCmdline(readFileSync(`/proc/${hostPid}/cmdline`, "utf8"));
    if (argv.length) return argv;
  } catch { /* no /proc */ }
  // macOS/BSD have NO boundary-preserving per-pid argv source accessible without a native syscall (KERN_PROCARGS2). A `ps -o args=`
  // display string has LOST the argument boundaries, and re-splitting it on whitespace can FABRICATE a `resume <sid>` credential
  // out of a single space-containing argument (a false adopt). Per the review threshold, when exact arguments cannot be obtained we
  // return NO argv ⇒ NO resume credential ⇒ the plan falls back to sidBinds (claude keeps its sid) or fresh — never an inference
  // from a boundary-lost string. (macOS Codex resume-credential succession would need a /proc-equivalent exact source.)
  return [];
}

/** SU2 (DA2-R6 reuse): the adopt lock SITE for a sid, backed by the VERIFIED holder-lock (shared primitive — identity-in-the-
 *  filename dir lock, structurally race-free reclaim + hold-intent credential for the mkdir→publish window). This replaces the
 *  hand-rolled O_EXCL/rename lock whose stale-reclaim had a TOCTOU (r2/r3). lockDir = presence/<sid>.adopt.lockd; the hold-intents
 *  live in the (writable, always-present) presence dir, isolated by a per-sid prefix. */
export function adoptLockSite(home: string, sid: string): LockSite {
  const presence = path.join(home, ".agenthop", "presence");
  return { lockDir: path.join(presence, `${sid}.adopt.lockd`), intentDir: presence, intentPrefix: `${sid}.adopt.hold.` };
}

/**
 * Bus-core-init / presence-startup consumption point (dormant: SWARM_SUCCESSION off). Gather this shell's attestation — the
 * binding credential (resume target) comes from the AGENT's OWN argv via ps on `hostPid` (coordinator ruling a: argv is the
 * truest source; not a relayable file / not the roster snapshot) — plan succession against the roster snapshot, and on "adopt"
 * TAKE OVER the stable sid's presence slot (write presence/<sid>.pid), returning the adopted sid so the caller does
 * `core.adoptStableId(sid)` (drains its inbox + rebinds the liveness socket + makes resolveSession find it). Returns null on
 * fresh/reject or any IO fault (fail-closed — never hijack on error).
 */
/** Read presence/<...>.pid at `pidPath` and report whether it still holds exactly `pid` (so a rollback only removes OUR claim). */
function pidFileIs(pidPath: string, pid: number): boolean {
  try { return Number(readFileSync(pidPath, "utf8").trim()) === pid; } catch { return false; }
}

export async function runSuccessionAtStartup(home: string, selfTool: string, selfNativeSid: string, hostPid: number | undefined, publish: (adoptedSid: string) => Promise<boolean> | boolean, log: (m: string) => void = () => {}): Promise<string | null> {
  const hostArgv = readHostArgv(hostPid); // the AGENT's real launch argv (e.g. `codex resume <sid>`) — the credential source
  const att: Attestation = {
    machine: os.hostname(),
    cwd: process.cwd(),
    tool: selfTool,
    resumeCmd: hostArgv.join(" ") || process.argv.join(" "),
    resumeTargetSid: parseResumeTargetFromArgv(hostArgv) ?? undefined, // from the HOST (agent) argv, not this bus process's own
    herdrPane: process.env.AGENTHOP_HERDR_PANE || null,
    newPid: process.pid,
    newNativeSid: selfNativeSid,
  };
  const incumbentOf = incumbentLivenessOf(home); // ONE uncertainty-preserving observation, used by BOTH the plan and the lock-inner re-check (SU1)
  let result: SuccessionResult;
  try { result = await planSuccession(att, readRosterMembers(home), incumbentOf); }
  catch (e) { log(`succession: plan failed (coming up fresh): ${e instanceof Error ? e.message : e}`); return null; }
  if (result.action !== "adopt" || !result.rebind) { log(`succession: ${result.action} — ${result.reason}`); return null; }
  const sid = result.rebind.stableSid;
  // SU2 (DA2-R6 holder-lock): SINGLE-WINNER occupancy via the verified identity-in-the-filename lock. acquire in one attempt —
  // a contended lock (another shell adopting, or a live hold-intent in the mkdir→publish window) ⇒ null ⇒ come up fresh (never
  // steal); a dead/own-stranded holder is reclaimed race-free by the primitive. Held across the re-check + pid-write + publish,
  // released in finally.
  try { mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true }); } catch { /* best effort — must exist for hold-intents */ }
  const site = adoptLockSite(home, sid);
  const token = acquireHolderLock(site);
  if (!token) { log(`succession: adopt lock for ${sid} is held by another shell — coming up fresh`); return null; }
  const pidPath = path.join(home, ".agenthop", presencePidRelPath(sid));
  try {
    // SU1: re-check UNDER the lock with the SAME uncertainty-preserving observation as the plan (NOT raw probeSessionAlive, which
    // folds an enumeration failure to "not alive"). Only a CONFIRMED dead/absent incumbent may be adopted; a live OR unconfirmable
    // (unknown) one ⇒ do not adopt.
    const recheck = await incumbentOf(sid);
    if (recheck.liveness !== "dead" && recheck.liveness !== "absent") { log(`succession: ${sid} is ${recheck.liveness} under the lock — not adopting`); return null; }
    writeFileSync(pidPath, String(att.newPid)); // claim the slot (under the lock)
    const ready = await publish(sid); // bind the liveness socket THEN adopt the identity; TRUE iff the listener for sid is actually ready (SU3)
    if (!ready) {
      // SU3: the publish did NOT complete (bind failed / superseded / stop). Not adopted; ROLL BACK this write's occupancy — remove
      // our pid claim (only if it is still ours). The publish reverts the socket identity itself (presence), so the heartbeat does
      // not re-publish the un-adopted target. The incumbent was confirmed dead/absent under the lock, so no live owner is lost.
      try { if (pidFileIs(pidPath, att.newPid)) unlinkSync(pidPath); } catch { /* best effort */ }
      log(`succession: publish did not complete for ${sid} — not adopting (rolled back the pid claim)`);
      return null;
    }
    log(`succession: ADOPTED stable sid ${sid} — ${result.reason}`);
    return sid;
  } catch (e) {
    try { if (pidFileIs(pidPath, att.newPid)) unlinkSync(pidPath); } catch { /* best effort */ }
    log(`succession: adopt commit failed (coming up fresh): ${e instanceof Error ? e.message : e}`); return null;
  } finally { releaseHolderLock(site, token); }
}
