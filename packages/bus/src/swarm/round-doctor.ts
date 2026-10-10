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
// Best-effort extraction from existing round records (PROGRESS verdict lines). PURE + fail-soft — never throws, never fabricates.
// ------------------------------------------------------------------------------------------------------------------------

/** Pull the REMAIN count from one verdict-ish line, or -1 if the line carries no remain signal. Recognizes `<n> REMAIN`
 *  (English, the verdict banner) and `余 <n>P` / `余 <n> REMAIN` (Chinese shorthand). A bare `0 REMAIN` ⇒ 0 (cleared). Pure. */
export function parseRemainFromLine(line: string): number {
  const m = /(\d+)\s*REMAIN/i.exec(line) ?? /余\s*(\d+)\s*(?:P|REMAIN)/i.exec(line);
  return m ? Number(m[1]) : -1;
}

/** Pull the count of NEW P-findings opened this round, or -1 if the line carries no such signal. Recognizes `新开 <n> P` /
 *  `开 <n> P` / `<n> 新 P`. Conservative: no explicit "new P" phrase ⇒ -1 (unknown), so fix-one-open-one never false-fires. Pure. */
export function parseNewPFromLine(line: string): number {
  const m = /(?:新开|开|新增)\s*(\d+)\s*P/i.exec(line) ?? /(\d+)\s*新\s*P/i.exec(line);
  return m ? Number(m[1]) : -1;
}

/** Best-effort per-round {remain,newP} sequence from PROGRESS-style `lines` ALREADY filtered to ONE task and ordered
 *  oldest→newest (the dispatcher substring-filters by the ticket slug). A line with no remain signal is NOT a verdict and is
 *  skipped; a line with a remain but no new-P signal records newP = -1 (unknown). No matches ⇒ []. Pure; never throws. */
export function parseRoundHistory(lines: readonly string[]): RoundRecord[] {
  const out: RoundRecord[] = [];
  for (const line of lines) {
    const remain = parseRemainFromLine(line);
    if (remain < 0) continue;
    out.push({ remain, newP: parseNewPFromLine(line) });
  }
  return out;
}
