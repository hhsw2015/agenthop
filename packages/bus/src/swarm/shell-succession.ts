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

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROSTER_FILE, type RosterMember } from "./resume.js";
import { makeFileLiveness } from "./task-liveness.js";

export interface IncumbentLiveness { pid: number | null; liveness: "alive" | "dead" | "absent"; }

/** Normalize a cwd for comparison (strip trailing slashes). Local mirror of resume.normCwd (not exported). */
function normCwd(cwd: string): string { return cwd.replace(/\/+$/, "") || "/"; }

/**
 * PURE succession plan against a roster snapshot. Choose a prior stable identity this restarting shell might continue —
 * a snapshot member on THIS machine (the snapshot lives in this home) with the SAME tool+cwd whose sid is NOT this shell's
 * own native sid (a DIFFERENT prior identity worth adopting) — build its IncumbentBinding (liveness injected) and apply the
 * full continuity proof via successionVerdict. Fail-closed "fresh" when nothing matches. `incumbentOf` is injected so the
 * decision is unit-tested without fs. NOTE (consumption-point caveat, surfaced to the coordinator): the binding credential
 * must come from the shell's OWN launch context (resumeTargetSid from `codex resume <sid>` argv, or an inherited pane); a
 * detached presence daemon rarely carries one, so this adopts only when such a credential is genuinely present. */
export function planSuccession(att: Attestation, members: readonly RosterMember[], incumbentOf: (stableSid: string) => IncumbentLiveness): SuccessionResult {
  // Normalize the cwd on BOTH sides consistently — the candidate filter AND the continuity proof must agree, so a trailing
  // slash never makes provesContinuity (which compares att.cwd to recordedCwd) reject a real match the filter accepted.
  const attN: Attestation = { ...att, cwd: normCwd(att.cwd) };
  const cand = members.find((m) => m.member && m.member !== attN.newNativeSid && m.tool === attN.tool && normCwd(m.cwd) === attN.cwd);
  if (!cand) return { action: "fresh", reason: "no prior roster member matches this shell's tool+cwd on this machine — coming up fresh" };
  const live = incumbentOf(cand.member);
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

/** IncumbentLiveness for a stable sid from presence/<sid>.pid + signal-0 (reuses makeFileLiveness). "unknown" (any non-ESRCH
 *  errno, F17) maps to "alive" — never convict a maybe-live incumbent, so the verdict rejects rather than stealing a live slot. */
export function incumbentLivenessOf(home: string): (stableSid: string) => IncumbentLiveness {
  const io = makeFileLiveness(home);
  return (sid) => {
    const pid = io.readPid(sid);
    if (pid === null) return { pid: null, liveness: "absent" };
    return { pid, liveness: io.procAlive(pid) === "dead" ? "dead" : "alive" };
  };
}

/**
 * Presence-startup consumption point (dormant: SWARM_SUCCESSION off). Gather this shell's attestation, plan succession
 * against the roster snapshot, and on "adopt" TAKE OVER the stable sid's presence slot (write presence/<sid>.pid) — then
 * return the adopted sid so the caller does `core.adoptStableId(sid)` (drains its inbox + rebinds the liveness socket +
 * makes resolveSession find it). Returns null on fresh/reject or any IO fault (fail-closed — never hijack on error).
 */
export function runSuccessionAtStartup(home: string, selfTool: string, selfNativeSid: string, log: (m: string) => void = () => {}): string | null {
  const att: Attestation = {
    machine: os.hostname(),
    cwd: process.cwd(),
    tool: selfTool,
    resumeCmd: process.argv.join(" "),
    resumeTargetSid: parseResumeTargetFromArgv(process.argv) ?? undefined, // a detached presence daemon rarely carries this (caveat above)
    herdrPane: process.env.AGENTHOP_HERDR_PANE || null,
    newPid: process.pid,
    newNativeSid: selfNativeSid,
  };
  let result: SuccessionResult;
  try { result = planSuccession(att, readRosterMembers(home), incumbentLivenessOf(home)); }
  catch (e) { log(`succession: plan failed (coming up fresh): ${e instanceof Error ? e.message : e}`); return null; }
  if (result.action !== "adopt" || !result.rebind) { log(`succession: ${result.action} — ${result.reason}`); return null; }
  const sid = result.rebind.stableSid;
  try { writeFileSync(path.join(home, ".agenthop", presencePidRelPath(sid)), String(att.newPid)); }
  catch (e) { log(`succession: adopt pid-write failed (not adopting): ${e instanceof Error ? e.message : e}`); return null; }
  log(`succession: ADOPTED stable sid ${sid} — ${result.reason}`);
  return sid;
}
