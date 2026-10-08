/**
 * perm-inbound-gate — permission-mode-aware inbound message gating (S14 absorb #3).
 *
 * Absorbed from the official cross-session-messaging inbound default: an explicit `crossSessionInbound` of
 * accept/hold/refuse wins; otherwise the default decides per the two sessions' permission-mode CLASSES — a message from
 * a BYPASS-mode sender to a PROMPTING receiver is HELD for the user's approval (its sender skips its own prompts, so its
 * request shouldn't auto-act on a stricter peer), and a BYPASS receiver holds everything except from another bypass peer.
 * This is the message-layer sibling of R16 / C8 (a peer's bypass never silently drives a stricter peer); C8 HMAC caps
 * stay the stronger gate for ACTIONS, this gates DELIVERY. Family-neutral (it reads modes, not a vendor event).
 *
 * Pure core below (selftested); wiring into the durable inbox is dormant (`SWARM_PERM_GATE` off).
 */

// ============================================================================================================
// Pure core (selftested in perm-inbound-gate.selftest.mts)
// ============================================================================================================

export type InboundMode = "accept" | "hold" | "refuse"; // explicit crossSessionInbound setting
export type GateResult = "deliver" | "hold" | "refuse";

export type PermMode = "default" | "manual" | "plan" | "auto" | "acceptEdits" | "dontAsk" | "bypassPermissions";

/** The two classes: bypassPermissions (and plan, which runs read-only/approve-free in the official default) bypass
 *  prompts; auto / acceptEdits / dontAsk / manual / default all PROMPT. Pure. */
export function isBypassClass(mode: PermMode): boolean {
  return mode === "bypassPermissions" || mode === "plan";
}

/**
 * Decide an inbound peer message's fate. Explicit `crossSessionInbound` wins (refuse > accept > hold as written);
 * otherwise the default two-class rule:
 *  - receiver PROMPTS: deliver, UNLESS the sender is bypass-class ⇒ hold for the user's approval.
 *  - receiver BYPASSES: hold, UNLESS the sender also bypasses ⇒ deliver.
 * Pure. */
export function inboundGate(opts: { senderBypass: boolean; receiverBypass: boolean; explicit?: InboundMode }): GateResult {
  if (opts.explicit === "refuse") return "refuse";
  if (opts.explicit === "accept") return "deliver";
  if (opts.explicit === "hold") return "hold";
  if (!opts.receiverBypass) return opts.senderBypass ? "hold" : "deliver"; // receiver prompts
  return opts.senderBypass ? "deliver" : "hold"; // receiver bypasses
}

/** Convenience: decide straight from the two modes + optional explicit setting. Pure. */
export function gateByModes(senderMode: PermMode, receiverMode: PermMode, explicit?: InboundMode): GateResult {
  return inboundGate({ senderBypass: isBypassClass(senderMode), receiverBypass: isBypassClass(receiverMode), explicit });
}

// ============================================================================================================
// IO shell — wiring into the durable inbox (dormant: SWARM_PERM_GATE off; exercised by live runs)
// ============================================================================================================

/** perm-inbound-gate wiring flip, default OFF (dormant-ahead-of-use). */
export function permGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_PERM_GATE ?? "");
}
