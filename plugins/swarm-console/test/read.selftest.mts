// Standalone selftest for the swarm-console mod's PURE read/parse/format core. Run: tsx test/read.selftest.mts
// Verifies happy-path parsing AND fail-soft (malformed/missing/wrong-schema ⇒ null, NEVER throws — a throw would break the host CC session).
import {
  parseGauge, parseDigest, parseBoardName, parseBoardFile, sortBoard, parseDecisionBatch, parseRoster,
  bandSummary, cardOptions, decisionPrefill, type DecisionItemView,
} from "../hooks/read.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };

// ── gauge ──
{
  const g = parseGauge('{"schema":"bandwidth-gauge/v1","zone":"amber","ratio":0.93,"backlog":7}');
  ok(g !== null && g.zone === "amber" && g.ratio === 0.93 && g.backlog === 7, "parseGauge: valid v1");
  ok(parseGauge('{"schema":"other","zone":"red"}') === null, "parseGauge: wrong schema ⇒ null");
  ok(parseGauge("not json") === null, "parseGauge: malformed ⇒ null (no throw)");
  const g2 = parseGauge('{"schema":"bandwidth-gauge/v1","zone":"nonsense","ratio":"x","backlog":"y"}');
  ok(g2 !== null && g2.zone === "green" && g2.ratio === null && g2.backlog === 0, "parseGauge: bad fields ⇒ safe defaults");
}
// ── digest ──
{
  const d = parseDigest('{"schema":"morning-digest/v1","date":"2026-10-11","sections":[{"title":"signed","lines":["a","b"]},{"title":"x","lines":[1,"c"]}]}');
  ok(d !== null && d.date === "2026-10-11" && d.sections.length === 2 && d.sections[0]!.lines.length === 2 && d.sections[1]!.lines.length === 1, "parseDigest: valid, non-string lines filtered");
  ok(parseDigest('{"schema":"x"}') === null, "parseDigest: wrong schema ⇒ null");
  ok(parseDigest("{bad") === null, "parseDigest: malformed ⇒ null");
}
// ── board ──
{
  ok(JSON.stringify(parseBoardName("my-task.claimed.3e097dfe.json")) === JSON.stringify({ state: "claimed", owner: "3e097dfe" }), "parseBoardName: state+owner from filename");
  ok(parseBoardName("flat.json") === null, "parseBoardName: too few segments ⇒ null");
  ok(parseBoardName("x.y.z.txt") === null, "parseBoardName: non-json ⇒ null");
  const r = parseBoardFile("coord-console.done.90b58f9c.json", '{"id":"coord-console","title":"T","goal":"G"}');
  ok(r !== null && r.id === "coord-console" && r.state === "done" && r.owner === "90b58f9c" && r.title === "T", "parseBoardFile: full row");
  ok(parseBoardFile("a.b.c.json", '{"title":"no id"}') === null, "parseBoardFile: missing id ⇒ null");
  ok(parseBoardFile("a.b.c.json", "nope") === null, "parseBoardFile: malformed ⇒ null");
  const sorted = sortBoard([
    { id: "z", state: "claimed", owner: "o", title: "", goal: "" },
    { id: "a", state: "claimed", owner: "o", title: "", goal: "" },
    { id: "m", state: "active", owner: "o", title: "", goal: "" },
  ]);
  ok(sorted.map((x) => x.id).join(",") === "m,a,z", "sortBoard: by state then id, deterministic");
}
// ── decisions ──
{
  const b = parseDecisionBatch('{"batchId":"B1","owner":"fe0376cd","items":[{"id":"i1","kind":"呈批","summary":"s1","suggestedAction":"approve","hardGate":true},{"id":"","summary":"skip-no-id"}]}');
  ok(b !== null && b.batchId === "B1" && b.items.length === 1 && b.items[0]!.id === "i1" && b.items[0]!.hardGate === true, "parseDecisionBatch: valid, id-less item skipped");
  ok(parseDecisionBatch('{"owner":"x"}') === null, "parseDecisionBatch: no batchId ⇒ null");
  ok(parseDecisionBatch("{bad") === null, "parseDecisionBatch: malformed ⇒ null");
}
// ── roster ──
{
  const r = parseRoster('{"seats":[{"name":"f32a0507","state":"working"},{"name":"","state":"x"},{"name":"happycapy"}]}');
  ok(r !== null && r.length === 2 && r[0]!.state === "working" && r[1]!.state === "unknown", "parseRoster: valid, nameless skipped, default state");
  ok(parseRoster('{"nope":1}') === null, "parseRoster: no seats ⇒ null");
}
// ── band summary (fail-soft placeholders for unproduced sources) ──
{
  const full = bandSummary({ roster: [{ name: "a", state: "working" }, { name: "b", state: "gone" }], pendingDecisions: 3, gauge: { zone: "amber", ratio: 0.9, backlog: 7 } });
  ok(full.includes("席:1/2") && full.includes("待裁:3") && full.includes("amber"), "bandSummary: full line");
  const none = bandSummary({ roster: null, pendingDecisions: null, gauge: null });
  ok(none.includes("席:源未产") && none.includes("待裁:源未产") && none.includes("带宽:—"), "bandSummary: unproduced ⇒ placeholders (fail-soft)");
}
// ── decision options + prefill (carries frozen decisions.json fields; hardGate restricts scope) ──
{
  const soft: DecisionItemView = { id: "i1", kind: "k", summary: "do X", suggestedAction: "approve", hardGate: false };
  const hard: DecisionItemView = { id: "i2", kind: "k", summary: "risky", suggestedAction: "approve", hardGate: true };
  const so = cardOptions(soft), ho = cardOptions(hard);
  ok(so.length === 4 && so[0]!.verdict === "approve" && so[1]!.scope === "this-chat" && so[2]!.verdict === "reject" && so[3]!.verdict === "defer", "cardOptions: soft item offers this-chat scope");
  ok(ho.length === 3 && !ho.some((o) => o.scope === "this-chat"), "cardOptions: hardGate item never offers broad scope");
  ok(so.every((o, i) => o.key === i + 1), "cardOptions: keys are 1..N contiguous");
  const pf = decisionPrefill("B1", soft, so[0]!);
  ok(pf.includes("batch=B1") && pf.includes("item=i1") && pf.includes("verdict=approve") && pf.includes("scope=once"), "decisionPrefill: carries frozen batchId/id/verdict/scope");
  const pfd = decisionPrefill("B1", soft, so[3]!);
  ok(pfd.includes("verdict=defer") && !pfd.includes("scope="), "decisionPrefill: defer carries no scope");
}

console.log(`\nall swarm-console read selftests passed (${pass})`);
