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

/** True if `cmd` is the dispatcher LOOP (not a one-shot --sweep-once / --observe-once invocation, which are short-lived). */
/** JS runtimes that can actually EXECUTE the dispatcher script (argv0, by basename). Anything else holding the path as an
 *  argument — an editor, `git`, `rg`, `cat` — is a mere file reference, never a running loop. */
const JS_RUNTIMES = new Set(["node", "nodejs", "tsx", "ts-node", "bun", "deno", "npx", "pnpm"]);
/** Flags that make the script path DATA, not an entry: `node -e '... swarm-dispatch.ts ...'` runs the eval string, not the file. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
const isScriptEntry = (tok: string): boolean => !tok.startsWith("-") && (tok === "swarm-dispatch.ts" || tok.endsWith("/swarm-dispatch.ts"));

/** True ONLY when `cmd` is a real, long-running execution of the dispatcher — a JS-runtime argv0, a bare `swarm-dispatch.ts`
 *  entry token (NOT inside an eval flag), and NOT a one-shot invocation. F44-P1-1: a mere mention of the path (an editor, a
 *  grep, a `node -e` whose eval string names the file) is NOT a running loop and must never block a legitimate startup. The
 *  one-shot check mirrors main()'s EXACT parse: `--sweep-once` / `--observe-once` disable the loop ONLY as argv[0] (the FIRST
 *  token after the script entry), so a NON-first `--sweep-once` still runs the loop. */
export function isDispatcherLoopCommand(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const argv0 = tokens[0]!;
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  if (!JS_RUNTIMES.has(base)) return false;               // not a JS runtime ⇒ a file reference, not an execution
  if (tokens.some((t) => EVAL_FLAGS.has(t))) return false; // eval-style ⇒ the path is data, not a script entry
  const entryIdx = tokens.findIndex((t, i) => i > 0 && isScriptEntry(t));
  if (entryIdx < 0) return false;                          // the dispatcher is not the thing being run
  const firstArg = tokens[entryIdx + 1];                   // argv[0] from main()'s perspective (process.argv.slice(2)[0])
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
