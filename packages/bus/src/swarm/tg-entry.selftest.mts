// Selftest for the TG entry pure core (render/parse) + the shared CORE decision extensions (allowedScopes) + the digest.
// Run: node --import tsx packages/bus/src/swarm/tg-entry.selftest.mts
import { renderProjection, parseUpdate, encodeDecisionCb, parseCallback, type EntryProjection, type TgUpdate } from "./tg-entry.js";
import { allowedScopes, validDecision, type DecisionItem } from "./decision-batch.js";
import { composeDigest } from "./morning-digest.js";
import type { DualBandwidthReading } from "./dual-bandwidth.js";
import type { RoomPost } from "./chat-room.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

const soft: DecisionItem = { id: "n1", kind: "merge", summary: "merge PR 7", suggestedAction: "approve" };
const hard: DecisionItem = { id: "n2", kind: "spend", summary: "pay $40 invoice", suggestedAction: "approve", hardGate: true };

// --- allowedScopes (CORE, shared by every entry) ---
{
  t("soft item -> 3 scopes", JSON.stringify(allowedScopes(soft)) === JSON.stringify(["once", "this-chat", "always"]));
  t("hard gate -> ONLY once (never always, R16)", JSON.stringify(allowedScopes(hard)) === JSON.stringify(["once"]));
}

// --- callback encode/parse round-trip ---
{
  t("encode/parse approve+scope round-trips", (() => { const c = parseCallback(encodeDecisionCb("b1", "n1", "approve", "this-chat")); return !!c && c.batchId === "b1" && c.id === "n1" && c.verdict === "approve" && c.scope === "this-chat"; })());
  t("reject carries no scope", (() => { const c = parseCallback(encodeDecisionCb("b1", "n1", "reject")); return !!c && c.verdict === "reject" && c.scope === undefined; })());
  t("malformed callback -> null", parseCallback("x|y|z") === null);
  t("non-decision callback -> null", parseCallback("other") === null);
}

// --- renderProjection ---
{
  const d = renderProjection({ kind: "decision", batchId: "b1", item: soft });
  t("soft decision: message + keyboard", d.primitive === "message" && !!d.keyboard);
  t("soft decision: approve row has 3 scope buttons", d.keyboard![0]!.length === 3);
  const h = renderProjection({ kind: "decision", batchId: "b1", item: hard });
  t("hard decision: approve row has ONLY 1 button (once)", h.keyboard![0]!.length === 1);
  t("hard decision: no 'always' button anywhere", !h.keyboard!.flat().some((b) => b.data.endsWith("|always")));
  t("hard decision: warned in text", h.text.startsWith("⚠"));
  const red = renderProjection({ kind: "bandwidth", reading: { zone: "red", bProd1h: 9, bCons1h: 1, backlog: 30 } as DualBandwidthReading });
  t("bandwidth RED -> pinned card", red.primitive === "pin" && red.attachment?.kind === "card");
  const green = renderProjection({ kind: "bandwidth", reading: { zone: "green", bProd1h: 2, bCons1h: 3, backlog: 0 } as DualBandwidthReading });
  t("bandwidth GREEN -> photo card", green.primitive === "photo");
  const chat = renderProjection({ kind: "chat", post: { seq: 1, from: "x", fromLabel: "codex:Work", text: "hi", ts: 0 } as RoomPost });
  t("chat -> message with label", chat.primitive === "message" && chat.text.includes("codex:Work"));
  t("digest -> message", renderProjection({ kind: "digest", text: "morning" }).primitive === "message");
}

// --- parseUpdate (allowlist + map to the single ledger) ---
{
  const allow = new Set([42]);
  t("off-allowlist chat_id -> ignore", parseUpdate({ chatId: 99, callbackData: encodeDecisionCb("b1", "n1", "approve", "once") }, allow, 100).kind === "ignore");
  t("no chat_id -> ignore", parseUpdate({ callbackData: "d|b1|n1|approve" }, allow, 100).kind === "ignore");
  const ok = parseUpdate({ chatId: 42, callbackData: encodeDecisionCb("b1", "n1", "approve", "once") }, allow, 100);
  t("allowlisted callback -> a one-decision DecisionsDoc", ok.kind === "decision" && ok.doc.batchId === "b1" && ok.doc.decisions[0]!.id === "n1" && ok.doc.decisions[0]!.verdict === "approve" && ok.doc.decisions[0]!.scope === "once");
  t("typed reply (no callback) -> ignore in v1", parseUpdate({ chatId: 42, text: "hello" }, allow, 100).kind === "ignore");
  t("malformed callback -> ignore", parseUpdate({ chatId: 42, callbackData: "garbage" }, allow, 100).kind === "ignore");
  // the written doc survives the ledger validator (so a TG verdict is a legal decision):
  const ok2 = parseUpdate({ chatId: 42, callbackData: encodeDecisionCb("b1", "n1", "approve", "always") }, allow, 100);
  t("TG verdict validates at the ledger boundary", ok2.kind === "decision" && validDecision(ok2.doc.decisions[0]) !== null);
}

// --- composeDigest ---
{
  t("quiet night -> explicit, never empty", composeDigest({}, "2026-10-09").includes("quiet night"));
  const d = composeDigest({ alerts: ["x blocked"], clearedReviews: ["BA9"], shipped: ["fanout r12"] }, "2026-10-09");
  t("alerts lead (needs you first)", d.indexOf("needs you") < d.indexOf("cleared"));
  t("digest includes a cleared review", d.includes("BA9"));
}

console.log("all tg-entry selftests passed");
