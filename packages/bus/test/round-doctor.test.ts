import { expect, test } from "vitest";
import {
  assessRoundHealth, detectDegradation, diagnoseRounds, buildRoundDoctorNote,
  roundDoctorEnabled, roundAlertN, parseRemainFromLine, parseNewPFromLine, parseRoundHistory,
  DEFAULT_ROUND_DOCTOR_CONFIG, type RoundRecord,
} from "../src/swarm/round-doctor.js";

/**
 * round-doctor (double-mirror ①) is SUGGESTION ONLY: it diagnoses a review/rework loop and advises the coordinator; it never
 * changes a disposition. Tests cover the two pure signals (over-long rounds, cascade degradation), the safe "unknown" direction,
 * and the calibration the dispatch named: inbox-wake's 10 LEGITIMATELY-PROGRESSING rounds must trip the round-count alert near
 * r5 but NOT the degradation alert (remain was falling), while a genuinely worsening loop trips degradation.
 */

const C = DEFAULT_ROUND_DOCTOR_CONFIG; // { alertN: 5, degradeWindow: 3 }

// --- assessRoundHealth: >= N rounds and not cleared ---

test("assessRoundHealth: under the threshold ⇒ no alert", () => {
  expect(assessRoundHealth(4, [{ remain: 3, newP: 0 }])).toBe(false);
});

test("assessRoundHealth: >= N rounds, not cleared ⇒ alert", () => {
  expect(assessRoundHealth(5, [{ remain: 2, newP: 0 }])).toBe(true);
  expect(assessRoundHealth(9, [])).toBe(true); // no remain history, long ⇒ still flags on count
});

test("assessRoundHealth: >= N rounds but cleared (last remain 0) ⇒ no alert", () => {
  expect(assessRoundHealth(7, [{ remain: 2, newP: 0 }, { remain: 0, newP: 0 }])).toBe(false);
});

// --- detectDegradation ---

test("detectDegradation: remain never falls and stays > 0 ⇒ remain-not-falling", () => {
  expect(detectDegradation([{ remain: 2, newP: 0 }, { remain: 3, newP: 0 }, { remain: 4, newP: 0 }])).toBe("remain-not-falling");
  expect(detectDegradation([{ remain: 3, newP: 0 }, { remain: 3, newP: 0 }, { remain: 3, newP: 0 }])).toBe("remain-not-falling"); // stuck counts
});

test("detectDegradation: falling remain ⇒ none (converging)", () => {
  expect(detectDegradation([{ remain: 4, newP: 0 }, { remain: 3, newP: 0 }, { remain: 2, newP: 0 }])).toBe("none");
});

test("detectDegradation: every round opens a new P ⇒ fix-one-open-one (even while remain falls)", () => {
  expect(detectDegradation([{ remain: 3, newP: 1 }, { remain: 2, newP: 2 }, { remain: 1, newP: 1 }])).toBe("fix-one-open-one");
});

test("detectDegradation: an unknown (<0) in the window does NOT assert a signal (safe direction)", () => {
  expect(detectDegradation([{ remain: -1, newP: -1 }, { remain: 4, newP: -1 }, { remain: 5, newP: -1 }])).toBe("none");
});

test("detectDegradation: fewer than K rounds ⇒ none", () => {
  expect(detectDegradation([{ remain: 5, newP: 2 }, { remain: 6, newP: 2 }])).toBe("none");
});

test("detectDegradation: a window ending at 0 is converging, not degrading", () => {
  expect(detectDegradation([{ remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 }])).toBe("none");
});

// --- calibration: inbox-wake's 10 progressing rounds ---

const inboxWakeLike: RoundRecord[] = [
  { remain: 6, newP: 2 }, { remain: 5, newP: 1 }, { remain: 4, newP: 1 }, { remain: 3, newP: 0 }, { remain: 2, newP: 0 },
  { remain: 2, newP: 0 }, { remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 },
];

test("calibration: a long BUT PROGRESSING loop trips the round-count alert at r5, never degradation", () => {
  // before r5: no alert
  expect(diagnoseRounds(4, inboxWakeLike.slice(0, 4)).concern).toBe(false);
  // at r5 (remain still > 0): over-long fires, degradation does NOT (remain is falling)
  const at5 = diagnoseRounds(5, inboxWakeLike.slice(0, 5));
  expect(at5.overLong).toBe(true);
  expect(at5.degradation).toBe("none");
  expect(at5.concern).toBe(true);
  // the full 10-round history ends cleared ⇒ no alert at all
  expect(diagnoseRounds(10, inboxWakeLike).concern).toBe(false);
});

// --- diagnoseRounds + note ---

test("diagnoseRounds: concern carries the fixed suggestion menu", () => {
  const v = diagnoseRounds(6, [{ remain: 3, newP: 1 }, { remain: 4, newP: 1 }, { remain: 5, newP: 1 }]);
  expect(v.concern).toBe(true);
  expect(v.overLong).toBe(true);
  expect(v.degradation).toBe("remain-not-falling");
  expect(v.suggestions).toEqual(["换方案", "换人", "拆小", "升 user"]);
});

test("diagnoseRounds: healthy ⇒ no concern, no suggestions", () => {
  const v = diagnoseRounds(3, [{ remain: 3, newP: 0 }, { remain: 1, newP: 0 }]);
  expect(v.concern).toBe(false);
  expect(v.suggestions).toEqual([]);
});

test("buildRoundDoctorNote: advisory only — names the item, the menu, and that disposition is unchanged", () => {
  const note = buildRoundDoctorNote("round-doctor", diagnoseRounds(6, [{ remain: 4, newP: 0 }, { remain: 4, newP: 0 }, { remain: 4, newP: 0 }]));
  expect(note).toMatch(/round-doctor/);
  expect(note).toMatch(/仅建议/);
  expect(note).toMatch(/不中断审查/);
  expect(note).toMatch(/升 user/);
  expect(note).toMatch(/不改变任何流程/);
});

// --- config helpers ---

test("roundAlertN: integer >= 2 wins; junk / < 2 ⇒ default", () => {
  expect(roundAlertN("7")).toBe(7);
  expect(roundAlertN("1")).toBe(C.alertN);   // < 2 rejected (would alert on round 1)
  expect(roundAlertN("abc")).toBe(C.alertN);
  expect(roundAlertN(undefined)).toBe(C.alertN);
});

test("roundDoctorEnabled: live by default (opt-out)", () => {
  expect(roundDoctorEnabled(undefined)).toBe(true);
  expect(roundDoctorEnabled("")).toBe(true);
  expect(roundDoctorEnabled("0")).toBe(false);
  expect(roundDoctorEnabled("off")).toBe(false);
});

// --- best-effort parsing (fail-soft) ---

test("parseRemainFromLine: English REMAIN banner, Chinese 余 <n>P, and cleared", () => {
  expect(parseRemainFromLine("r2 verdict: 2P1+5P2 (8 REMAIN)")).toBe(8);
  expect(parseRemainFromLine("P1-3 关,余 4P1")).toBe(4);
  expect(parseRemainFromLine("codex r8: 0 REMAIN, CLEARED")).toBe(0);
  expect(parseRemainFromLine("just a delivery note, no verdict")).toBe(-1);
});

test("parseNewPFromLine: explicit new-P phrase, else unknown", () => {
  expect(parseNewPFromLine("修一开一:新开 1 P2")).toBe(1);
  expect(parseNewPFromLine("开 2 P1 this round")).toBe(2);
  expect(parseNewPFromLine("P1-3 关,余 4P1")).toBe(-1); // no new-P phrase ⇒ unknown
});

test("parseRoundHistory: only verdict lines become records, in order; garbage ⇒ []", () => {
  const lines = [
    "交付 @aaa 送审",                       // not a verdict ⇒ skipped
    "r1 判 @aaa: 3 REMAIN",                 // remain 3, newP unknown
    "r2 判 @bbb: 余 2P1,新开 1 P2",          // remain 2, newP 1
    "r3 判 @ccc: 0 REMAIN CLEARED",         // remain 0
  ];
  expect(parseRoundHistory(lines)).toEqual([
    { remain: 3, newP: -1 }, { remain: 2, newP: 1 }, { remain: 0, newP: -1 },
  ]);
  expect(parseRoundHistory(["no verdicts here", "still nothing"])).toEqual([]);
});
