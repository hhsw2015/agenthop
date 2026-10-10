/**
 * round-doctor — round self-diagnosis + cascade-degradation detection (double-mirror ①, AgentGate `PipelineDoctor` borrow;
 * grounds in docs/research/agent-gate-eval.md §3). Two failure modes AgentGate had and our sentinels did not: a review/rework
 * loop running too many rounds without converging (loopback_loop / "≥N 轮未收敛"), and a cascade degradation where each round
 * gets WORSE rather than merely failing (exit_drift — "重试在变差"). Both are SUGGESTION ONLY: the doctor advises the
 * coordinator ("this item is N rounds in — change approach / change owner / split / escalate to user"); it NEVER interrupts a
 * review or changes its disposition (R16 — that stays with the coordinator / user). Pure core here (no IO / clock); the
 * dispatcher wires it thin onto the sweep, fail-soft, gated by SWARM_ROUND_DOCTOR (live by default — a pure advisory is
 * zero-risk). Data source: the swarm's EXISTING round records (PROGRESS verdict lines); no new persistence surface.
 */

import { flagDefaultOn } from "./flag-default.js";

/** One COMPLETED review round of a task. `remain` = the REMAIN count after that round's verdict; `newP` = new P-findings opened
 *  that round. A NEGATIVE value = unknown / unparsed (kept distinct from 0, which is a real "zero REMAIN"); the degradation
 *  rules treat an unknown as "signal not asserted" (the safe direction). */
export type RoundRecord = { remain: number; newP: number };

export interface RoundDoctorConfig {
  alertN: number;       // over-long threshold: >= this many rounds without clearing ⇒ an escalation suggestion (default 5)
  degradeWindow: number; // K: a degradation is judged over the last K rounds (default 3)
}
export const DEFAULT_ROUND_DOCTOR_CONFIG: RoundDoctorConfig = { alertN: 5, degradeWindow: 3 };

/** SWARM_ROUND_DOCTOR — LIVE BY DEFAULT (opt-out; kill with =0). A pure advisory, zero-risk, so it follows the flag-default rule. */
export function roundDoctorEnabled(env: string | undefined): boolean { return flagDefaultOn(env); }

/** SWARM_ROUND_ALERT_N — the over-long round threshold. Guarded: a parseable integer >= 2 wins; anything else ⇒ the default (5).
 *  (< 2 is nonsensical for "too many rounds" and would alert on the first review, so it is rejected — a number-boundary guard.) */
export function roundAlertN(env: string | undefined, fallback: number = DEFAULT_ROUND_DOCTOR_CONFIG.alertN): number {
  const n = Number((env ?? "").trim());
  return Number.isInteger(n) && n >= 2 ? n : fallback;
}

export type DegradationKind = "none" | "remain-not-falling" | "fix-one-open-one";

export interface RoundDoctorVerdict {
  concern: boolean;          // true ⇒ worth a coordinator suggestion
  overLong: boolean;         // >= alertN rounds without clearing
  rounds: number;
  degradation: DegradationKind;
  reasons: string[];         // human reasons (one per fired signal)
  suggestions: string[];     // the fixed menu: 换方案 / 换人 / 拆小 / 升 user
}

/** ≥N rounds and NOT yet cleared. "cleared" = the last KNOWN round reached 0 REMAIN (history's last record remain === 0); a
 *  cleared task never alerts however many rounds it took. If the remain history is empty/unknown, only the round COUNT decides
 *  (the dispatcher additionally runs this only for not-yet-done tickets, so a done task is filtered upstream too). Pure. */
export function assessRoundHealth(rounds: number, history: readonly RoundRecord[], cfg: RoundDoctorConfig = DEFAULT_ROUND_DOCTOR_CONFIG): boolean {
  if (!Number.isFinite(rounds) || rounds < cfg.alertN) return false;
  const cleared = history.length > 0 && history[history.length - 1]!.remain === 0;
  return !cleared;
}

/**
 * Cascade degradation over the LAST K rounds (the current trajectory):
 *  - "remain-not-falling": every step's REMAIN is >= the previous one (stuck or rising, never improving) AND the latest is still
 *    > 0 — the exit_drift analogue (each round no better than the last);
 *  - "fix-one-open-one": every round in the window opened >= 1 new P (each fix spawns a fresh finding).
 * Needs >= K rounds. A window containing an UNKNOWN value (< 0) does NOT assert that signal (safe direction — "宁可不匹配"):
 * remain-not-falling requires all K remains known; fix-one-open-one requires all K newP known-and->=1. Pure. */
export function detectDegradation(history: readonly RoundRecord[], cfg: RoundDoctorConfig = DEFAULT_ROUND_DOCTOR_CONFIG): DegradationKind {
  const K = cfg.degradeWindow;
  if (K < 2 || history.length < K) return "none";
  const win = history.slice(history.length - K);
  const remainsKnown = win.every((r) => r.remain >= 0);
  if (remainsKnown && win[win.length - 1]!.remain > 0 && win.every((r, i) => i === 0 || r.remain >= win[i - 1]!.remain)) return "remain-not-falling";
  if (win.every((r) => r.newP >= 1)) return "fix-one-open-one";
  return "none";
}

/** Combine both diagnoses into a verdict + the fixed suggestion menu. `rounds` is the authoritative round count (the dispatcher
 *  passes max(record-count, history length)); `history` is the per-round remain/newP sequence. Pure. */
export function diagnoseRounds(rounds: number, history: readonly RoundRecord[], cfg: RoundDoctorConfig = DEFAULT_ROUND_DOCTOR_CONFIG): RoundDoctorVerdict {
  const overLong = assessRoundHealth(rounds, history, cfg);
  const degradation = detectDegradation(history, cfg);
  const reasons: string[] = [];
  if (overLong) reasons.push(`已 ${rounds} 轮未达 0 REMAIN(阈值 ${cfg.alertN})`);
  if (degradation === "remain-not-falling") reasons.push(`连续 ${cfg.degradeWindow} 轮 REMAIN 不降反升(级联退化)`);
  if (degradation === "fix-one-open-one") reasons.push(`连续 ${cfg.degradeWindow} 轮每轮都开新 P(修一开一)`);
  const concern = overLong || degradation !== "none";
  const suggestions = concern ? ["换方案", "换人", "拆小", "升 user"] : [];
  return { concern, overLong, rounds, degradation, reasons, suggestions };
}

/** The S19-style escalation SUGGESTION text (Chinese). Advisory only — it always restates that disposition stays with the
 *  coordinator / user and the review itself is not interrupted. Pure; the caller delivers it to the coordinator inbox. */
export function buildRoundDoctorNote(taskRef: string, v: RoundDoctorVerdict): string {
  return `[round-doctor] 件「${taskRef}」轮次自诊:${v.reasons.join(";")}。建议(仅建议,不中断审查):${v.suggestions.join(" / ")}。是否换方案/换人/拆小/升 user 由协调者或 user 裁决;审查处置与轮次照常,本提示不改变任何流程。`;
}

// ------------------------------------------------------------------------------------------------------------------------
// Extraction from EXISTING round records (PROGRESS verdict lines). PURE + fail-soft. Soundness rails (review RD-1/RD-2/RD-3/RD-4):
//  - a verdict is identified by its HEADER: the line, after leading markup is stripped, must START with `<ticket> <round-verb>`
//    where round-verb ∈ {首审(=round 1), 终审, `rN 判`}. The body (sub-findings, follow-up actions, references to other tickets)
//    never changes the subject, the round, or the completion. This replaces whole-line keyword matching — a submission
//    ("… rN @sha 已投审"), a queue/await line ("候 … rN 判"), a summary ("协调者…<ticket>…"), a prefix/underscore sibling
//    ("placement_ledger …"), and a line whose subject is another ticket all FAIL the header, with no keyword blocklist (RD-1/RD-2);
//  - the round number is a bounded 1..999 integer; a pathological/overflowing number is not a round, and only a BOUNDED last-K
//    window is materialised — never a 1..maxRound array sized by an unchecked external value (RD-4);
//  - CLEARED is TICKET-level only (终审, or remain === 0), never a sub-finding "RD-1 CLEARED" (RD-1); a round whose remain can't be
//    read stays UNKNOWN (-1), never dropped; REMAIN is sign-/conditional-safe and a finding tally is not summed (RD-3); a body
//    that names ANOTHER known ticket makes this round's metric UNKNOWN (never cross-attributed) while the round still counts (RD-2).
// ------------------------------------------------------------------------------------------------------------------------

const TICKET_EDGE = "A-Za-z0-9_-";         // the review-queue id alphabet (isValidReviewId) — a slug boundary must exclude '_' too
const MAX_ROUND = 999;                      // a round number beyond this is pathological, not a real review round (RD-4 bound)

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Strip ONLY real leading markup (whitespace, emoji/symbols/marks/format, markdown emphasis `* \` ~ # > |`, and a `-`/`+`/`*`
 *  list marker that is FOLLOWED BY whitespace) — never a legal id char. A `_` or a `-`/`+` GLUED to a word is preserved, because
 *  a review-queue id may legally start with `_`/`-` (isValidReviewId: `^[A-Za-z0-9_-]+$`); a leading CJK word is preserved too, so
 *  a summary line like "协调者收卷:…" never collapses into a false ticket header (RD-2: no alias via character deletion). Pure. */
export function stripLeadMarkup(s: string): string {
  let t = s;
  for (;;) {
    const sym = /^[\p{S}\p{M}\p{Cf}\s]+/u.exec(t);          // whitespace, symbols (emoji), combining marks, format (ZWJ/VS)
    if (sym) { t = t.slice(sym[0].length); continue; }
    if (/^[-+*](?=\s)/.test(t)) { t = t.slice(1); continue; } // a list marker: dash/plus/star BEFORE whitespace (not `-id`/`_id`)
    if (/^[*`~#>|]/.test(t)) { t = t.slice(1); continue; }    // markdown emphasis/code/quote/header — never an id char
    break;
  }
  return t;
}

/** Exact, id-boundary mention of a ticket ANYWHERE in the line — never as a prefix/suffix of a longer id. Uses the real
 *  review-queue alphabet (incl. `_`), so `placement` matches neither `placement-ledger` nor `placement_ledger`. Pure. */
export function mentionsTicket(line: string, ticket: string): boolean {
  if (!ticket) return false;
  return new RegExp(`(?<![${TICKET_EDGE}])${escapeRegExp(ticket)}(?![${TICKET_EDGE}])`).test(line);
}

/** The REMAIN count a line asserts, or -1 (unknown) if none can be read RELIABLY. Sign-safe: a digit preceded by `-`/another
 *  digit is not taken (`-1 REMAIN` ⇒ unknown). Conditional-safe: `N REMAIN` followed by 即/若/将/拟 is a future clause ⇒ skipped.
 *  Also reads `余 <n>` (`余 4P1` ⇒ 4; `余 IW-..`/`余 一寸` ⇒ unknown). A finding tally (`1P1+2P2`) is NOT summed into a remain. Pure. */
export function parseRemainSafe(line: string): number {
  for (const m of line.matchAll(/(?<![\d-])(\d+)\s*REMAIN/gi)) {
    const after = line.slice((m.index ?? 0) + m[0].length);
    if (/^\s*(即|若|将|拟)/.test(after)) continue; // a conditional/future REMAIN is not a rendered fact
    return Number(m[1]);
  }
  const z = /余\s*(\d+)/.exec(line);
  return z ? Number(z[1]) : -1;
}

/** The count of NEW P-findings opened this round, or -1 (unknown) if no EXPLICIT count. Only `新开/新增/开 <n> P`; a bare
 *  `新开 IW-..` (an id, no count) stays unknown — so fix-one-open-one never false-fires. Pure. */
export function parseNewPSafe(line: string): number {
  const m = /(?:新开|新增|开)\s*(\d+)\s*P/i.exec(line);
  return m ? Number(m[1]) : -1;
}

/**
 * Parse ONE rendered verdict for `ticket` from a line, or null. The line (after leading markup) MUST START with the ticket
 * (id-boundary) followed by a round-verb: `首审` (round 1), `rN 判` (round N, N ≤ 999), or `终审` (a final verdict; its round is
 * the `rN` found on the line, if any). The body is ignored for subject/round/clear. round < 1 (unplaceable) ⇒ null. CLEARED counts
 * only for a 终审 verb or a literal `0 REMAIN`, never a sub-finding `RD-1 CLEARED`. Pure. */
export function parseVerdictLine(line: string, ticket: string): { round: number; remain: number; newP: number } | null {
  const head = stripLeadMarkup(line);
  const m = new RegExp(`^${escapeRegExp(ticket)}(?![${TICKET_EDGE}])\\s+(首审|终审|r\\d{1,3}\\s*(?:判|终审))(?![${TICKET_EDGE}])`).exec(head);
  if (!m) return null;
  const verb = m[1]!;
  const isFinal = /终审/.test(verb);
  const rm = /r(\d{1,3})(?!\d)/i.exec(verb) ?? (isFinal ? /\br(\d{1,3})(?!\d)/i.exec(line) : null);
  const round = /首审/.test(verb) ? 1 : rm ? Number(rm[1]) : 0;
  if (!Number.isSafeInteger(round) || round < 1 || round > MAX_ROUND) return null; // unplaceable / out-of-bound ⇒ not a counted round
  // RD-1: the ONLY ticket-level clear signal is an explicit remain of 0. A CLEARED keyword — even on a 终审 line — is NOT a clear:
  // it may be a sub-finding ("RD-1 CLEARED") and must never override a parsed POSITIVE remain. A genuinely cleared ticket is marked
  // done in the review-queue ledger (filtered upstream), so reading clear only from remain===0 stays conservative = keep surfacing.
  return { round, remain: parseRemainSafe(line), newP: parseNewPSafe(line) };
}

export interface TicketRounds {
  rounds: number;          // the highest round number reached (0 if none) — the authoritative COUNT, independent of remain parseability
  history: RoundRecord[];  // ONLY the last-K-window rounds (bounded), gap-filled with unknowns; its last entry is round `rounds`
}

/**
 * Reconstruct a ticket's round state from PROGRESS `lines` (oldest→newest). `otherTickets` = ALL other KNOWN tickets (open OR
 * done) — a line whose body also names one makes this round's METRIC unknown (never cross-attributed), independent of that
 * ticket's current done/open status. Rounds are keyed by the header's round number (same-round mentions merge, preferring a known
 * metric + a CLEARED fact). Only a BOUNDED window of the last `cfg.degradeWindow` rounds is materialised; `rounds` is the max
 * round number (≤ MAX_ROUND). Pure; never allocates by an unchecked number. */
export function extractTicketRounds(lines: readonly string[], ticket: string, otherTickets: readonly string[] = [], cfg: RoundDoctorConfig = DEFAULT_ROUND_DOCTOR_CONFIG): TicketRounds {
  const byRound = new Map<number, RoundRecord>();
  for (const line of lines) {
    const v = parseVerdictLine(line, ticket);
    if (!v) continue;
    const crossRef = otherTickets.some((t) => t !== ticket && mentionsTicket(line, t)); // body names another known ticket ⇒ don't trust its metric
    const remain = crossRef ? -1 : v.remain;
    const newP = crossRef ? -1 : v.newP;
    const prev = byRound.get(v.round);
    byRound.set(v.round, prev
      ? { remain: prev.remain >= 0 ? prev.remain : remain, newP: prev.newP >= 0 ? prev.newP : newP } // same round merges, preferring a KNOWN metric
      : { remain, newP });
  }
  if (byRound.size === 0) return { rounds: 0, history: [] };
  const maxRound = Math.max(...byRound.keys());
  const k = Math.max(1, cfg.degradeWindow);
  const history: RoundRecord[] = [];
  for (let r = Math.max(1, maxRound - k + 1); r <= maxRound; r += 1) { // BOUNDED to k entries — never 1..maxRound (RD-4)
    history.push(byRound.get(r) ?? { remain: -1, newP: -1 });
  }
  return { rounds: maxRound, history };
}
