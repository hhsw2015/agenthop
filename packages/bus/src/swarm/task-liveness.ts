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
