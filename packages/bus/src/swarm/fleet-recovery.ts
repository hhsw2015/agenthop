/**
 * fleet-recovery — the PURE decision core for full-fleet-recovery (全舰队状态恢复, brief docs/swarm/full-fleet-recovery-brief.md,
 * FROZEN @cf7a6e2 with 6 rulings; author 90b58f9c). North star (user 原话): after the machine reboots, ONE command brings the whole
 * swarm back to what it was running — not just the windows (F36 resume already does those), but the DISPATCHER, its env, each member's
 * in-flight work, and a DURABLE receipt proving what actually came back.
 *
 * This module is the delicate, pure half: the snapshot schema + tolerant parse, the env-capture ALLOWLIST (fail-closed toward secrets
 * and unknown families, Q1), the dispatcher-relaunch decision (Q2), the breakpoint re-pointer builder (Q3), and the recovery verdicts.
 * It reuses the F53 receipt primitives (verifyOpsAction / OpsReceiptRecord) verbatim rather than re-inventing verification, and the
 * F54 wake-health gate (inboxWakeStatus's tri-state) so a recovered dispatcher that comes up wake-INERT is flagged, never assumed OK.
 *
 * PURE (msglog P1 / resume.ts discipline): no fs, no bus, no top-level side effects. The IO shell is fleet-recovery-store.ts + the
 * thin scripts/swarm-recover.ts orchestrator. Selftests + the 3 zero-bug fixture classes (crash-recovery / restart-idempotency /
 * concurrency-race) live in fleet-recovery.selftest.mts.
 */
import { flagDefaultOn } from "./flag-default.js";
import { verifyOpsAction, type OpsVerdict, type OpsReceiptRecord } from "./coordinator-ops-receipt.js";

// re-export the receipt verdict/record types so the IO shell + selftests need only this module's surface
export { verifyOpsAction };
export type { OpsVerdict, OpsReceiptRecord };

export const FLEET_SNAPSHOT_SCHEMA = "fleet-recovery-snapshot/v1" as const;

/** SWARM_FLEET_RECOVERY — the closeout auto-snapshot hook (Q4: flagDefaultOn, default ON; writing a snapshot to disk is zero-risk,
 *  the user's "开发出来就是拿来用" precedent). recover itself is a manual/triggered action, NOT gated by this flag. Pure. */
export function fleetRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_FLEET_RECOVERY);
}

// ============================================================================================================
// Q1 — env capture allowlist (fail-closed). Lives in the PURE core as an EXPLICIT policy; a credential is NEVER
// captured (re-sourced from its canonical file at recover time), and a var outside the allowed families is dropped.
// ============================================================================================================

/** Non-family env names recovery explicitly needs: AH_HOME (the swarm home) + the endpoint base URLs (keep the dispatcher pointed at
 *  the same CPA/Anthropic endpoints). */
export const ENV_NAME_ALLOW: readonly string[] = ["AH_HOME", "ANTHROPIC_BASE_URL", "CPA_BASE_URL"];

/** Allowed NAME PREFIXES — two families:
 *  - SWARM_ : the identity + behavior-flag family (the "flag 集" of Q1). A NEW SWARM_ flag is captured on purpose (losing a flag on
 *    restart is the whole problem this fixes).
 *  - HERDR_ : the herdr-reachability family (Q2 / F54 regression pin). HERDR_ENV + HERDR_PANE_ID gate inbox-wake; HERDR_BIN /
 *    HERDR_SOCKET_PATH / HERDR_WORKSPACE_ID let the relaunched dispatcher ACTUALLY reach the herdr server to inject wakes. Without
 *    this family a bare restart loses herdr reach ⇒ inbox-wake INERT (the exact F54 bug the receipt must catch). None are secrets.
 *  A brand-new NON-family var is dropped (fail-closed). */
export const ENV_PREFIX_ALLOW: readonly string[] = ["SWARM_", "HERDR_"];

/** The SECRET denylist — OVERRIDES every allow rule above. Any name that looks like a credential is NEVER captured, even if it is in
 *  the SWARM_ family or the explicit name list (e.g. a hypothetical SWARM_*_TOKEN, or CPA_API_KEY). Credentials are re-sourced from
 *  their canonical files (~/.agenthop/cpa.json etc.) at recover time, so a leaked fleet-snapshot can never leak a key. */
export const ENV_SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_PAT(?![A-Z]))/i;

/** Is this env var captured into the snapshot? Secret denylist first (fail-closed), then the explicit name set, then the family
 *  prefixes. Anything else ⇒ dropped. Pure. */
export function envAllowed(name: string): boolean {
  if (!name || ENV_SECRET_RE.test(name)) return false;        // fail-closed: never capture a credential
  if (ENV_NAME_ALLOW.includes(name)) return true;
  return ENV_PREFIX_ALLOW.some((p) => name.startsWith(p));
}

/** Filter a raw environ into the captured subset: allowlisted, secret-stripped, string values only. Pure (no process.env read). */
export function filterCaptureEnv(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && envAllowed(k)) out[k] = v;
  }
  return out;
}

// ============================================================================================================
// snapshot schema + tolerant parse
// ============================================================================================================

export type EnvCaptureSource = "captured" | "unavailable";

/** Everything needed to relaunch the dispatcher exactly. `env` is the ALREADY-FILTERED subset (filterCaptureEnv); `envSource` is
 *  "unavailable" when the live environ could not be read — in which case `env` is {} and recover must warn + run with the current
 *  shell env (NEVER fabricate flag values, FC-2 r3 honest-degrade). */
export interface DispatcherRecipe {
  command: string;              // the dispatcher command line (ps -o args=), run verbatim
  cwd: string;                  // the dispatcher's working directory
  env: Record<string, string>;  // the captured, allowlisted, secret-stripped env subset
  envSource: EnvCaptureSource;
}

export interface FleetSnapshot {
  schema: typeof FLEET_SNAPSHOT_SCHEMA;
  capturedAtSec: number;
  dispatcher: DispatcherRecipe | null; // null when no dispatcher was live at capture time
  rosterFile: string;                    // pointer to the roster-snapshot.json F36 resume owns (members live there)
}

/** Age of a snapshot in seconds (never negative; non-finite inputs ⇒ 0 so a bad clock never looks "fresh"). Pure. */
export function snapshotStaleSec(snap: { capturedAtSec: number }, nowSec: number): number {
  if (!Number.isFinite(snap.capturedAtSec) || !Number.isFinite(nowSec)) return 0;
  return Math.max(0, Math.floor(nowSec - snap.capturedAtSec));
}

/** Tolerant parse of a fleet-snapshot file — returns null on ANYTHING malformed (a recovery must refuse to act on garbage, never
 *  guess a fleet). Validates the schema tag, capturedAtSec, the dispatcher sub-object (or null), and rosterFile. Pure. */
export function parseFleetSnapshot(text: string): FleetSnapshot | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.schema !== FLEET_SNAPSHOT_SCHEMA) return null;
  if (typeof r.capturedAtSec !== "number" || !Number.isFinite(r.capturedAtSec)) return null;
  if (typeof r.rosterFile !== "string" || r.rosterFile.length === 0) return null;
  let dispatcher: DispatcherRecipe | null = null;
  if (r.dispatcher !== null && r.dispatcher !== undefined) {
    if (typeof r.dispatcher !== "object") return null;
    const d = r.dispatcher as Record<string, unknown>;
    if (typeof d.command !== "string" || d.command.length === 0) return null;
    if (typeof d.cwd !== "string" || d.cwd.length === 0) return null;
    const envSource: EnvCaptureSource = d.envSource === "captured" ? "captured" : "unavailable";
    const env: Record<string, string> = {};
    if (d.env && typeof d.env === "object") {
      for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) {
        // re-apply the allowlist on READ too: an edited/old snapshot can never smuggle a non-allowed (e.g. secret) var back in.
        if (typeof v === "string" && envAllowed(k)) env[k] = v;
      }
    }
    dispatcher = { command: d.command, cwd: d.cwd, env, envSource };
  }
  return { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: r.capturedAtSec, dispatcher, rosterFile: r.rosterFile };
}

// ============================================================================================================
// Q2 — dispatcher relaunch decision + verdict (the F54 wake-health pin)
// ============================================================================================================

/** Should recover relaunch the dispatcher? Idempotent: a dispatcher already live ⇒ NO (skip). Otherwise YES iff we hold a recipe to
 *  relaunch it with (no recipe ⇒ nothing to do but report). Pure. */
export function dispatcherNeedsRelaunch(snap: FleetSnapshot, dispatcherLiveNow: boolean): boolean {
  if (dispatcherLiveNow) return false;
  return snap.dispatcher !== null;
}

/** The F54 wake-health gate (Q2): the recovered dispatcher must be wake-ACTIVE. inboxWakeStatus() "on" ⇒ healthy; "on(inert:no-herdr)"
 *  (HERDR_ENV/HERDR_PANE_ID lost — the exact bare-restart trap) or "off" ⇒ the wake capability did NOT come back. Pure. */
export function wakeHealthy(status: "off" | "on" | "on(inert:no-herdr)"): boolean {
  return status === "on";
}

/** Durable facts the recover orchestrator gathers for the relaunched dispatcher. `heartbeatFreshSec` = age of heartbeat.json's last
 *  tick (null = unreadable/absent ⇒ not proven ticking). `wakeStatus` = inboxWakeStatus() of the recovered process's env. */
export interface DispatcherLiveness {
  pidAlive: boolean;
  heartbeatFreshSec: number | null;
  wakeStatus: "off" | "on" | "on(inert:no-herdr)";
}

/**
 * The dispatcher recovery verdict, PURELY from durable facts (F53 shape):
 *   - failed:    the process is provably gone (pid dead) ⇒ durable negative ⇒ redo + account.
 *   - confirmed: pid alive AND heartbeat fresh AND wake ACTIVE ("on") — the dispatcher is really ticking and its inbox-wake works.
 *   - unknown:   pid alive but NOT proven ticking, OR wake is INERT (the F54 trap) ⇒ redo + account, NEVER "assume up"
 *                (coordinator ruling: "inert 即 unknown 级呈报").
 * Pure. The orchestrator owns WHEN to gather facts; this only reads them.
 */
export function dispatcherVerdict(f: DispatcherLiveness, heartbeatFreshThresholdSec: number): OpsVerdict {
  if (!f.pidAlive) return "failed";
  const heartbeatOk = f.heartbeatFreshSec !== null && Number.isFinite(f.heartbeatFreshSec) && f.heartbeatFreshSec <= heartbeatFreshThresholdSec;
  if (heartbeatOk && wakeHealthy(f.wakeStatus)) return "confirmed";
  return "unknown"; // alive but unproven, or wake inert ⇒ the F54 escalation
}

/** Member spawn evidence ⇒ verdict, delegating to the F53 verifyOpsAction (spawn kind). A relaunched member is confirmed when it is
 *  bus-visible OR has checked in; provably gone ⇒ failed; neither ⇒ unknown (redo + account). Pure wrapper so the shell has one call. */
export function memberVerdict(busVisible: boolean, checkinInInbox: boolean, failureSignal: boolean): OpsVerdict {
  return verifyOpsAction({ kind: "spawn", target: "member" }, { busVisible, checkinInInbox, failureSignal });
}

// ============================================================================================================
// Q3 — breakpoint re-pointer (default ON). A recovered session resumes its transcript but does NOT know a reboot happened; this one
// durable message re-points it at its OWN in-flight work so it continues instead of idling (the user's four "怎么又空闲了"). It NEVER
// assigns new work and NEVER spends — every fact is READ from durable state, honest-or-omitted.
// ============================================================================================================

export interface MemberBreakpointFacts {
  member: string;                 // display id (for the message)
  boardClaims: readonly string[]; // item ids this member still has CLAIMED on the board (its in-flight work), [] when none found
  unreadInbox: number;            // scanUnclaimedInbox count for this member's box
}

/** Build the one-line-ish breakpoint message. Only states facts that are present (no "claim: none" noise beyond a short hint); the
 *  ask is always the same honest re-pointer: you were recovered, resume your in-flight work. Pure (the recoveredAt stamp is passed in).
 *  NEVER contains a new task. */
export function buildBreakpointText(f: MemberBreakpointFacts, recoveredAtIso: string): string {
  const parts: string[] = [`[fleet-recovery] 已随舰队恢复 @ ${recoveredAtIso}。`];
  if (f.boardClaims.length > 0) {
    parts.push(`你仍认领着 ${f.boardClaims.length} 件在途工作:${f.boardClaims.join(", ")}。`);
  } else {
    parts.push(`未发现你名下的在途 board 认领。`);
  }
  if (f.unreadInbox > 0) parts.push(`收件箱有 ${f.unreadInbox} 件未认领。`);
  parts.push(`请核对你的 board/收件箱并继续你倒下前的工作;本条只重指既有工作,未派新活。`);
  return parts.join(" ");
}

/** Should a breakpoint be injected for this member (Q3: default ON)? Only for a member whose recovery was CONFIRMED (injecting into a
 *  session we are not sure came back is noise) and only when the feature is on. Pure. */
export function shouldInjectBreakpoint(memberVerdictV: OpsVerdict, breakpointsEnabled: boolean): boolean {
  return breakpointsEnabled && memberVerdictV === "confirmed";
}

/** SWARM_FLEET_BREAKPOINT — Q3 default ON (opt-out). Pure. */
export function breakpointInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_FLEET_BREAKPOINT);
}

/** Extract a member's 8-hex short id (the board filename `who` token) from its session id / handle, for matching board claims. Returns
 *  null when no unambiguous 8-hex token is present (⇒ don't guess a claim owner; report []). Pure. */
export function memberShortId(member: string): string | null {
  const m = (member ?? "").match(/[0-9a-f]{8}/i);
  return m ? m[0].toLowerCase() : null;
}

/** From the board dir's file names, the item ids this member (by short id) still has CLAIMED (`<item>.claimed.<who>.json`). Pure (the
 *  shell supplies the readdir result). A member with no resolvable short id ⇒ [] (never guess ownership). */
export function claimedItemsForMember(member: string, boardFileNames: readonly string[]): string[] {
  const who = memberShortId(member);
  if (!who) return [];
  const out: string[] = [];
  for (const name of boardFileNames) {
    if (!name.endsWith(".json")) continue;
    const parts = name.slice(0, -5).split("."); // strip .json, split
    // `<item>.claimed.<who>` — item may itself contain dots, so match the LAST two segments as state + who
    if (parts.length >= 3 && parts[parts.length - 2] === "claimed" && (parts[parts.length - 1] ?? "").toLowerCase() === who) {
      out.push(parts.slice(0, parts.length - 2).join("."));
    }
  }
  return out;
}
