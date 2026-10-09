/**
 * submit-tag intent (T5-2 secondary-source seam) — a tiny PURE vocabulary shared by the S11 envelope (inbox.ts), the chat-room
 * post (swarm/chat-room.ts), and the dual-bandwidth gauge. Kept in its own core module so inbox.ts (core) and chat-room.ts
 * (swarm) can both import it with no fs and no core→swarm dependency inversion.
 *
 * An OPTIONAL marker declaring what a message IS for the gauge. ONLY `submit` is a verdict-needing produce (呈批/立项); `report`
 * and `fyi` are communication and the gauge ignores them (same spirit as the T5-2 ruling that chat-room sign-offs are
 * communication, never counted). Absent ⇒ untagged ⇒ not counted — fully backward-compatible. Distinct from transport `via`
 * (local/relay/durable-inbox), which it never overloads.
 */
export type SubmitIntent = "submit" | "report" | "fyi";

export function isSubmitIntent(v: unknown): v is SubmitIntent {
  return v === "submit" || v === "report" || v === "fyi";
}
