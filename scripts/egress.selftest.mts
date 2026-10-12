// Selftest for the egress CLI's pure helpers (classifyArgs + foldEvents). The chain/store are covered by
// packages/bus/src/swarm/egress-ledger.selftest.mts; this is the thin arg/format layer.
//   npx tsx scripts/egress.selftest.mts
import { classifyArgs, foldEvents } from "./egress.js";
import { chainEntry, type EgressEntry, type EgressBody } from "../packages/bus/src/swarm/egress-ledger.js";

let pass = 0;
const t = (n: string, c: boolean): void => { if (!c) { console.error(`FAIL ${n}`); process.exit(1); } pass++; console.log(`ok  ${n}`); };

// ── classifyArgs ──
t("classify: list", classifyArgs(["list"]).mode === "list");
t("classify: verify", classifyArgs(["verify"]).mode === "verify");
t("classify: empty ⇒ usage (no error)", (() => { const q = classifyArgs([]); return q.mode === "usage" && q.error === undefined; })());
t("classify: unknown ⇒ usage with error", (() => { const q = classifyArgs(["bogus"]); return q.mode === "usage" && typeof q.error === "string"; })());
t("classify: list with extra arg ⇒ usage error", (() => { const q = classifyArgs(["list", "x"]); return q.mode === "usage" && !!q.error; })());
t("classify: verify with extra arg ⇒ usage error", (() => { const q = classifyArgs(["verify", "x"]); return q.mode === "usage" && !!q.error; })());

// ── foldEvents: one row per event, intent order, result paired or "pending" ──
const b = (body: EgressBody, prev: EgressEntry | null): EgressEntry => chainEntry(prev, body);
{
  const e0 = b({ kind: "intent", eventId: "a", tsSec: 1000, destHost: "relay.example", callFace: "relay.post", initiatorSid: "sidA" }, null);
  const e1 = b({ kind: "result", eventId: "a", tsSec: 1001, byteMagnitude: "<64K", outcome: "ok" }, e0);
  const e2 = b({ kind: "intent", eventId: "z", tsSec: 1002, destHost: "api.example", callFace: "update.download", initiatorSid: "sidB" }, e1); // no result ⇒ pending
  const rows = foldEvents([e0, e1, e2]);
  t("fold: one row per event in intent order", rows.length === 2);
  t("fold: paired result shows magnitude + outcome", rows[0]!.includes("relay.example") && rows[0]!.includes("<64K ok"));
  t("fold: an unpaired intent shows pending", rows[1]!.includes("api.example") && rows[1]!.includes("pending"));
  t("fold: a result arriving before its intent is ignored for ordering (no duplicate row)", foldEvents([e1, e0]).length === 1);
}

console.log(`\nall egress CLI selftests passed (${pass})`);
