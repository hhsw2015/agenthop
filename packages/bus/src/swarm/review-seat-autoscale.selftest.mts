import {
  filterLiveRecords,
  queueDepth,
  canRouteToSeat,
  selectSeatToReclaim,
  scaleDecision,
  buildReviewSeatBirthCert,
  parseReviewFileName,
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

console.log("all review-seat-autoscale selftests passed");
