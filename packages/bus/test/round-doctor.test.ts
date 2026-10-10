import { expect, test } from "vitest";
import {
  assessRoundHealth, detectDegradation, diagnoseRounds, buildRoundDoctorNote,
  roundDoctorEnabled, roundAlertN, mentionsTicket, parseVerdictLine, parseRemainSafe, parseNewPSafe, extractTicketRounds,
  DEFAULT_ROUND_DOCTOR_CONFIG, type RoundRecord,
} from "../src/swarm/round-doctor.js";

/**
 * round-doctor (double-mirror ①) is SUGGESTION ONLY. The pure signals are simple; the hard part (review RD-1..RD-4) is turning
 * free-form PROGRESS prose into COMPLETED ROUND records. The extractor uses a HEADER grammar — a line must START with
 * `<ticket> <round-verb>` — so body keywords, submissions, queue lines, summaries, prefix/underscore siblings and other-ticket
 * subjects all fail without a keyword blocklist; round numbers are bounded; unknowns are preserved. Tests pin each counterexample.
 */

const C = DEFAULT_ROUND_DOCTOR_CONFIG; // { alertN: 5, degradeWindow: 3 }

// ===== pure signals =====

test("assessRoundHealth: under threshold ⇒ no; >= N & not cleared ⇒ yes; cleared ⇒ no", () => {
  expect(assessRoundHealth(4, [{ remain: 3, newP: 0 }])).toBe(false);
  expect(assessRoundHealth(5, [{ remain: 2, newP: 0 }])).toBe(true);
  expect(assessRoundHealth(9, [])).toBe(true);
  expect(assessRoundHealth(7, [{ remain: 2, newP: 0 }, { remain: 0, newP: 0 }])).toBe(false);
});

test("detectDegradation: not-falling / fix-one-open-one / converging / unknown-safe / short", () => {
  expect(detectDegradation([{ remain: 2, newP: 0 }, { remain: 3, newP: 0 }, { remain: 4, newP: 0 }])).toBe("remain-not-falling");
  expect(detectDegradation([{ remain: 3, newP: 0 }, { remain: 3, newP: 0 }, { remain: 3, newP: 0 }])).toBe("remain-not-falling");
  expect(detectDegradation([{ remain: 3, newP: 1 }, { remain: 2, newP: 2 }, { remain: 1, newP: 1 }])).toBe("fix-one-open-one");
  expect(detectDegradation([{ remain: 4, newP: 0 }, { remain: 3, newP: 0 }, { remain: 2, newP: 0 }])).toBe("none");
  expect(detectDegradation([{ remain: -1, newP: -1 }, { remain: 4, newP: -1 }, { remain: 5, newP: -1 }])).toBe("none");
  expect(detectDegradation([{ remain: 1, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 }])).toBe("none");
  expect(detectDegradation([{ remain: 5, newP: 2 }, { remain: 6, newP: 2 }])).toBe("none");
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

test("mentionsTicket: exact id boundary incl. underscore — placement ∉ placement-ledger ∉ placement_ledger", () => {
  expect(mentionsTicket("placement 首审 2 REMAIN", "placement")).toBe(true);
  expect(mentionsTicket("placement-ledger r2 判", "placement")).toBe(false);
  expect(mentionsTicket("placement_ledger r2 判", "placement")).toBe(false); // RD-2: underscore sibling
  expect(mentionsTicket("round-doctor:placement advice", "placement")).toBe(true);
});

test("parseRemainSafe: sign-safe, conditional-safe, Chinese shorthand, not a finding tally", () => {
  expect(parseRemainSafe("r2 verdict: 8 REMAIN")).toBe(8);
  expect(parseRemainSafe("0 REMAIN CLEARED")).toBe(0);
  expect(parseRemainSafe("-1 REMAIN")).toBe(-1);
  expect(parseRemainSafe("r6 0 REMAIN 即并批")).toBe(-1);
  expect(parseRemainSafe("P1-3 关,余 4P1")).toBe(4);
  expect(parseRemainSafe("余 IW-P2-1 一寸")).toBe(-1);
  expect(parseRemainSafe("首审 1P1+2P2")).toBe(-1);
});

test("parseNewPSafe: explicit count only; a bare id ⇒ unknown", () => {
  expect(parseNewPSafe("新开 2 P1")).toBe(2);
  expect(parseNewPSafe("新开 IW-R4-P2-1")).toBe(-1);
});

// ===== parseVerdictLine — the header grammar (RD-1/RD-2/RD-4) =====

test("parseVerdictLine: recognizes 首审 / rN 判 / 终审 headers after leading markup", () => {
  expect(parseVerdictLine("📥 **inbox-wake 首审 1P1+2P2 @2c5f904**(happycapy):body", "inbox-wake")).toMatchObject({ round: 1, cleared: false });
  expect(parseVerdictLine("📥 **inbox-wake r2 判 @b7a4e6a**(happycapy):余 IW-P2-1", "inbox-wake")).toMatchObject({ round: 2 });
  expect(parseVerdictLine("✅ **inbox-wake 终审 CLEARED @713d7be**(happycapy r10,0 REMAIN)", "inbox-wake")).toMatchObject({ round: 10, cleared: true });
});

test("parseVerdictLine: non-verdicts return null — queue / summary / submission / 待判 (RD-1)", () => {
  expect(parseVerdictLine("📦 批-11 池:候 inbox-wake r5 判", "inbox-wake")).toBeNull();      // starts with 批/候, not the ticket
  expect(parseVerdictLine("协调者收卷:inbox-wake r2 判 2 REMAIN", "inbox-wake")).toBeNull(); // summary (starts with 协调者)
  expect(parseVerdictLine("📥 inbox-wake r5 @a881b87 已自投复审(f32a0507)", "inbox-wake")).toBeNull(); // submission (r5 not followed by 判)
  expect(parseVerdictLine("inbox-wake r5 待判", "inbox-wake")).toBeNull();                   // awaiting
  expect(parseVerdictLine("inbox-wake r5 候终判", "inbox-wake")).toBeNull();                 // awaiting
});

test("parseVerdictLine: body keywords do NOT change ticket state (RD-1)", () => {
  // a sub-finding CLEARED does not clear the ticket when the ticket still has REMAIN
  expect(parseVerdictLine("inbox-wake r5 判 @s:RD-1 CLEARED,2 REMAIN", "inbox-wake")).toMatchObject({ round: 5, remain: 2, cleared: false });
  // a follow-up "送审" in the body does not drop a real verdict
  expect(parseVerdictLine("inbox-wake r5 判 @s:2 REMAIN;返修后再送审", "inbox-wake")).toMatchObject({ round: 5, remain: 2 });
});

test("parseVerdictLine: subject is the leading ticket — a sibling/underscore header is not ours (RD-2)", () => {
  expect(parseVerdictLine("placement_ledger r5 判: 2 REMAIN", "placement")).toBeNull();
  expect(parseVerdictLine("placement-ledger r6 终审 CLEARED,0 REMAIN;placement r5 仍在审", "placement")).toBeNull();
});

test("parseVerdictLine: an out-of-bound / overflow round number is not a round (RD-4)", () => {
  expect(parseVerdictLine("inbox-wake r1000000000000 判 @s:2 REMAIN", "inbox-wake")).toBeNull();
  expect(parseVerdictLine("inbox-wake r9999 判 @s", "inbox-wake")).toBeNull(); // > 3 digits ⇒ header won't match
});

// ===== extractTicketRounds — {rounds, history(bounded window)} =====

test("RD-1a: a submission/conditional 'r6 … 已送审,0 REMAIN 即并批' is not a round and does not clear", () => {
  const base = [
    "inbox-wake 首审 6 REMAIN @r1(happycapy)",
    "inbox-wake r2 判 5 REMAIN @r2(happycapy)",
    "inbox-wake r3 判 4 REMAIN @r3(happycapy)",
    "inbox-wake r4 判 3 REMAIN @r4(happycapy)",
    "inbox-wake r5 判 2 REMAIN @r5(happycapy)",
  ];
  const withR6 = [...base, "inbox-wake r6 已送审,0 REMAIN 即并批 @r6"];
  const { rounds } = extractTicketRounds(withR6, "inbox-wake");
  expect(rounds).toBe(5);
  expect(diagnoseRounds(rounds, extractTicketRounds(withR6, "inbox-wake").history).overLong).toBe(true);
});

test("RD-1b: a verdict + summary + author echo of ONE round collapse to ONE round", () => {
  const lines = [
    "inbox-wake 首审 2 REMAIN @aaa(happycapy):三洞",
    "协调者收卷:inbox-wake 2 REMAIN,返修中",
    "d7f6c917 确认 inbox-wake 首审 反馈",
  ];
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(1);
  expect(history).toEqual([{ remain: 2, newP: -1 }]);
});

test("RD-1c: a 5th verdict with a sub-finding CLEARED still counts and does NOT clear the ticket", () => {
  const lines = [
    "inbox-wake 首审 5 REMAIN @r1(happycapy)",
    "inbox-wake r2 判 4 REMAIN @r2(happycapy)",
    "inbox-wake r3 判 3 REMAIN @r3(happycapy)",
    "inbox-wake r4 判 2 REMAIN @r4(happycapy)",
    "inbox-wake r5 判 @r5(happycapy):RD-1 CLEARED,2 REMAIN",
  ];
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(5);
  expect(diagnoseRounds(rounds, history).overLong).toBe(true); // not falsely cleared by the sub-finding
  // positive control: a terminal 终审 clear DOES stop it
  const cleared = [...lines, "inbox-wake r6 终审 CLEARED,0 REMAIN @r6(happycapy)"];
  const r2 = extractTicketRounds(cleared, "inbox-wake");
  expect(r2.rounds).toBe(6);
  expect(diagnoseRounds(r2.rounds, r2.history).overLong).toBe(false);
});

test("RD-2a: an underscore sibling (placement_ledger) does NOT attribute to placement", () => {
  const lines = [
    "placement_ledger r1 判 2 REMAIN @a(happycapy)",
    "placement_ledger r2 判 2 REMAIN @b(happycapy)",
    "placement_ledger r5 判 2 REMAIN @e(happycapy)",
  ];
  expect(extractTicketRounds(lines, "placement", ["placement_ledger"]).rounds).toBe(0);
});

test("RD-2b: attribution is header-bound — a done sibling's line never credits/clears this ticket", () => {
  const lines = [
    "placement 首审 2 REMAIN @a(happycapy)",
    "placement r2 判 2 REMAIN @b(happycapy)",
    "placement r3 判 2 REMAIN @c(happycapy)",
    "placement r4 判 2 REMAIN @d(happycapy)",
    "placement r5 判 2 REMAIN @e(happycapy)",
    "placement-ledger r6 终审 CLEARED,0 REMAIN;placement 仍在审 @x", // sibling is DONE (not in otherTickets) — must still not clear placement
  ];
  const { rounds, history } = extractTicketRounds(lines, "placement", []); // placement-ledger done ⇒ absent from otherTickets
  expect(rounds).toBe(5);
  expect(diagnoseRounds(rounds, history).overLong).toBe(true);
});

test("RD-3a: an unparsed middle round stays UNKNOWN ⇒ breaks the degradation window", () => {
  const lines = [
    "inbox-wake 首审 1 REMAIN @a(happycapy)",
    "inbox-wake r2 判 2 REMAIN @b(happycapy)",
    "inbox-wake r3 判 @c(happycapy):余 IW-P2-1 三洞",
    "inbox-wake r4 判 3 REMAIN @d(happycapy)",
  ];
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(4);
  expect(history).toEqual([{ remain: 2, newP: -1 }, { remain: -1, newP: -1 }, { remain: 3, newP: -1 }]); // window r2,r3,r4
  expect(detectDegradation(history)).toBe("none");
});

test("RD-3b: rounds counted even when every remain is unparseable", () => {
  const lines = [
    "inbox-wake 首审 1P1+2P2 @a(happycapy)",
    "inbox-wake r2 判 三洞 @b(happycapy)",
    "inbox-wake r3 判 两洞 @c(happycapy)",
    "inbox-wake r4 判 新开 IW-R4-P2-1 @d(happycapy)",
    "inbox-wake r5 判 2P2 收尾 @e(happycapy)",
  ];
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(5);
  expect(history.every((r) => r.remain === -1)).toBe(true);
  expect(assessRoundHealth(rounds, history)).toBe(true);
});

test("RD-4: an overflow round number never enters the window and never hangs", () => {
  const lines = [
    "inbox-wake r1000000000000 判 @s:2 REMAIN", // pathological ⇒ not a round
    "inbox-wake 首审 3 REMAIN @r1(happycapy)",
    "inbox-wake r2 判 3 REMAIN @r2(happycapy)",
  ];
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(2);                 // only the two valid rounds
  expect(history.length).toBeLessThanOrEqual(C.degradeWindow); // window bounded (never 1..1e12)
});

test("extractTicketRounds: history is bounded to the last degradeWindow rounds", () => {
  const lines = Array.from({ length: 7 }, (_, i) => `inbox-wake r${i + 1} 判 ${7 - i} REMAIN @s${i + 1}(happycapy)`);
  const { rounds, history } = extractTicketRounds(lines, "inbox-wake");
  expect(rounds).toBe(7);
  expect(history.length).toBe(C.degradeWindow); // last 3 only
});

// ===== calibration: real inbox-wake verdict formats at r5 =====

test("calibration: real inbox-wake r1..r5 verdict lines ⇒ round alert at r5, no false degradation", () => {
  const inboxWake = [
    "📥 **inbox-wake 首审 1P1+2P2 @2c5f904**(happycapy):IW-P1-1 hook 仅 dispatcher",
    "📦 批-11 池:候 inbox-wake r2(happycapy)",
    "📥 **inbox-wake r2 @b7a4e6a 已自投复审**(f32a0507)",
    "📥 **inbox-wake r2 判 @b7a4e6a**(happycapy):余 IW-P2-1 一寸,返修 r3",
    "📥 **inbox-wake r3 判 @0ce4800**(happycapy):余 IW-P2-1 三洞",
    "📥 **inbox-wake r4 判 @77ff4bb**(happycapy):三洞全 CLOSED,新开 IW-R4-P2-1",
    "📥 **inbox-wake r5 判 @a881b87**(happycapy):窗编号漂移",
  ];
  const { rounds, history } = extractTicketRounds(inboxWake, "inbox-wake");
  expect(rounds).toBe(5);
  const v = diagnoseRounds(rounds, history);
  expect(v.overLong).toBe(true);
  expect(v.degradation).toBe("none");
  expect(v.concern).toBe(true);
});

test("calibration: a progressing loop that clears ⇒ no concern", () => {
  const progressing: RoundRecord[] = [
    { remain: 2, newP: 0 }, { remain: 1, newP: 0 }, { remain: 0, newP: 0 },
  ];
  expect(diagnoseRounds(10, progressing).concern).toBe(false); // last remain 0 ⇒ cleared
});
