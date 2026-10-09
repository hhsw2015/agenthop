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
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

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

/** F45-P1-2: the ENVIRONMENT of a live pid (whitespace-joined KEY=VALUE), via `ps eww`, or null if unavailable. Used to
 *  CORRELATE a presence pid to a session's current instance by the identity the launcher passes in the env
 *  (AGENTHOP_PID_FILE / CLAUDE_CODE_SESSION_ID) — a bare signal-0 "alive" can be a recycled, unrelated pid, and the
 *  daemon's ARGV carries no sid. Rare path (only a same-machine relay peer), so a synchronous `ps` is acceptable; any
 *  failure ⇒ null (keep relay). `ps eww` prints the command followed by the environment for OUR own processes. */
export function readPidEnv(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 4000 }).trim() || null; }
  catch { return null; }
}
