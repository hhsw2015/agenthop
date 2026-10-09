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
import { writeInbox, buildPoisonS19, type InboxMsg } from "./inbox.js";
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

/** FC-2 — notify the coordinator that a poison message was quarantined (content preview + failure trace + strike count),
 *  reusing the same coordinator-handle resolution as the check-in. Best-effort + fail-soft: the quarantine itself + the F26
 *  dead-letter ledger line are the DURABLE record, so a missing/unresolvable coordinator never loses the incident — this is
 *  the ACTIVE push on top. "sent" = written to the coordinator inbox; "skip" = no coordinator / not resolvable / is self /
 *  write failed. NEVER throws. */
export function notifyCoordinatorPoison(home: string, self: SelfInfo, coordinatorHandle: string | undefined, poison: InboxMsg, strikes: number, trace: string): "sent" | "skip" {
  try {
    if (!coordinatorHandle || !coordinatorHandle.trim()) return "skip";
    const coordSid = resolveSession(coordinatorHandle, listSessions(home));
    if (!coordSid) return "skip"; // not resolvable here — the dead-letter ledger remains the durable fallback
    const mySid = self.stableId ?? self.id;
    if (coordSid === mySid) return "skip"; // never to self
    writeInbox(home, coordSid, buildPoisonS19(mySid, self.title, poison, strikes, trace));
    return "sent";
  } catch { return "skip"; } // fail-soft: the quarantine + ledger already captured it
}
