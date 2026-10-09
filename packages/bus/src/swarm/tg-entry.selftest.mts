// Selftest for the TG entry pure core (render/parse, ref-based) + the shared CORE decision rules (allowedScopes /
// enforceScope / upsertDecision) + the digest. Run: node --import tsx packages/bus/src/swarm/tg-entry.selftest.mts
import { renderProjection, parseUpdate, encodeDecisionCb, parseCallback, type TgUpdate } from "./tg-entry.js";
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
  // a ref from a 64-char batchId is still hash10.index -> the callback is tiny:
  const longBatch = "B".repeat(64);
  const ref = `${"0123456789"}.${999}`; // shape the driver produces (sha256 slice(0,10) . index)
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

console.log("all tg-entry selftests passed");
