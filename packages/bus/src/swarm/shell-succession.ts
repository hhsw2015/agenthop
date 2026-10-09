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

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ROSTER_FILE, type RosterMember } from "./resume.js";
import { makeFileLiveness, probeSessionAlive } from "./task-liveness.js";

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
    if (await probeSessionAlive(home, sid)) return { pid: readPidDetailed(home, sid).pid, liveness: "alive" };
    const d = readPidDetailed(home, sid);
    if (d.kind === "missing") return { pid: null, liveness: "absent" };
    if (d.kind === "unreadable" || d.pid === null) return { pid: d.pid, liveness: "alive" }; // SU1: unreadable/unparseable ⇒ do not authorize
    return { pid: d.pid, liveness: io.procAlive(d.pid) === "dead" ? "dead" : "alive" };
  };
}

/** Read a process's argv via `ps -o args= -p <pid>` — the AGENT's OWN launch command, read straight from the OS (the truest
 *  credential source; not a relayable file, coordinator ruling a). A bus process's own `process.argv` is `node presence.mjs` /
 *  `agenthop mcp`, never the resume command, so the resume target must come from the HOST (agent) process. Split on whitespace
 *  (resume sids/paths rarely contain spaces; mirrors resume.ts's capture). Empty on any fault. */
export function readHostArgv(hostPid: number | undefined): string[] {
  if (!hostPid || !Number.isInteger(hostPid) || hostPid <= 1) return [];
  // SP3: prefer /proc/<pid>/cmdline — argv is NUL-separated with EXACT boundaries, so a program path containing spaces
  // (e.g. `Tool Install/codex`) survives and argv[0] basename is correct. Linux only.
  try {
    const raw = readFileSync(`/proc/${hostPid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter(Boolean);
    if (argv.length) return argv;
  } catch { /* no /proc (macOS) — fall through to ps */ }
  // ps fallback (no /proc): `ps -o args=` is a display string that LOSES arg boundaries, so a space in the path mis-splits
  // and parseResumeTargetFromArgv returns null ⇒ FRESH (fail-closed: a miss, never a mis-adopt). We do NOT quote-reconstruct
  // a boundary-lost string (SP3 threshold).
  try {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(hostPid)], { encoding: "utf8", timeout: 2000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim().split(/\s+/).filter(Boolean);
  } catch { /* noop */ }
  return [];
}

function adoptLockPath(home: string, sid: string): string { return path.join(home, ".agenthop", "presence", `${sid}.adopt.lock`); }

/** signal-0: true ONLY on ESRCH (definitely dead). alive / EPERM (exists, not ours) / any other errno ⇒ false (never convict). */
function procIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** SU2: acquire the single-winner adopt lock for `sid` via O_EXCL (`wx`). true ⇒ WE hold it (proceed with the commit); false ⇒
 *  another shell holds a LIVE adopt and we must NOT adopt (loser → fresh). A lock whose holder pid is DEFINITIVELY dead (ESRCH)
 *  is reclaimed exactly once; an unreadable lock or a live holder is never stolen. The O_EXCL create is the serializer, so even
 *  with concurrent reclaimers at most one re-create wins. */
export function acquireAdoptLock(home: string, sid: string, selfPid: number): boolean {
  const p = adoptLockPath(home, sid);
  try { writeFileSync(p, String(selfPid), { flag: "wx" }); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; // any other error ⇒ fail-closed (do not adopt)
    let holder: number | null = null;
    try { const n = Number(readFileSync(p, "utf8").trim()); holder = Number.isInteger(n) && n > 0 ? n : null; } catch { holder = null; }
    if (holder === null || !procIsDead(holder)) return false;         // unreadable, or a LIVE holder ⇒ loser (never steal a live adopt)
    try { unlinkSync(p); } catch { return false; }                    // reclaim a provably-dead holder's lock, once
    try { writeFileSync(p, String(selfPid), { flag: "wx" }); return true; } catch { return false; }
  }
}
export function releaseAdoptLock(home: string, sid: string): void { try { unlinkSync(adoptLockPath(home, sid)); } catch { /* best effort */ } }

/**
 * Bus-core-init / presence-startup consumption point (dormant: SWARM_SUCCESSION off). Gather this shell's attestation — the
 * binding credential (resume target) comes from the AGENT's OWN argv via ps on `hostPid` (coordinator ruling a: argv is the
 * truest source; not a relayable file / not the roster snapshot) — plan succession against the roster snapshot, and on "adopt"
 * TAKE OVER the stable sid's presence slot (write presence/<sid>.pid), returning the adopted sid so the caller does
 * `core.adoptStableId(sid)` (drains its inbox + rebinds the liveness socket + makes resolveSession find it). Returns null on
 * fresh/reject or any IO fault (fail-closed — never hijack on error).
 */
export async function runSuccessionAtStartup(home: string, selfTool: string, selfNativeSid: string, hostPid: number | undefined, publish: (adoptedSid: string) => Promise<void> | void, log: (m: string) => void = () => {}): Promise<string | null> {
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
  let result: SuccessionResult;
  try { result = await planSuccession(att, readRosterMembers(home), incumbentLivenessOf(home)); }
  catch (e) { log(`succession: plan failed (coming up fresh): ${e instanceof Error ? e.message : e}`); return null; }
  if (result.action !== "adopt" || !result.rebind) { log(`succession: ${result.action} — ${result.reason}`); return null; }
  const sid = result.rebind.stableSid;
  // SU2: SINGLE-WINNER occupancy. Hold an O_EXCL lock across the re-check + pid-write + listener publish, so two shells racing
  // to adopt the same prior sid can't both commit; the loser (EEXIST on a live holder) comes up fresh and never overwrites the
  // winner. The lock is held until `publish` resolves (the winner's liveness socket is actually bound — covering the pre-publish
  // interval), then released.
  if (!acquireAdoptLock(home, sid, att.newPid)) { log(`succession: another shell is adopting ${sid} — coming up fresh`); return null; }
  try {
    // Re-check UNDER the lock: a winner may have published a live socket between the plan and the lock acquire.
    if (await probeSessionAlive(home, sid)) { log(`succession: ${sid} became live under the lock — not adopting`); return null; }
    writeFileSync(path.join(home, ".agenthop", presencePidRelPath(sid)), String(att.newPid));
    await publish(sid); // core.adoptStableId + bind the liveness socket — the listener is published WHILE we hold the lock
    log(`succession: ADOPTED stable sid ${sid} — ${result.reason}`);
    return sid;
  } catch (e) { log(`succession: adopt commit failed (coming up fresh): ${e instanceof Error ? e.message : e}`); return null; }
  finally { releaseAdoptLock(home, sid); }
}
