// TG entry — pure render/parse for the Telegram user-entry (peer to the console). An ENTRY reads the core's FROZEN
// projections and renders them for its medium, and parses the user's tap into a verdict the driver writes to the SINGLE
// decision ledger (decision-batch). ZERO business logic: the allowed approval scopes come from the CORE (allowedScopes),
// enforced there on the real item (NOT by the buttons); the digest comes from the CORE (morning-digest). No IO.
import { createHash } from "node:crypto";
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

// ------------------------------------------------------------------------------------------------------------------------
// Outbound-request proxy selection + inbound immediacy receipts (TG bridge bring-up). Pure; the thin driver does the IO.
// ------------------------------------------------------------------------------------------------------------------------

/** Pick the proxy URL for an HTTPS request to `host` from standard env, or null for a DIRECT connection. `HTTPS_PROXY` (then
 *  `HTTP_PROXY`) wins; `NO_PROXY` (an exact host, a `.suffix`/`suffix`, or `*`) forces direct; lowercase variants honored. No env
 *  ⇒ null ⇒ the caller connects directly (ZERO behavior change vs today). Pure. */
export function selectProxyUrl(env: Record<string, string | undefined>, host: string): string | null {
  const h = host.toLowerCase();
  for (const p of (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (p === "*") return null;
    const bare = p.replace(/^\./, "");
    if (h === bare || h.endsWith(`.${bare}`)) return null;
  }
  const url = (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? "").trim();
  return url || null;
}

/** The immediate TG-side ACK text — a sub-second "read receipt" the bridge sends back to the user's chat ON RECEIVING an update,
 *  before the coordinator processes it (conversation-level SLA). The final result rides the outbound path later. */
export const TG_ACK_TEXT = "✅ 收到,正在处理…";

/** The S11 decision receipt the bridge writes to the COORDINATOR inbox after a verdict is RECORDED, so the coordinator wakes
 *  (writeInbox carries inbox-wake) in seconds instead of waiting for a cron, and the receipt is a durable audit trace. NOTIFY
 *  ONLY — it never executes; the coordinator's re-injection chain still does the work. Pure (returns the message fields). */
export function buildTgVerdictReceipt(batchId: string, itemId: string, verdict: Verdict, scope?: ApprovalScope): { text: string; taskRef: string; title: string } {
  return { text: `[tg-verdict] 批 ${batchId} 项 ${itemId}: ${verdict}${scope ? ` (scope=${scope})` : ""}`, taskRef: "tg-verdict", title: "TG 决策回执" };
}

/** A clamped decision (the enforceScope output the ledger actually stores): a verdict, plus an approve scope. */
export type ClampedDecision = { verdict: Verdict; scope?: ApprovalScope };

/** TGP-4 — what verdict receipt (if any) THIS tap owes the coordinator, derived from the DURABLE LEDGER, not the volatile
 *  recordDecision outcome. The receipt obligation must survive consume AND crash and must never be a false/stale audit:
 *   - "recorded": this tap just wrote the ledger ⇒ owes its own clamped decision (`mine`).
 *   - "consumed": the batch is SEALED ⇒ EITHER a genuinely-late/losing tap (owes nothing) OR the recovery of a tap that WAS
 *     recorded earlier but whose receipt never completed (forward retry held the offset, or a crash before advance) and the batch
 *     was consumed in between. We distinguish them by MATCHING `mine` against the ledger's FINAL decision for the item
 *     (`ledgerFinal`, read post-seal from the stable ledger): a match ⇒ owe the REAL (ledger) receipt; a mismatch/absent ledger ⇒
 *     a late/losing tap whose verdict is NOT the final truth ⇒ owe nothing (never report a stale/wrong verdict).
 *  Returns the clamped decision to report, or null. Pure — the driver supplies `mine` (enforceScope of the item) and `ledgerFinal`
 *  (readDecisions → the item's folded decision). On a match `mine` equals `ledgerFinal`, so returning `mine` is the real receipt. */
export function receiptOwed(outcome: "recorded" | "consumed", mine: ClampedDecision, ledgerFinal: ClampedDecision | null): ClampedDecision | null {
  if (outcome === "recorded") return mine; // this tap wrote the ledger ⇒ report what it recorded
  // consumed: a recovery iff this tap IS the item's final decision; otherwise a late/losing tap that owes nothing.
  return ledgerFinal && ledgerFinal.verdict === mine.verdict && ledgerFinal.scope === mine.scope ? mine : null;
}

/** The S11 receipt for a NON-verdict allowlisted TG message — forwarded to the coordinator inbox (notify + inbox-wake) so the
 *  user's free text is seen promptly. Notify only, never executed; the text is bounded. Pure. */
export function buildTgMessageReceipt(chatId: number, text: string): { text: string; taskRef: string; title: string } {
  const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return { text: `[tg-message] chat ${chatId}: ${clipped}`, taskRef: "tg-message", title: "TG 消息" };
}

/** A stable, writeInbox-contract-compliant idempotency key for a forwarded TG event (a verdict per batch+item, a message per
 *  update_id). writeInbox's dedup key must match `^[A-Za-z0-9._-]{1,120}$` (else it falls to the non-deduped random-name path —
 *  TGP-3), so any unsafe char in a part is folded to `_` and the whole is clipped to 120. Same event ⇒ same key (replay dedups);
 *  distinct events ⇒ distinct keys. Pure. */
export function tgIdempotencyKey(prefix: string, ...parts: Array<string | number>): string {
  // LOSSLESS identity (TGP-3b): the parts are sha256-hashed (NUL-joined), so distinct identities never collide and a long/`/`-bearing
  // id is never lost to truncation or char-folding — unlike a raw replace/slice. A readable prefix aids debugging. Contract-safe
  // (`^[A-Za-z0-9._-]{1,120}$`): prefix(≤24) + "." + 40 hex.
  const p = prefix.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 24);
  const hash = createHash("sha256").update(parts.map(String).join("\u0000")).digest("hex").slice(0, 40);
  return `${p}.${hash}`;
}
