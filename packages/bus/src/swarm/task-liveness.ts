/**
 * Thin file-based member liveness (team-collab §0b R2) — the TEMP sweep-side consumer of member liveness; bus-identity's
 * whois owns the real implementation + the fine-grained "pid alive but truly hung" judgement (its liveness-probe face).
 *
 * TEMP RULING (fe0376cd, Codex review P1-4/P2-2): a member's STATUS file (working/idle/blocked) is EVENT-driven — written
 * on SessionStart/Tool/Stop/… — NOT a periodic heartbeat, and presence's keep-alive timer does not refresh it. So status
 * AGE is not a liveness signal: a healthy idle/working session can be silent for minutes. Liveness here uses ONLY the
 * presence pid + signal 0, and never convicts on a weak signal (F17):
 *   - no presence pid (file missing/unreadable)            ⇒ suspected (bus-not-visible / daemon absent ≠ the session died)
 *   - signal 0 ⇒ ESRCH (no such process)                   ⇒ dead      (the ONE strong death signal)
 *   - signal 0 ⇒ ok, or EPERM (exists, not ours to signal) ⇒ alive     (EPERM ≠ ESRCH — the process EXISTS)
 *   - signal 0 ⇒ any other errno                           ⇒ suspected (unknown — leave for investigation, never dead)
 * status is NOT read here at all (dropped with P2-4's buggy staging-file reader): working/idle load info, when needed,
 * comes from the bus-identity roster, not this file. A "suspected" owner is NOT reassigned (only a trustworthy "dead" is);
 * a to-expire wait under a suspected owner waits for the bus-identity suspected×binding check (future), not a false
 * conviction.
 *
 * bus-identity (the formal project) replaces all of this. Its two known seams live ONLY here as comments:
 *   defect ① the key is the NATIVE session id, not the bus handle (F18 dual-ID). resolveSession maps handle→sessionId by
 *     the handle's short-id tail; it demands a UNIQUE match and REJECTS ambiguity (F16 — never guess which session).
 *   defect ② real whois replaces this pid heuristic with an authoritative liveness probe.
 * All fs/proc access is injected (LivenessIO) so this is unit-tested with fixtures.
 */

export type Liveness = "alive" | "suspected" | "dead";

export type LivenessIO = {
  /** pid from ~/.agenthop/presence/<sessionId>.pid, or null if the file is missing/unreadable/unparseable. */
  readPid: (sessionId: string) => number | null;
  /** `kill -0` tri-state: "alive" (exists — ok or EPERM), "dead" (ESRCH only), "unknown" (any other errno; F17: don't convict). */
  procAlive: (pid: number) => "alive" | "dead" | "unknown";
};

export function fileIsAlive(sessionId: string, io: LivenessIO): Liveness {
  const pid = io.readPid(sessionId);
  if (pid === null) return "suspected"; // no presence pid ⇒ bus-not-visible, NOT convicted dead (P2-2/F17)
  const proc = io.procAlive(pid);
  if (proc === "dead") return "dead";       // ESRCH — the only strong death signal
  if (proc === "unknown") return "suspected";
  return "alive";                           // pid exists; status age is NOT a heartbeat, so it never downgrades (P1-4)
}

/** Map a bus handle (e.g. "claude:swarm-brain-io-20cab0a5") to a native sessionId. The tail after the last '-' is the
 *  short id; an EXACT id match wins; otherwise a UNIQUE prefix match; 0 or >1 ⇒ null — ambiguity is REJECTED, never
 *  guessed (F16: two different handles can share a short-id prefix; guessing misroutes the inbox). bus-identity's alias
 *  table replaces this. null ⇒ the caller treats the owner as unresolvable (suspected), not dead. */
export function resolveSession(ownerHandle: string, sessionIds: string[]): string | null {
  // B4 (review d8dd4b1): a FULL session id passed as the handle must match exactly FIRST. Otherwise the tail logic below
  // takes only the segment after its last "-" (a UUID's final group) and never finds the complete id — so a send addressed
  // by a full sid to an OFFLINE session (presence/<sid>.pid) failed to resolve. A handle (tool:dir-<short>) is never a
  // sessionId, so this exact check only helps the full-sid case and never shadows the handle/prefix logic.
  const whole = ownerHandle.trim();
  if (whole && sessionIds.includes(whole)) return whole;
  const tail = ownerHandle.slice(ownerHandle.lastIndexOf("-") + 1).trim();
  if (!tail) return null;
  const exact = sessionIds.find((id) => id === tail);
  if (exact) return exact; // an exact id match is unambiguous
  const prefix = sessionIds.filter((id) => id.startsWith(tail));
  return prefix.length === 1 ? prefix[0]! : null; // unique prefix only — 0 or >1 ⇒ reject (never guess, F16)
}

// --- real-fs binding (the TEMP v1; bus-identity replaces it). Thin; the testable decisions are above. -------------
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";

/** The presence daemon refreshes its pid-file mtime this often (presence.ts) — a liveness-classification aid for the
 *  sentinel; it is NOT used for durable-redirect OWNERSHIP (that is the liveness socket, F45-R1). */
export const PRESENCE_HEARTBEAT_SEC = 30;
/** connect timeout for the per-session liveness socket probe — short so a dead/unreachable sock never hangs a send. */
export const PRESENCE_PROBE_MS = 200;

/** Max bytes for a unix-domain socket PATH. The OS sun_path array is 104 (macOS) / 108 (Linux) INCLUDING the NUL terminator; a
 *  longer path is SILENTLY TRUNCATED by the kernel (not an error on macOS), which would make two distinct paths collide on one
 *  endpoint. We use the smaller platform bound and reject anything that would not fit — never let truncation form a false
 *  identity match (F45-R7-P1-2). */
export const MAX_SOCK_PATH_BYTES = 103; // 104 (macOS sun_path) - 1 for the NUL terminator

/** True iff `sockPath` fits in sun_path without truncation (so the kernel endpoint is EXACTLY this path, not a prefix). */
export function sockPathFits(sockPath: string): boolean { return Buffer.byteLength(sockPath) <= MAX_SOCK_PATH_BYTES; }

/** F45-R7-P1-2: a BOUNDED, STABLE, collision-free mapping sid -> socket-name prefix. sha256 truncated to 32 hex (128 bits): a
 *  crafted sid (`../bridge`) can no longer traverse (the name is hex), and two distinct LONG sids can no longer truncate to the
 *  same path (the prefix is fixed 32 chars). A targeted collision needs ~2^64 work (128-bit second-preimage) = infeasible. */
export function sidSockPrefix(sessionId: string): string { return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32); }

/** The directory holding per-session liveness sockets. */
function presenceDir(home: string): string { return path.join(home, ".agenthop", "presence"); }

/** A per-INSTANCE liveness socket path: `presence/<sidPrefix>.<nonce>.sock`. The nonce makes each daemon instance own a UNIQUE
 *  path, so close() (which unlinks its OWN path) can never delete another instance's endpoint (F45-R7-P2-1), and there is no
 *  shared path to reclaim. */
export function instanceSockPath(home: string, sessionId: string, nonce: string): string {
  return path.join(presenceDir(home), `${sidSockPrefix(sessionId)}.${nonce}.sock`);
}

/** F45-R1 (ruling B): probe a liveness socket (true ONLY on an accepted connection). A live instance LISTENS; death drops the
 *  listener, so a successful connect proves the CURRENT instance is alive — window-free. Stale/missing/hang/EACCES ⇒ false. A
 *  failed probe is NEVER used to authorize a delete anywhere (F45-R7-P2-1), so a transient false is harmless (worst case: a
 *  one-off relay fallback instead of durable). */
export function probeLivenessSock(sockPath: string, timeoutMs: number = PRESENCE_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect(sockPath);
    const finish = (ok: boolean): void => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    sock.once("connect", () => { clearTimeout(timer); finish(true); });
    sock.once("error", () => { clearTimeout(timer); finish(false); });
  });
}

/** Connect to a liveness socket and read the FULL sid it emits (openLivenessSocket writes the owning sid on accept, then closes).
 *  Returns the emitted sid, or null on error/timeout/empty. Used to back-VERIFY identity (coordinator r9 hint ①): the hashed
 *  filename is only a bounded, collision-free KEY — the connect then confirms the socket actually belongs to the probed sid, so
 *  even an (infeasible) 128-bit collision or a same-prefix leftover cannot answer for a sid it does not own. */
export function probeSocketSid(sockPath: string, timeoutMs: number = PRESENCE_PROBE_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false; let buf = "";
    const sock = net.connect(sockPath);
    const finish = (v: string | null): void => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    sock.setEncoding("utf8");
    sock.on("data", (d) => { buf += d; if (buf.length > 4096) finish(buf.slice(0, 4096)); }); // a sid is short; cap a rogue stream
    sock.once("end", () => { clearTimeout(timer); finish(buf.length ? buf : null); });
    sock.once("error", () => { clearTimeout(timer); finish(null); });
  });
}

/** F45-R7 (ruling B, rounds 7-9): is the SAME-MACHINE current instance of `sessionId` alive? The socket name is a bounded hash
 *  of the sid (no traversal, no truncation collision) + a per-instance nonce, so we LIST the presence dir for this sid's prefix
 *  and probe each candidate. A candidate is ALIVE only if the connect is accepted AND the socket EMITS the exact probed sid
 *  (coordinator r9 hint ①: the hashed filename is the key, the emitted sid is the back-verification — a collision/leftover that
 *  does not own this sid is rejected). A candidate whose path would not fit sun_path is skipped (never trust a truncatable path).
 *  A readdir fault ⇒ false (keep relay). No pid/mtime/start-time proof; stops at the first verified live match. */
export async function probeSessionAlive(home: string, sessionId: string, timeoutMs: number = PRESENCE_PROBE_MS): Promise<boolean> {
  const prefix = sidSockPrefix(sessionId);
  let files: string[];
  try { files = readdirSync(presenceDir(home)); } catch { return false; }
  for (const f of files) {
    if (!f.startsWith(`${prefix}.`) || !f.endsWith(".sock")) continue;
    const p = path.join(presenceDir(home), f);
    if (!sockPathFits(p)) continue; // a truncatable path could answer for a different sid — never trust it
    if (await probeSocketSid(p, timeoutMs) === sessionId) return true; // connect + the socket proves it owns THIS sid
  }
  return false;
}

/** F45-R7-P2-1: open THIS instance's liveness socket on a UNIQUE per-instance path (bounded hash prefix + random nonce). No
 *  shared path ⇒ no EADDRINUSE contention, no reclaim, and close() unlinks only OUR OWN path (never another instance's) — so an
 *  exiting instance can never delete a live instance's endpoint. Returns the server + its path, or null when the path would not
 *  fit sun_path (then the session is relay-only — never a truncated or colliding socket).
 *
 *  Deliberately NO orphan reclaim: a crashed prior instance leaves a stale socket file, but deleting it would require a probe,
 *  and a probe failure (a transient ECONNREFUSED from a backlog-full LIVE sibling, a timeout, an EACCES) must NEVER authorize a
 *  delete (F45-R7-P2-1) — there is no delete here at all. Orphans are harmless: probeSessionAlive connects to each candidate and
 *  a dead orphan simply fails the connect (skipped), so a leftover never reads as alive and is never removed by a false signal.
 *  ponytail: orphans from a session that repeatedly CRASHES accumulate slowly under its hash prefix; an age-based reaper can
 *  bound them later if it ever matters, but it must not be a probe-authorized unlink. */
export async function openLivenessSocket(home: string, sessionId: string, _timeoutMs: number = PRESENCE_PROBE_MS): Promise<{ server: net.Server; path: string } | null> {
  const nonce = randomBytes(4).toString("hex");
  const sockPath = instanceSockPath(home, sessionId, nonce);
  if (!sockPathFits(sockPath)) return null; // can't express this endpoint without truncation ⇒ relay-only
  // B7-1: ensure the presence dir exists before binding. A presence daemon with no pid file (the B7-1 scenario) has nothing else
  // that creates it, so without this listen() fails ENOENT ⇒ no liveness socket ⇒ the listener can never prove the identity alive.
  try { mkdirSync(presenceDir(home), { recursive: true }); } catch { /* a concurrent create / EEXIST is fine; a real failure surfaces at listen() */ }
  try {
    const server = await new Promise<net.Server>((resolve, reject) => {
      // On accept, EMIT the owning sid then close (coordinator r9 hint ①: lets a prober back-verify this socket owns the sid —
      // the hashed filename alone is just a key). F45-R9-P2-1: the CONNECTION's own async stream errors (a client that
      // disconnects before the reply ⇒ EPIPE/ECONNRESET on the write) are NOT delivered to the server's error listener, so
      // register a per-connection error handler FIRST — a single broken connection must end only itself, never the daemon.
      const srv = net.createServer((c) => { c.on("error", () => { /* broken client conn — end this conn only, never the daemon */ }); try { c.end(sessionId); } catch { try { c.destroy(); } catch { /* noop */ } } });
      srv.once("error", reject);
      srv.listen(sockPath, () => { srv.removeListener("error", reject); srv.on("error", () => { /* never crash on a socket error */ }); srv.unref?.(); resolve(srv); });
    });
    return { server, path: sockPath };
  } catch { return null; } // a fresh random path should not be in use; any bind failure ⇒ relay-only, not a reclaim
}

/** Native sessionIds that have a presence pid file under <home>/.agenthop/presence/<id>.pid (for resolveSession). */
export function listSessions(home: string): string[] {
  try { return readdirSync(path.join(home, ".agenthop", "presence")).filter((f) => f.endsWith(".pid")).map((f) => f.slice(0, -4)); }
  catch { return []; }
}

/** LivenessIO backed by the real filesystem + process signals (presence pid + signal 0; status is deliberately NOT read). */
export function makeFileLiveness(home: string): LivenessIO {
  const base = path.join(home, ".agenthop");
  return {
    readPid: (sessionId) => {
      try { const n = Number(readFileSync(path.join(base, "presence", `${sessionId}.pid`), "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; }
      catch { return null; }
    },
    procAlive: (pid) => {
      try { process.kill(pid, 0); return "alive"; } // signal 0 = existence check
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPERM") return "alive"; // process EXISTS, just not ours to signal (EPERM != ESRCH, P2-2)
        if (code === "ESRCH") return "dead";  // no such process — the only strong death signal
        return "unknown";                     // any other errno: do not convict (F17)
      }
    },
  };
}

/** F45-P1-2: the mtime (epoch seconds) of `presence/<sid>.pid`, or null if missing/unreadable. The presence daemon keeps
 *  this fresh (heartbeat every PRESENCE_HEARTBEAT_SEC); a mtime older than PRESENCE_FRESH_MAX_SEC ⇒ the daemon is gone, so
 *  the live pid in the file (if any) is a recycle, not the current instance. */
export function pidFileMtimeSec(home: string, sessionId: string): number | null {
  try { return Math.floor(statSync(path.join(home, ".agenthop", "presence", `${sessionId}.pid`)).mtimeMs / 1000); }
  catch { return null; }
}
