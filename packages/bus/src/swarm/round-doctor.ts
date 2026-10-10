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
// Extraction from EXISTING round records (PROGRESS verdict lines). PURE + fail-soft. Soundness rails (review RD-1/RD-2/RD-3):
//  - a round is keyed by its explicit ROUND NUMBER (首审=1, rN=n), NOT by "a line that mentions a REMAIN"; same-round mentions
//    DEDUP, so a verdict + its summary + an author echo collapse to ONE round (never a fabricated degradation run);
//  - only a RENDERED verdict counts — a submission (投审/送审), a queue/await line (候/在途/池/排队) or a conditional ("0 REMAIN
//    即并批") is NOT a completed round;
//  - a ticket is bound EXACTLY (slug-boundary, so `placement` never matches `placement-ledger`); a line that also names ANOTHER
//    open ticket is ambiguous and skipped — no substring cross-attribution;
//  - a completed round whose remain/newP cannot be read stays as UNKNOWN (-1), never dropped and never fabricated; unparsed
//    middle rounds are gap-filled as unknown so a degradation window never stitches across them; REMAIN parsing is sign-safe
//    (`-1 REMAIN` ⇒ unknown, not 1). Round COUNT is therefore independent of whether any remain parsed.
// ------------------------------------------------------------------------------------------------------------------------

const SUBMIT_RE = /(投审|投复审|送审|送复审|自投)/;        // the author SENT for review — not a verdict
const QUEUE_RE = /(候\s|在途|排队|池[::]|⏳|即并批|即开批|拟判|将判)/; // awaiting / pooled / conditional — not a completed verdict
const VERDICT_MARK_RE = /(判|首审|终审|CLEARED)/;         // a rendered judgment banner (NOT a bare "REMAIN" mention — a quote is not a verdict)

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Exact, slug-boundary mention of a ticket (kebab `[A-Za-z0-9-]`) — never as a prefix of a longer slug. So `placement` does NOT
 *  match inside `placement-ledger`, and vice-versa. Empty ticket ⇒ false. Pure. */
export function mentionsTicket(line: string, ticket: string): boolean {
  if (!ticket) return false;
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(ticket)}(?![A-Za-z0-9-])`).test(line);
}

/** The round number a verdict line reports, or 0 if none: `首审` ⇒ 1; an explicit `rN` ⇒ N (used by 终审/复审 lines too). Pure. */
export function parseRoundNumber(line: string): number {
  const m = /\br(\d+)\b/i.exec(line);
  if (m) return Number(m[1]);
  return /首审/.test(line) ? 1 : 0;
}

/** The REMAIN count a verdict line asserts, or -1 (unknown) if none can be read RELIABLY. Sign-safe: a digit preceded by `-` or
 *  another digit is not taken (so `-1 REMAIN` ⇒ unknown). Conditional-safe: `N REMAIN` immediately followed by 即/若/将/拟 is a
 *  future clause, not a fact ⇒ skipped. Also reads `余 <n>` (Chinese shorthand; `余 4P1` ⇒ 4, `余 IW-..`/`余 一寸` ⇒ unknown).
 *  A finding tally like `1P1+2P2` is intentionally NOT summed into a remain (P-tokens also appear in finding IDs like IW-P2-1). */
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
 * Reconstruct a ticket's per-round {remain,newP} history from PROGRESS `lines` (oldest→newest). `otherTickets` = the other OPEN
 * tickets, used to reject ambiguous multi-ticket lines. A line contributes a round only if it (a) names `ticket` exactly and no
 * other open ticket, (b) is not a submission / queue / conditional line, (c) carries a verdict marker AND an explicit round
 * number. Rounds are keyed by that number (same-round mentions merge, preferring a KNOWN remain/newP and a CLEARED fact). The
 * result is indexed 1..maxRound; a round with no verdict line is an UNKNOWN placeholder (so a degradation window breaks across
 * it). `length === maxRound` ⇒ the round COUNT, independent of how many remains parsed. [] when no verdict is found. Pure. */
export function extractTicketRounds(lines: readonly string[], ticket: string, otherTickets: readonly string[] = []): RoundRecord[] {
  const byRound = new Map<number, { remain: number; newP: number; cleared: boolean }>();
  for (const line of lines) {
    if (!mentionsTicket(line, ticket)) continue;
    if (otherTickets.some((t) => t !== ticket && mentionsTicket(line, t))) continue; // ambiguous multi-ticket ⇒ skip
    if (SUBMIT_RE.test(line) || QUEUE_RE.test(line)) continue;                        // not a completed verdict
    if (!VERDICT_MARK_RE.test(line)) continue;
    const round = parseRoundNumber(line);
    if (round <= 0) continue;                                                         // no placeable round identity
    const remain = parseRemainSafe(line);
    const cleared = /CLEARED/.test(line) || remain === 0;
    const newP = parseNewPSafe(line);
    const prev = byRound.get(round);
    byRound.set(round, prev
      ? { remain: prev.remain >= 0 ? prev.remain : remain, newP: prev.newP >= 0 ? prev.newP : newP, cleared: prev.cleared || cleared }
      : { remain, newP, cleared });
  }
  if (byRound.size === 0) return [];
  const maxRound = Math.max(...byRound.keys());
  const out: RoundRecord[] = [];
  for (let r = 1; r <= maxRound; r += 1) {
    const e = byRound.get(r);
    out.push(e ? { remain: e.cleared ? 0 : e.remain, newP: e.newP } : { remain: -1, newP: -1 });
  }
  return out;
}
