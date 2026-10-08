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
  resumeCmd: string;      // the command this shell was (re)launched with — matched against the roster's recorded resumeCmd
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

/** Continuity proof: same machine AND cwd AND tool, the roster's resumeCmd when recorded, and a matching herdr pane when
 *  BOTH sides know one. A missing recorded resumeCmd (old v1 roster) falls back to machine+cwd+tool (no weaker than what a
 *  v1 roster can assert); a recorded resumeCmd that DISAGREES is a hard fail. Pure. */
export function provesContinuity(att: Attestation, inc: IncumbentBinding): boolean {
  if (att.machine !== inc.recordedMachine) return false;
  if (att.cwd !== inc.recordedCwd) return false;
  if (att.tool !== inc.recordedTool) return false;
  if (inc.recordedResumeCmd != null && inc.recordedResumeCmd !== "" && att.resumeCmd !== inc.recordedResumeCmd) return false;
  if (att.herdrPane != null && inc.recordedHerdrPane != null && att.herdrPane !== inc.recordedHerdrPane) return false;
  return true;
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
  if (inc.incumbentLiveness === "alive") {
    if (inc.incumbentPid != null && inc.incumbentPid === att.newPid) return adopt("incumbent is this same process (idempotent rebind)");
    return { action: "reject", reason: "a live OTHER process still holds the stable identity — not stealing a live slot" };
  }
  if (!provesContinuity(att, inc)) return { action: "fresh", reason: "continuity not proven (machine/cwd/tool/resumeCmd/pane mismatch) — coming up as a new identity, not hijacking the stable slot" };
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
