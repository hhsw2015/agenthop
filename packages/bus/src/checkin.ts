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
import { writeInbox, type InboxMsg } from "./inbox.js";
import { resolveSession, listSessions } from "./swarm/task-liveness.js";
import type { SelfInfo } from "./label.js";

/** The outcome of a check-in attempt, so the caller knows whether to RETAIN a retry obligation (review 01b773d-B5):
 *  "sent" = delivered to the coordinator inbox; "retry" = a TRANSIENT miss (coordinator not resolvable YET, or the write
 *  failed) — retain and retry when it becomes reachable / on a later tick; "skip" = PERMANENT no-op (not in a swarm, or we
 *  ARE the coordinator) — never retry. */
export type CheckInResult = "sent" | "retry" | "skip";

export function reportCheckIn(home: string, self: SelfInfo, coordinatorHandle: string | undefined): CheckInResult {
  try {
    if (!coordinatorHandle || !coordinatorHandle.trim()) return "skip"; // not in a swarm context — permanent
    const coordSid = resolveSession(coordinatorHandle, listSessions(home));
    if (!coordSid) return "retry";          // coordinator not resolvable on this machine YET -> retain + retry when it appears (B5)
    const mySid = self.stableId ?? self.id;
    if (coordSid === mySid) return "skip";  // we ARE the coordinator -> don't check in to ourselves — permanent
    const line = JSON.stringify({ sid: mySid, handle: self.title, pid: self.pid, startedAt: self.startedAt });
    writeInbox(home, coordSid, {
      from: mySid, fromLabel: self.title, ...(self.mode ? { fromMode: self.mode } : {}),
      text: `[checkin] ${line}`, via: "local", ts: Date.now(),
    });
    return "sent";
  } catch { return "retry"; } // transient (e.g. the write failed) -> retain the obligation (B5); never throw on startup
}

/** FC-2 (PD-P2-2) — deliver an already-built notice to the coordinator, reusing the same coordinator-handle resolution as the
 *  check-in. THREE-STATE so the caller can RETAIN a retry obligation: "sent" = written to the coordinator inbox; "retry" =
 *  TRANSIENT (coordinator not resolvable yet, or the write failed) ⇒ keep the durable notice + retry on a later flush; "skip" =
 *  PERMANENT (no coordinator configured, or we ARE the coordinator) ⇒ discharge. NEVER throws. The durable poison-notice queue
 *  (inbox.ts enqueue/drain) + the F26 ledger are the durable record; this is the delivery step. */
export function deliverToCoordinator(home: string, self: SelfInfo, coordinatorHandle: string | undefined, msg: InboxMsg): "sent" | "retry" | "skip" {
  try {
    if (!coordinatorHandle || !coordinatorHandle.trim()) return "skip"; // no coordinator ⇒ permanent
    const coordSid = resolveSession(coordinatorHandle, listSessions(home));
    if (!coordSid) return "retry"; // not resolvable on this machine YET ⇒ retain + retry
    const mySid = self.stableId ?? self.id;
    if (coordSid === mySid) return "skip"; // never to self ⇒ permanent
    writeInbox(home, coordSid, msg);
    return "sent";
  } catch { return "retry"; } // write failed ⇒ retain + retry; fail-soft, never throw
}
