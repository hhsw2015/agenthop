/**
 * Code-level startup check-in (bus-reachability §4). When a bus node comes up, it writes ONE {sid,handle,pid,startedAt}
 * line to the coordinator's durable inbox, so a (re)started session becomes discoverable WITHOUT relying on a prompt the
 * LLM must remember to send (the F30 "报到" rule, moved from discipline into code). The prompt clause stays as a backstop,
 * but its absence no longer blinds the coordinator.
 *
 * Best-effort + fail-soft: a missed check-in must NEVER fail startup. Gated on a coordinator handle (SWARM_COORDINATOR, only
 * set in the swarm context — so tests and ordinary sessions never write); never checks in to self; skips silently when the
 * coordinator has no resolvable same-machine presence file yet (it is found on a later node's startup / the next run).
 */
import { writeInbox } from "./inbox.js";
import { resolveSession, listSessions } from "./swarm/task-liveness.js";
import type { SelfInfo } from "./label.js";

export function reportCheckIn(home: string, self: SelfInfo, coordinatorHandle: string | undefined): boolean {
  try {
    if (!coordinatorHandle || !coordinatorHandle.trim()) return false; // not in a swarm context
    const coordSid = resolveSession(coordinatorHandle, listSessions(home));
    if (!coordSid) return false;           // coordinator not resolvable on this machine yet -> skip (not an error)
    const mySid = self.stableId ?? self.id;
    if (coordSid === mySid) return false;  // we ARE the coordinator -> don't check in to ourselves
    const line = JSON.stringify({ sid: mySid, handle: self.title, pid: self.pid, startedAt: self.startedAt });
    writeInbox(home, coordSid, {
      from: mySid, fromLabel: self.title, ...(self.mode ? { fromMode: self.mode } : {}),
      text: `[checkin] ${line}`, via: "local", ts: Date.now(),
    });
    return true;
  } catch { return false; } // best-effort; a check-in must never throw on startup
}
