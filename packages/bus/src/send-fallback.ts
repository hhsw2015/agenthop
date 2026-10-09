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

/**
 * F45-P1-2: decide whether a RELAY-resolved peer is actually SAME-MACHINE, returning the sid to deliver durably to, or
 * null. The proof is NOT a mere filename: the peer's OWN full stableId must own a presence pid (exact match, so a short-id
 * collision cannot misroute) AND that pid must be LIVE on this host (`liveness(sid) === "alive"`). A dead or corrupt
 * presence file — e.g. left behind by a session that once ran here, or an isolation fixture for a remote peer — is NOT
 * proof of a shared filesystem and must NOT redirect a remote peer to a local inbox (which no live local node would drain,
 * while the real remote peer gets nothing and the send falsely reports "durable"). Insufficient proof ⇒ null ⇒ the caller
 * keeps the relay path. `liveness` is injected (fileIsAlive) so this stays pure and unit-testable. Pure. */
export function relaySameMachineSid(peer: UnifiedPeer, isLocalInstance: (sid: string) => boolean): string | null {
  if (peer.via !== "relay" || !peer.stableId) return null;
  // F45-P1-2: a live presence pid (signal-0) is NOT enough — a stale presence file may name a pid RECYCLED to an unrelated
  // live process, which would silently redirect a remote peer to a local inbox nobody drains. `isLocalInstance` must PROVE
  // the peer's current instance owns the local pid (see argvBoundToSid); unproven ⇒ null ⇒ the caller keeps the relay path.
  return isLocalInstance(peer.stableId) ? peer.stableId : null;
}

/** F45-P1-2 (round-4): a live presence pid belongs to session `sid`'s CURRENT instance only if THAT PROCESS'S ENVIRONMENT
 *  carries the identity the launcher passes — NOT its argv (an unrelated process can carry the sid as a plain argument; the
 *  real presence DAEMON's argv is just `node presence.mjs` and has no sid). The daemon (agents.ts presenceStartCommand /
 *  presence.ts) is launched with `AGENTHOP_PID_FILE=.../<sid>.pid` and inherits `CLAUDE_CODE_SESSION_ID=<sid>`. So ownership
 *  is proven iff the env has `AGENTHOP_PID_FILE=<…>/<sid>.pid` OR `CLAUDE_CODE_SESSION_ID=<sid>`. A recycled/unrelated pid
 *  has neither ⇒ false ⇒ keep relay (never a false durable); the real daemon has them ⇒ its same-machine inbox is used.
 *  `envText` is a whitespace-joined `KEY=VALUE` dump (e.g. `ps eww`); null/empty ⇒ false. Pure. */
export function presenceEnvOwnsSid(envText: string | null | undefined, sid: string): boolean {
  if (!envText || !sid) return false;
  const toks = envText.split(/\s+/);
  if (toks.includes(`CLAUDE_CODE_SESSION_ID=${sid}`)) return true;
  for (const t of toks) if (t.startsWith("AGENTHOP_PID_FILE=") && t.endsWith(`/${sid}.pid`)) return true;
  return false;
}

export function resolveInboxTarget(to: string, resolved: UnifiedPeer | ResolveError, offlineSid: string | null, relayLocalSid: string | null = null): InboxTarget {
  if ("error" in resolved) {
    // B1: an AMBIGUOUS (or empty) target must NEVER fall back — a weaker handle match could pick one of several live matches
    // and misroute a private message. Only a genuine no-match may route to a same-machine durable inbox owned offline.
    if (resolved.kind !== "none") return { kind: "none", reason: resolved.error };
    const plan = fallbackForUnresolved(offlineSid, resolved.error);
    return plan.kind === "durable" ? { kind: "durable", sid: plan.sid, label: to } : { kind: "none", reason: plan.reason };
  }
  // RELAY-resolved. F45 ③: a relay peer is "cross-broker", which is NOT the same as "cross-machine". When the peer's OWN
  // durable id owns a local presence pid (passed in as `relayLocalSid` — computed from the peer's stableId, so a short-id
  // collision cannot misroute), it shares our filesystem and HAS a local durable inbox. Route durable, keyed by that exact
  // sid — restoring "same-machine ⇒ durable-always" ACROSS brokers. Before this, a same-machine peer on a different broker
  // resolved as relay ⇒ a live-only send ⇒ no durable copy ⇒ a dispatch stranded in no inbox (the F45 incident). A truly
  // CROSS-MACHINE relay peer (relayLocalSid null) has no local inbox ⇒ a live best-effort relay send.
  if (resolved.via === "relay") {
    if (relayLocalSid) return { kind: "durable", sid: relayLocalSid, label: resolved.title, peer: resolved };
    return { kind: "relay", peer: resolved };
  }
  // SAME-MACHINE (local): durable-always, keyed by the DURABLE identity (never the handle — that is `label`).
  const plan = fallbackForMissedDelivery(resolved);
  return plan.kind === "durable" ? { kind: "durable", sid: plan.sid, label: resolved.title, peer: resolved } : { kind: "none", reason: plan.reason };
}
