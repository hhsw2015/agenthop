import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isValidSessionId } from "../send-fallback.js";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";

/**
 * #1053 presence for ACP seats. A Tern ACP seat (`tern acp claude|codex --resume <sid>`) never runs Claude Code's SessionStart hook
 * and Codex never writes one, so nothing writes ~/.agenthop/presence/<sid>.pid for it — F40 addressing then reads the seat as
 * bus-invisible and the inbox sentinel reports STALL. The seat's LAUNCHER writes it instead: tern-restore after a seat comes up, and
 * agenthop_tern after a start. ONE implementation shared by both (tern-restore shells out to scripts/seat-presence.ts).
 *
 *   resolveAgentPid  walks DOWN from the block's `tern acp` process (tern process <block> --json .child.pid) to the agent process:
 *                    claude ⇒ the unique descendant whose argv has `stream-json` AND a whole argument `--resume=<sid>` or the pair
 *                    `--resume <sid>` (live: tern acp → node adapter → claude …--resume=<sid>; argv[0] may be a versioned native
 *                    path, so its basename is NOT the test); codex ⇒ the unique DIRECT node child whose argv names the
 *                    /@agentclientprotocol/codex-acp/ adapter. 0 or >1 matches ⇒ null, never a guess.
 *   writePresence    the caller passes the RESOLVED agent pid (never an arbitrary live pid). It must be alive. An existing file
 *                    with the same live pid is kept; a different pid is replaced (a wrong pid routes by another seat's liveness);
 *                    an existing file that cannot be read is refused, never overwritten (FC-2). O_EXCL temp + rename.
 *
 * #1053 r2 TWO WRITERS (coordinator ruling): the SessionStart hook's presence daemon writes ITS pid (origin "bus"); this module
 * writes the AGENT pid (origin "agent"). Authority = agent. The origin lives in a SIDECAR presence/<sid>.origin
 * (`origin=agent|bus ts=<epoch ms>`), NOT a second line in the .pid: every existing reader parses the WHOLE .pid as one number
 * (task-liveness readPid, shell-succession readPidDetailed/pidFileIs, and the already-installed hook shell `kill -0 "$(cat …)"`),
 * so a second line would turn every live seat into "no pid". Rules: an agent write may replace a bus record; a bus write never
 * replaces a LIVE agent record (only fills an absent one or replaces a dead one) — busMayWrite.
 */

export type PsRow = { pid: number; ppid: number; argv: string[] };
/** EXACT argument vector of a process (element boundaries as the kernel holds them) plus its executable path; null = unreadable. */
export type ExactArgv = (pid: number) => { exe: string; argv: string[] } | null;
export type SeatTool = "claude" | "codex";

/** Parse `ps axo pid=,ppid=,command=` output. argv here is whitespace-split (ps does not quote), so it is used ONLY to build the
 *  process tree — never to identify the agent (SP-ARGV: one `node -e "… stream-json --resume=<sid>"` argument would split into
 *  fake flags). Identification uses ExactArgv. Pure. */
export function parsePs(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), argv: m[3]!.trim().split(/\s+/) });
  }
  return out;
}

/** The seat's own id on a claude argv, as whole elements: `--resume <sid>` / `--resume=<sid>` (a resumed seat) or `--session-id <sid>`
 *  / `--session-id=<sid>` (a FRESH seat: Tern's ACP adapter starts a new session with an explicit id — every seat rotated by the
 *  lifecycle runbook runs this way and has no --resume). Either is an exact, kernel-reported statement of which session the process
 *  is; nothing weaker (a substring, a ps text split) is accepted. */
function namesSession(argv: string[], sid: string): boolean {
  return argv.some((a, i) => a === `--resume=${sid}` || a === `--session-id=${sid}`
    || ((a === "--resume" || a === "--session-id") && argv[i + 1] === sid));
}

/** The agent pid under a block's `tern acp` root, or null when not exactly one candidate. The tree comes from `rows`; every
 *  candidate is then identified from its EXACT argv and executable (`exact`): claude ⇒ the executable's argv[0] basename is
 *  "claude" (the native build runs as a versioned file but keeps argv[0] = "claude") AND `stream-json` and the seat's id
 *  (`--resume` or, for a fresh seat, `--session-id`, either form) are whole, separate elements; codex ⇒ a direct child whose executable basename is "node" and whose argv[1] is
 *  a path inside /@agentclientprotocol/codex-acp/. An unreadable exact argv is UNKNOWN: it never matches, and if it might have been
 *  the agent the answer is null (never a guess). */
export function resolveAgentPid(rootPid: number, sid: string, tool: SeatTool, rows: PsRow[], exact: ExactArgv): number | null {
  const kids = new Map<number, PsRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  let hits: PsRow[];
  if (tool === "claude") {
    const desc: PsRow[] = [];
    const seen = new Set<number>();
    const frontier = [rootPid];
    while (frontier.length > 0) {
      for (const c of kids.get(frontier.pop()!) ?? []) {
        if (!seen.has(c.pid)) { seen.add(c.pid); desc.push(c); frontier.push(c.pid); }
      }
    }
    let unknown = false;
    hits = desc.filter((r) => {
      if (!r.argv.join(" ").includes(sid)) return false; // cheap prefilter only; the decision is on the exact argv
      const x = exact(r.pid);
      if (x === null) { unknown = true; return false; }
      return path.basename(x.argv[0] ?? "") === "claude" && x.argv.includes("stream-json") && namesSession(x.argv, sid);
    });
    if (unknown) return null;
  } else {
    let unknown = false;
    hits = (kids.get(rootPid) ?? []).filter((r) => {
      if (!r.argv.join(" ").includes("/@agentclientprotocol/codex-acp/")) return false;
      const x = exact(r.pid);
      if (x === null) { unknown = true; return false; }
      return path.basename(x.exe) === "node" && (x.argv[1] ?? "").includes("/@agentclientprotocol/codex-acp/");
    });
    if (unknown) return null;
  }
  return hits.length === 1 ? hits[0]!.pid : null;
}

export type PresenceResult = { state: "wrote" | "kept" | "refused"; pid?: number; was?: number | null; reason?: string };

export function presenceFile(home: string, sid: string): string {
  if (!isValidSessionId(sid) || sid.includes("/") || sid === "." || sid === "..") throw new Error(`invalid sid: ${sid}`);
  return path.join(home, ".agenthop", "presence", `${sid}.pid`);
}

export type Origin = "agent" | "bus";
export function originFile(home: string, sid: string): string { return presenceFile(home, sid).replace(/\.pid$/, ".origin"); }

/** SP-ORIGIN-UNKNOWN: "absent" = no sidecar (a pre-r2 / legacy record — treated like bus); "unreadable" = a sidecar EXISTS but
 *  cannot be read or does not parse — UNKNOWN, so a bus writer HOLDS (never overwrites what might be an agent record). */
export function readOrigin(home: string, sid: string): Origin | "absent" | "unreadable" {
  let raw: string;
  try { raw = readFileSync(originFile(home, sid), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"; }
  const m = /^origin=(agent|bus) ts=\d+\s*$/.exec(raw);
  return m ? (m[1] as Origin) : "unreadable";
}

// SP-WRITER-RACE: every presence write / delete for a sid happens under ONE per-sid holder-lock (dead-pid reclaim only), with the
// .pid and .origin re-read UNDER the lock — so an agent publish can never land between a bus writer's check and its overwrite.
function presenceSite(home: string, sid: string): LockSite {
  const dir = path.dirname(presenceFile(home, sid));
  return { lockDir: path.join(dir, `${sid}.lockd`), intentDir: dir, intentPrefix: `${sid}.lockd.hold.` };
}
function withPresenceLock<T>(home: string, sid: string, busy: T, fn: () => T): T {
  const site = presenceSite(home, sid);
  try { mkdirSync(site.intentDir, { recursive: true, mode: 0o700 }); } catch { return busy; }
  const deadline = Date.now() + 2000;
  let token: string | null = null;
  while (!(token = acquireHolderLock(site))) {
    if (Date.now() >= deadline) return busy;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try { return fn(); } finally { try { releaseHolderLock(site, token); } catch { /* a dead holder is reclaimed */ } }
}

function atomicWrite(f: string, body: string): void {
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, body); closeSync(fd); renameSync(tmp, f); }
  catch (e) { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(tmp); } catch { /* own temp */ } throw e; }
}

/** May the BUS presence daemon (pid `self`) write presence/<sid>.pid? Only when there is no live AGENT record: the .pid is absent,
 *  its pid is dead, it is our own pid, or the sidecar positively says "bus" / is absent (legacy). An unreadable .pid or sidecar
 *  ⇒ false (FC-2 / SP-ORIGIN-UNKNOWN: never overwrite what we cannot read). Call it UNDER the presence lock. */
export function busMayWrite(home: string, sid: string, self: number, alive: (pid: number) => boolean): boolean {
  let raw: string;
  try { raw = readFileSync(presenceFile(home, sid), "utf8").trim(); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) return false;
  if (n === self || !alive(n)) return true;
  const o = readOrigin(home, sid);
  return o === "bus" || o === "absent";
}

/** The bus daemon's write (origin "bus"), honoring busMayWrite. Returns whether it wrote. Never throws. */
export function writeBusPresence(home: string, sid: string, self: number, alive: (pid: number) => boolean): boolean {
  try {
    return withPresenceLock(home, sid, false, () => {
      if (!busMayWrite(home, sid, self, alive)) return false;
      atomicWrite(originFile(home, sid), `origin=bus ts=${Date.now()}\n`); // origin first, then the pid (coordinator ruling)
      atomicWrite(presenceFile(home, sid), String(self));
      return true;
    });
  } catch { return false; }
}

/** SessionEnd (SP-SESSIONEND): under the per-sid lock, re-read .pid and .origin; ONLY when the origin is "bus" (strict full-line
 *  parse, the same readOrigin) or absent (legacy) and the pid parses, SIGTERM that pid and remove the .pid (and a bus sidecar).
 *  An agent record, an unreadable/malformed sidecar, a busy lock, or an unparseable pid ⇒ nothing killed, nothing removed.
 *  A kill that fails with anything but ESRCH ⇒ "kill-failed", both files kept. `kill` is injected (tests). Returns what it did. */
export function endBusPresence(home: string, sid: string, kill: (pid: number) => void): "killed" | "held" | "absent" | "kill-failed" {
  try { presenceFile(home, sid); } catch { return "held"; }
  return withPresenceLock(home, sid, "held" as const, () => {
    let raw: string;
    try { raw = readFileSync(presenceFile(home, sid), "utf8").trim(); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? ("absent" as const) : ("held" as const); }
    const o = readOrigin(home, sid);
    if (o !== "bus" && o !== "absent") return "held" as const;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) return "held" as const;
    // only ESRCH proves the process is gone; EPERM / anything else ⇒ it may still run: keep both files (the obligation) and say so
    try { kill(n); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return "kill-failed" as const; }
    try { unlinkSync(presenceFile(home, sid)); } catch { /* gone */ }
    if (o === "bus") { try { unlinkSync(originFile(home, sid)); } catch { /* gone */ } }
    return "killed" as const;
  });
}

/** Remove presence/<sid>.pid (and its sidecar) at shutdown — under the lock, and ONLY if it still records `self` AND the sidecar
 *  says bus (or is absent: a legacy record the daemon wrote). An agent record, or an unreadable sidecar, is never deleted. */
export function removeOwnPresence(home: string, sid: string, self: number): void {
  try {
    withPresenceLock(home, sid, undefined, () => {
      try {
        if (readFileSync(presenceFile(home, sid), "utf8").trim() !== String(self)) return;
        const o = readOrigin(home, sid);
        if (o !== "bus" && o !== "absent") return;
        unlinkSync(presenceFile(home, sid));
        if (o === "bus") { try { unlinkSync(originFile(home, sid)); } catch { /* already gone */ } }
      } catch { /* absent / unreadable: nothing of ours to remove */ }
    });
  } catch { /* best effort */ }
}

export function writePresence(home: string, sid: string, pid: number, alive: (pid: number) => boolean): PresenceResult {
  try { presenceFile(home, sid); } catch (e) { return { state: "refused", reason: (e as Error).message }; }
  return withPresenceLock(home, sid, { state: "refused", reason: "presence lock busy" } as PresenceResult, () => writePresenceLocked(home, sid, pid, alive));
}
function writePresenceLocked(home: string, sid: string, pid: number, alive: (pid: number) => boolean): PresenceResult {
  let f: string;
  try { f = presenceFile(home, sid); } catch (e) { return { state: "refused", reason: (e as Error).message }; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "refused", reason: `invalid pid: ${pid}` };
  if (!alive(pid)) return { state: "refused", reason: `pid ${pid} is not alive` };
  let was: number | null = null;
  try {
    const raw = readFileSync(f, "utf8").trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) return { state: "refused", reason: `existing ${path.basename(f)} is not a pid; not overwriting` };
    was = n;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { state: "refused", reason: `existing ${path.basename(f)} unreadable (${(e as Error).message}); not overwriting` };
  }
  if (was === pid && readOrigin(home, sid) === "agent") return { state: "kept", pid, was };
  try {
    // origin FIRST: a bus daemon that reads between the two writes sees "agent" and leaves the record alone
    atomicWrite(originFile(home, sid), `origin=agent ts=${Date.now()}\n`);
    if (was !== pid) atomicWrite(f, String(pid));
  } catch (e) { return { state: "refused", reason: `write failed: ${(e as Error).message}` }; }
  return { state: was === pid ? "kept" : "wrote", pid, was };
}

/** Exact argv from the kernel: Linux /proc/<pid>/cmdline (NUL-separated) + /proc/<pid>/exe; macOS sysctl KERN_PROCARGS2 via a
 *  fixed python3 -I helper (node has no binding for it). Any failure ⇒ null. */
export function realExactArgv(run: (bin: string, args: string[]) => string | null = defaultRunSync): ExactArgv {
  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (process.platform === "linux") {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((x, i, a) => !(i === a.length - 1 && x === ""));
        const exe = readlinkSync(`/proc/${pid}/exe`);
        return argv.length > 0 ? { exe, argv } : null;
      } catch { return null; }
    }
    const out = run("python3", ["-I", "-c", PROCARGS_PY, String(pid)]);
    if (out === null) return null;
    try {
      const j = JSON.parse(out) as { exe?: unknown; argv?: unknown };
      return typeof j.exe === "string" && Array.isArray(j.argv) && j.argv.every((x) => typeof x === "string") ? { exe: j.exe, argv: j.argv as string[] } : null;
    } catch { return null; }
  };
}
const PROCARGS_PY = [
  "import ctypes,struct,sys,json",
  "l=ctypes.CDLL(None);p=int(sys.argv[1]);m=(ctypes.c_int*3)(1,49,p);n=ctypes.c_size_t(0)",
  "assert l.sysctl(m,3,None,ctypes.byref(n),None,0)==0",
  "b=ctypes.create_string_buffer(n.value);assert l.sysctl(m,3,b,ctypes.byref(n),None,0)==0",
  "r=b.raw[:n.value];c=struct.unpack_from('i',r,0)[0];e,_,t=r[4:].partition(b'\\0');t=t.lstrip(b'\\0');a=t.split(b'\\0')[:c]",
  "assert len(a)==c",
  "print(json.dumps({'exe':e.decode(),'argv':[x.decode() for x in a]}))",
].join("\n");
function defaultRunSync(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout : null;
}

/** `kill -0`: alive on success or EPERM. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Three-state resolver (bus.11 r4, PW-LOCATOR-UNKNOWN): the agent pid for `sid` under `rootPid`, or why there is none.
 *  "none" = every candidate's exact argv was READ and none is this seat; "unknown" = some candidate's argv could not be read (or
 *  the budget ran out before it was read) — it might have been the seat, so the caller must not treat this as absence; "ambiguous"
 *  = more than one process is this seat. Same identity rules as resolveAgentPid (which keeps its old null contract for its other
 *  callers). `exact` may return "over-budget" (treated as unknown). */
export type Resolved = { kind: "match"; pid: number } | { kind: "none" } | { kind: "unknown"; why: string } | { kind: "ambiguous" };
export function resolveAgentPid3(rootPid: number, sid: string, tool: SeatTool, rows: PsRow[],
  exact: (pid: number) => ReturnType<ExactArgv> | "over-budget"): Resolved {
  // PW-INVALID-ROOT: never search from pid 0 / negative / 1 (that is every process on the machine)
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return { kind: "unknown", why: `invalid root pid ${rootPid}` };
  const kids = new Map<number, PsRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  let cands: PsRow[];
  if (tool === "claude") {
    const desc: PsRow[] = []; const seen = new Set<number>(); const frontier = [rootPid];
    while (frontier.length > 0) for (const c of kids.get(frontier.pop()!) ?? []) if (!seen.has(c.pid)) { seen.add(c.pid); desc.push(c); frontier.push(c.pid); }
    cands = desc.filter((r) => r.argv.join(" ").includes(sid)); // cheap prefilter only; the decision is on the exact argv
  } else cands = (kids.get(rootPid) ?? []).filter((r) => r.argv.join(" ").includes("/@agentclientprotocol/codex-acp/"));
  const hits: number[] = [];
  for (const r of cands) {
    const x = exact(r.pid);
    if (x === "over-budget") return { kind: "unknown", why: `budget spent before pid ${r.pid}'s argv was read` };
    if (x === null) return { kind: "unknown", why: `argv of pid ${r.pid} unreadable` };
    const yes = tool === "claude"
      ? path.basename(x.argv[0] ?? "") === "claude" && x.argv.includes("stream-json") && namesSession(x.argv, sid)
      : path.basename(x.exe) === "node" && (x.argv[1] ?? "").includes("/@agentclientprotocol/codex-acp/");
    if (yes) hits.push(r.pid);
  }
  return hits.length === 0 ? { kind: "none" } : hits.length === 1 ? { kind: "match", pid: hits[0]! } : { kind: "ambiguous" };
}

/** realExactArgv under a shared deadline (PW-SV-SWEEP-BUDGET): each query is given what is left as its timeout and charged what it
 *  took; once the deadline has passed the query is not started ("over-budget"). `deadlineMs` is a performance.now()-style monotonic
 *  value; `now` is injectable for tests. */
export function budgetedExactArgv(deadlineMs: number, now: () => number,
  run: (bin: string, args: string[], timeoutMs: number) => string | null = (bin, args, t) => { const r = safeSpawnSync(bin, args, t); return r.status === 0 ? r.stdout : null; },
): (pid: number) => ReturnType<ExactArgv> | "over-budget" {
  return (pid) => {
    const left = deadlineMs - now();
    if (spawnTimeout(left) === null) return "over-budget"; // < 1ms left (or a fraction of one) ⇒ never start a query
    const res = realExactArgv((bin, args) => run(bin, args, left))(pid);
    return now() > deadlineMs ? "over-budget" : res; // finished past the deadline ⇒ not used
  };
}

/** A spawnSync timeout from a remaining budget (PW-FRACTIONAL-TIMEOUT): Node takes only a non-negative INTEGER, and 0 means "no
 *  timeout at all". Fractional performance.now() remainders are floored (conservative); anything below 1ms is refused (null) so an
 *  exhausted budget never becomes an unbounded call. Pure. */
export function spawnTimeout(leftMs: number): number | null {
  if (!Number.isFinite(leftMs)) return null;
  const t = Math.floor(leftMs);
  return t >= 1 ? t : null;
}
/** spawnSync that never throws and never runs unbounded: a refused budget or a thrown spawn ⇒ { refused | error }; at the deadline
 *  the child is SIGKILLed (not asked to stop), so the call returns within the budget even if the child ignores SIGTERM. */
export function safeSpawnSync(bin: string, args: string[], leftMs: number, extra: { env?: NodeJS.ProcessEnv } = {}):
  { status: number | null; stdout: string; timedOut: boolean; refused: boolean; error?: string } {
  const t = spawnTimeout(leftMs);
  if (t === null) return { status: null, stdout: "", timedOut: false, refused: true };
  try {
    // killSignal SIGKILL (PW-SV-SWEEP-BUDGET): the default SIGTERM can be ignored, and spawnSync then waits for the child to exit
    // on its own — a 300ms budget became 4s+ with a child that traps TERM. Every child here (tern ls/process/send, ps, the argv
    // helper) is a short read-only or one-shot call with no state to flush, so an immediate SIGKILL at the deadline is safe.
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: t, killSignal: "SIGKILL", ...(extra.env ? { env: extra.env } : {}) });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return { status: r.error ? null : r.status, stdout: r.stdout || "", timedOut, refused: false, ...(r.error && !timedOut ? { error: String(r.error.message) } : {}) };
  } catch (e) { return { status: null, stdout: "", timedOut: false, refused: false, error: e instanceof Error ? e.message : String(e) }; }
}
