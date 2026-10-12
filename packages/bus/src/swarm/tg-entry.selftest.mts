// Selftest for the TG entry pure core (render/parse, ref-based) + the shared CORE decision rules (allowedScopes /
// enforceScope / upsertDecision) + the digest. Run: node --import tsx packages/bus/src/swarm/tg-entry.selftest.mts
import { renderProjection, parseUpdate, encodeDecisionCb, parseCallback, selectProxyUrl, buildTgVerdictReceipt, buildTgMessageReceipt, tgIdempotencyKey, TG_ACK_TEXT, type TgUpdate } from "./tg-entry.js";
import { allowedScopes, enforceScope, upsertDecision, validDecision, type DecisionItem, type DecisionsDoc } from "./decision-batch.js";
import { composeDigest } from "./morning-digest.js";
import type { DualBandwidthReading } from "./dual-bandwidth.js";
import type { RoomPost } from "./chat-room.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

const soft: DecisionItem = { id: "n1", kind: "merge", summary: "merge PR 7", suggestedAction: "approve" };
const hard: DecisionItem = { id: "n2", kind: "spend", summary: "pay $40 invoice", suggestedAction: "approve", hardGate: true };

// --- allowedScopes (CORE) ---
{
  t("soft item -> 3 scopes", JSON.stringify(allowedScopes(soft)) === JSON.stringify(["once", "this-chat", "always"]));
  t("hard gate -> ONLY once", JSON.stringify(allowedScopes(hard)) === JSON.stringify(["once"]));
}

// --- TG-P1-1: enforceScope clamps against the REAL item (the UI is not the boundary) ---
{
  t("hard-gate approve 'always' -> clamped to once", enforceScope(hard, { id: "n2", verdict: "approve", scope: "always" }).scope === "once");
  t("hard-gate approve 'this-chat' -> clamped to once", enforceScope(hard, { id: "n2", verdict: "approve", scope: "this-chat" }).scope === "once");
  t("soft approve 'always' -> kept", enforceScope(soft, { id: "n1", verdict: "approve", scope: "always" }).scope === "always");
  t("approve with no scope -> defaults once", enforceScope(soft, { id: "n1", verdict: "approve" }).scope === "once");
  t("reject drops any scope", enforceScope(soft, { id: "n1", verdict: "reject", scope: "always" } as never).scope === undefined);
}

// --- TG-P1-2: upsertDecision merges, preserving siblings ---
{
  const d0: DecisionsDoc = { batchId: "b1", decidedAtSec: 1, decisions: [{ id: "a", verdict: "approve" }] };
  const merged = upsertDecision(d0, "b1", { id: "b", verdict: "reject" }, 2);
  t("upsert preserves the sibling a", merged.decisions.some((d) => d.id === "a") && merged.decisions.some((d) => d.id === "b"));
  const re = upsertDecision(merged, "b1", { id: "a", verdict: "reject" }, 3);
  t("re-tap of a UPDATES it (one entry, not two)", re.decisions.filter((d) => d.id === "a").length === 1 && re.decisions.find((d) => d.id === "a")!.verdict === "reject");
  t("a doc for a different batchId is treated as absent", upsertDecision(d0, "OTHER", { id: "z", verdict: "approve" }, 4).decisions.length === 1);
}

// --- TG-P2-3: callback encode/parse round-trips + fits 64 bytes for any legal id's ref ---
{
  t("encode/parse round-trips approve+scope", (() => { const c = parseCallback(encodeDecisionCb("abcd012345.3", "approve", "this-chat")); return !!c && c.ref === "abcd012345.3" && c.verdict === "approve" && c.scope === "this-chat"; })());
  t("reject carries no scope", (() => { const c = parseCallback(encodeDecisionCb("h.0", "reject")); return !!c && c.verdict === "reject" && c.scope === undefined; })());
  // a ref from a 64-char batchId is still hash32.index (the driver's sha256 slice(0,32) . index) -> the callback stays tiny:
  const longBatch = "B".repeat(64);
  const ref = `${"0123456789abcdef0123456789abcdef"}.${999}`; // shape the driver produces (sha256 slice(0,32) . index)
  t("callback for any ref stays <= 64 bytes", Buffer.byteLength(encodeDecisionCb(ref, "approve", "always"), "utf8") <= 64);
  void longBatch;
}

// --- TG-P2-4: parseCallback / parseUpdate are shape-safe (never throw) ---
{
  t("non-string callback -> null (no throw)", parseCallback(7 as never) === null);
  t("object callback -> null", parseCallback({} as never) === null);
  t("over-64-byte callback -> null", parseCallback("d|" + "x".repeat(80) + "|approve") === null);
  t("bad shape -> null", parseCallback("d|only") === null);
  const allow = new Set([42]);
  t("null update -> ignore", parseUpdate(null as never, allow).kind === "ignore");
  t("callbackData=7 (non-string) -> ignore (not throw)", parseUpdate({ chatId: 42, callbackData: 7 }, allow).kind === "ignore");
  t("callbackData=object -> ignore", parseUpdate({ chatId: 42, callbackData: {} }, allow).kind === "ignore");
  t("off-allowlist -> ignore", parseUpdate({ chatId: 99, callbackData: encodeDecisionCb("h.0", "approve", "once") }, allow).kind === "ignore");
  t("non-number chatId -> ignore", parseUpdate({ chatId: "42", callbackData: "d|h.0|approve" }, allow).kind === "ignore");
  const ok = parseUpdate({ chatId: 42, callbackData: encodeDecisionCb("h.0", "approve", "once") }, allow);
  t("valid tap -> decision with ref (driver resolves)", ok.kind === "decision" && ok.ref === "h.0" && ok.verdict === "approve" && ok.scope === "once");
  t("typed reply -> ignore in v1", parseUpdate({ chatId: 42, text: "hi" }, allow).kind === "ignore");
}

// --- renderProjection ---
{
  const d = renderProjection({ kind: "decision", item: soft, ref: "h.0" });
  t("soft decision: message + keyboard", d.primitive === "message" && !!d.keyboard);
  t("soft decision: approve row has 3 scope buttons", d.keyboard![0]!.length === 3);
  const h = renderProjection({ kind: "decision", item: hard, ref: "h.1" });
  t("hard decision: approve row has ONLY once", h.keyboard![0]!.length === 1);
  t("hard decision: NO 'always' button anywhere", !h.keyboard!.flat().some((b) => b.data.endsWith("|always")));
  t("hard decision: every callback <= 64 bytes", h.keyboard!.flat().every((b) => Buffer.byteLength(b.data, "utf8") <= 64));
  const red = renderProjection({ kind: "bandwidth", reading: { zone: "red", bProd1h: 9, bCons1h: 1, backlog: 30 } as DualBandwidthReading });
  t("bandwidth RED -> pinned card", red.primitive === "pin" && red.attachment?.kind === "card");
  t("bandwidth GREEN -> photo", renderProjection({ kind: "bandwidth", reading: { zone: "green", bProd1h: 2, bCons1h: 3, backlog: 0 } as DualBandwidthReading }).primitive === "photo");
  t("chat -> message with label", renderProjection({ kind: "chat", post: { seq: 1, from: "x", fromLabel: "codex:Work", text: "hi", ts: 0 } as RoomPost }).text.includes("codex:Work"));
  t("digest -> message", renderProjection({ kind: "digest", text: "morning" }).primitive === "message");
}

// --- composeDigest ---
{
  t("quiet night -> explicit", composeDigest({}, "2026-10-09").includes("quiet night"));
  const dg = composeDigest({ alerts: ["x blocked"], clearedReviews: ["BA9"], shipped: ["fanout r12"] }, "2026-10-09");
  t("alerts lead", dg.indexOf("needs you") < dg.indexOf("cleared"));
  t("includes a cleared review", dg.includes("BA9"));
}

// --- the enforced decision still validates at the ledger boundary ---
{
  t("enforced hard-gate decision is a legal ledger Decision", validDecision(enforceScope(hard, { id: "n2", verdict: "approve", scope: "always" })) !== null);
}

// --- proxy selection (pure; TG bridge bring-up) ---
{
  t("no env -> direct (null)", selectProxyUrl({}, "api.telegram.org") === null);
  t("HTTPS_PROXY picked", selectProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:10808" }, "api.telegram.org") === "http://127.0.0.1:10808");
  t("lowercase https_proxy picked", selectProxyUrl({ https_proxy: "http://p:1" }, "x.y") === "http://p:1");
  t("HTTP_PROXY fallback", selectProxyUrl({ HTTP_PROXY: "http://p:2" }, "x.y") === "http://p:2");
  t("HTTPS_PROXY wins over HTTP_PROXY", selectProxyUrl({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" }, "x.y") === "http://a:1");
  t("NO_PROXY exact host -> direct", selectProxyUrl({ HTTPS_PROXY: "http://p:1", NO_PROXY: "api.telegram.org" }, "api.telegram.org") === null);
  t("NO_PROXY .suffix -> direct", selectProxyUrl({ HTTPS_PROXY: "http://p:1", NO_PROXY: ".telegram.org" }, "api.telegram.org") === null);
  t("NO_PROXY bare suffix -> direct", selectProxyUrl({ HTTPS_PROXY: "http://p:1", NO_PROXY: "telegram.org" }, "api.telegram.org") === null);
  t("NO_PROXY * -> direct", selectProxyUrl({ HTTPS_PROXY: "http://p:1", NO_PROXY: "*" }, "x.y") === null);
  t("NO_PROXY non-match -> proxied", selectProxyUrl({ HTTPS_PROXY: "http://p:1", NO_PROXY: "other.com" }, "api.telegram.org") === "http://p:1");
}

// --- inbound immediacy receipts (pure) ---
{
  const vr = buildTgVerdictReceipt("b1", "n2", "approve", "once");
  t("verdict receipt taskRef=tg-verdict", vr.taskRef === "tg-verdict");
  t("verdict receipt text has batch/item/verdict/scope", vr.text.includes("b1") && vr.text.includes("n2") && vr.text.includes("approve") && vr.text.includes("once"));
  t("verdict receipt no scope omits scope=", !buildTgVerdictReceipt("b1", "n2", "reject").text.includes("scope="));
  const mr = buildTgMessageReceipt(123, "hello there");
  t("message receipt taskRef=tg-message", mr.taskRef === "tg-message");
  t("message receipt text has chat+body", mr.text.includes("123") && mr.text.includes("hello there"));
  t("message receipt clips long text", buildTgMessageReceipt(1, "x".repeat(600)).text.length < 560);
  t("ack text is a short read-receipt", typeof TG_ACK_TEXT === "string" && TG_ACK_TEXT.length > 0 && TG_ACK_TEXT.length < 40);
}

// --- idempotency key for forwarded TG events (pure; TGP-3) ---
{
  t("verdict key stable per batch+item", tgIdempotencyKey("tg-verdict", "b1", "n2") === "tg-verdict.b1.n2");
  t("same event -> same key (replay dedups)", tgIdempotencyKey("tg-msg", 42) === tgIdempotencyKey("tg-msg", 42));
  t("distinct events -> distinct keys", tgIdempotencyKey("tg-verdict", "b1", "n2") !== tgIdempotencyKey("tg-verdict", "b1", "n3"));
  t("unsafe chars folded to _", tgIdempotencyKey("tg-verdict", "b/1", "n:2").replace(/[A-Za-z0-9._-]/g, "") === "");
  t("key is writeInbox-contract compliant (<=120, charset)", /^[A-Za-z0-9._-]{1,120}$/.test(tgIdempotencyKey("tg-msg", "x".repeat(400))));
}

console.log("all tg-entry selftests passed");
