/**
 * retro-learn — PURE core (brief docs/swarm/retro-learn-brief.md, FROZEN @2b46959; author 90b58f9c). The read-only command ring that
 * turns the swarm's RECORD surfaces (review-reports dir names / control-log attempts / rulings ledger / PROGRESS lines) into LESSONS,
 * and drafts ruling SEEDS for the coordinator to sign. gstack /retro+/learn (镜十六) ∩ polydao 周期 meta-review (镜十四).
 *
 * HARD boundary (brief §2④, the polydao loop-edits-loop red line + the coordinator's hardening): this module is PURE — no fs, no bus,
 * no clock beyond injected now. It has NO reference to the signed ledger as a WRITE target, not even a passive helper. retro produces
 * DRAFTS only; the coordinator's human `mv` into rulings/ + index rebuild is the ONLY path into the simultaneously-live ledger.
 *
 * Evidence honesty (brief §2⑤): every lesson carries source refs; signals are tagged STRUCTURED (review-dir rounds / control-log
 * failureClass — trustworthy) vs HEURISTIC (keyword tallies over PROGRESS/report prose — 待人核, never a conclusion).
 *
 * IO is retro-store.ts; the CLI is scripts/retro.ts. Selftests + the 3 zero-bug fixtures (crash/restart/concurrency over the draft +
 * inbox write faces) live in retro.selftest.mts.
 */
import { createHash } from "node:crypto";
import { flagDefaultOn } from "./flag-default.js";

export const RETRO_REPORT_SCHEMA = "retro-report/v1" as const;
export const RULING_SEED_SCHEMA = "ruling-seed/v1" as const;

/** SWARM_RETRO — flagDefaultOn (Q4: default ON; read-only analysis + a draft to the coordinator inbox is zero-risk). Pure. */
export function retroEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_RETRO);
}

/** Throttle for an optional periodic run (Q2: manual primary, sweep/cron optional). never-run ⇒ due; else due when `periodSec`
 *  elapsed since `lastRunSec`. A bad clock / non-positive period ⇒ NOT due (fail-closed toward not-running the heavier retro). Pure. */
export function shouldRunRetro(lastRunSec: number | null, nowSec: number, periodSec: number): boolean {
  if (!Number.isFinite(nowSec) || !(periodSec > 0)) return false;
  if (lastRunSec === null || !Number.isFinite(lastRunSec)) return true;
  return nowSec - lastRunSec >= periodSec;
}

// ============================================================================================================
// RL-P3-1 — argument validation (pure). An invalid window value NEVER produces a NaN-d report or advances the water-mark.
// ============================================================================================================

/** The resolved window: `days` (reviews filtered by mtime to the last N days), `batch` (a labeled run), or `since-last` (reviews since
 *  the water-mark). Only reviews are mtime-scopeable; control-log has no timestamp and PROGRESS has no reliable batch-section structure,
 *  so BOTH are whole-corpus — every axis's actual scope is reported honestly via axisScopes (RL-P2-1), never claimed windowed. */
export type WindowSpec = { kind: "days"; days: number } | { kind: "batch"; batch: number } | { kind: "since-last" };
export type RetroArgs =
  | { mode: "usage"; error?: string }
  | { mode: "retro"; window: WindowSpec; ifDue: boolean; periodDays: number; coordinator?: string }
  | { mode: "learn"; from: string };

/** A finite positive INTEGER, else null (RL-P3-1: "nonsense"/"0"/"-1"/"3.5"/"" ⇒ null ⇒ usage, never a NaN window). */
const posInt = (s: string | undefined): number | null => { if (s === undefined) return null; const n = Number(s); return Number.isInteger(n) && n > 0 ? n : null; };
const RETRO_VALUE_FLAGS = new Set(["--days", "--batch", "--period-days", "--coordinator"]);
const RETRO_BOOL_FLAGS = new Set(["--since-last", "--if-due"]);
const LEARN_VALUE_FLAGS = new Set(["--from"]);

/** RL-P3-1 (r3): scan options against THIS subcommand's allowed set. An unknown option, a positional arg, OR a value flag whose value
 *  is missing (end of argv, or the next token is itself a flag) ⇒ an error (the CLI then exits 2 with ZERO writes). A present bool flag
 *  maps to "". Distinguishes "flag absent" (not in the map) from "flag present with a value". Pure. */
function scanOptions(argv: readonly string[], valueFlags: ReadonlySet<string>, boolFlags: ReadonlySet<string>): { error?: string; values: Map<string, string> } {
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) return { error: `unexpected argument '${a}'`, values };
    if (boolFlags.has(a)) { values.set(a, ""); continue; }
    if (valueFlags.has(a)) { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) return { error: `option '${a}' requires a value`, values }; values.set(a, v); i += 1; continue; }
    return { error: `unknown option '${a}'`, values };
  }
  return { values };
}

/** Classify + VALIDATE argv (RL-P3-1). Validates BOTH subcommands fully: unknown/foreign options, a value flag missing its value, a
 *  non-positive-integer --days/--batch/--period-days, or >1 window mode ⇒ usage (the CLI then exits 2 with ZERO writes). Pure. */
export function classifyRetroArgs(argv: readonly string[]): RetroArgs {
  const cmd = argv[0];
  if (cmd === "learn") {
    const s = scanOptions(argv, LEARN_VALUE_FLAGS, new Set()); // learn accepts ONLY --from (a retro-only flag here is "unknown")
    if (s.error) return { mode: "usage", error: s.error };
    const from = s.values.get("--from");
    return from ? { mode: "learn", from } : { mode: "usage", error: "learn requires --from <report.json>" };
  }
  if (cmd !== "retro") return { mode: "usage", ...(cmd ? { error: `unknown command '${cmd}'` } : {}) };
  const s = scanOptions(argv, RETRO_VALUE_FLAGS, RETRO_BOOL_FLAGS);
  if (s.error) return { mode: "usage", error: s.error };
  const has = (f: string) => s.values.has(f);
  if ([has("--days"), has("--batch"), has("--since-last")].filter(Boolean).length > 1) return { mode: "usage", error: "--days / --batch / --since-last are mutually exclusive" };
  let window: WindowSpec;
  if (has("--batch")) { const n = posInt(s.values.get("--batch")); if (n === null) return { mode: "usage", error: "--batch requires a positive integer" }; window = { kind: "batch", batch: n }; }
  else if (has("--since-last")) window = { kind: "since-last" };
  else if (has("--days")) { const n = posInt(s.values.get("--days")); if (n === null) return { mode: "usage", error: "--days requires a positive integer" }; window = { kind: "days", days: n }; }
  else window = { kind: "days", days: 7 }; // the default 7 applies ONLY when --days is entirely absent (a bare --days is a missing value above)
  let periodDays = 7;
  if (has("--period-days")) { const n = posInt(s.values.get("--period-days")); if (n === null) return { mode: "usage", error: "--period-days requires a positive integer" }; periodDays = n; }
  const coordinator = s.values.get("--coordinator");
  return { mode: "retro", window, ifDue: has("--if-due"), periodDays, ...(coordinator ? { coordinator } : {}) };
}

// ============================================================================================================
// AXIS 1 — rework-round distribution (STRUCTURED: review-reports dir names `<ticket>-<sha>-review...`)
// ============================================================================================================

export type ReviewRoundRecord = { ticket: string; sha: string; dir: string };

/** Parse a review-report dir name into {ticket, sha}. The name is `<ticket...>-<7..40 hex sha>-review...`; the ticket itself may
 *  contain hyphens, so match the LAST `-<hex>-review` segment. null when it is not a review dir. Pure. */
export function parseReviewDirName(name: string): { ticket: string; sha: string } | null {
  const m = name.match(/^(.+)-([0-9a-f]{7,40})-review/);
  return m ? { ticket: m[1]!, sha: m[2]! } : null;
}

export type ReworkDist = {
  perTicket: { ticket: string; rounds: number; shas: string[] }[];
  totalTickets: number;
  singlePass: number;   // tickets that landed in ONE round
  multiRound: number;   // tickets that needed >1 round
  maxRounds: number;
  medianRounds: number;
};

/** Group review records by ticket; DISTINCT shas per ticket = review rounds (each resubmission is a new sha). Pure. */
export function reworkRoundDist(records: readonly ReviewRoundRecord[]): ReworkDist {
  const byTicket = new Map<string, Set<string>>();
  for (const r of records) {
    if (!byTicket.has(r.ticket)) byTicket.set(r.ticket, new Set());
    byTicket.get(r.ticket)!.add(r.sha);
  }
  const perTicket = [...byTicket.entries()]
    .map(([ticket, shas]) => ({ ticket, rounds: shas.size, shas: [...shas].sort() }))
    .sort((a, b) => b.rounds - a.rounds || (a.ticket < b.ticket ? -1 : 1));
  const counts = perTicket.map((t) => t.rounds).sort((a, b) => a - b);
  const median = counts.length === 0 ? 0 : counts.length % 2 ? counts[(counts.length - 1) / 2]! : (counts[counts.length / 2 - 1]! + counts[counts.length / 2]!) / 2;
  return {
    perTicket,
    totalTickets: perTicket.length,
    singlePass: perTicket.filter((t) => t.rounds === 1).length,
    multiRound: perTicket.filter((t) => t.rounds > 1).length,
    maxRounds: counts.length ? counts[counts.length - 1]! : 0,
    medianRounds: median,
  };
}

// ============================================================================================================
// AXIS 2 — repeated ailments (STRUCTURED control-log failureClass + HEURISTIC keyword tally, layered)
// ============================================================================================================

export type AttemptRecord = { attemptId: string; nodeId: string; status: string; failureClass?: string };
export type TextLine = { source: string; line: number; text: string };

/** The seed "ailment vocabulary" for the HEURISTIC tally — recurring defect categories this swarm has actually hit (extensible). A
 *  match is a HINT (待人核), never a conclusion; the structured failureClass tally is the trustworthy layer. */
export const AILMENT_KEYWORDS: readonly { slug: string; re: RegExp }[] = [
  { slug: "read-error-as-empty", re: /读错空集|empty set|当无|false[- ]?empty|静默清空|silent(ly)? empt/i },
  { slug: "swallow-error", re: /吞错|swallow|catch\s*\{\s*\}|静默(丢|跳|吞)/i },
  { slug: "symlink-boundary", re: /symlink|符号链接|CP-3|祖先链|boundary (escape|漏)/i },
  { slug: "fc-2-three-state", re: /FC-2|三态|unknown.*vs.*(zero|empty)|fail-?closed/i },
  { slug: "lossy-capture", re: /ps.*(lossy|截断|空格)|无法还原|round-?trip/i },
  { slug: "identity-drift", re: /未绑|唯一 ?SID|title.*复用|handle.*投错|ambiguous/i },
  { slug: "budget-capability-soft", re: /兜底降级|no-staffable|weak default|over[- ]?budget/i },
  { slug: "gate-escape", re: /出门|escaped? (the )?gate|红出门|tsc 红|未 gating|不进 CI/i },
];

export type AilmentCluster = {
  structured: { failureClass: string; count: number; attempts: string[] }[];
  heuristic: { slug: string; count: number; hits: { source: string; line: number }[] }[];
};

/** Cluster repeated ailments. STRUCTURED: tally control-log failureClass across attempts (recurring class = a real repeated
 *  ailment). HEURISTIC: tally the seed vocabulary over prose lines, keeping hits (source:line) for every match; a slug recurring
 *  ≥ `minRecur` is surfaced as a HINT. Both sorted by count desc. Pure. */
export function clusterAilments(attempts: readonly AttemptRecord[], textLines: readonly TextLine[], minRecur = 2): AilmentCluster {
  const byClass = new Map<string, string[]>();
  for (const a of attempts) {
    if (!a.failureClass) continue;
    if (!byClass.has(a.failureClass)) byClass.set(a.failureClass, []);
    byClass.get(a.failureClass)!.push(a.attemptId);
  }
  const structured = [...byClass.entries()]
    .map(([failureClass, attemptsArr]) => ({ failureClass, count: attemptsArr.length, attempts: attemptsArr.sort() }))
    .filter((c) => c.count >= minRecur)
    .sort((a, b) => b.count - a.count || (a.failureClass < b.failureClass ? -1 : 1));

  const bySlug = new Map<string, { source: string; line: number }[]>();
  for (const l of textLines) {
    for (const k of AILMENT_KEYWORDS) {
      if (k.re.test(l.text)) {
        if (!bySlug.has(k.slug)) bySlug.set(k.slug, []);
        bySlug.get(k.slug)!.push({ source: l.source, line: l.line });
      }
    }
  }
  const heuristic = [...bySlug.entries()]
    .map(([slug, hits]) => ({ slug, count: hits.length, hits }))
    .filter((c) => c.count >= minRecur)
    .sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : 1));
  return { structured, heuristic };
}

// ============================================================================================================
// AXIS 3 — process gaps (PROGRESS line-cited; each a candidate new gate)
// ============================================================================================================

export const PROCESS_GAP_SIGNALS: readonly { slug: string; re: RegExp }[] = [
  { slug: "gate-escape", re: /出门|红出门|tsc 红|escaped? (the )?gate|未 gating|不进 CI|漏网/i },
  { slug: "post-install-lesson", re: /装机后.*教训|装机.*挡|合并.*碰撞|grep 教训/i },
  { slug: "swallow-in-hot-path", re: /吞错继续|热路径.*(吞|静默)|silently (swallow|drop)/i },
  { slug: "unwired-inert", re: /unwired|inert|no-?op|未接线|接线点在 dormant/i },
];

export type ProcessGap = { slug: string; source: string; line: number; text: string };

/** Surface process-gap signals over prose lines (line-cited). Every match is flagged (even one is worth a human look — "候补新门?").
 *  Heuristic by nature (prose), so each carries its exact source:line. Pure. */
export function extractProcessGaps(textLines: readonly TextLine[]): ProcessGap[] {
  const out: ProcessGap[] = [];
  for (const l of textLines) {
    for (const g of PROCESS_GAP_SIGNALS) {
      if (g.re.test(l.text)) { out.push({ slug: g.slug, source: l.source, line: l.line, text: l.text.slice(0, 200) }); break; }
    }
  }
  return out;
}

// ============================================================================================================
// report (markdown draft + structured JSON side-car)
// ============================================================================================================

/** Three-state note per source so the report is honest about what it could read (brief §3: EACCES ⇒ unknown, never "no ailments"). */
export type SourceStatus = "read" | "unreadable" | "absent";

/** RL-P2-1: the ACTUAL scope each axis covered, so a reader never mistakes whole-corpus data for a windowed conclusion. "windowed"
 *  = filtered to the window; "whole" = NOT window-scoped (e.g. control-log has no timestamp to filter by — reported in full, honestly
 *  labeled); "incomplete" = a windowed scan hit a per-item read error so some items could not be attributed. */
export type AxisScope = "windowed" | "whole" | "incomplete";
export type RetroReportJson = {
  schema: typeof RETRO_REPORT_SCHEMA;
  window: string;
  generatedAtSec: number;
  rework: ReworkDist;
  ailments: AilmentCluster;
  gaps: ProcessGap[];
  sources: { reviewReports: SourceStatus; controlLog: SourceStatus; progress: SourceStatus; rulings: SourceStatus };
  axisScopes: { reviews: AxisScope; controlLog: AxisScope; progress: AxisScope };
};

export function buildRetroReportJson(a: {
  window: string;
  nowSec: number;
  rework: ReworkDist;
  ailments: AilmentCluster;
  gaps: ProcessGap[];
  sources: RetroReportJson["sources"];
  axisScopes: RetroReportJson["axisScopes"];
}): RetroReportJson {
  return { schema: RETRO_REPORT_SCHEMA, window: a.window, generatedAtSec: Math.floor(a.nowSec), rework: a.rework, ailments: a.ailments, gaps: a.gaps, sources: a.sources, axisScopes: a.axisScopes };
}

/** RL-P2-4 (r4): a stable version tag over the report SIGNALS (everything EXCEPT generatedAtSec), so the delivery key binds to the
 *  report VERSION: identical signals ⇒ same key (idempotent "already"); changed signals ⇒ a NEW key ⇒ a new delivery, so a re-run with
 *  new data publishes a new version and one with the same data does not re-deliver. Excludes the timestamp so unchanged re-runs stay
 *  idempotent. SHA-256 (128-bit prefix) — collision-resistant, so "already" can never confirm a DIFFERENT report (the r3 32-bit FNV tag
 *  collided under a bounded search). Pure (crypto hashing is a deterministic transform; no fs/bus/clock). */
export function reportVersionTag(r: RetroReportJson): string {
  const { generatedAtSec: _omit, ...signals } = r;
  const s = JSON.stringify(signals); // field order is fixed by RetroReportJson construction ⇒ deterministic
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** Render the human-readable DRAFT. Every item carries its source refs; structured vs heuristic is labeled; a truly empty signal is
 *  distinguished from an unreadable source. Pure. */
export function renderRetroMarkdown(r: RetroReportJson): string {
  const L: string[] = [];
  L.push(`# retro — ${r.window}`, ``, `_草稿 (draft)。生成于 ${new Date(r.generatedAtSec * 1000).toISOString()}。本报告只读分析,待人审;不自动入 PROGRESS。_`, ``);
  L.push(`源可读性: review-reports=${r.sources.reviewReports} · control-log=${r.sources.controlLog} · PROGRESS=${r.sources.progress} · rulings=${r.sources.rulings}`, ``);
  // RL-P2-1: state each axis's ACTUAL scope so whole-corpus data is never read as a windowed conclusion.
  L.push(`轴覆盖: reviews=${r.axisScopes.reviews} · control-log=${r.axisScopes.controlLog} · PROGRESS=${r.axisScopes.progress}  (whole=非窗口限定/全量; incomplete=部分不可读)`, ``);
  // axis 1
  L.push(`## 返修轮数分布 (结构化, ${r.axisScopes.reviews})`, ``);
  if (r.sources.reviewReports !== "read") L.push(`- (源 ${r.sources.reviewReports} — 无结论)`, ``);
  else {
    L.push(`- ${r.rework.totalTickets} ticket · 一次过 ${r.rework.singlePass} · 多轮 ${r.rework.multiRound} · 中位 ${r.rework.medianRounds} · 最大 ${r.rework.maxRounds}`, ``);
    for (const t of r.rework.perTicket.filter((x) => x.rounds > 1)) L.push(`  - **${t.ticket}**: ${t.rounds} 轮 (${t.shas.join(", ")})`);
    L.push(``);
  }
  // axis 2
  L.push(`## 重复病灶`, ``, `### 结构化 (control-log failureClass — 可信)`);
  if (r.sources.controlLog !== "read") L.push(`- (源 ${r.sources.controlLog} — 无结论)`);
  else if (r.ailments.structured.length === 0) L.push(`- (窗口内无复发 failureClass)`);
  else for (const c of r.ailments.structured) L.push(`- **${c.failureClass}** ×${c.count} (${c.attempts.slice(0, 5).join(", ")}${c.attempts.length > 5 ? "…" : ""})`);
  L.push(``, `### 启发式 (关键词词频 — 待人核,非定论)`);
  // RL-P2-2: the heuristic tally is derived from the PROGRESS corpus — if that source is not readable, an empty tally is UNKNOWN,
  // never a confident "no hits".
  if (r.sources.progress !== "read") L.push(`- (源 ${r.sources.progress} — 无结论,非「无命中」)`);
  else if (r.ailments.heuristic.length === 0) L.push(`- (无复发关键词命中)`);
  else for (const c of r.ailments.heuristic) L.push(`- **${c.slug}** ×${c.count}  来源: ${c.hits.slice(0, 6).map((h) => `${h.source}:${h.line}`).join(", ")}${c.hits.length > 6 ? "…" : ""}`);
  L.push(``);
  // axis 3
  L.push(`## 流程缺口 (PROGRESS 行引 — 候补新门?)`, ``);
  if (r.sources.progress !== "read") L.push(`- (源 ${r.sources.progress} — 无结论)`);
  else if (r.gaps.length === 0) L.push(`- (无命中)`);
  else for (const g of r.gaps.slice(0, 30)) L.push(`- [${g.slug}] ${g.source}:${g.line} — ${g.text}`);
  L.push(``, `---`, `下一步(人工): 选「可判例化」条目 → \`learn --from <此报告>\` 生成 ruling 生坯到 console/retro-drafts/ → 协调者签 + 人工 mv 入 rulings/。`);
  return L.join("\n");
}

// ============================================================================================================
// learn — ruling SEEDS (drafts; NEVER the signed ledger; the coordinator's mv is the only entry path)
// ============================================================================================================

export type RulingSeries = "R" | "S" | "F";
/** `identity` (RL-P2-5) = the stable ailment identity (a failureClass or `gap:<slug>`), the dedup key — NOT the statement (whose
 *  shared window-template prefix made different ailments look identical). */
export type Lesson = { identity: string; title: string; statement: string; rationale?: string; sources: string[]; series: RulingSeries };

/** A DRAFT ruling (生坯). Deliberately NOT a valid ledger record: `draft:true`, a `suggestedId` (NOT the `id` field loadLedger
 *  validates), no signed `status`. Written only to console/retro-drafts/; loadLedger (which scans rulings/) never sees it, and even
 *  if copied it lacks a valid `id`/`status` ⇒ rejected. The coordinator assigns the real id + signs on manual mv. */
export type RulingSeed = {
  schema: typeof RULING_SEED_SCHEMA;
  draft: true;
  suggestedId: string;
  series: RulingSeries;
  title: string;
  statement: string;
  rationale?: string;
  sources: string[];
  proposedAtSec: number;
};

/** The next suggested id in a series = max existing number + 1 (Q5: pre-fill a SUGGESTION, the coordinator may change). Pure. */
export function nextSeriesId(series: RulingSeries, existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = id.match(/^([RSF])(\d+)/);
    if (m && m[1] === series) max = Math.max(max, Number(m[2]));
  }
  return `${series}${max + 1}`;
}

/** Dedup (brief §2②): a lesson is already covered when an ACTIVE ruling shares a source ref OR a near-identical statement. Avoids
 *  re-drafting a seed for a病灶 the ledger already rules on. Pure (conservative: any shared source OR a strong statement-token
 *  overlap ⇒ covered). */
/** The ACTIVE ruling that already covers this lesson — a shared cited source OR the ailment IDENTITY token (failureClass:/gap:, NOT a
 *  window-template prefix) in the ruling's statement/sources — or null. RL-P2-5 (r3): returning the covering id lets `learn` show WHICH
 *  ruling covers a skipped lesson (the frozen brief §2② + prior close gate require naming it). Pure. */
export function coveringRulingId(lesson: Lesson, existing: readonly { id?: string; statement: string; sources?: string[]; status: string }[]): string | null {
  const ls = new Set((lesson.sources ?? []).map((s) => s.trim()).filter(Boolean));
  const idTok = lesson.identity.trim().toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const r of existing) {
    if (r.status !== "active") continue;
    const sharesSource = (r.sources ?? []).some((s) => ls.has(s.trim()));
    const idMatch = idTok.length > 0 && (norm(r.statement).includes(idTok) || (r.sources ?? []).some((s) => norm(s).includes(idTok)));
    if (sharesSource || idMatch) return r.id ?? "(unnamed ruling)";
  }
  return null;
}

/** Boolean form of [[coveringRulingId]] (covered ⇔ some active ruling covers it). Pure. */
export function isAlreadyCovered(lesson: Lesson, existing: readonly { id?: string; statement: string; sources?: string[]; status: string }[]): boolean {
  return coveringRulingId(lesson, existing) !== null;
}

/** Draft a ruling seed from a lesson (Q5 suggested id). Pure. */
export function draftRulingSeed(lesson: Lesson, existingIds: readonly string[], nowSec: number): RulingSeed {
  return {
    schema: RULING_SEED_SCHEMA,
    draft: true,
    suggestedId: nextSeriesId(lesson.series, existingIds),
    series: lesson.series,
    title: lesson.title,
    statement: lesson.statement,
    ...(lesson.rationale ? { rationale: lesson.rationale } : {}),
    sources: lesson.sources,
    proposedAtSec: Math.floor(nowSec),
  };
}

/** Propose candidate lessons from a report: a recurring STRUCTURED failureClass ⇒ an F-series lesson; a process-gap slug ⇒ an
 *  S-series (process) lesson. Heuristic ailments are NOT auto-proposed (待人核 — they stay in the report for a human to promote).
 *  Each lesson carries its source refs. Pure — the human/coordinator still selects which seeds to actually draft+sign. */
export function lessonsFromReport(r: RetroReportJson): Lesson[] {
  const out: Lesson[] = [];
  for (const c of r.ailments.structured) {
    out.push({
      identity: `failureClass:${c.failureClass}`, // RL-P2-5: the dedup key (stable ailment identity, not the window-template statement)
      series: "F",
      title: `复发失败类 ${c.failureClass}`,
      // RL-P2-5: lead with the identity (NOT the window template) so (a) two ailments in the same window no longer share a prefix, and
      // (b) the identity travels INTO the ledger on promotion, enabling precise future dedup without relying on shared sources.
      statement: `[failureClass:${c.failureClass}] 复发 ${c.count} 次 (窗口 ${r.window}) — 候判例化为针对该失败类的根治/门禁规矩。`,
      sources: c.attempts.slice(0, 8).map((a) => `control-log:attempt:${a}`),
    });
  }
  const bySlug = new Map<string, ProcessGap[]>();
  for (const g of r.gaps) { if (!bySlug.has(g.slug)) bySlug.set(g.slug, []); bySlug.get(g.slug)!.push(g); }
  for (const [slug, gaps] of bySlug) {
    out.push({
      identity: `gap:${slug}`,
      series: "S",
      title: `流程缺口 ${slug}`,
      statement: `[gap:${slug}] 流程缺口「${slug}」命中 ${gaps.length} 次 (窗口 ${r.window}) — 候判例化为新门/流程规矩。`,
      sources: gaps.slice(0, 8).map((g) => `${g.source}:${g.line}`),
    });
  }
  return out;
}
