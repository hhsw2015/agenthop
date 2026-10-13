/**
 * verification-ledger — PURE core (econ-mirror-21 candidate ③; coordinator-greenlit after the eval 闭卷 @648aea8).
 *
 * Turns our in-repo review RECORD into a COST-per-accepted-change projection: for each ACCEPTED change (a control-log
 * `accepted` entity, keyed by the reliable nodeId) how much REWORK it took to get there — attempts + the explicit rejections
 * that bounced it before acceptance. This is the Q2 "cost side" the econ eval (docs/research/agentic-economics-eval.md §e③)
 * says is missing. It is explicitly a **COST** metric, **NOT an ROI**: pricing the VALUE of an accepted change needs a return
 * signal we do not have, so this never claims one (the eval review struck exactly that overclaim).
 *
 * Evidence honesty (the discipline the eval itself passed). The ONE reliably-keyed surface is the control-log: `accepted`,
 * `rejected` and `attempt` entities all carry nodeId, so rework-to-acceptance joins cleanly. Two other surfaces are NOT
 * force-joined, because their key does not match nodeId and a fabricated join would be the very overclaim the review removed:
 *   - review-report dir names are keyed by ticket-NAME → carried as a SEPARATE view, labelled "not keyed to acceptance";
 *   - `$` cost (tasklog `usage.costUsd`) has NO nodeId link → omitted, with an honest note, not guessed.
 *
 * SUGGESTION/REPORT ONLY (R16, like autoscale-suggest + retro): this core reads already-loaded records and renders a report;
 * it NEVER spends, acts, or writes to control-log / rulings. The shell drafts the report to the coordinator inbox.
 *
 * Pure: no fs, no clock. The IO half (loadControlLog → accepted/rework; retro-store review rounds; FC-2 three-state) lives in
 * verification-ledger-store.ts.
 */
import { createHash } from "node:crypto";
import type { ReworkDist, SourceStatus } from "./retro.js";

/** Opt-in OFF (dormant): a brand-new projection with no user ruling to run it live (unlike autoscale, which flagDefaultOn's ON
 *  by a user ruling). Explicit SWARM_VERIFICATION_LEDGER=1|true|yes|on arms it; anything else (incl. unset) ⇒ off. */
export function verificationLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.SWARM_VERIFICATION_LEDGER ?? "").trim());
}

export type LedgerArgs = { threshold: number; sinceSec: number | null; coordinator?: string; dry: boolean };

/** Parse argv (pure; validated BEFORE any read — bad input ⇒ null ⇒ the shell prints usage + exits 2 with zero side effects).
 *  `nowSec` is injected so --days is pure. --since-last leaves sinceSec null (the review-rounds reader treats null as unscoped). */
export function parseLedgerArgs(argv: readonly string[], nowSec: number): LedgerArgs | null {
  let threshold = 3; let sinceSec: number | null = null; let coordinator: string | undefined; let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") { dry = true; continue; }
    if (a === "--since-last") { sinceSec = null; continue; }
    if (a === "--threshold") { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return null; threshold = n; continue; }
    if (a === "--days") { const n = Number(argv[++i]); if (!Number.isFinite(n) || n <= 0) return null; sinceSec = nowSec - Math.floor(n * 86400); continue; }
    if (a === "--coordinator") { const v = argv[++i]; if (!v) return null; coordinator = v; continue; }
    return null; // unknown flag
  }
  return { threshold, sinceSec, coordinator, dry };
}

/** One accepted change exactly as the control-log records it (an AcceptedResult carries all four ids + the supersede flag). */
export type AcceptedChange = { nodeId: string; jobId: string; attemptId: string; acceptedResultId: string; superseded: boolean };

/** Per-nodeId rework counters derived from the control-log: how many attempts the node saw, and how many were explicitly
 *  rejected (bounced) before it reached an accepted result. */
export type ReworkByNode = Record<string, { attempts: number; rejections: number }>;

/** The verification COST of one accepted change, keyed by the reliable nodeId. `reworkRounds` = rejections (each rejection is one
 *  more round the change had to come back); a change accepted on its first attempt with zero rejections is the cheapest (0). */
export type LedgerRow = {
  nodeId: string; jobId: string; acceptedResultId: string;
  attempts: number; rejections: number; reworkRounds: number;
  superseded: boolean;
  /** TRUE when the accepted change has no matching rework counter (should not happen — an accepted implies ≥1 attempt). Carried
   *  so a 0/0 row is never silently read as "cheap" when it is really "unaccounted" (FC-2 honesty on the join itself). */
  countersMissing: boolean;
};

/** Extract accepted changes + per-node rework counters from control-log entity bodies (pure, duck-typed — the store passes
 *  `Object.values(liveEntities(state))`). Accepted ⇐ put:"accepted" (carries nodeId/jobId/attemptId/acceptedResultId + supersede
 *  flag); attempts/rejections ⇐ put:"attempt"/"rejected" tallied by nodeId. Unknown/empty-nodeId bodies are skipped, never guessed. */
export function extractLedgerInputs(bodies: readonly unknown[]): { accepted: AcceptedChange[]; rework: ReworkByNode } {
  const accepted: AcceptedChange[] = [];
  const rework: ReworkByNode = {};
  const bump = (nodeId: unknown, field: "attempts" | "rejections") => {
    if (typeof nodeId !== "string" || nodeId === "") return;
    const cur = rework[nodeId] ?? { attempts: 0, rejections: 0 };
    cur[field] += 1; rework[nodeId] = cur;
  };
  for (const body of bodies) {
    const b = body as { put?: string; accepted?: Record<string, unknown>; attempt?: Record<string, unknown>; rejected?: Record<string, unknown> };
    if (b.put === "accepted" && b.accepted && typeof b.accepted.acceptedResultId === "string") {
      accepted.push({
        acceptedResultId: b.accepted.acceptedResultId,
        nodeId: typeof b.accepted.nodeId === "string" ? b.accepted.nodeId : "",
        jobId: typeof b.accepted.jobId === "string" ? b.accepted.jobId : "",
        attemptId: typeof b.accepted.attemptId === "string" ? b.accepted.attemptId : "",
        superseded: b.accepted.superseded === true,
      });
    } else if (b.put === "attempt" && b.attempt) {
      bump(b.attempt.nodeId, "attempts");
    } else if (b.put === "rejected" && b.rejected) {
      bump(b.rejected.nodeId, "rejections");
    }
  }
  return { accepted, rework };
}

/** Join accepted changes to their rework counters on nodeId (pure). A node with no counter entry is reported 0/0 + countersMissing. */
export function costPerAcceptedChange(accepted: readonly AcceptedChange[], rework: ReworkByNode): LedgerRow[] {
  return accepted.map((a) => {
    const r = rework[a.nodeId];
    return {
      nodeId: a.nodeId, jobId: a.jobId, acceptedResultId: a.acceptedResultId,
      attempts: r?.attempts ?? 0, rejections: r?.rejections ?? 0, reworkRounds: r?.rejections ?? 0,
      superseded: a.superseded, countersMissing: r === undefined,
    };
  });
}

/** A change whose rework meets/exceeds the threshold is "disproportionate" — a Q2 cost-side signal the coordinator may want to
 *  look at (why did it take so many rounds?). Default 3. Pure, never an action. */
export function disproportionateRework(row: LedgerRow, threshold = 3): boolean {
  return row.reworkRounds >= threshold;
}

export type LedgerSummary = {
  acceptedCount: number; totalRework: number; meanRework: number; zeroReworkCount: number;
  countersMissingCount: number; flagged: LedgerRow[];
};

/** Aggregate the rows. Superseded accepts are EXCLUDED from the live summary (their acceptance was later replaced — counting them
 *  would double-charge). Pure. */
export function summarizeLedger(rows: readonly LedgerRow[], threshold = 3): LedgerSummary {
  const live = rows.filter((r) => !r.superseded);
  const totalRework = live.reduce((s, r) => s + r.reworkRounds, 0);
  return {
    acceptedCount: live.length,
    totalRework,
    meanRework: live.length === 0 ? 0 : totalRework / live.length,
    zeroReworkCount: live.filter((r) => r.reworkRounds === 0).length,
    countersMissingCount: live.filter((r) => r.countersMissing).length,
    flagged: live.filter((r) => disproportionateRework(r, threshold)).sort((a, b) => b.reworkRounds - a.reworkRounds),
  };
}

export type LedgerSources = { controlLog: SourceStatus; reviewReports: SourceStatus };

/** Render the coordinator report. Honest framing throughout: a COST metric (not ROI); the control-log join is the reliable one
 *  (nodeId); review-report rounds are a SEPARATE view keyed by ticket-NAME and NOT tied to acceptance; `$` is omitted (no nodeId
 *  link). An unreadable/absent source is stated as such — never silently rendered as "zero". Pure (no fs/clock). */
export function renderLedgerReport(input: {
  rows: readonly LedgerRow[]; summary: LedgerSummary; reviewRounds: ReworkDist | null; sources: LedgerSources; threshold?: number;
}): string {
  const { summary, reviewRounds, sources } = input;
  const th = input.threshold ?? 3;
  const lines: string[] = [];
  lines.push(`[verification-ledger] cost-per-accepted-change (a COST metric, NOT an ROI — it does not price the VALUE of a change).`);

  if (sources.controlLog !== "read") {
    lines.push(`control-log: ${sources.controlLog} — cannot compute accepted-change cost (NOT reported as zero).`);
  } else {
    lines.push(`accepted changes: ${summary.acceptedCount} (live, superseded excluded); rework rounds = rejections before acceptance.`);
    lines.push(`  mean rework ${summary.meanRework.toFixed(2)}; accepted-first-try (0 rework): ${summary.zeroReworkCount}; total rework ${summary.totalRework}.`);
    if (summary.countersMissingCount > 0) lines.push(`  ⚠ ${summary.countersMissingCount} accepted change(s) have NO matching attempt/rejection record (counters unaccounted, shown 0/0 — not "cheap").`);
    if (summary.flagged.length > 0) {
      lines.push(`  disproportionate (≥${th} rework rounds), most-expensive first:`);
      for (const r of summary.flagged) lines.push(`    - node ${r.nodeId} (job ${r.jobId}): ${r.reworkRounds} rework / ${r.attempts} attempts.`);
    } else {
      lines.push(`  none at/over ${th} rework rounds.`);
    }
  }

  // SEPARATE view — honest about the non-join.
  if (reviewRounds === null) {
    lines.push(`review-report rounds: ${sources.reviewReports} — view unavailable (NOT reported as zero).`);
  } else {
    lines.push(`review-report rounds (by ticket-NAME, NOT keyed to acceptance — a separate cost view, do not join to the above):`);
    lines.push(`  tickets ${reviewRounds.totalTickets}; single-pass ${reviewRounds.singlePass}; multi-round ${reviewRounds.multiRound}; median rounds ${reviewRounds.medianRounds}; max ${reviewRounds.maxRounds}.`);
  }
  lines.push(`($ cost omitted: tasklog has no nodeId link to an accepted change; a fabricated join would overclaim — see eval §e③.)`);
  return lines.join("\n");
}

/** Content-addressed tag of a rendered report (SHA-256, first 128 bits) — the shell's publishOnce key stem. Identical inputs ⇒
 *  identical report ⇒ identical tag ⇒ a re-run DEDUPS (publishOnce "already", never a duplicate coordinator draft); changed inputs
 *  ⇒ a new tag ⇒ a fresh draft. Pure. */
export function ledgerReportTag(reportText: string): string {
  return createHash("sha256").update(reportText).digest("hex").slice(0, 32);
}
