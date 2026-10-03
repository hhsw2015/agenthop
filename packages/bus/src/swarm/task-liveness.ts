/**
 * Thin file-based member liveness (team-collab §0b R2 §4) — the FIRST code-ification of F17's two-evidence rule. isAlive
 * needs TWO evidence faces, never one:
 *   face 1 (process):     ~/.agenthop/presence/<sessionId>.pid + `kill -0` (the FILE existing is not proof — F17: it can
 *                         be a corpse; the process must actually answer signal 0).
 *   face 2 (self-report): the newest ~/.agenthop/status/<sessionId>.json.<seq> (seq = a ms timestamp suffix) — its
 *                         freshness + state.
 * Mapping (two-face consensus): pid-alive & fresh & state∈{working,idle} ⇒ alive; pid-alive & stale ⇒ suspected (process
 * up but no heartbeat = maybe stuck on a long action; a SINGLE tick never convicts); no pid / kill -0 fails ⇒ dead.
 *
 * TEMPORARY: bus-identity (the formal project) owns the real implementation + its two known defects, which live ONLY
 * here as comments so the sweep doesn't carry them:
 *   defect ① the key is the NATIVE session id, not the bus handle (F18 dual-ID). wait.owner is a handle, so resolveSession
 *     maps handle→sessionId by the handle's short-id tail (v1 peers-roster semantics); a real alias table is bus-identity.
 *   defect ② a session with a pid but that NEVER wrote a status file reads as suspected, not dead (today's roster unknowns).
 * All fs/proc access is injected (LivenessIO) so this is unit-tested with fixtures.
 */

export type Liveness = "alive" | "suspected" | "dead";

export type LivenessIO = {
  /** pid from ~/.agenthop/presence/<sessionId>.pid, or null if the file is missing/unparseable. */
  readPid: (sessionId: string) => number | null;
  /** `kill -0` — true iff that pid is a live process. */
  procAlive: (pid: number) => boolean;
  /** The newest status for a session: max-seq ~/.agenthop/status/<sessionId>.json.<seq>, or null if none. */
  latestStatus: (sessionId: string) => { state: string; seq: number } | null;
  nowMs: () => number;
};

export function fileIsAlive(sessionId: string, io: LivenessIO, staleMs: number): Liveness {
  const pid = io.readPid(sessionId);
  if (pid === null || !io.procAlive(pid)) return "dead"; // face 1 fails ⇒ no process ⇒ dead
  const st = io.latestStatus(sessionId);
  if (st === null) return "suspected"; // pid up but never self-reported (defect ②) — not convicted on one face
  const fresh = io.nowMs() - st.seq < staleMs;
  if (fresh && (st.state === "working" || st.state === "idle")) return "alive";
  return "suspected"; // stale heartbeat, or a non-active fresh state — maybe stuck; a single tick never convicts
}

/** Map a bus handle (e.g. "claude:swarm-brain-io-20cab0a5") to a native sessionId among the known ids, by the handle's
 *  short-id tail (v1 peers-roster semantics — a real alias table is bus-identity's job). null = no match (⇒ treated dead).
 *  The tail after the last '-' is the short id; match a sessionId that starts with it. */
export function resolveSession(ownerHandle: string, sessionIds: string[]): string | null {
  const tail = ownerHandle.slice(ownerHandle.lastIndexOf("-") + 1).trim();
  if (!tail) return null;
  return sessionIds.find((id) => id === tail || id.startsWith(tail)) ?? null;
}

// --- real-fs binding (the TEMPORARY v1; bus-identity replaces it). Thin; the testable decisions are above. -------------
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Native sessionIds that have a presence pid file under <home>/.agenthop/presence/<id>.pid (for resolveSession). */
export function listSessions(home: string): string[] {
  try { return readdirSync(path.join(home, ".agenthop", "presence")).filter((f) => f.endsWith(".pid")).map((f) => f.slice(0, -4)); }
  catch { return []; }
}

/** LivenessIO backed by the real filesystem + process signals (two-evidence: presence pid + status files). */
export function makeFileLiveness(home: string): LivenessIO {
  const base = path.join(home, ".agenthop");
  return {
    readPid: (sessionId) => {
      try { const n = Number(readFileSync(path.join(base, "presence", `${sessionId}.pid`), "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; }
      catch { return null; }
    },
    procAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, // signal 0 = existence check
    latestStatus: (sessionId) => {
      try {
        const dir = path.join(base, "status");
        const mine = readdirSync(dir).filter((f) => f.startsWith(`${sessionId}.json.`));
        if (mine.length === 0) return null;
        const newest = mine.map((f) => ({ f, seq: Number(f.slice(f.lastIndexOf(".") + 1)) })).filter((x) => Number.isFinite(x.seq)).sort((a, b) => b.seq - a.seq)[0];
        if (!newest) return null;
        const j = JSON.parse(readFileSync(path.join(dir, newest.f), "utf8")) as { state?: unknown };
        return { state: typeof j.state === "string" ? j.state : "unknown", seq: newest.seq };
      } catch { return null; }
    },
    nowMs: () => Date.now(),
  };
}
