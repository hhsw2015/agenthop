// Standalone selftest for the swarm-console mod's PURE read/parse/format core. Run: tsx test/read.selftest.mts
// Verifies happy-path parsing AND fail-soft (malformed/missing/wrong-schema ⇒ null, NEVER throws — a throw would break the host CC
// session) PLUS the review fixes: SCM-P2-1 (unknown-not-green gauge, board itemId/posted filename), SCM-P2-2 (fingerprint binds the
// seen item), SCM-N1 (console-decisions/v1 + console-roster/v1 envelopes).
import {
  parseGauge, parseDigest, parseBoardName, parseBoardFile, sortBoard, parseDecisionMirror, parseBatch, parseRoster,
  bandSummary, pendingLabel, cardOptions, decisionPrefill, decisionFingerprint, decisionCards,
  type DecisionItemView, type DecisionBatchView,
} from "../hooks/read.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };

// ── gauge (SCM-P2-1: corrupt ⇒ unknown, never a false-healthy green/zero) ──
{
  const g = parseGauge('{"schema":"bandwidth-gauge/v1","zone":"amber","ratio":0.93,"backlog":7}');
  ok(g !== null && g.zone === "amber" && g.ratio === 0.93 && g.backlog === 7, "parseGauge: valid v1");
  const gnull = parseGauge('{"schema":"bandwidth-gauge/v1","zone":"green","ratio":null,"backlog":0}');
  ok(gnull !== null && gnull.zone === "green" && gnull.ratio === null && gnull.backlog === 0, "parseGauge: legit null ratio kept");
  ok(parseGauge('{"schema":"other","zone":"red"}') === null, "parseGauge: wrong schema ⇒ null");
  ok(parseGauge("not json") === null, "parseGauge: malformed ⇒ null (no throw)");
  const g2 = parseGauge('{"schema":"bandwidth-gauge/v1","zone":"nonsense","ratio":"x","backlog":"y"}');
  ok(g2 !== null && g2.zone === "unknown" && g2.ratio === null && g2.backlog === null, "parseGauge: bad fields ⇒ UNKNOWN (not green/0)");
}
// ── digest ──
{
  const d = parseDigest('{"schema":"morning-digest/v1","date":"2026-10-11","sections":[{"title":"signed","lines":["a","b"]},{"title":"x","lines":[1,"c"]}]}');
  ok(d !== null && d.date === "2026-10-11" && d.sections.length === 2 && d.sections[0]!.lines.length === 2 && d.sections[1]!.lines.length === 1, "parseDigest: valid, non-string lines filtered");
  ok(parseDigest('{"schema":"x"}') === null, "parseDigest: wrong schema ⇒ null");
  ok(parseDigest("{bad") === null, "parseDigest: malformed ⇒ null");
}
// ── board (SCM-P2-1: posted `<itemId>.json` + body `itemId` OR `id`) ──
{
  ok(JSON.stringify(parseBoardName("my-task.claimed.3e097dfe.json")) === JSON.stringify({ state: "claimed", owner: "3e097dfe" }), "parseBoardName: claimed state+owner from filename");
  ok(JSON.stringify(parseBoardName("job__node.json")) === JSON.stringify({ state: "posted", owner: "" }), "parseBoardName: single-segment ⇒ posted (SCM-P2-1 was rejecting these)");
  ok(JSON.stringify(parseBoardName("x.done.json")) === JSON.stringify({ state: "done", owner: "" }), "parseBoardName: two-segment <id>.<state>");
  ok(parseBoardName("x.y.z.txt") === null, "parseBoardName: non-json ⇒ null");
  const rItem = parseBoardFile("job__node.json", '{"itemId":"job__node","goal":"G","postedBy":"curator"}');
  ok(rItem !== null && rItem.id === "job__node" && rItem.state === "posted" && rItem.owner === "curator" && rItem.goal === "G", "parseBoardFile: formal board itemId + posted filename");
  const rId = parseBoardFile("coord-console.done.90b58f9c.json", '{"id":"coord-console","title":"T","goal":"G"}');
  ok(rId !== null && rId.id === "coord-console" && rId.state === "done" && rId.owner === "90b58f9c" && rId.title === "T", "parseBoardFile: coordinator board id");
  ok(parseBoardFile("a.b.c.json", '{"title":"no id/itemId"}') === null, "parseBoardFile: missing id AND itemId ⇒ null");
  ok(parseBoardFile("a.b.c.json", "nope") === null, "parseBoardFile: malformed ⇒ null");
  const sorted = sortBoard([
    { id: "z", state: "claimed", owner: "o", title: "", goal: "" },
    { id: "a", state: "claimed", owner: "o", title: "", goal: "" },
    { id: "m", state: "active", owner: "o", title: "", goal: "" },
  ]);
  ok(sorted.map((x) => x.id).join(",") === "m,a,z", "sortBoard: by state then id, deterministic");
}
// ── decisions ENVELOPE (SCM-N1: console-decisions/v1 wraps the verbatim batch at .batch) + SCM-P2-1 completeness ──
{
  // an id-less item is DROPPED ⇒ the batch is INCOMPLETE (complete:false), not silently a confident shorter list.
  const env = '{"schema":"console-decisions/v1","generatedAtSec":1791762820,"batch":{"batchId":"B1","owner":"fe0376cd","createdAtSec":1,"items":[{"id":"i1","kind":"呈批","summary":"s1","suggestedAction":"approve","hardGate":true},{"id":"","summary":"skip-no-id"}]}}';
  const b = parseDecisionMirror(env);
  ok(b !== null && b.view.batchId === "B1" && b.view.items.length === 1 && b.view.items[0]!.id === "i1" && b.view.items[0]!.hardGate === true, "parseDecisionMirror: envelope ⇒ .batch, id-less item dropped");
  ok(b !== null && b.complete === false, "parseDecisionMirror: dropped item ⇒ complete:false (SCM-P2-1 incomplete)");
  const good = parseDecisionMirror('{"schema":"console-decisions/v1","generatedAtSec":1,"batch":{"batchId":"B9","owner":"o","createdAtSec":1,"items":[{"id":"a","summary":"s","suggestedAction":"x"}]}}');
  ok(good !== null && good.complete === true, "parseDecisionMirror: all items valid ⇒ complete:true");
  const noItems = parseDecisionMirror('{"schema":"console-decisions/v1","generatedAtSec":1,"batch":{"batchId":"B8","owner":"o","createdAtSec":1}}');
  ok(noItems !== null && noItems.view.items.length === 0 && noItems.complete === false, "parseDecisionMirror: missing items array ⇒ complete:false");
  ok(parseDecisionMirror('{"batchId":"B1","items":[]}') === null, "parseDecisionMirror: bare batch (no envelope) ⇒ null (UNKNOWN)");
  ok(parseDecisionMirror('{"schema":"other","batch":{"batchId":"B"}}') === null, "parseDecisionMirror: wrong envelope schema ⇒ null");
  ok(parseDecisionMirror('{"schema":"console-decisions/v1"}') === null, "parseDecisionMirror: envelope without .batch ⇒ null");
  ok(parseDecisionMirror("{bad") === null, "parseDecisionMirror: malformed ⇒ null");
  const bb = parseBatch({ batchId: "B2", owner: "o", items: [{ id: "x", summary: "s" }] });
  ok(bb !== null && bb.view.items.length === 1 && bb.view.items[0]!.id === "x" && bb.complete === true, "parseBatch: direct batch object, complete");
}
// ── roster ENVELOPE (SCM-N1: console-roster/v1, seats {sid,tool,pane,alive,inflight}) ──
{
  const r = parseRoster('{"schema":"console-roster/v1","generatedAtSec":1,"seats":[{"sid":"f32a0507","tool":"claude","pane":"p1","alive":"alive","inflight":2},{"sid":"","alive":"x"},{"sid":"c0","tool":"codex","pane":null,"alive":"bogus","inflight":-5}]}');
  ok(r !== null && r.length === 2 && r[0]!.sid === "f32a0507" && r[0]!.alive === "alive" && r[0]!.inflight === 2, "parseRoster: valid seat");
  ok(r !== null && r[1]!.sid === "c0" && r[1]!.alive === "unknown" && r[1]!.inflight === 0 && r[1]!.pane === null, "parseRoster: bad alive⇒unknown, neg inflight⇒0, sidless skipped");
  ok(parseRoster('{"seats":[{"sid":"a"}]}') === null, "parseRoster: no envelope schema ⇒ null");
  ok(parseRoster('{"schema":"console-roster/v1","nope":1}') === null, "parseRoster: no seats ⇒ null");
}
// ── band summary + pendingLabel (SCM-P2-1: known vs unknown, never a false confident 0) ──
{
  const full = bandSummary({ roster: [{ sid: "a", tool: "claude", pane: null, alive: "alive", inflight: 0 }, { sid: "b", tool: "codex", pane: null, alive: "dead", inflight: 0 }], pending: { known: 3, unknown: 0 }, gauge: { zone: "amber", ratio: 0.9, backlog: 7 } });
  ok(full.includes("席:1/2") && full.includes("待裁:3") && full.includes("amber"), "bandSummary: full line (alive seats counted)");
  const unk = bandSummary({ roster: null, pending: null, gauge: null });
  ok(unk.includes("席:源未产") && unk.includes("待裁:?") && unk.includes("带宽:源未产"), "bandSummary: unproduced/unknown ⇒ placeholders (待裁:? not 0)");
  const emptyDecisions = bandSummary({ roster: [], pending: { known: 0, unknown: 0 }, gauge: { zone: "unknown", ratio: null, backlog: null } });
  ok(emptyDecisions.includes("待裁:0") && emptyDecisions.includes("带宽:?unknown"), "bandSummary: confirmed-empty ⇒ 待裁:0; unknown zone glyph");
  // SCM-P2-1: a confirmed count PLUS unread/corrupt files must show the unknown part, never a bare confident number.
  ok(pendingLabel(null) === "待裁:?", "pendingLabel: dir unknown ⇒ 待裁:?");
  ok(pendingLabel({ known: 0, unknown: 0 }) === "待裁:0", "pendingLabel: all read, empty ⇒ 待裁:0");
  ok(pendingLabel({ known: 2, unknown: 0 }) === "待裁:2", "pendingLabel: all read ⇒ exact 待裁:2");
  ok(pendingLabel({ known: 1, unknown: 1 }) === "待裁:1+1?", "pendingLabel: 1 known + 1 unread ⇒ 待裁:1+1? (never a confident 1)");
  ok(pendingLabel({ known: 0, unknown: 2 }) === "待裁:0+2?", "pendingLabel: only unreadable files ⇒ 待裁:0+2? (not 待裁:0)");
}
// ── decision options + prefill + fingerprint (SCM-P2-2) ──
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
  // SCM-P2-2: a content change flips the fingerprint ⇒ the host refuses to prefill the stale target.
  const changed: DecisionItemView = { ...soft, summary: "do Y" };
  ok(decisionFingerprint(soft) !== decisionFingerprint(changed), "decisionFingerprint: summary change ⇒ different fp");
  const changedAction: DecisionItemView = { ...soft, suggestedAction: "reject" };
  ok(decisionFingerprint(soft) !== decisionFingerprint(changedAction), "decisionFingerprint: suggestedAction change ⇒ different fp");
  ok(decisionFingerprint(soft) === decisionFingerprint({ ...soft }), "decisionFingerprint: identical content ⇒ same fp");
  // SCM-P2-2 (this round): evidenceRef is BOUND, and the encoding is UNAMBIGUOUS (no U+0000 concat collision).
  const ev1: DecisionItemView = { ...soft, evidenceRef: "docs/a.md:1" };
  const ev2: DecisionItemView = { ...soft, evidenceRef: "docs/b.md:9" };
  const evNone: DecisionItemView = { ...soft };
  ok(decisionFingerprint(ev1) !== decisionFingerprint(ev2), "decisionFingerprint: evidenceRef change ⇒ different fp (now bound)");
  ok(decisionFingerprint(ev1) !== decisionFingerprint(evNone), "decisionFingerprint: adding/removing evidenceRef ⇒ different fp");
  ok(decisionFingerprint({ ...soft, evidenceRef: "" }) !== decisionFingerprint(evNone), "decisionFingerprint: empty evidenceRef ≠ absent (null vs \"\")");
  // old U+0000 concat collided: ("a\0b","c") vs ("a","b\0c") hashed the same. JSON encoding keeps them distinct.
  const collA: DecisionItemView = { id: "x", kind: "k", summary: "a\u0000b", suggestedAction: "c", hardGate: false };
  const collB: DecisionItemView = { id: "x", kind: "k", summary: "a", suggestedAction: "b\u0000c", hardGate: false };
  ok(decisionFingerprint(collA) !== decisionFingerprint(collB), "decisionFingerprint: U+0000 in a field no longer collides (unambiguous JSON encoding)");
}
// ── decisionCards: all items flattened (SCM-P3-1 browse-all), each self-describing ──
{
  const batches: DecisionBatchView[] = [
    { batchId: "A", owner: "o", items: [{ id: "a1", kind: "k", summary: "s1", suggestedAction: "approve", hardGate: false }, { id: "a2", kind: "k", summary: "s2", suggestedAction: "defer", hardGate: true }] },
    { batchId: "B", owner: "o", items: [{ id: "b1", kind: "k", summary: "s3", suggestedAction: "reject", hardGate: false }] },
  ];
  const cards = decisionCards(batches);
  ok(cards.length === 3, "decisionCards: ALL items across batches (not capped at 9)");
  ok(cards[0]!.batchId === "A" && cards[0]!.itemId === "a1" && cards[0]!.options.length === 4 && cards[0]!.fp === decisionFingerprint(batches[0]!.items[0]!), "decisionCards: card carries batchId/itemId/options/fp of the seen item");
  ok(cards[1]!.options.length === 3, "decisionCards: hardGate card has no this-chat option");
  ok(decisionCards([]).length === 0, "decisionCards: empty ⇒ []");
  // JsonValue-clean: a card is passed verbatim as Client props — a single `undefined` value makes the mod runtime REFUSE the
  // whole pane ("props holds undefined"). An item with no evidenceRef must OMIT the key, never carry `evidenceRef: undefined`.
  const noEvidence = decisionCards([{ batchId: "C", owner: "o", items: [{ id: "c1", kind: "k", summary: "s", suggestedAction: "approve", hardGate: true }] }]);
  const hasUndefined = (v: unknown): boolean => v === undefined || (Array.isArray(v) ? v.some(hasUndefined) : typeof v === "object" && v !== null ? Object.values(v).some(hasUndefined) : false);
  ok(!("evidenceRef" in noEvidence[0]!), "decisionCards: no evidenceRef ⇒ key OMITTED (not undefined)");
  ok(!hasUndefined(cards) && !hasUndefined(noEvidence), "decisionCards: JsonValue-clean (no undefined anywhere — Client props safety)");
}

console.log(`\nall swarm-console read selftests passed (${pass})`);
