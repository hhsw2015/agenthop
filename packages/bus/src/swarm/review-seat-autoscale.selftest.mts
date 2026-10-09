import {
  filterLiveRecords,
  queueDepth,
  canRouteToSeat,
  selectSeatToReclaim,
  scaleDecision,
  planAutoscaleSuggestion,
  instantaneousWant,
  buildSeatStatesFromLedger,
  buildReviewSeatBirthCert,
  parseReviewFileName,
  isValidReviewId,
  type ReviewRecord,
  type SeatState,
  type ScaleConfig,
} from "./review-seat-autoscale.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const rec = (ticket: string, seat: string, author: string, done = false): ReviewRecord => ({ ticket, seat, author, sha: "x", sentSec: 0, done });
const seat = (id: string, o: Partial<SeatState> = {}): SeatState => ({ seat: id, live: true, idle: true, inFlight: 0, completedReviews: 1, spawnedSec: 0, floor: false, ...o });
const CFG: ScaleConfig = { kUp: 2, kDown: 1, floor: 2, sustainSec: 60, minDwellSec: 120 };

// --- filterLiveRecords: phantom-depth guard ---
const recs = [rec("a", "s1", "alice"), rec("b", "s1", "ghost"), rec("c", "s2", "alice", true)];
const live = filterLiveRecords(recs, new Set(["alice"]), new Set(["s1", "s2"]));
t("live filter drops dead author", live.length === 1 && live[0].ticket === "a");
t("live filter drops done records", !live.some((r) => r.done));
t("live filter drops dead seat", filterLiveRecords([rec("a", "dead", "alice")], new Set(["alice"]), new Set(["s1"])).length === 0);

// --- queueDepth ---
const q = queueDepth([rec("a", "s1", "x"), rec("b", "s1", "x"), rec("c", "s2", "x")]);
t("queueDepth total", q.totalOpen === 3);
t("queueDepth per-seat", q.perSeat["s1"] === 2 && q.perSeat["s2"] === 1);
// T55-P2-2: seat names that collide with Object.prototype keys must count as plain keys (null-proto map)
const qp = queueDepth([rec("a", "toString", "x"), rec("b", "constructor", "x"), rec("c", "__proto__", "x"), rec("d", "toString", "x")]);
t("T55-P2-2: prototype-key seats count numerically", qp.perSeat["toString"] === 2 && qp.perSeat["constructor"] === 1 && qp.perSeat["__proto__"] === 1);
t("T55-P2-2: Σ per-seat === totalOpen", Object.values(qp.perSeat).reduce((a, b) => a + b, 0) === qp.totalOpen && qp.totalOpen === 4);

// --- canRouteToSeat: amendment ② slow-start band ---
t("fresh seat blocks P0", canRouteToSeat({ priority: 0 }, { completedReviews: 0 }) === false);
t("fresh seat blocks P1", canRouteToSeat({ priority: 1 }, { completedReviews: 0 }) === false);
t("fresh seat allows P2", canRouteToSeat({ priority: 2 }, { completedReviews: 0 }) === true);
t("fresh seat allows P3", canRouteToSeat({ priority: 3 }, { completedReviews: 0 }) === true);
t("fresh seat allows small P0", canRouteToSeat({ priority: 0, small: true }, { completedReviews: 0 }) === true);
t("fresh seat REJECTS absent-priority (fail-closed, reviewer Q2)", canRouteToSeat({}, { completedReviews: 0 }) === false);
t("fresh seat REJECTS absent-priority non-small", canRouteToSeat({ small: false }, { completedReviews: 0 }) === false);
t("experienced seat takes P0", canRouteToSeat({ priority: 0 }, { completedReviews: 1 }) === true);
t("experienced seat takes absent-priority", canRouteToSeat({}, { completedReviews: 1 }) === true);

// --- selectSeatToReclaim: amendment ① idle + in-flight=0, never floor, never mid-review ---
t("reclaim picks idle+empty non-floor", selectSeatToReclaim([seat("f1", { floor: true }), seat("f2", { floor: true }), seat("x", { spawnedSec: 10 })]) === "x");
t("reclaim NEVER a busy (in-flight>0) seat even if newest", selectSeatToReclaim([seat("x", { spawnedSec: 10, inFlight: 1 })]) === null);
t("reclaim NEVER a non-idle seat", selectSeatToReclaim([seat("x", { spawnedSec: 10, idle: false })]) === null);
t("reclaim NEVER a dead seat", selectSeatToReclaim([seat("x", { live: false })]) === null);
t("reclaim NEVER a floor seat", selectSeatToReclaim([seat("f", { floor: true })]) === null);
t("reclaim newest among eligible (seniority preserved)", selectSeatToReclaim([seat("old", { spawnedSec: 5 }), seat("new", { spawnedSec: 99 })]) === "new");
t("all busy -> null (don't scale down, wait)", selectSeatToReclaim([seat("a", { inFlight: 2 }), seat("b", { idle: false })]) === null);

// --- scaleDecision ---
const twoSeats = [seat("s1", { floor: true }), seat("s2", { floor: true })];
const threeSeats = [...twoSeats, seat("s3", { spawnedSec: 10 })];
// scale-up: total > n*kUp (2 seats * 2 = 4), sustained, dwell elapsed
t("scale-up when deep + sustained + dwell", scaleDecision({ totalOpen: 5, perSeat: {} }, twoSeats, CFG, 999, 60).action === "scale-up");
t("hold when deep but NOT sustained", scaleDecision({ totalOpen: 5, perSeat: {} }, twoSeats, CFG, 999, 30).action === "hold");
t("hold when deep but min-dwell not elapsed", scaleDecision({ totalOpen: 5, perSeat: {} }, twoSeats, CFG, 10, 999).action === "hold");
t("hold in band (4 open, 2 seats, not > 4 and not < kDown band)", scaleDecision({ totalOpen: 4, perSeat: {} }, twoSeats, CFG, 999, 999).action === "hold");
// scale-down: total < (n-1)*kDown; 3 seats -> (3-1)*1 = 2; open=1 < 2, eligible s3
const down = scaleDecision({ totalOpen: 1, perSeat: {} }, threeSeats, CFG, 999, 60);
t("scale-down drains to eligible seat", down.action === "scale-down" && (down as any).seat === "s3");
t("hold at floor (2 seats never scale down)", scaleDecision({ totalOpen: 0, perSeat: {} }, twoSeats, CFG, 999, 999).action === "hold");
// Q1: below floor (a standing seat crashed) -> hold; autoscaler does NOT top up, the roster does (F22)
t("below floor -> hold even with deep queue (roster restores, reviewer Q1)", scaleDecision({ totalOpen: 99, perSeat: {} }, [seat("s1", { floor: true })], CFG, 999, 999).action === "hold");
t("below floor reason names the roster", (scaleDecision({ totalOpen: 99, perSeat: {} }, [], CFG, 999, 999) as any).reason.includes("below floor"));
t("down but no eligible seat -> hold+wait", scaleDecision({ totalOpen: 1, perSeat: {} }, [...twoSeats, seat("s3", { inFlight: 1 })], CFG, 999, 999).action === "hold");
t("down not sustained -> hold", scaleDecision({ totalOpen: 1, perSeat: {} }, threeSeats, CFG, 999, 30).action === "hold");
// hysteresis gap: with kUp=2,kDown=1 and 3 seats, open=3 is neither up(>6) nor down(<2) -> hold (no churn)
t("hysteresis band -> hold (no flap)", scaleDecision({ totalOpen: 3, perSeat: {} }, threeSeats, CFG, 999, 999).action === "hold");

// --- birth cert ---
const bc = buildReviewSeatBirthCert(3, "/repo");
t("birth cert reviewer/codex/heavy", bc.roleProfile === "reviewer" && bc.tool === "codex" && bc.modelTier === "heavy");
t("birth cert label", bc.seatLabel === "review-seat-3" && bc.cwd === "/repo");

// --- parseReviewFileName ---
t("parse open", JSON.stringify(parseReviewFileName("remote-herdr-view.codex-work.json")) === JSON.stringify({ ticket: "remote-herdr-view", seat: "codex-work", done: false }));
t("parse done", parseReviewFileName("t5-5.happycapy.done.json")?.done === true);
t("parse done seat/ticket", JSON.stringify(parseReviewFileName("t5-5.happycapy.done.json")) === JSON.stringify({ ticket: "t5-5", seat: "happycapy", done: true }));
t("parse non-json -> null", parseReviewFileName("notes.txt") === null);
t("parse missing seat -> null", parseReviewFileName("ticketonly.json") === null);

// T55-P2-3: filename encoding round-trips for conforming ids; non-conforming ids rejected (not misparsed)
t("isValidReviewId: kebab ok", isValidReviewId("remote-herdr-view") && isValidReviewId("t5_5"));
t("isValidReviewId: dot rejected", !isValidReviewId("a.b"));
t("isValidReviewId: 'done' reserved", !isValidReviewId("done"));
t("isValidReviewId: empty rejected", !isValidReviewId(""));
for (const [tk, st2] of [["remote-herdr-view", "codex-work"], ["t5-5", "happycapy"]] as const) {
  t(`T55-P2-3 round-trip open ${tk}.${st2}`, JSON.stringify(parseReviewFileName(`${tk}.${st2}.json`)) === JSON.stringify({ ticket: tk, seat: st2, done: false }));
  t(`T55-P2-3 round-trip done ${tk}.${st2}`, JSON.stringify(parseReviewFileName(`${tk}.${st2}.done.json`)) === JSON.stringify({ ticket: tk, seat: st2, done: true }));
}
t("T55-P2-3: seat 'done' open file not misread as done-marker", parseReviewFileName("x.done.json") === null);
t("T55-P2-3: dotted ticket rejected (no mis-split)", parseReviewFileName("a.b.c.json") === null);

// --- instantaneousWant: the raw want before the sustain/dwell gates (for cross-tick sustain tracking) ---
t("instantaneousWant up (deep)", instantaneousWant({ totalOpen: 5, perSeat: {} }, twoSeats, CFG) === "up");
t("instantaneousWant none (in band)", instantaneousWant({ totalOpen: 4, perSeat: {} }, twoSeats, CFG) === "none");
t("instantaneousWant down (drained, >floor)", instantaneousWant({ totalOpen: 1, perSeat: {} }, threeSeats, CFG) === "down");
t("instantaneousWant none at floor (never down below floor)", instantaneousWant({ totalOpen: 0, perSeat: {} }, twoSeats, CFG) === "none");
t("instantaneousWant none below floor (roster restores)", instantaneousWant({ totalOpen: 99, perSeat: {} }, [seat("s1", { floor: true })], CFG) === "none");

// --- buildSeatStatesFromLedger: derive SeatState[] for suggestion mode from ledger + presence ---
const bl = buildSeatStatesFromLedger([rec("a", "s1", "x"), rec("b", "s1", "x"), rec("c", "s2", "x"), rec("d", "s2", "x", true)], new Set(["s1", "s2"]), CFG, 1000);
const bS1 = bl.find((s) => s.seat === "s1")!, bS2 = bl.find((s) => s.seat === "s2")!;
t("buildSeatStates: inFlight = open records per seat", bS1.inFlight === 2 && bS2.inFlight === 1);
t("buildSeatStates: completedReviews = done records per seat", bS2.completedReviews === 1 && bS1.completedReviews === 0);
t("buildSeatStates: live from presence set", bS1.live === true && bS2.live === true);
t("buildSeatStates: idle = inFlight===0 (ledger proxy)", bS1.idle === false && buildSeatStatesFromLedger([rec("d", "s2", "x", true)], new Set(["s2"]), CFG, 1000)[0]!.idle === true);
t("buildSeatStates: a ledger seat NOT in presence is not live", buildSeatStatesFromLedger([rec("a", "dead", "x")], new Set<string>(), CFG, 1000)[0]!.live === false);
t("buildSeatStates: floor marks the cfg.floor most-senior LIVE seats", (() => { const r = buildSeatStatesFromLedger([{ ...rec("a", "old", "x"), sentSec: 5 }, { ...rec("b", "new", "x"), sentSec: 50 }, { ...rec("c", "newest", "x"), sentSec: 99 }], new Set(["old", "new", "newest"]), CFG, 1000); return r.find((s) => s.seat === "old")!.floor && r.find((s) => s.seat === "new")!.floor && !r.find((s) => s.seat === "newest")!.floor; })());
t("buildSeatStates: prototype-key seat names are plain keys (Map-based)", (() => { const r = buildSeatStatesFromLedger([rec("a", "toString", "x"), rec("b", "__proto__", "x")], new Set(["toString", "__proto__"]), CFG, 1000); return r.length === 2 && r.every((s) => s.inFlight === 1); })());

// --- planAutoscaleSuggestion: suggestion mode (compose filter→depth→scaleDecision→render; NEVER acts) ---
const upRecs = [rec("t1", "s1", "alice"), rec("t2", "s1", "alice"), rec("t3", "s2", "alice"), rec("t4", "s2", "alice"), rec("t5", "s1", "alice")]; // 5 live open
const upSug = planAutoscaleSuggestion({ records: upRecs, liveAuthors: new Set(["alice"]), liveSeats: new Set(["s1", "s2"]), seats: twoSeats, cfg: CFG, sinceLastActionSec: 999, sustainedSec: 60 });
t("suggest scale-up: non-null, action scale-up, text advises spawning", upSug !== null && upSug.action.action === "scale-up" && upSug.text.includes("SUGGEST spawning"));
const holdSug = planAutoscaleSuggestion({ records: [rec("t1", "s1", "alice"), rec("t2", "s2", "alice")], liveAuthors: new Set(["alice"]), liveSeats: new Set(["s1", "s2"]), seats: twoSeats, cfg: CFG, sinceLastActionSec: 999, sustainedSec: 999 });
t("suggest hold -> null (nothing to advise)", holdSug === null);
// phantom-depth guard feeds the suggestion: 5 records but 3 by a dead author ⇒ only 2 live ⇒ in band ⇒ no needless suggestion
const phantomSug = planAutoscaleSuggestion({ records: [rec("t1", "s1", "alice"), rec("t2", "s2", "alice"), rec("g1", "s1", "ghost"), rec("g2", "s1", "ghost"), rec("g3", "s2", "ghost")], liveAuthors: new Set(["alice"]), liveSeats: new Set(["s1", "s2"]), seats: twoSeats, cfg: CFG, sinceLastActionSec: 999, sustainedSec: 60 });
t("suggest: a dead-author phantom depth does NOT trigger a scale-up suggestion", phantomSug === null);
const downSug = planAutoscaleSuggestion({ records: [rec("t1", "s1", "alice")], liveAuthors: new Set(["alice"]), liveSeats: new Set(["s1", "s2", "s3"]), seats: threeSeats, cfg: CFG, sinceLastActionSec: 999, sustainedSec: 60 });
t("suggest scale-down: non-null, names the eligible idle seat", downSug !== null && downSug.action.action === "scale-down" && downSug.text.includes('reclaiming idle seat "s3"'));
// not sustained ⇒ scaleDecision holds ⇒ no suggestion (debounce still governs advice, just not seats)
t("suggest: an un-sustained spike yields no suggestion (debounce)", planAutoscaleSuggestion({ records: upRecs, liveAuthors: new Set(["alice"]), liveSeats: new Set(["s1", "s2"]), seats: twoSeats, cfg: CFG, sinceLastActionSec: 999, sustainedSec: 10 }) === null);

console.log("all review-seat-autoscale selftests passed");
