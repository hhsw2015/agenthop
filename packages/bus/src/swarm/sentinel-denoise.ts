/**
 * F44 — sentinel denoise. The F40/S14 sentinels are the last line against a silent stall, but they over-fire: re-pinging the
 * same box every tick, alerting on garbage inbox dirs, idle-timeouting a healthy member with no work, ghost-alerting a stray
 * presence, echoing the coordinator's own PROGRESS edits, and (the npm-wrapper gap) a second dispatcher tree slipping past the
 * single-flight lock. This module holds the PURE denoise decisions so each rule is unit-tested without a filesystem, a clock, or
 * a process table; the dispatcher wires them thin. Every alert is keyed by EVENT IDENTITY (box/member + kind), never message
 * text, so a self-induced count change can never bypass dedup (F44-①).
 */

/**
 * F44-① event-identity dedup with a cooldown. Keyed by a STABLE identity (box id / member+kind), NOT the message text, so the
 * same ongoing condition surfaces at most once per `cooldownMs`, then a bounded reminder. `shouldFire` is the CHECK;
 * `record` is called only AFTER a successful delivery, so a failed send never consumes the slot (the dispatcher's LS4 retry
 * discipline). Clock is injected ⇒ unit-tested with no real time. The map self-bounds: expired keys are dropped on each check.
 */
export class AlertDedup {
  private readonly last = new Map<string, number>();
  constructor(private readonly cooldownMs: number, private readonly now: () => number = () => Date.now()) {
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error(`AlertDedup: cooldownMs must be a non-negative finite number (got ${String(cooldownMs)})`);
  }
  /** True if this identity has NOT fired within the cooldown (caller may send). Drops expired keys (bounds the map). */
  shouldFire(key: string): boolean {
    const t = this.now();
    for (const [k, at] of this.last) if (t - at >= this.cooldownMs) this.last.delete(k);
    return (this.last.get(key) ?? -Infinity) <= t - this.cooldownMs;
  }
  /** Record a SUCCESSFUL fire (start the cooldown). Call only after the notice actually went out. */
  record(key: string): void { this.last.set(key, this.now()); }
}

/** Build the stable alert key: an event IDENTITY + its kind — never the rendered text (F44-①). */
export function alertKey(identity: string, kind: string): string { return `${identity}\u0000${kind}`; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * F44-② — is `name` a legit inbox-dir key? Every real box is a swarm stableId, which is a UUID (v4/v7 — the 8-4-4-4-12 hex
 * form; legacy/alias keys are prior identities, also UUIDs). A non-conforming dir is swarm bookkeeping or debris — `_archive`,
 * `quarantine`, a dotfile, the `sanitize()` fallback (`unknown` / leading `_`), or stray garbage — and the sentinel must NOT
 * scan or alert on it. Conservative by design: accepting only the stableId shape can at worst miss an (unknown, non-existent)
 * non-UUID box, never raise a false stall on a garbage dir.
 */
export function isValidInboxKey(name: string): boolean {
  return UUID_RE.test(name);
}

export type MemberHealthInput = {
  onRoster: boolean;    // a registered swarm member (resolvable identity, or owns live work) — not a stray bus presence
  hasInFlight: boolean; // owns a live (non-terminal) wait / assigned task right now
  idleSec: number;      // how long self-reported idle
  presenceSeen: boolean;
};
export type MemberHealth = "ok" | "disconnect-candidate" | "ghost-daemon";

/**
 * F44-③④ — classify a presence-only member's idleness. idle-timeout (disconnect-candidate) is for ROSTER members ONLY, and
 * ONLY when they hold in-flight work: a registered member idle with nothing assigned is HEALTHY (④, no alert — the board/ledger
 * shows it has nothing owed). A presence that is NOT on the roster is a stray "ghost daemon" (③) — a distinct, one-time alert
 * (the caller dedups it via AlertDedup / the member+kind key). Pure.
 */
export function classifyMemberHealth(m: MemberHealthInput, cfg: { idleTimeoutSec: number }): MemberHealth {
  if (!m.presenceSeen) return "ok";
  if (!(m.idleSec >= cfg.idleTimeoutSec)) return "ok"; // not idle long enough (also guards NaN)
  if (!m.onRoster) return "ghost-daemon";              // ③ stray presence, not a registered member
  return m.hasInFlight ? "disconnect-candidate" : "ok"; // ④ roster member: only an in-flight owner gone idle is a disconnect
}

/**
 * F44-⑨ — "on the roster" is the UNION of ALL roster sources, not just the identity log + in-flight owners. The
 * roster-snapshot (resume.ts ROSTER_FILE) is an equally authoritative member list: a session captured there (e.g. the
 * swarm-viz front end 3e097dfe) is a real member even with no in-flight wait and no identity-log entity yet. Omitting the
 * snapshot mislabels a registered member as a ghost daemon (the reported incident). Pure set-union. */
export function isOnRoster(sid: string, src: { activeOwners: ReadonlySet<string>; identityEntity: boolean; snapshotMembers: ReadonlySet<string> }): boolean {
  return src.activeOwners.has(sid) || src.identityEntity || src.snapshotMembers.has(sid);
}

/** F44-9: a roster-snapshot member may be a full presence SID or a short HANDLE (assembleRoster falls back to e.g.
 *  `Work-3e097dfe` when the stableId is absent). The ghost check compares against full presence SIDs, so each snapshot
 *  member must be RESOLVED to its current SID first (via the unique-identity rule — `resolve` = resolveSession bound to the
 *  live presence sids). An ambiguous/unknown handle resolves to null and is dropped (never guessed), so it simply does not
 *  grant roster membership. A full SID resolves to itself. Returns the set of resolved SIDs. Pure (resolve injected). */
export function resolveSnapshotMembers(members: readonly unknown[], resolve: (handle: string) => string | null): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(members)) return out;
  for (const m of members) {
    const handle = m && typeof m === "object" && typeof (m as { member?: unknown }).member === "string"
      ? (m as { member: string }).member
      : typeof m === "string" ? m : null;
    if (!handle) continue;
    const sid = resolve(handle);
    if (sid) out.add(sid);
  }
  return out;
}

export type BlockedRoute = "escalate" | "escalate-once";

/**
 * F44-⑧ — a `blocked` self-report from a presence-only session escalates to the coordinator as swarm work ONLY for a
 * ROSTER member. A non-roster presence (e.g. the user's PRIVATE session) is not swarm work and must not keep surfacing to
 * the coordinator — it is routed "escalate-once" (surfaced at most once per blocked episode, since it MIGHT be a member
 * whose identity has not resolved yet, then suppressed). The caller gates "escalate-once" with a one-time set. Pure. */
export function classifyBlockedEscalation(onRoster: boolean): BlockedRoute {
  return onRoster ? "escalate" : "escalate-once";
}

export type ProcInfo = { pid: number; ppid: number; command: string };

/** Parse `ps -axo pid=,ppid=,command=` output into {pid, ppid, command}. Pure; malformed lines are skipped. */
export function parsePsOutput(raw: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return out;
}

/** JS runtimes that actually EXECUTE a script (by basename). npx/pnpm are WRAPPERS that exec one of these. Anything else — an
 *  editor, git, rg, cat, or a Node-based TOOL (prettier/eslint) whose OWN entry is a different script — is not the loop, even
 *  when a swarm-dispatch.ts token appears as one of its arguments. */
const JS_RUNTIMES = new Set(["node", "nodejs", "tsx", "ts-node", "bun", "deno"]);
/** Node options that CONSUME the next token as their value (so it is never mistaken for the script entry). Equals forms
 *  (`--import=x`) are self-contained and handled separately. */
const VALUE_OPTS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]);
/** An eval option in ANY form (`-e` `--eval` `-p` `--print` `-c` + their `=value` forms): the runtime runs the eval STRING, not
 *  a script — a swarm-dispatch.ts token after it is data, never an entry. */
const EVAL_OPT_RE = /^(-e|--eval|-p|--print|-c)(=|$)/;
const baseName = (t: string): string => t.slice(t.lastIndexOf("/") + 1);
const isDispatchEntry = (t: string): boolean => !t.startsWith("-") && (t === "swarm-dispatch.ts" || t.endsWith("/swarm-dispatch.ts"));
/** A nested JS-runtime cli passed as the parent runtime's first positional (`node /x/tsx <script>`, `node .../tsx/dist/cli.mjs
 *  <script>`): the REAL entry is the token AFTER it. Recognized ONLY as the bare `tsx`/`ts-node` basename or an EXPLICIT cli
 *  entrypoint (`.../tsx/dist/cli.*`, `.../ts-node/dist/bin.*`) — NOT any file that merely sits under a `tsx/` directory
 *  (F44-P1-1: `.../tsx/analyzer.mjs` is an ordinary tool, not a runner). */
const isNestedRuntimeCli = (t: string): boolean => !t.startsWith("-") && !isDispatchEntry(t) && (["tsx", "ts-node"].includes(baseName(t)) || /\/(tsx|ts-node)\/dist\/(cli|bin)\.[cm]?js$/.test(t));

/**
 * F44-P1-1 — true ONLY when `cmd` is a real, long-running execution whose ENTRY is the dispatcher script. It PARSES the command
 * like a runtime CLI instead of string-searching: unwrap npx/pnpm wrappers; require a JS-runtime program (a Node TOOL whose own
 * entry is some other script, with swarm-dispatch.ts a mere business ARGUMENT, is NOT the loop); walk the runtime's options to
 * the first positional (an eval option in ANY form incl. `--eval=` BEFORE the entry ⇒ it runs the eval, not a script; a
 * value-taking option consumes its value); resolve a nested tsx/ts-node cli to the next positional; the entry itself MUST be
 * swarm-dispatch.ts. One-shot is then judged ONLY by the first token AFTER the entry (main's argv[0]), so an `-e`/`--eval`/
 * `--sweep-once` appearing LATER is the dispatcher's own application argument, not an interpreter flag.
 */
export function isDispatcherLoopCommand(cmd: string): boolean {
  const toks = cmd.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (i >= toks.length) return false;
  // Unwrap wrappers: `npx [flags (-p/--package take a value)] <prog> …` ; `pnpm [exec|dlx] [flags] <prog> …`.
  if (baseName(toks[i]!) === "npx") {
    i += 1;
    while (i < toks.length && toks[i]!.startsWith("-")) { const f = toks[i]!; i += 1; if ((f === "-p" || f === "--package") && i < toks.length && !toks[i]!.startsWith("-")) i += 1; }
  } else if (baseName(toks[i]!) === "pnpm") {
    i += 1;
    if (i < toks.length && (toks[i] === "exec" || toks[i] === "dlx")) i += 1;
    while (i < toks.length && toks[i]!.startsWith("-")) i += 1;
  }
  // The program must be a JS runtime — otherwise it is a tool/editor/other program whose entry is NOT the dispatcher.
  if (i >= toks.length || !JS_RUNTIMES.has(baseName(toks[i]!))) return false;
  i += 1;
  // Walk runtime options to the first positional (the entry). Returns false if an eval option is seen (not a script run).
  const skipOpts = (): boolean => {
    while (i < toks.length && toks[i]!.startsWith("-")) {
      const t = toks[i]!;
      if (EVAL_OPT_RE.test(t)) return false;        // eval in any form ⇒ runs the eval STRING, not a script entry
      if (t.includes("=")) { i += 1; continue; }     // self-contained flag (value attached) ⇒ consumes only itself
      if (VALUE_OPTS.has(t)) { i += 2; continue; }   // KNOWN value-taking option ⇒ skip it + its value
      return false;                                  // UNKNOWN space-form option: cannot tell if its value is the next token,
                                                     // so never guess that token is the entry (F44-P1-1: an unknown option must
                                                     // not ground a refusal) ⇒ not a confident dispatcher loop
    }
    return true;
  };
  if (!skipOpts()) return false;
  if (i >= toks.length) return false; // bare runtime, no entry
  // Resolve a nested tsx/ts-node cli (`node /x/tsx <script>`): the dispatcher entry is its first positional.
  if (isNestedRuntimeCli(toks[i]!)) { i += 1; if (!skipOpts()) return false; if (i >= toks.length) return false; }
  if (!isDispatchEntry(toks[i]!)) return false; // the thing actually being run is some OTHER script/tool
  const firstArg = toks[i + 1]; // main()'s process.argv.slice(2)[0]
  if (firstArg === "--sweep-once" || firstArg === "--observe-once") return false; // one-shot ⇒ not the loop
  return true;
}

/** Pure one-time-per-episode gate for ghost-daemon alerts: fire ONCE while a member is a ghost, re-fire only after it has
 *  LEFT the ghost state and later returns. NOT a cooldown (which would re-remind every window). Unit-tested here; the live
 *  sentinel inlines the same three operations because its review harness injects a fixed dep set without this class. */
export class GhostOnce {
  private readonly fired = new Set<string>();
  /** Forget any already-fired member that is no longer a ghost this tick, so a later re-ghost of the same member re-fires. */
  reconcile(currentGhosts: Iterable<string>): void {
    const cur = currentGhosts instanceof Set ? currentGhosts : new Set(currentGhosts);
    for (const m of [...this.fired]) if (!cur.has(m)) this.fired.delete(m);
  }
  /** True if this ghost member has not yet been alerted this episode (caller may fire). */
  shouldFire(member: string): boolean { return !this.fired.has(member); }
  /** Record a delivered ghost alert so it is not repeated until the member leaves and re-enters the ghost state. */
  record(member: string): void { this.fired.add(member); }
}

/** The pid set of THIS process's own tree (self + ancestor chain via ppid), so our own `npx`/`tsx`/`node` wrapper layers are
 *  never mistaken for a second dispatcher. Pure over the proc list; stops on a cycle or a missing parent. */
export function selfTree(procs: readonly ProcInfo[], selfPid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const set = new Set<number>([selfPid]);
  let cur = byPid.get(selfPid)?.ppid ?? 0;
  while (cur > 0 && byPid.has(cur) && !set.has(cur)) { set.add(cur); cur = byPid.get(cur)!.ppid; } // only LISTED ancestors (a dangling ppid like init is never a dispatcher loop)
  return set;
}

/**
 * F44-⑤ — is another dispatcher LOOP process tree already running? Defense-in-depth OVER the single-flight lock: the lock can
 * be free (a crash left it unreleased-then-expired, or a restarting `npx tsx scripts/swarm-dispatch.ts` wrapper still lives)
 * while a real loop is up. Excludes OUR OWN process tree (self + ancestors) so our own wrapper layers never false-positive.
 */
export function isDispatcherAlreadyRunning(procs: readonly ProcInfo[], selfPid: number): boolean {
  const mine = selfTree(procs, selfPid);
  return procs.some((p) => !mine.has(p.pid) && isDispatcherLoopCommand(p.command));
}

/**
 * F44-⑥ — should the board/PROGRESS watch emit a coordinator notice for this event? Board changes ALWAYS notify (a durable
 * board transition needs reconcile). The PROGRESS-mtime ping is self-noise now that the coordinator is PROGRESS's main writer —
 * echoing its own edits back as alerts — so it is OFF by default, opt-in via SWARM_WATCH_PROGRESS (for eras where members write
 * PROGRESS directly). Pure.
 */
export function shouldEmitWatchNotice(evKind: string, watchProgressEnv: string | undefined): boolean {
  if (evKind === "board") return true;
  return /^(1|true|yes|on)$/i.test(watchProgressEnv ?? "");
}
