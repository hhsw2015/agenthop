/**
 * fleet-recovery — the PURE decision core for full-fleet-recovery (全舰队状态恢复, brief docs/swarm/full-fleet-recovery-brief.md,
 * FROZEN @cf7a6e2; author 90b58f9c). North star (user 原话): after the machine reboots, ONE command brings the whole swarm back to
 * what it was running — not just the windows (F36 resume already does those), but the DISPATCHER, its env, each member's in-flight
 * work, and a DURABLE receipt proving what actually came back.
 *
 * r2 (codex:Work @29bd0e1 first review, 11 P2 + 1 P3): this core was rebuilt around the review's findings —
 *  - FR-1 the launch recipe is a LOSSLESS argv array + env object (the dispatcher self-records its own process.argv/env; a ps
 *    display string cannot round-trip spaces), with a clearly-marked lossy ps fallback.
 *  - FR-2 captured VALUES are credential-scrubbed (a userinfo `scheme://user:pass@host` in SWARM_WORK_REPO's Git URL is stripped;
 *    the name denylist cannot catch a secret that rides inside a value).
 *  - FR-5 a roster member is resolved to the UNIQUE live SID before it is confirmed / delivered to (title reuse ⇒ ambiguous).
 *  - FR-7 the recovery EPISODE id (dedup key root) is distinct per reboot but reused by a retry of an interrupted run.
 *  - FR-8 each recovery step yields an outstanding/ done obligation; a spawn/deliver fault is recorded, never masked by a 0 exit.
 *  - FR-10 breakpoint facts come from the canonical board parser (full-SID GRANTED = accepted work) + control-log live attempts;
 *    an unreadable source stays UNKNOWN, never conflated with "none".
 *
 * PURE (msglog P1 / resume.ts discipline): no fs, no bus, no top-level side effects. The IO shell is fleet-recovery-store.ts + the
 * thin scripts/swarm-recover.ts orchestrator (whose orchestration is itself a dep-injected pure-ish function here: orchestrateRecover).
 */
import { flagDefaultOn } from "./flag-default.js";
import { verifyOpsAction, type OpsVerdict, type OpsReceiptRecord } from "./coordinator-ops-receipt.js";

export { verifyOpsAction };
export type { OpsVerdict, OpsReceiptRecord };

export const FLEET_SNAPSHOT_SCHEMA = "fleet-recovery-snapshot/v1" as const;
export const DISPATCHER_RECIPE_SCHEMA = "dispatcher-recipe/v1" as const;

/** SWARM_FLEET_RECOVERY — the dispatcher's self-record + fleet-snapshot auto-capture hook (Q4: flagDefaultOn, default ON; writing a
 *  snapshot/recipe to disk is zero-risk). recover itself is a manual/triggered action, NOT gated by this flag. Pure. */
export function fleetRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_FLEET_RECOVERY);
}

/** SWARM_FLEET_BREAKPOINT — Q3 default ON (opt-out). Pure. */
export function breakpointInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_FLEET_BREAKPOINT);
}

// ============================================================================================================
// Q1 / FR-2 — env capture allowlist (fail-closed) + value-level credential scrub
// ============================================================================================================

/** Non-family env names recovery explicitly needs: AH_HOME + the endpoint base URLs. */
export const ENV_NAME_ALLOW: readonly string[] = ["AH_HOME", "ANTHROPIC_BASE_URL", "CPA_BASE_URL"];

/** Allowed NAME PREFIXES — the SWARM_ identity+flag family + the HERDR_ reachability family (Q2/F54: HERDR_ENV/HERDR_PANE_ID gate
 *  inbox-wake, HERDR_BIN/HERDR_SOCKET_PATH let the relaunched dispatcher actually reach herdr). A new non-family var is dropped. */
export const ENV_PREFIX_ALLOW: readonly string[] = ["SWARM_", "HERDR_"];

/** The SECRET name denylist — overrides every allow rule (a credential NAME is never captured). */
export const ENV_SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_PAT(?![A-Z]))/i;

/** Is this env var captured by NAME? Secret denylist first (fail-closed), then the explicit name set, then the family prefixes. */
export function envAllowed(name: string): boolean {
  if (!name || ENV_SECRET_RE.test(name)) return false;
  if (ENV_NAME_ALLOW.includes(name)) return true;
  return ENV_PREFIX_ALLOW.some((p) => name.startsWith(p));
}

/** FR-2 — strip inline credentials from a VALUE before it is persisted: a URL userinfo `scheme://user:pass@host` (or `user@host`)
 *  ⇒ `scheme://host`. SWARM_WORK_REPO is a supported Git URL that the name-denylist cannot protect (the secret is in the value, not
 *  the name). Idempotent, conservative (only touches the userinfo segment of a URL authority). Pure. */
export function scrubValueSecrets(v: string): string {
  // FR-2 (r4): URL userinfo scrubbing is PER-SCHEME, because the username means different things:
  //  - ssh / git+ssh: the user is a non-secret ADDRESS segment (`ssh://git@host`) — KEEP the user, strip only a `:password`.
  //  - http(s) and every OTHER scheme: the userinfo username can be an AUTH TOKEN — strip the WHOLE `user[:pass]@` (the r3 bug kept
  //    the HTTP username, which can carry a credential).
  return v.replace(/([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/@\s]+)@/g, (_m, scheme: string, userinfo: string) => {
    const s = scheme.toLowerCase();
    if (s === "ssh" || s === "git+ssh") { const c = userinfo.indexOf(":"); return `${scheme}://${c >= 0 ? userinfo.slice(0, c) : userinfo}@`; }
    return `${scheme}://`; // http(s)/ftp/…: strip the entire userinfo (username may be a token)
  });
}

/** Filter a raw environ into the captured subset: allowlisted by name, credential-scrubbed by value (FR-2), string values only.
 *  Pure (no process.env read). */
export function filterCaptureEnv(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && envAllowed(k)) out[k] = scrubValueSecrets(v);
  }
  return out;
}

// ============================================================================================================
// FR-1 — the LOSSLESS dispatcher recipe (argv array + env object) + snapshot schema + tolerant parse
// ============================================================================================================

/** How the recipe was obtained: `self-recorded` = the dispatcher wrote its OWN process.argv/env (lossless, handles spaces);
 *  `ps-fallback` = reconstructed from a ps display string (LOSSY — a space in a path/value is not recoverable; relaunch warns and
 *  will NOT shell-split). */
export type RecipeSource = "self-recorded" | "ps-fallback";

/** Everything needed to relaunch the dispatcher. `argv` is the EXACT argv array (lossless when self-recorded) — relaunch spawns
 *  argv[0] with argv.slice(1) directly (never a shell re-split). `env` is the captured, allowlisted, scrubbed subset. */
export interface DispatcherRecipe {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  source: RecipeSource;
}

export interface FleetSnapshot {
  schema: typeof FLEET_SNAPSHOT_SCHEMA;
  capturedAtSec: number;
  dispatcher: DispatcherRecipe | null;
  rosterFile: string;
}

/** Age of a snapshot in seconds (never negative; non-finite ⇒ 0 so a bad clock never looks "fresh"). Pure. */
export function snapshotStaleSec(snap: { capturedAtSec: number }, nowSec: number): number {
  if (!Number.isFinite(snap.capturedAtSec) || !Number.isFinite(nowSec)) return 0;
  return Math.max(0, Math.floor(nowSec - snap.capturedAtSec));
}

/** Tolerant parse of a dispatcher-recipe record (self-recorded file or the dispatcher sub-object of a snapshot). Re-applies the
 *  allowlist + scrub on READ (an edited/old file can never smuggle a non-allowed or credential-bearing value back in). null when
 *  malformed (no argv array, no cwd). Pure. */
export function parseDispatcherRecipe(raw: unknown): DispatcherRecipe | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.argv) || d.argv.length === 0 || !d.argv.every((a) => typeof a === "string")) return null;
  if (typeof d.cwd !== "string" || d.cwd.length === 0) return null;
  const source: RecipeSource = d.source === "self-recorded" ? "self-recorded" : "ps-fallback";
  const env: Record<string, string> = {};
  if (d.env && typeof d.env === "object") {
    for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) {
      if (typeof v === "string" && envAllowed(k)) env[k] = scrubValueSecrets(v); // FR-2: re-scrub on read
    }
  }
  return { argv: d.argv as string[], cwd: d.cwd, env, source };
}

/** Tolerant parse of a fleet-snapshot file — null on ANYTHING malformed (a recovery must refuse to act on garbage). Pure. */
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
    dispatcher = parseDispatcherRecipe(r.dispatcher);
    if (dispatcher === null) return null; // a present-but-malformed dispatcher ⇒ refuse (never act on a half-parsed recipe)
  }
  return { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: r.capturedAtSec, dispatcher, rosterFile: r.rosterFile };
}

// ============================================================================================================
// Q2 — dispatcher relaunch decision + verdict (the F54 wake-health pin)
// ============================================================================================================

/** Should recover relaunch the dispatcher? Idempotent: live ⇒ NO. Otherwise YES iff we hold a recipe. Pure. */
export function dispatcherNeedsRelaunch(snap: FleetSnapshot, dispatcherLiveNow: boolean): boolean {
  if (dispatcherLiveNow) return false;
  return snap.dispatcher !== null;
}

/** The F54 wake-health gate (Q2): "on" ⇒ healthy; "on(inert:no-herdr)" / "off" ⇒ the wake capability did NOT come back. Pure. */
export function wakeHealthy(status: "off" | "on" | "on(inert:no-herdr)"): boolean {
  return status === "on";
}

/** Durable facts for the relaunched dispatcher. `wakeStatus` is null when the TARGET's env could not be read (FR-3: never borrow
 *  the caller's env to fill the gap). */
export interface DispatcherLiveness {
  pidAlive: boolean;
  heartbeatFreshSec: number | null;
  wakeStatus: "off" | "on" | "on(inert:no-herdr)" | null;
}

/**
 * The dispatcher recovery verdict, PURELY from durable facts (F53 shape):
 *   - failed:    pid provably gone ⇒ durable negative.
 *   - confirmed: pid alive AND heartbeat fresh AND wake ACTIVE ("on").
 *   - unknown:   pid alive but not proven ticking, OR wake INERT, OR wake UNKNOWN (FR-3: target env unreadable) ⇒ redo + account.
 * Pure.
 */
export function dispatcherVerdict(f: DispatcherLiveness, heartbeatFreshThresholdSec: number): OpsVerdict {
  if (!f.pidAlive) return "failed";
  const heartbeatOk = f.heartbeatFreshSec !== null && Number.isFinite(f.heartbeatFreshSec) && f.heartbeatFreshSec <= heartbeatFreshThresholdSec;
  if (heartbeatOk && f.wakeStatus !== null && wakeHealthy(f.wakeStatus)) return "confirmed";
  return "unknown";
}

/** Member spawn evidence ⇒ verdict (F53 verifyOpsAction, spawn kind). Pure. */
export function memberVerdict(busVisible: boolean, checkinInInbox: boolean, failureSignal: boolean): OpsVerdict {
  return verifyOpsAction({ kind: "spawn", target: "member" }, { busVisible, checkinInInbox, failureSignal });
}

// ============================================================================================================
// FR-5 — resolve a roster member to the UNIQUE live SID (never a reused title / a bare handle)
// ============================================================================================================

/** The minimal roster-member shape resolution needs. `member` = the captured id (stableId or handle); `title` = the short handle. */
export interface RosterMemberLike { member: string; title?: string; tool?: string; cwd?: string }
/** The minimal live-peer shape. */
export interface PeerLikeMin { id?: string; stableId?: string; title?: string; tool?: string; cwd?: string }

export type MemberResolution =
  | { kind: "resolved"; sid: string }   // bound to a unique live peer's native SID
  | { kind: "ambiguous" }                // >1 live peer matches ⇒ cannot confirm this member
  | { kind: "absent" };                  // no live peer matches ⇒ not (yet) recovered

/**
 * Resolve a roster member to its live SID (FR-5, r4). The UNIQUE identity key is the STABLE SID itself — NOTHING else. A member is
 * resolved ONLY by an EXACT SID match (peer.stableId / peer.id === the captured member id); tool/cwd/title are display/workstation
 * hints, never identity (a different session sharing the same tool+cwd+title is NOT the same member — the r3 bug confirmed one and
 * delivered the breakpoint to the wrong box). SID absent among peers ⇒ ABSENT (never guessed from a shared workstation). A member
 * resumed with its SID preserved (claude `--resume <sid>`) matches; one whose SID genuinely changed (e.g. codex thread id) can't be
 * confirmed by identity and stays absent/unknown — the honest fail-closed outcome. >1 peer with the SAME sid ⇒ ambiguous. Pure.
 */
export function resolveMemberSid(member: RosterMemberLike, peers: readonly PeerLikeMin[]): MemberResolution {
  const matches = peers.filter((p) => (p.stableId && p.stableId === member.member) || (p.id && p.id === member.member));
  if (matches.length === 1) { const p = matches[0]!; return { kind: "resolved", sid: p.stableId ?? p.id! }; }
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "absent" };
}

// ============================================================================================================
// FR-7 — recovery EPISODE identity (dedup key root): distinct per reboot, reused by a retry of an interrupted run
// ============================================================================================================

export interface RecoveryEpisode { episodeId: string; startedAtSec: number; snapshotCapturedAtSec: number; completed: boolean }

/**
 * Decide the recovery episode id (FR-7). A recovery EVENT is distinct per run so a NEW reboot (even reusing the same snapshot)
 * delivers a fresh report/breakpoint; but a RETRY of an INTERRUPTED run reuses its id so durable dedup still collapses the retry.
 * Reuse iff the existing marker is INCOMPLETE and recent (within staleWindowSec); else mint a fresh id. Pure (the id minter + clock
 * are injected).
 */
export type EpisodeRead = { kind: "present"; ep: RecoveryEpisode } | { kind: "absent" } | { kind: "unreadable" };
export type EpisodeDecision = { action: "reuse"; episodeId: string } | { action: "new"; episodeId: string } | { action: "abort"; reason: string };

/**
 * Decide the recovery episode (FR-7, r3). Three-state read:
 *   - unreadable (EACCES/corrupt marker) ⇒ ABORT — minting a new id would rename an outstanding recovery's obligation away; a read
 *     error is NOT "no episode" (FC-2).
 *   - present + INCOMPLETE ⇒ REUSE, regardless of age — time passing is NOT evidence the prior launch disappeared; the episode's
 *     obligations persist until it is COMPLETED (so a re-run continues it, never re-mints + double-launches).
 *   - absent OR present+completed ⇒ NEW (a genuinely new recovery event).
 * Atomicity across concurrent recover processes (FR-6) is provided by the caller's single-flight lock, so this read-then-decide runs
 * single-threaded. Pure.
 */
export function resolveEpisode(read: EpisodeRead, mint: () => string): EpisodeDecision {
  if (read.kind === "unreadable") return { action: "abort", reason: "episode marker unreadable — refusing to mint a new episode (would abandon an outstanding recovery)" };
  if (read.kind === "present" && read.ep.completed === false) return { action: "reuse", episodeId: read.ep.episodeId };
  return { action: "new", episodeId: mint() };
}

// ============================================================================================================
// FR-10 — breakpoint re-pointer from AUTHORITATIVE in-flight work (granted board items + live control-log attempts)
// ============================================================================================================

/** Breakpoint facts. Each source is a `string[]` when READ, or `null` when UNREADABLE (FR-10: an unreadable board/control-log is
 *  "unknown", NEVER conflated with "none"). `grantedItems` = board items ACCEPTED (granted) by this member (its real in-flight work,
 *  not a pending `claimed` application); `liveAttempts` = control-log attempt ids RUNNING/RPV for those items; `unreadInbox` null
 *  when the box could not be scanned. */
export interface MemberBreakpointFacts {
  member: string;
  grantedItems: readonly string[] | null;
  liveAttempts: readonly string[] | null;
  unreadInbox: number | null;
}

/** Build the breakpoint message (FR-10). States only what is KNOWN; an unreadable source becomes an explicit "could not read"
 *  rather than a false "none". The ask is always the honest re-pointer: you were recovered, resume your ACCEPTED in-flight work.
 *  NEVER a new task. Pure. */
export function buildBreakpointText(f: MemberBreakpointFacts, recoveredAtIso: string): string {
  const parts: string[] = [`[fleet-recovery] 已随舰队恢复 @ ${recoveredAtIso}。`];
  if (f.grantedItems === null) parts.push(`无法读取你的 board 认领状态(来源不可读)。`);
  else if (f.grantedItems.length > 0) parts.push(`你有 ${f.grantedItems.length} 件已准入(granted)的在途工作:${f.grantedItems.join(", ")}。`);
  else parts.push(`未发现你名下已准入的在途 board 工作。`);
  if (f.liveAttempts === null) parts.push(`无法读取在途 attempt(来源不可读)。`);
  else if (f.liveAttempts.length > 0) parts.push(`control-log 在途 attempt:${f.liveAttempts.join(", ")}。`);
  if (f.unreadInbox === null) parts.push(`无法读取收件箱。`);
  else if (f.unreadInbox > 0) parts.push(`收件箱有 ${f.unreadInbox} 件未认领。`);
  parts.push(`请核对并继续你倒下前已接受的工作;本条只重指既有工作,未派新活。`);
  return parts.join(" ");
}

/** Should a breakpoint be injected for this member (Q3 default ON)? Only for a CONFIRMED member and only when the feature is on. */
export function shouldInjectBreakpoint(memberVerdictV: OpsVerdict, breakpointsEnabled: boolean): boolean {
  return breakpointsEnabled && memberVerdictV === "confirmed";
}

/** Filter the board file NAMES to the items this member has GRANTED (accepted work) using the canonical parser result (FR-10). The
 *  caller supplies the parse fn (task-board.parseBoardItemName) so this stays pure + the full-SID `who` is honored. Pure. */
export function grantedItemsForMember(
  memberSid: string,
  boardFileNames: readonly string[],
  parse: (name: string) => { itemId: string; state: string; who: string } | null,
): string[] {
  const out: string[] = [];
  for (const name of boardFileNames) {
    const p = parse(name);
    if (p && p.state === "granted" && p.who === memberSid) out.push(p.itemId);
  }
  return out;
}

// ============================================================================================================
// FR-8 — recovery obligations + orchestration (dep-injected so the real recover is testable, FR-11)
// ============================================================================================================

export type DeliveryStatus = "published" | "already" | "failed" | "skipped";
/** FR-8 (r4): a launch attempt's outcome — three states, never conflated. "unknown" (e.g. a timeout) is NOT "failed" (never auto-retried). */
export type LaunchOutcome = "launched" | "failed" | "unknown";

/** FR-8 (r5): classify a launcher error into a LaunchOutcome. ONLY an EXPLICIT not-started error — the launcher binary could not be
 *  spawned (ENOENT/EACCES) — is a retryable "failed". A timeout, OR any other post-dispatch error, is indeterminate ⇒ "unknown" (the
 *  window may have opened; never a blind auto-retry). "sent-but-indeterminate" must never be classed as "definitely not started". Pure. */
export function classifyLaunchError(err: { code?: string; killed?: boolean; message?: string }): LaunchOutcome {
  if (err.code === "ETIMEDOUT" || err.killed === true || /time(d)?\s*out/i.test(err.message ?? "")) return "unknown";
  if (err.code === "ENOENT" || err.code === "EACCES") return "failed"; // the launcher itself could not be spawned ⇒ definitely never dispatched
  return "unknown";
}

/** The result of one member's recovery leg. `resolution` is the FR-5 binding; `verdict` the F53 spawn verdict; `breakpoint` the
 *  FR-8 delivery outcome (an unresolved member is never delivered to). */
export interface MemberRecoveryResult {
  member: string;
  title?: string;
  resolution: MemberResolution["kind"];
  sid?: string;
  verdict: OpsVerdict;
  breakpoint: DeliveryStatus;
}

/** The whole recovery outcome. `outstanding` lists steps NOT confirmed-done (FR-8) — a non-empty list ⇒ a non-zero exit + a durable
 *  record, never masked by "0/0 confirmed". `reportDelivery` is the coordinator-report outcome (also an obligation). */
export interface RecoveryResult {
  episodeId: string;
  dispatcher: { relaunched: boolean; verdict: OpsVerdict; wakeStatus: "off" | "on" | "on(inert:no-herdr)" | null };
  members: MemberRecoveryResult[];
  reportDelivery: DeliveryStatus;
  outstanding: string[];
  notConfirmed: number;
}

/** True iff a delivery outcome discharges the obligation (FR-8: a pending/deferred/unknown/failed inbox write is NOT delivered). */
export function deliveryDischarged(s: DeliveryStatus): boolean {
  return s === "published" || s === "already";
}

/** Fold the per-step results into the outstanding list + notConfirmed count (FR-8). Pure. */
export function summarizeOutstanding(r: Omit<RecoveryResult, "outstanding" | "notConfirmed">): { outstanding: string[]; notConfirmed: number } {
  const outstanding: string[] = [];
  if (r.dispatcher.verdict !== "confirmed") outstanding.push(`dispatcher:${r.dispatcher.verdict}${r.dispatcher.wakeStatus && r.dispatcher.wakeStatus !== "on" ? `(wake:${r.dispatcher.wakeStatus})` : ""}`);
  let notConfirmed = r.dispatcher.verdict !== "confirmed" ? 1 : 0;
  for (const m of r.members) {
    if (m.verdict !== "confirmed") { outstanding.push(`member:${m.title ?? m.member}:${m.verdict}`); notConfirmed += 1; }
    else if (m.breakpoint !== "skipped" && !deliveryDischarged(m.breakpoint)) outstanding.push(`breakpoint:${m.title ?? m.member}:${m.breakpoint}`);
  }
  if (!deliveryDischarged(r.reportDelivery) && r.reportDelivery !== "skipped") outstanding.push(`coordinator-report:${r.reportDelivery}`);
  return { outstanding, notConfirmed };
}

// ============================================================================================================
// FR-11 — orchestrateRecover: the real recovery flow as a DEP-INJECTED function, so the actual orchestration (episode identity,
// launch ownership, verification, breakpoint/report obligations) runs under test with fakes for launch/peers/inbox/clock.
// ============================================================================================================

/** Every IO/launch seam the orchestration needs, injected (the shell wires real; the selftest wires fakes). */
export interface RecoverDeps {
  now: () => number;
  mintEpisodeId: () => string;
  heartbeatThresholdSec: number;
  breakpointsEnabled: boolean;
  recoveredAtIso: string;
  readEpisode: () => EpisodeRead;                    // FR-7: three-state (present/absent/unreadable)
  writeEpisode: (ep: RecoveryEpisode) => boolean;    // FR-8: returns success — a failed marker write is NEVER swallowed
  dispatcherLive: () => boolean;
  /** Relaunch the dispatcher; MUST be fail-soft (its own async spawn 'error' handled by the shell, FR-8). Return false on a sync fault. */
  relaunchDispatcher: (recipe: DispatcherRecipe) => boolean;
  /** Durable dispatcher liveness AFTER settle — the TARGET's own wake status (FR-3), never the caller's env. */
  verifyDispatcher: () => DispatcherLiveness;
  peers: () => readonly PeerLikeMin[];
  settle: () => Promise<void>;
  /** FR-8 launch ownership (two-phase): true ⇒ LAUNCH now (no prior claim, or a prior claim that explicitly FAILED ⇒ safe retry);
   *  false ⇒ SKIP (a claim is pending/launched this episode — never double-launch over an unconfirmed outcome). */
  claimLaunch: (memberKey: string, episodeId: string) => boolean;
  /** FR-8 (r4): THREE outcomes — "launched" (confirmed started), "failed" (an EXPLICIT not-started, e.g. command-not-found ⇒ safe to
   *  retry), "unknown" (sent but result indeterminate, e.g. a launch timeout that may have started ⇒ never auto-retry = no double). */
  launchMember: (member: RosterMemberLike) => Promise<{ outcome: LaunchOutcome; error?: string }>;
  /** FR-8 (r6/r7): durably record the "launch sink entered" state (claim ⇒ `launching:<ts>`) BEFORE launchMember's side effect — so a
   *  crash between a SUCCESSFUL launch and markLaunchOutcome leaves `launching:` (NEVER auto-retried), not a retryable `pending:`. Returns
   *  true IFF the write durably succeeded; the orchestrator MUST NOT launch on false (a failed mark leaves `pending:`, so launching anyway
   *  would re-create the crash-window double). A crash BEFORE this call also leaves `pending:` (the genuine retryable pre-launch crash). */
  markLaunching: (memberKey: string, episodeId: string) => boolean;
  /** FR-8: record the launch outcome — "launched"/"failed"/"unknown" drive the claim state (launched & unknown both block a blind
   *  re-launch; only "failed" is retryable). */
  markLaunchOutcome: (memberKey: string, episodeId: string, outcome: LaunchOutcome) => void;
  breakpointFacts: (sid: string) => MemberBreakpointFacts;
  /** Deliver the breakpoint; the shell builds the durable idempotency key from (episodeId, sid). */
  deliverBreakpoint: (sid: string, text: string, episodeId: string) => DeliveryStatus;
  /** Deliver the coordinator report with the REAL result (FR-8: never a zeroed placeholder). "skipped" when no coordinator. */
  deliverReport: (result: RecoveryResult, episodeId: string) => DeliveryStatus;
  /** FR-8: persist the durable receipt; its success is part of the completion criteria (a refused write ⇒ not completed, exit≠0). */
  writeReceipt: (result: RecoveryResult) => boolean;
}

/**
 * Run the recovery orchestration (FR-5/6/7/8). The caller (shell) has ALREADY validated the fleet-snapshot AND the roster are
 * present+parseable (FR-4 refuse-on-absent happens before this). Steps: resolve the episode id (retry-reuse vs new) → relaunch the
 * dispatcher if needed → launch each ABSENT member under a per-episode ownership claim (never double-launch) → settle → verify each
 * member against the UNIQUE live SID (ambiguous/absent ⇒ unknown, never a false confirm) → inject a breakpoint to each CONFIRMED
 * member → deliver the coordinator report → fold outstanding obligations → mark the episode completed ONLY when nothing is
 * outstanding (so a re-run of an interrupted recovery retries the rest). Pure given its deps.
 */
export async function orchestrateRecover(snap: FleetSnapshot, roster: readonly RosterMemberLike[], deps: RecoverDeps): Promise<RecoveryResult> {
  const nowSec = deps.now();
  const emptyDisp = { relaunched: false, verdict: "unknown" as OpsVerdict, wakeStatus: null };

  // FR-7: episode identity (three-state). unreadable ⇒ ABORT (never re-mint over an outstanding recovery). The caller's single-flight
  // lock (FR-6) serializes recover, so this read-then-write is race-free.
  const read = deps.readEpisode();
  const decision = resolveEpisode(read, deps.mintEpisodeId);
  if (decision.action === "abort") return { episodeId: "", dispatcher: emptyDisp, members: [], reportDelivery: "skipped", outstanding: [`episode:${decision.reason}`], notConfirmed: 1 };
  const episodeId = decision.episodeId;
  const startedAtSec = decision.action === "reuse" && read.kind === "present" ? read.ep.startedAtSec : nowSec;
  // FR-8: a failed episode-marker write is NOT swallowed — without the marker the claim namespace cannot be established, so abort.
  if (!deps.writeEpisode({ episodeId, startedAtSec, snapshotCapturedAtSec: snap.capturedAtSec, completed: false })) {
    return { episodeId, dispatcher: emptyDisp, members: [], reportDelivery: "skipped", outstanding: ["episode-marker:unwritten"], notConfirmed: 1 };
  }

  // 1) dispatcher first (fail-soft; the verdict below reflects whether it actually came up)
  let relaunched = false;
  if (dispatcherNeedsRelaunch(snap, deps.dispatcherLive()) && snap.dispatcher) relaunched = deps.relaunchDispatcher(snap.dispatcher);

  // 2) members: launch each ABSENT one under the FR-8 two-phase claim (claim pending → launch → record outcome). claimLaunch returns
  //    false for a pending/launched claim (crash-before-outcome / launched-not-yet-visible) ⇒ NEVER a blind double-launch.
  const peersBefore = deps.peers();
  for (const m of roster) {
    if (resolveMemberSid(m, peersBefore).kind !== "absent") continue;
    // FR-8 (r7): only cross into the launch side effect once the durable "launching:" marker is CONFIRMED written. If markLaunching
    // fails (e.g. EACCES), DO NOT launch — the claim stays "pending:" (no launch happened ⇒ a later recover retries safely); the member
    // is left unconfirmed ⇒ reported outstanding. Launching on a failed mark would re-open the crash-window double (the r6 gap).
    if (deps.claimLaunch(m.member, episodeId) && deps.markLaunching(m.member, episodeId)) {
      const r = await deps.launchMember(m); deps.markLaunchOutcome(m.member, episodeId, r.outcome);
    }
  }

  // 3) settle, then VERIFY against the unique live SID (FR-5) + the TARGET-only dispatcher wake (FR-3)
  await deps.settle();
  const liveness = deps.verifyDispatcher();
  const dispV = dispatcherVerdict(liveness, deps.heartbeatThresholdSec);
  const peersAfter = deps.peers();
  const members: MemberRecoveryResult[] = roster.map((m) => {
    const res = resolveMemberSid(m, peersAfter);
    const verdict: OpsVerdict = res.kind === "resolved" ? memberVerdict(true, false, false) : memberVerdict(false, false, false); // ambiguous/absent ⇒ unknown
    let breakpoint: DeliveryStatus = "skipped";
    if (res.kind === "resolved" && shouldInjectBreakpoint(verdict, deps.breakpointsEnabled)) {
      breakpoint = deps.deliverBreakpoint(res.sid, buildBreakpointText(deps.breakpointFacts(res.sid), deps.recoveredAtIso), episodeId);
    }
    return { member: m.member, ...(m.title ? { title: m.title } : {}), resolution: res.kind, ...(res.kind === "resolved" ? { sid: res.sid } : {}), verdict, breakpoint };
  });

  // 4) FR-8 账随实走: compute the REAL outstanding/notConfirmed FIRST, deliver the report WITH that real result (never a zeroed
  //    placeholder), then re-fold including the report's own delivery status.
  const base: RecoveryResult = { episodeId, dispatcher: { relaunched, verdict: dispV, wakeStatus: liveness.wakeStatus }, members, reportDelivery: "skipped", outstanding: [], notConfirmed: 0 };
  const pre = summarizeOutstanding(base);
  const real: RecoveryResult = { ...base, outstanding: pre.outstanding, notConfirmed: pre.notConfirmed };
  const reportDelivery = deps.deliverReport(real, episodeId); // REAL result in hand
  const withReport: RecoveryResult = { ...real, reportDelivery };
  const folded = summarizeOutstanding(withReport);
  let result: RecoveryResult = { ...withReport, outstanding: folded.outstanding, notConfirmed: folded.notConfirmed };

  // 5) FR-8 (r7): the RECEIPT is written FIRST, so the episode's completed marker (step 6) can gate on its result. A completed marker
  //    therefore NEVER exists while the receipt is unsettled — closing the r6 windows where a crash BETWEEN the completed marker and the
  //    receipt, or a failed compensation, left a completed episode with an unwritten receipt (⇒ a re-run minted a new episode + dup
  //    breakpoints). The receipt reflects the recovery obligations known now (members/report); a refused write is itself outstanding.
  const receiptWritten = deps.writeReceipt(result);
  if (!receiptWritten) result = { ...result, outstanding: [...result.outstanding, "receipt:unwritten"] };

  // 6) FR-8 (r7): mark the episode COMPLETE only when NOTHING is outstanding — now INCLUDING the receipt result. So completed=true ⟺ the
  //    receipt durably succeeded (+ members/report/report-delivery all clean). A receipt failure ⇒ outstanding ⇒ completed=false ⇒ a
  //    re-run REUSES this episode (same breakpoint idempotency domain, no dup). The final marker write's result is NOT ignored: a refused
  //    write (CP-3) is itself outstanding (exit≠0) and leaves the marker incomplete, so a re-run finishes it. No compensation window.
  if (!deps.writeEpisode({ episodeId, startedAtSec, snapshotCapturedAtSec: snap.capturedAtSec, completed: result.outstanding.length === 0 })) {
    result = { ...result, outstanding: [...result.outstanding, "episode-final:unwritten"] };
  }
  return result;
}
