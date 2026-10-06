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
import type { UnifiedPeer, ResolveError } from "./resolve.js";

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

/**
 * F40 — the SINGLE write-side addressing entry. Given an address `to`, its roster resolution, and an offline presence match,
 * return WHERE to deliver: a durable inbox keyed by the recipient's STABLE IDENTITY, a cross-machine relay send, or nothing.
 *
 * The one invariant it enforces structurally (F40 root fix): the durable inbox KEY (`sid`) is ALWAYS the recipient's durable
 * identity — a resolved local peer's `stableId ?? per-run id`, or the presence-owned native sid of an offline session — and
 * NEVER the routing name / handle (`to`, `peer.title`), which is display-only and returned separately as `label`. Routing an
 * inbox by a short-lived handle (e.g. a Codex `tool:dir-<threadId>` whose tail drifts on restart) is exactly what stranded
 * mail in a box no live node drained; because every send computes its key HERE, a routing name can no longer become one.
 *
 * Pure (the resolution + offline match are passed in), so the decision — where a wrong choice silently drops or misroutes —
 * is unit-tested without a broker. `peer` is carried on a resolved-local durable target so the caller can still special-case a
 * node that does not consume the durable inbox (an OpenCode node, C1) without re-deriving the resolution.
 */
export type InboxTarget =
  | { kind: "durable"; sid: string; label: string; peer?: UnifiedPeer } // write ~/.agenthop/inbox/<sid>/; peer set iff a resolved local peer
  | { kind: "relay"; peer: UnifiedPeer }                                 // cross-machine ⇒ the caller does a live relay send
  | { kind: "none"; reason: string };                                    // undeliverable ⇒ { ok:false, error:reason }

export function resolveInboxTarget(to: string, resolved: UnifiedPeer | ResolveError, offlineSid: string | null): InboxTarget {
  if ("error" in resolved) {
    // B1: an AMBIGUOUS (or empty) target must NEVER fall back — a weaker handle match could pick one of several live matches
    // and misroute a private message. Only a genuine no-match may route to a same-machine durable inbox owned offline.
    if (resolved.kind !== "none") return { kind: "none", reason: resolved.error };
    const plan = fallbackForUnresolved(offlineSid, resolved.error);
    return plan.kind === "durable" ? { kind: "durable", sid: plan.sid, label: to } : { kind: "none", reason: plan.reason };
  }
  // CROSS-MACHINE (relay): a live best-effort send; no local durable inbox.
  if (resolved.via === "relay") return { kind: "relay", peer: resolved };
  // SAME-MACHINE (local): durable-always, keyed by the DURABLE identity (never the handle — that is `label`).
  const plan = fallbackForMissedDelivery(resolved);
  return plan.kind === "durable" ? { kind: "durable", sid: plan.sid, label: resolved.title, peer: resolved } : { kind: "none", reason: plan.reason };
}
