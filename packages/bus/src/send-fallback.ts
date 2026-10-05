/**
 * Pure routing for the durable-inbox FALLBACK on the send path (bus-reachability §1). When live delivery is not available,
 * a known SAME-MACHINE recipient gets the message in its durable inbox (`~/.agenthop/inbox/<sid>/`) instead of a dropped
 * send — "message = accelerator, durable = channel" moved from per-caller discipline into the send path itself, so the
 * caller always makes ONE call and code (not the caller's judgment) picks fast vs durable.
 *
 * Kept pure so the routing — where a wrong choice silently DROPS or MISROUTES a message — is unit-tested without a broker.
 * SAME-MACHINE ONLY: the durable inbox is a LOCAL filesystem path, so a cross-machine (relay) target has no local
 * fallback; that is reported as an honest failure, never a false "queued".
 */
import type { UnifiedPeer } from "./resolve.js";

export type FallbackPlan =
  | { kind: "durable"; sid: string }    // write the message to ~/.agenthop/inbox/<sid>/ and report delivered:"durable"
  | { kind: "none"; reason: string };   // genuinely undeliverable from here -> report { ok:false, error:reason }

/** Resolve FAILED (the peer is not on the live roster). Fall back ONLY if a same-machine session owns the handle:
 *  `offlineSid` = resolveSession(to, listSessions(home)) (a presence/<sid>.pid match), or null when none/ambiguous. */
export function fallbackForUnresolved(offlineSid: string | null, resolveError: string): FallbackPlan {
  return offlineSid ? { kind: "durable", sid: offlineSid } : { kind: "none", reason: resolveError };
}

/** Peer RESOLVED ⇒ the durable sid to deliver to. A local peer is same-machine ⇒ its durable inbox (keyed by stableId, or the
 *  per-run id when a Codex node has not learned its thread id yet) is now the PRIMARY path (B2/B3 option b: durable-always, the
 *  only guarantee), not a miss-fallback. A relay peer is cross-machine ⇒ no local durable inbox (the caller does a live relay send). */
export function fallbackForMissedDelivery(peer: UnifiedPeer): FallbackPlan {
  if (peer.via === "local") return { kind: "durable", sid: peer.stableId ?? peer.id };
  return { kind: "none", reason: `Relay delivery to "${peer.title}" failed; it is on another machine, which has no local durable fallback.` };
}
