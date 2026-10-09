// TG entry — pure render/parse for the Telegram user-entry (peer to the console). An ENTRY reads the core's FROZEN
// projections and renders them for its medium, and parses the user's tap back into a verdict for the SINGLE decision ledger
// (decision-batch DecisionsDoc). ZERO business logic lives here: the allowed approval scopes + the digest come from the CORE
// (decision-batch.allowedScopes / composeDigest), so console and TG never diverge. No IO — the driver does the bot calls +
// the ledger write; this module only decides WHAT to render and HOW to read an update.
import { type DecisionItem, type Verdict, type ApprovalScope, type DecisionsDoc, allowedScopes } from "./decision-batch.js";
import type { DualBandwidthReading } from "./dual-bandwidth.js";
import type { RoomPost } from "./chat-room.js";

/** A Telegram send primitive the driver executes. Multimodal is the FORM of a notification, not a new capability: an
 *  image/card/document is the ENTRY's PRESENTATION of a projection — the projection stays the only source of truth. */
export type TgPrimitive = "message" | "photo" | "document" | "pin";
/** An inline-keyboard button: `label` shown, `data` is the callback payload (parsed by parseCallback). */
export type TgButton = { label: string; data: string };
/** What the driver must build + attach (it holds the bytes; this module only names the source). `ref` is a POINTER (S18):
 *  a card to rasterize from a projection, a screenshot path, or an evidenceRef document — never inlined content. */
export type TgAttachment = { kind: "card" | "screenshot" | "document"; ref: string };
export type RenderSpec = { primitive: TgPrimitive; text: string; keyboard?: TgButton[][]; attachment?: TgAttachment };

/** The frozen projections a TG entry renders (same source the console reads). A `decision` covers both a decision-batch item
 *  and an S19 approval surfaced as one; `bandwidth` is the gauge; `chat` a room post; `digest` the once-generated morning feed. */
export type EntryProjection =
  | { kind: "decision"; batchId: string; item: DecisionItem }
  | { kind: "bandwidth"; reading: DualBandwidthReading }
  | { kind: "chat"; post: RoomPost }
  | { kind: "digest"; text: string };

const SCOPE_LABEL: Record<ApprovalScope, string> = { once: "once", "this-chat": "this chat", always: "always" };

/** Encode a decision callback: `d|<batchId>|<id>|<verdict>[|<scope>]`. `|` is not allowed in a safe batchId ([A-Za-z0-9_-]),
 *  and item ids are plan node ids / batch ids (no `|`), so split-by-`|` is unambiguous. Kept short — TG callback_data <= 64 bytes. */
export function encodeDecisionCb(batchId: string, id: string, verdict: Verdict, scope?: ApprovalScope): string {
  return `d|${batchId}|${id}|${verdict}${verdict === "approve" && scope ? `|${scope}` : ""}`;
}
/** Decode a decision callback back to a verdict; null if it is not a well-formed decision callback. */
export function parseCallback(data: string): { batchId: string; id: string; verdict: Verdict; scope?: ApprovalScope } | null {
  const p = data.split("|");
  if (p[0] !== "d" || p.length < 4 || p.length > 5) return null;
  const [, batchId, id, verdict, scope] = p;
  if (!batchId || !id) return null;
  if (verdict !== "approve" && verdict !== "reject" && verdict !== "defer") return null;
  if (scope !== undefined && scope !== "once" && scope !== "this-chat" && scope !== "always") return null;
  return { batchId, id, verdict: verdict as Verdict, ...(verdict === "approve" && scope ? { scope: scope as ApprovalScope } : {}) };
}

/** Render a frozen projection into a TG RenderSpec. A decision item carries the inline keyboard built from the CORE-allowed
 *  scopes (hard gate -> no "always"); a bandwidth RED zone is a pinned card; a digest is a message. Pure: picks the primitive
 *  + content from the projection, never does IO, never changes the projection. */
export function renderProjection(proj: EntryProjection): RenderSpec {
  switch (proj.kind) {
    case "decision": {
      const { batchId, item } = proj;
      const text = `${item.hardGate ? "⚠ " : ""}${item.summary}\nsuggested: ${item.suggestedAction}${item.evidenceRef ? `\nref: ${item.evidenceRef}` : ""}`;
      // approve (one button per allowed scope) + reject + defer. Hard gate -> allowedScopes is ["once"] only, so no "always".
      const approveRow: TgButton[] = allowedScopes(item).map((s) => ({ label: `approve (${SCOPE_LABEL[s]})`, data: encodeDecisionCb(batchId, item.id, "approve", s) }));
      const keyboard: TgButton[][] = [approveRow, [
        { label: "decline", data: encodeDecisionCb(batchId, item.id, "reject") },
        { label: "defer", data: encodeDecisionCb(batchId, item.id, "defer") },
      ]];
      // If evidenceRef points at a document, the driver may send it as an attachment alongside; the pointer rides the spec.
      return { primitive: "message", text, keyboard, ...(item.evidenceRef ? { attachment: { kind: "document", ref: item.evidenceRef } } : {}) };
    }
    case "bandwidth": {
      const r = proj.reading;
      const text = `bandwidth ${r.zone.toUpperCase()} — produce ${r.bProd1h}/h, consume ${r.bCons1h}/h, backlog ${r.backlog}`;
      // RED -> pin the alert; otherwise a gauge card photo (the driver rasterizes the zones from the projection json).
      return r.zone === "red"
        ? { primitive: "pin", text, attachment: { kind: "card", ref: "bandwidth-gauge" } }
        : { primitive: "photo", text, attachment: { kind: "card", ref: "bandwidth-gauge" } };
    }
    case "chat":
      return { primitive: "message", text: `${proj.post.fromLabel}: ${proj.post.text}` };
    case "digest":
      return { primitive: "message", text: proj.text };
  }
}

/** A typed TG update the driver hands in (the fields we read from getUpdates). */
export type TgUpdate = { chatId?: number; callbackData?: string; text?: string };
/** The result of parsing an update against the allowlist: a decision to WRITE, or an ignore (off-allowlist / not a verdict). */
export type ParseResult =
  | { kind: "decision"; batchId: string; doc: DecisionsDoc }
  | { kind: "ignore"; reason: string };

/** Allowlist-gate the chat_id FIRST, then map a callback tap to a one-decision DecisionsDoc for the SINGLE ledger. A typed
 *  reply / non-decision update is ignored (logged by the driver, never acted on). Untrusted input: anything off-allowlist or
 *  malformed -> ignore. nowSec is injected (pure). The hard-gate "never always" rule already shaped the buttons; validDecision
 *  (ledger write boundary) is the second guard. */
export function parseUpdate(update: TgUpdate, allowlist: ReadonlySet<number>, nowSec: number): ParseResult {
  if (typeof update.chatId !== "number" || !allowlist.has(update.chatId)) return { kind: "ignore", reason: "chat_id not allowlisted" };
  if (update.callbackData === undefined) return { kind: "ignore", reason: "not a decision callback (typed reply ignored in v1)" };
  const cb = parseCallback(update.callbackData);
  if (!cb) return { kind: "ignore", reason: "malformed callback" };
  const doc: DecisionsDoc = { batchId: cb.batchId, decidedAtSec: nowSec, decisions: [{ id: cb.id, verdict: cb.verdict, ...(cb.scope ? { scope: cb.scope } : {}) }] };
  return { kind: "decision", batchId: cb.batchId, doc };
}
