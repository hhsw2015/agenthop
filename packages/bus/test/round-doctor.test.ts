import { expect, test } from "vitest";
import {
  assessRoundHealth, detectDegradation, diagnoseRounds, buildRoundDoctorNote,
  roundDoctorEnabled, roundAlertN, mentionsTicket, parseRoundNumber, parseRemainSafe, parseNewPSafe, extractTicketRounds,
  DEFAULT_ROUND_DOCTOR_CONFIG, type RoundRecord,
} from "../src/swarm/round-doctor.js";

/**
 * round-doctor (double-mirror ①) is SUGGESTION ONLY. The pure signals are straightforward; the hard part the review (RD-1/2/3)
 * exposed is turning free-form PROGRESS prose into COMPLETED ROUND records. These tests pin each review counterexample: a
 * submission / conditional / summary line is not a round; a ticket binds exactly (no `placement`⊂`placement-ledger` bleed, no
 * multi-ticket line); an unparsed round stays unknown (never dropped, never sign-flipped), rounds counted independent of remain.
 */

const C = DEFAULT_ROUND_DOCTOR_CONFIG; // { alertN: 5, degradeWindow: 3 }

// ===== pure signals =====

test("assessRoundHealth: under threshold ⇒ no; >= N & not cleared ⇒ yes; cleared ⇒ no", () => {
  expect(assessRoundHealth(4, [{ remain: 3, newP: 0 }])).toBe(false);
  expect(assessRoundHealth(5, [{ remain: 2, newP: 0 }])).toBe(true);
  expect(assessRoundHealth(9, [])).toBe(true);                                    // long, no remain history ⇒ still flags on count
  expect(assessRoundHealth(7, [{ remain: 2, newP: 0 }, { remain: 0, newP: 0 }])).toBe(false); // cleared
});

test("detectDegradation: not-falling / fix-one-open-one / converging / unknown-safe / short", () => {
  expect(detectDegradation([{ remain: 2, newP: 0 }, { remain: 3, newP: 0 }, { remain: 4, newP: 0 }])).toBe("remain-not-falling");
  expect(detectDegradation([{ remain: 3, newP: 0 }, { remain: 3, newP: 0 }, { remain: 3, newP: 0 }])).toBe("remain-not-falling");
  expect(detectDegradation([{ remain: 3, newP: 1 }, { remain: 2, newP: 2 }, { remain: 1, newP: 1 }])).toBe("fix-one-open-one");
  expect(detectDegradation([{ remain: 4, newP: 0 }, { remain: 3, newP: 0 }, { remain: 2, newP: 0 }])).toBe("none");
  expect(detectDegradation([{ remain: -1, newP: -1 }, { remain: 4, newP: -1 }, { remain: 5, newP: -1 }])).toBe("none"); // unknown breaks it
  expect(detectDegradation([{ remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 }])).toBe("none");     // ends at 0 ⇒ converging
  expect(detectDegradation([{ remain: 5, newP: 2 }, { remain: 6, newP: 2 }])).toBe("none");                             // < K
});

test("diagnoseRounds + buildRoundDoctorNote: concern carries the menu; note is advisory only", () => {
  const v = diagnoseRounds(6, [{ remain: 3, newP: 1 }, { remain: 4, newP: 1 }, { remain: 5, newP: 1 }]);
  expect(v.concern).toBe(true);
  expect(v.overLong).toBe(true);
  expect(v.degradation).toBe("remain-not-falling");
  expect(v.suggestions).toEqual(["换方案", "换人", "拆小", "升 user"]);
  expect(diagnoseRounds(3, [{ remain: 3, newP: 0 }, { remain: 1, newP: 0 }]).concern).toBe(false);
  const note = buildRoundDoctorNote("round-doctor", v);
  expect(note).toMatch(/round-doctor/);
  expect(note).toMatch(/仅建议/);
  expect(note).toMatch(/不中断审查/);
  expect(note).toMatch(/升 user/);
  expect(note).toMatch(/不改变任何流程/);
});

// ===== config helpers =====

test("roundAlertN: integer >= 2 wins; junk / < 2 ⇒ default", () => {
  expect(roundAlertN("7")).toBe(7);
  expect(roundAlertN("1")).toBe(C.alertN);
  expect(roundAlertN("abc")).toBe(C.alertN);
  expect(roundAlertN(undefined)).toBe(C.alertN);
});

test("roundDoctorEnabled: live by default (opt-out)", () => {
  expect(roundDoctorEnabled(undefined)).toBe(true);
  expect(roundDoctorEnabled("0")).toBe(false);
  expect(roundDoctorEnabled("off")).toBe(false);
});

// ===== line helpers =====

test("mentionsTicket: exact slug boundary — placement is NOT inside placement-ledger", () => {
  expect(mentionsTicket("placement 首审 2 REMAIN", "placement")).toBe(true);
  expect(mentionsTicket("placement-ledger r2 判", "placement")).toBe(false);     // prefix must not match
  expect(mentionsTicket("placement-ledger r2 判", "placement-ledger")).toBe(true);
  expect(mentionsTicket("round-doctor:placement advice", "placement")).toBe(true); // bounded by ':'
});

test("parseRoundNumber: 首审 ⇒ 1, rN ⇒ N, none ⇒ 0", () => {
  expect(parseRoundNumber("inbox-wake 首审 1P1")).toBe(1);
  expect(parseRoundNumber("inbox-wake r3 判")).toBe(3);
  expect(parseRoundNumber("inbox-wake r10 终审")).toBe(10);
  expect(parseRoundNumber("候 inbox-wake 排队")).toBe(0);
});

test("parseRemainSafe: sign-safe, conditional-safe, Chinese shorthand, not a finding tally", () => {
  expect(parseRemainSafe("r2 verdict: 8 REMAIN")).toBe(8);
  expect(parseRemainSafe("0 REMAIN CLEARED")).toBe(0);
  expect(parseRemainSafe("-1 REMAIN")).toBe(-1);                 // RD-3: the '-' must not be dropped into 1
  expect(parseRemainSafe("r6 已送审,0 REMAIN 即并批")).toBe(-1);  // RD-1: a conditional/future REMAIN is not a fact
  expect(parseRemainSafe("P1-3 关,余 4P1")).toBe(4);
  expect(parseRemainSafe("余 IW-P2-1 一寸")).toBe(-1);            // no numeric remain ⇒ unknown
  expect(parseRemainSafe("首审 1P1+2P2")).toBe(-1);              // a finding tally is NOT summed into a remain
});

test("parseNewPSafe: explicit count only; a bare id ⇒ unknown", () => {
  expect(parseNewPSafe("新开 2 P1")).toBe(2);
  expect(parseNewPSafe("新开 IW-R4-P2-1")).toBe(-1);
});

// ===== extractTicketRounds — the review counterexamples =====

test("RD-1a: a submission + conditional '0 REMAIN 即并批' is NOT a round and does NOT clear the loop", () => {
  const base = [
    "inbox-wake 首审 6 REMAIN @r1(happycapy)",
    "inbox-wake r2 判 5 REMAIN @r2(happycapy)",
    "inbox-wake r3 判 4 REMAIN @r3(happycapy)",
    "inbox-wake r4 判 3 REMAIN @r4(happycapy)",
    "inbox-wake r5 判 2 REMAIN @r5(happycapy)",
  ];
  expect(diagnoseRounds(extractTicketRounds(base, "inbox-wake").length, extractTicketRounds(base, "inbox-wake")).overLong).toBe(true);
  const withR6 = [...base, "inbox-wake r6 已送审,0 REMAIN 即并批 @r6"]; // submission + conditional
  const h6 = extractTicketRounds(withR6, "inbox-wake");
  expect(h6.length).toBe(5);                                          // r6 ignored — not counted, not cleared
  expect(diagnoseRounds(h6.length, h6).overLong).toBe(true);         // still alerts (not falsely cleared)
});

test("RD-1b: a verdict + its summary + an author echo of ONE round collapse to ONE round (no fabricated degradation)", () => {
  const lines = [
    "inbox-wake 首审 2 REMAIN @aaa(happycapy):三洞",
    "协调者收卷:inbox-wake 2 REMAIN,返修中",   // no round token ⇒ not a round
    "d7f6c917 确认 inbox-wake 首审 反馈,修复中", // round 1 again ⇒ merges
  ];
  expect(extractTicketRounds(lines, "inbox-wake")).toEqual([{ remain: 2, newP: -1 }]); // ONE round, not three
  expect(detectDegradation(extractTicketRounds(lines, "inbox-wake"))).toBe("none");
});

test("RD-2a: placement-ledger rounds do NOT attribute to the placement ticket (prefix)", () => {
  const lines = [
    "placement-ledger r1 判 2 REMAIN @a(happycapy)",
    "placement-ledger r2 判 2 REMAIN @b(happycapy)",
    "placement-ledger r3 判 2 REMAIN @c(happycapy)",
    "placement-ledger r4 判 2 REMAIN @d(happycapy)",
    "placement-ledger r5 判 2 REMAIN @e(happycapy)",
  ];
  expect(extractTicketRounds(lines, "placement", ["placement-ledger"])).toEqual([]); // zero placement rounds
});

test("RD-2b: a line naming TWO open tickets is ambiguous and does not clear/credit either", () => {
  const lines = [
    "placement 首审 2 REMAIN @a(happycapy)",
    "placement r2 判 2 REMAIN @b(happycapy)",
    "placement r3 判 2 REMAIN @c(happycapy)",
    "placement r4 判 2 REMAIN @d(happycapy)",
    "placement r5 判 2 REMAIN @e(happycapy)",
    "placement-ledger 已签 0 REMAIN,placement 仍在审 @x", // mentions BOTH ⇒ skipped (would otherwise clear placement)
  ];
  const h = extractTicketRounds(lines, "placement", ["placement-ledger"]);
  expect(h.length).toBe(5);                                   // placement's 5 rounds stand
  expect(diagnoseRounds(h.length, h).overLong).toBe(true);
});

test("RD-3a: an unparsed middle round stays UNKNOWN (kept, not dropped) ⇒ breaks the degradation window", () => {
  const lines = [
    "inbox-wake 首审 1 REMAIN @a(happycapy)",
    "inbox-wake r2 判 2 REMAIN @b(happycapy)",
    "inbox-wake r3 判 余 IW-P2-1 三洞 @c(happycapy)", // remain unparseable ⇒ unknown, round still counted
    "inbox-wake r4 判 3 REMAIN @d(happycapy)",
  ];
  const h = extractTicketRounds(lines, "inbox-wake");
  expect(h).toEqual([{ remain: 1, newP: -1 }, { remain: 2, newP: -1 }, { remain: -1, newP: -1 }, { remain: 3, newP: -1 }]);
  expect(detectDegradation(h)).toBe("none"); // NOT a false [1,2,3] remain-not-falling
});

test("RD-3b: rounds counted even when every remain is unparseable ⇒ the >=N alert still fires", () => {
  const lines = [
    "inbox-wake 首审 1P1+2P2 @a(happycapy)",
    "inbox-wake r2 判 三洞 @b(happycapy)",
    "inbox-wake r3 判 两洞 @c(happycapy)",
    "inbox-wake r4 判 新开 IW-R4-P2-1 @d(happycapy)",
    "inbox-wake r5 判 2P2 收尾 @e(happycapy)",
  ];
  const h = extractTicketRounds(lines, "inbox-wake");
  expect(h.length).toBe(5);
  expect(h.every((r) => r.remain === -1)).toBe(true); // all unknown remain
  expect(assessRoundHealth(h.length, h)).toBe(true);  // round count independent of remain parseability
});

test("extractTicketRounds: queue/await lines (候/在途/池) are not verdicts", () => {
  const lines = [
    "📦 批-11 池:候 inbox-wake r5 判(happycapy)",
    "⏳ 在途:inbox-wake r6 判(happycapy)",
    "inbox-wake r2 已自投复审 @b(f32a0507)",  // submission
  ];
  expect(extractTicketRounds(lines, "inbox-wake")).toEqual([]);
});

// ===== calibration: real inbox-wake verdict formats at r5 =====

test("calibration: real inbox-wake r1..r5 verdict lines ⇒ round-count alert at r5, no false degradation", () => {
  const inboxWake = [
    "📥 inbox-wake 首审 1P1+2P2 @2c5f904(happycapy):IW-P1-1 hook 仅 dispatcher",
    "📦 批-11 池:候 inbox-wake r2(happycapy)",                       // queue ⇒ skip
    "📥 inbox-wake r2 @b7a4e6a 已自投复审(f32a0507)",                // submission ⇒ skip
    "📥 inbox-wake r2 判 @b7a4e6a(happycapy):余 IW-P2-1 一寸,返修 r3",
    "📥 inbox-wake r3 判 @0ce4800(happycapy):余 IW-P2-1 三洞,r4",
    "📥 inbox-wake r4 判 @77ff4bb(happycapy):三洞全 CLOSED,新开 IW-R4-P2-1,r5",
    "📥 inbox-wake r5 判 @a881b87(happycapy):窗编号漂移",
  ];
  const h = extractTicketRounds(inboxWake, "inbox-wake");
  expect(h.length).toBe(5);                              // r1..r5 verdicts (queue + submission excluded)
  const v = diagnoseRounds(h.length, h);
  expect(v.overLong).toBe(true);                         // r5 calibration met
  expect(v.degradation).toBe("none");                    // mostly-unknown remains ⇒ no false degradation
  expect(v.concern).toBe(true);
});

// a progressing 10-round history that ends cleared ⇒ no concern (structured-input calibration)
test("calibration: a progressing loop that clears ⇒ no concern at the end", () => {
  const progressing: RoundRecord[] = [
    { remain: 6, newP: 2 }, { remain: 5, newP: 1 }, { remain: 4, newP: 1 }, { remain: 3, newP: 0 }, { remain: 2, newP: 0 },
    { remain: 2, newP: 0 }, { remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 },
  ];
  expect(diagnoseRounds(10, progressing).concern).toBe(false);
  // mid-flight at r5 (not yet cleared): over-long fires, degradation does not (remain falling)
  const at5 = diagnoseRounds(5, progressing.slice(0, 5));
  expect(at5.overLong).toBe(true);
  expect(at5.degradation).toBe("none");
});
