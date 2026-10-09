// TG entry — pure render/parse for the Telegram user-entry (peer to the console). An ENTRY reads the core's FROZEN
// projections and renders them for its medium, and parses the user's tap into a verdict the driver writes to the SINGLE
// decision ledger (decision-batch). ZERO business logic: the allowed approval scopes come from the CORE (allowedScopes),
// enforced there on the real item (NOT by the buttons); the digest comes from the CORE (morning-digest). No IO.
import { allowedScopes, type DecisionItem, type Verdict, type ApprovalScope } from "./decision-batch.js";
import type { DualBandwidthReading } from "./dual-bandwidth.js";
import type { RoomPost } from "./chat-room.js";

/** A Telegram send primitive the driver executes. Multimodal is the FORM of a notification, not a new capability: an
 *  image/card/document is the ENTRY's PRESENTATION of a projection — the projection stays the only source of truth. */
export type TgPrimitive = "message" | "photo" | "document" | "pin";
export type TgButton = { label: string; data: string };
export type TgAttachment = { kind: "card" | "screenshot" | "document"; ref: string };
export type RenderSpec = { primitive: TgPrimitive; text: string; keyboard?: TgButton[][]; attachment?: TgAttachment };

/** The frozen projections a TG entry renders (same source the console reads). A `decision` carries a compact `ref` the DRIVER
 *  built ( `<batchHash>.<itemIndex>` ) so the callback stays small — NO arbitrary batchId/itemId is embedded (TG-P2-3). */
export type EntryProjection =
  | { kind: "decision"; item: DecisionItem; ref: string }
  | { kind: "bandwidth"; reading: DualBandwidthReading }
  | { kind: "chat"; post: RoomPost }
  | { kind: "digest"; text: string };

const SCOPE_LABEL: Record<ApprovalScope, string> = { once: "once", "this-chat": "this chat", always: "always" };
const VERDICTS: readonly Verdict[] = ["approve", "reject", "defer"];
const SCOPES: readonly ApprovalScope[] = ["once", "this-chat", "always"];

/** Encode a decision callback: `d|<ref>|<verdict>[|<scope>]`. `ref` is the driver's compact opaque token (hash.index, no
 *  `|`), so ANY legal core id round-trips inside Telegram's 64-byte callback_data limit without truncation (TG-P2-3). */
export function encodeDecisionCb(ref: string, verdict: Verdict, scope?: ApprovalScope): string {
  return `d|${ref}|${verdict}${verdict === "approve" && scope ? `|${scope}` : ""}`;
}
/** Decode a decision callback. Shape-safe: a non-string / wrong-shape / over-64-byte value returns null (never throws). */
export function parseCallback(data: unknown): { ref: string; verdict: Verdict; scope?: ApprovalScope } | null {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 64) return null;
  const p = data.split("|");
  if (p[0] !== "d" || (p.length !== 3 && p.length !== 4)) return null;
  const [, ref, verdict, scope] = p;
  if (!ref || !VERDICTS.includes(verdict as Verdict)) return null;
  if (scope !== undefined && !SCOPES.includes(scope as ApprovalScope)) return null;
  return { ref, verdict: verdict as Verdict, ...(verdict === "approve" && scope ? { scope: scope as ApprovalScope } : {}) };
}

/** Render a frozen projection into a TG RenderSpec. A decision item carries the inline keyboard built from the CORE-allowed
 *  scopes (hard gate -> no "always"); a bandwidth RED zone is a pinned card; a digest is a message. Pure. */
export function renderProjection(proj: EntryProjection): RenderSpec {
  switch (proj.kind) {
    case "decision": {
      const { item, ref } = proj;
      const text = `${item.hardGate ? "⚠ " : ""}${item.summary}\nsuggested: ${item.suggestedAction}${item.evidenceRef ? `\nref: ${item.evidenceRef}` : ""}`;
      // the buttons reflect allowedScopes, but they are NOT the permission boundary — the CORE re-enforces on resolve (TG-P1-1).
      const approveRow: TgButton[] = allowedScopes(item).map((s) => ({ label: `approve (${SCOPE_LABEL[s]})`, data: encodeDecisionCb(ref, "approve", s) }));
      const keyboard: TgButton[][] = [approveRow, [
        { label: "decline", data: encodeDecisionCb(ref, "reject") },
        { label: "defer", data: encodeDecisionCb(ref, "defer") },
      ]];
      return { primitive: "message", text, keyboard, ...(item.evidenceRef ? { attachment: { kind: "document", ref: item.evidenceRef } } : {}) };
    }
    case "bandwidth": {
      const r = proj.reading;
      const text = `bandwidth ${r.zone.toUpperCase()} — produce ${r.bProd1h}/h, consume ${r.bCons1h}/h, backlog ${r.backlog}`;
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

/** A typed TG update the driver hands in (the fields we read from getUpdates). All optional + untrusted. */
export type TgUpdate = { chatId?: unknown; callbackData?: unknown; text?: unknown };
/** Parse result: a verdict tied to the driver's `ref` (the driver resolves ref -> batchId/itemId and merges), or ignore. */
export type ParseResult =
  | { kind: "decision"; ref: string; verdict: Verdict; scope?: ApprovalScope }
  | { kind: "ignore"; reason: string };

/** Allowlist-gate the chat_id FIRST, then shape-validate a callback into a (ref, verdict, scope). Untrusted input: a
 *  non-number chatId, off-allowlist, a non-string/garbled callback, or a typed reply all return `ignore` — NEVER throw
 *  (TG-P2-4). The driver resolves `ref` against the live batches and merges the single item into the ledger (TG-P1-2). */
export function parseUpdate(update: TgUpdate, allowlist: ReadonlySet<number>): ParseResult {
  if (update === null || typeof update !== "object") return { kind: "ignore", reason: "no update" };
  if (typeof update.chatId !== "number" || !allowlist.has(update.chatId)) return { kind: "ignore", reason: "chat_id not allowlisted" };
  if (update.callbackData === undefined) return { kind: "ignore", reason: "not a decision callback (typed reply ignored in v1)" };
  const cb = parseCallback(update.callbackData);
  if (!cb) return { kind: "ignore", reason: "malformed callback" };
  return { kind: "decision", ref: cb.ref, verdict: cb.verdict, ...(cb.scope ? { scope: cb.scope } : {}) };
}
