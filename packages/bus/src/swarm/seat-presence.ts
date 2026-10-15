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

function hasResume(argv: string[], sid: string): boolean {
  return argv.some((a, i) => a === `--resume=${sid}` || (a === "--resume" && argv[i + 1] === sid));
}

/** The agent pid under a block's `tern acp` root, or null when not exactly one candidate. The tree comes from `rows`; every
 *  candidate is then identified from its EXACT argv and executable (`exact`): claude ⇒ the executable's argv[0] basename is
 *  "claude" (the native build runs as a versioned file but keeps argv[0] = "claude") AND `stream-json` and `--resume=<sid>` /
 *  `--resume <sid>` are whole, separate elements; codex ⇒ a direct child whose executable basename is "node" and whose argv[1] is
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
      return path.basename(x.argv[0] ?? "") === "claude" && x.argv.includes("stream-json") && hasResume(x.argv, sid);
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
