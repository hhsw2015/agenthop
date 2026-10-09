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

/** claude long-options that CONSUME the following token as their value — so that value (even one that looks like `--resume`
 *  or `resume`) is never mistaken for the resume flag/target (F45-P1-1 round-4: "skip value-taking options"). `--resume`
 *  itself is handled explicitly before this set is consulted. Version-dependent; `--resume=<sid>` inline is always safe. */
const CLAUDE_VALUE_FLAGS = new Set([
  "--model", "--fallback-model", "--append-system-prompt", "--system-prompt", "--permission-mode", "--permission-prompt-tool",
  "--allowedTools", "--disallowedTools", "--add-dir", "--mcp-config", "--settings", "--setting-sources", "--session-id",
  "--agents", "--input-format", "--output-format",
]);

/** F45-P1-1 (round-4): extract the EXACT resume-target sid from a real argv array, TOOL- and POSITION-aware.
 *  - codex: the `resume` SUBCOMMAND must be EXACTLY argv[1] (`codex resume <sid>`) ⇒ target argv[2]. A later bare "resume"
 *    (an option value) is not the subcommand.
 *  - claude: a POSITION-CORRECT `--resume <sid>` / `--resume=<sid>` found by a left-to-right scan that STOPS at `--` (end of
 *    options) and SKIPS each value-option's value — so `--append-system-prompt resume <sid>`, `-- --resume <sid>`, and a
 *    value that merely looks like `--resume` are NOT taken as targets.
 *  Anything unprovable ⇒ null ⇒ no resume binding (continuity then needs sidBinds / an inherited pane). Pure. */
export function parseResumeTargetFromArgv(argv: readonly string[]): string | null {
  if (argv.length < 2) return null;
  const tool = (argv[0].split("/").pop() || argv[0]).toLowerCase();
  if (tool.includes("codex")) {
    return argv[1] === "resume" && argv.length >= 3 && argv[2] && !argv[2].startsWith("-") ? argv[2] : null;
  }
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") break;                                                     // end of options — nothing after is a flag
    if (tok === "--resume") { const v = argv[i + 1]; return v && !v.startsWith("-") ? v : null; }
    if (tok.startsWith("--resume=")) { const v = tok.slice("--resume=".length); return v || null; }
    if (CLAUDE_VALUE_FLAGS.has(tok)) i++;                                        // skip this option's VALUE (not a flag/positional)
  }
  return null;
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
