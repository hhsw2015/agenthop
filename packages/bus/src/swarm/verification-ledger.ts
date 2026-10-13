/**
 * verification-ledger — PURE core (econ-mirror-21 candidate ③; coordinator-greenlit after the eval 闭卷 @648aea8).
 *
 * Turns our in-repo review RECORD into a COST-per-accepted-change projection: for each ACCEPTED change (a control-log `accepted`
 * entity) how much REWORK it took to reach acceptance — the rejections for that SAME change's (jobId, nodeId), in the sequence
 * window that ends at its acceptance. The Q2 "cost side" the econ eval (docs/research/agentic-economics-eval.md §e③) says is
 * missing. Explicitly a **COST** metric, **NOT an ROI**: pricing the VALUE of a change needs a return signal we do not have.
 *
 * Correctness invariants (r2 — the review found and these fix real attribution bugs):
 *   - VL-1 compound key. nodeId is unique only WITHIN a (job, plan); `accepted`/`attempt` both carry jobId. We key by the COMPOUND
 *     (jobId, nodeId) via a Map (never a bare-nodeId object — a nodeId like "constructor" must not hit Object.prototype). A `rejected`
 *     has no jobId of its own, only attemptId → we resolve its (jobId, nodeId) through the attempt; an UNLINKED rejection is counted
 *     as `unresolvedRejections`, NEVER folded into a node.
 *   - VL-2 sequence window. Every `accepted` carries decidedAtSeq, every `rejected` atSeq, every `attempt` createdAtSeq. A change's
 *     rework = rejections for its node strictly AFTER the previous acceptance for that node and strictly BEFORE this one. A rejection
 *     that happens AFTER an acceptance belongs to a later revision's window, NEVER to the already-accepted change.
 *   - VL-3 unknown ≠ zero. A change with no in-window attempt (unaccounted) is `countersMissing` and is EXCLUDED from the mean and
 *     the first-try count; the summary reports the KNOWN sample size (coverage), never a 0/0 row read as "cheap".
 *
 * Evidence honesty (the discipline the eval itself passed): the control-log is the ONE reliably-keyed surface. `$` cost (tasklog)
 * has no (jobId, nodeId) link and review-report rounds are keyed by ticket-NAME — neither is force-joined; a fabricated join would be
 * the exact overclaim the review removed. Unreadable/absent/partial sources are stated (FC-2), never rendered as a clean zero.
 *
 * SUGGESTION/REPORT ONLY (R16, like autoscale-suggest + retro): reads already-loaded records and renders a report; NEVER spends,
 * acts, or writes to control-log / rulings. The shell drafts the report to the coordinator inbox.
 *
 * Pure: no fs, no clock. The IO half (loadControlLog → entities; retro-store review rounds; FC-2 three-state) lives in
 * verification-ledger-store.ts.
 */
import { createHash } from "node:crypto";
import type { ReworkDist, SourceStatus } from "./retro.js";

/** Opt-in OFF (dormant): a brand-new projection with no user ruling to run it live. Explicit SWARM_VERIFICATION_LEDGER=1|true|yes|on. */
export function verificationLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.SWARM_VERIFICATION_LEDGER ?? "").trim());
}

export type LedgerArgs = { threshold: number; sinceSec: number | null; coordinator?: string; dry: boolean };

/** Parse argv (pure; validated BEFORE any read — bad input ⇒ null ⇒ usage + exit 2, zero side effects). `nowSec` is injected so
 *  --days is pure. VL-5: --since-last is NOT accepted (there is no watermark to honor — accepting it silently ran a full scan); an
 *  unknown flag ⇒ null. --days filters ONLY the review-report mtime window (the control-log is always the full current projection). */
export function parseLedgerArgs(argv: readonly string[], nowSec: number): LedgerArgs | null {
  let threshold = 3; let sinceSec: number | null = null; let coordinator: string | undefined; let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") { dry = true; continue; }
    if (a === "--threshold") { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) return null; threshold = n; continue; }
    if (a === "--days") { const n = Number(argv[++i]); if (!Number.isFinite(n) || n <= 0) return null; sinceSec = nowSec - Math.floor(n * 86400); continue; }
    if (a === "--coordinator") { const v = argv[++i]; if (!v) return null; coordinator = v; continue; }
    return null; // unknown flag (incl. the retired --since-last)
  }
  return { threshold, sinceSec, coordinator, dry };
}

/** One accepted change (control-log `accepted` entity). All fields present on an AcceptedResult; decidedAtSeq orders revisions. */
export type AcceptedChange = { acceptedResultId: string; jobId: string; nodeId: string; planRevision: number; decidedAtSeq: number; attemptId: string; superseded: boolean };
/** One attempt (control-log `attempt` entity) — carries its node + its commit seq. */
export type AttemptRec = { attemptId: string; jobId: string; nodeId: string; createdAtSeq: number };
/** One rejection (control-log `rejected` entity) — NO jobId of its own; its node is resolved via attemptId → the attempt. */
export type RejectionRec = { attemptId: string; atSeq: number };
export type LedgerInputs = { accepted: AcceptedChange[]; attempts: AttemptRec[]; rejections: RejectionRec[] };

// VL-1 (r3): an INJECTIVE compound key. A separator-join (even NUL) can collide — the plan input validator does NOT ban any char in
// an id, so jobId="a\u0000b"+nodeId="c" and jobId="a"+nodeId="b\u0000c" would share a NUL-joined key. JSON.stringify of the
// [jobId,nodeId] tuple is a bijection for string pairs (quoting + escaping disambiguate) ⇒ no two distinct tuples collide.
const nodeKey = (jobId: string, nodeId: string) => JSON.stringify([jobId, nodeId]);
function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Extract accepted/attempt/rejected inputs from control-log entity bodies (pure, duck-typed — the store passes
 *  `Object.values(liveEntities(state))`). A body missing a REQUIRED field (ids / seq) is skipped, never guessed. */
export function extractLedgerInputs(bodies: readonly unknown[]): LedgerInputs {
  const accepted: AcceptedChange[] = [];
  const attempts: AttemptRec[] = [];
  const rejections: RejectionRec[] = [];
  for (const body of bodies) {
    const b = body as { put?: string; accepted?: Record<string, unknown>; attempt?: Record<string, unknown>; rejected?: Record<string, unknown> };
    if (b.put === "accepted" && b.accepted) {
      const a = b.accepted; const id = str(a.acceptedResultId); const jobId = str(a.jobId); const nodeId = str(a.nodeId); const seq = num(a.decidedAtSeq);
      if (id && jobId && nodeId && seq !== null) accepted.push({ acceptedResultId: id, jobId, nodeId, planRevision: num(a.planRevision) ?? 0, decidedAtSeq: seq, attemptId: str(a.attemptId) ?? "", superseded: a.superseded === true });
    } else if (b.put === "attempt" && b.attempt) {
      const a = b.attempt; const attemptId = str(a.attemptId); const jobId = str(a.jobId); const nodeId = str(a.nodeId); const seq = num(a.createdAtSeq);
      if (attemptId && jobId && nodeId && seq !== null) attempts.push({ attemptId, jobId, nodeId, createdAtSeq: seq });
    } else if (b.put === "rejected" && b.rejected) {
      const r = b.rejected; const attemptId = str(r.attemptId); const seq = num(r.atSeq);
      if (attemptId && seq !== null) rejections.push({ attemptId, atSeq: seq });
    }
  }
  return { accepted, attempts, rejections };
}

/** The verification COST of one accepted change. `reworkRounds` = rejections for this change's (jobId,nodeId) in its sequence window
 *  (after the previous acceptance for that node, before this one). `countersMissing` = no in-window attempt (unaccounted — NOT "cheap"). */
export type LedgerRow = {
  jobId: string; nodeId: string; acceptedResultId: string; planRevision: number; decidedAtSeq: number;
  attempts: number; reworkRounds: number; superseded: boolean; countersMissing: boolean;
};
export type CostPerAcceptedChange = { rows: LedgerRow[]; unresolvedRejections: number };

/** Join (pure). Compound (jobId,nodeId) keyed via Map (VL-1 — no cross-job bleed, no prototype pollution). Rejections resolve their
 *  node via attemptId → attempt (VL-1 — a rejection has no jobId); unlinked ⇒ unresolvedRejections, never folded. Per accepted, the
 *  rework window is (prevAcceptDecidedAtSeq, thisDecidedAtSeq) for rejections and (…, thisDecidedAtSeq] for attempts (VL-2 — a
 *  post-acceptance rejection belongs to a LATER revision, never to the already-accepted change). */
export function costPerAcceptedChange(inputs: LedgerInputs): CostPerAcceptedChange {
  const attemptNode = new Map<string, { jobId: string; nodeId: string }>();
  for (const a of inputs.attempts) attemptNode.set(a.attemptId, { jobId: a.jobId, nodeId: a.nodeId });

  let unresolvedRejections = 0;
  const rejSeqByNode = new Map<string, number[]>();
  for (const r of inputs.rejections) {
    const n = attemptNode.get(r.attemptId);
    if (!n) { unresolvedRejections += 1; continue; } // VL-1: never fold a rejection with no attempt link into a global/guessed node
    pushTo(rejSeqByNode, nodeKey(n.jobId, n.nodeId), r.atSeq);
  }
  const attSeqByNode = new Map<string, number[]>();
  for (const a of inputs.attempts) pushTo(attSeqByNode, nodeKey(a.jobId, a.nodeId), a.createdAtSeq);
  const accByNode = new Map<string, AcceptedChange[]>();
  for (const a of inputs.accepted) pushTo(accByNode, nodeKey(a.jobId, a.nodeId), a);

  const rows: LedgerRow[] = [];
  for (const [k, accs] of accByNode) {
    const sorted = [...accs].sort((x, y) => x.decidedAtSeq - y.decidedAtSeq);
    const rejSeqs = rejSeqByNode.get(k) ?? [];
    const attSeqs = attSeqByNode.get(k) ?? [];
    let prevSeq = -Infinity;
    for (const a of sorted) {
      const reworkRounds = rejSeqs.filter((s) => s > prevSeq && s < a.decidedAtSeq).length;
      const attemptsInWindow = attSeqs.filter((s) => s > prevSeq && s <= a.decidedAtSeq).length;
      rows.push({
        jobId: a.jobId, nodeId: a.nodeId, acceptedResultId: a.acceptedResultId, planRevision: a.planRevision, decidedAtSeq: a.decidedAtSeq,
        attempts: attemptsInWindow, reworkRounds, superseded: a.superseded, countersMissing: attemptsInWindow === 0,
      });
      prevSeq = a.decidedAtSeq;
    }
  }
  return { rows, unresolvedRejections };
}

/** A change whose rework meets/exceeds the threshold is "disproportionate" (a Q2 cost-side signal). Default 3. Pure. */
export function disproportionateRework(row: LedgerRow, threshold = 3): boolean {
  return row.reworkRounds >= threshold;
}

export type LedgerSummary = {
  acceptedCount: number;        // live accepted (superseded excluded)
  knownCount: number;           // live && !countersMissing — the sample the mean/first-try are over
  countersMissingCount: number; // live but unaccounted (excluded from mean/first-try — VL-3)
  meanReworkKnown: number;      // mean over KNOWN only
  zeroReworkKnown: number;      // first-try accepts among KNOWN
  totalReworkKnown: number;
  unresolvedRejections: number; // rejections with no attempt link (not attributed to any change — VL-1)
  flagged: LedgerRow[];         // known && disproportionate
};

/** Aggregate. Superseded accepts are EXCLUDED (their acceptance was replaced). `countersMissing` (unknown-cost) accepts are EXCLUDED
 *  from the mean + first-try count (VL-3 — unknown is not known-zero); the summary carries the coverage so the mean is never read as
 *  if it covered every change. Pure. */
export function summarizeLedger(cpac: CostPerAcceptedChange, threshold = 3): LedgerSummary {
  const live = cpac.rows.filter((r) => !r.superseded);
  const known = live.filter((r) => !r.countersMissing);
  const totalReworkKnown = known.reduce((s, r) => s + r.reworkRounds, 0);
  return {
    acceptedCount: live.length,
    knownCount: known.length,
    countersMissingCount: live.length - known.length,
    meanReworkKnown: known.length === 0 ? 0 : totalReworkKnown / known.length,
    zeroReworkKnown: known.filter((r) => r.reworkRounds === 0).length,
    totalReworkKnown,
    unresolvedRejections: cpac.unresolvedRejections,
    flagged: known.filter((r) => disproportionateRework(r, threshold)).sort((a, b) => b.reworkRounds - a.reworkRounds),
  };
}

/** FC-2 completeness of the review-report-rounds view: `read` + complete, `read` but PARTIAL (some ticket dirs faulted — a lower
 *  bound, VL-4), or the raw unreadable/absent status. */
export type LedgerSources = { controlLog: SourceStatus; reviewReports: SourceStatus; reviewReportsComplete: boolean };

/** Format a window of whole seconds in its COARSEST EXACT unit — never lossy (VL-5): d only for whole days, h/m only when they divide
 *  evenly, else raw seconds; a ≥1-day non-round window shows native days (e.g. 1.49d). So 86s⇒"86s" (not "0d"), 21600s⇒"6h", 86400s⇒"1d". */
export function fmtWindow(sec: number): string {
  if (sec > 0 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec < 86400) {
    if (sec % 3600 === 0) return `${sec / 3600}h`;
    if (sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
  }
  return `${sec / 86400}d`; // > 1 day, non-whole: native day precision (exact for values like 1.49)
}

/** Render the coordinator report (pure). Honest throughout: a COST metric (not ROI); control-log is the reliable join; the mean is
 *  over the KNOWN sample with coverage shown (VL-3); unresolved rejections are surfaced (VL-1); a PARTIAL review-rounds view is a lower
 *  bound (VL-4); the two surfaces' RANGES differ (VL-5: control-log = full current projection; review-rounds = --days mtime or all). An
 *  unreadable/absent source is stated, never rendered as zero. `$` omitted (no (job,node) link — a fabricated join would overclaim). */
export function renderLedgerReport(input: {
  summary: LedgerSummary; reviewRounds: ReworkDist | null; sources: LedgerSources; reviewWindowSec?: number | null; threshold?: number;
}): string {
  const { summary, reviewRounds, sources } = input;
  const th = input.threshold ?? 3;
  const lines: string[] = [];
  lines.push(`[verification-ledger] cost-per-accepted-change (a COST metric, NOT an ROI — it does not price the VALUE of a change).`);

  if (sources.controlLog !== "read") {
    lines.push(`control-log: ${sources.controlLog} — cannot compute accepted-change cost (NOT reported as zero).`);
  } else {
    lines.push(`accepted changes: ${summary.acceptedCount} live (superseded excluded). control-log range: FULL current projection.`);
    lines.push(`  known-cost sample: ${summary.knownCount}/${summary.acceptedCount} (unknown-cost excluded from mean/first-try); unaccounted: ${summary.countersMissingCount}.`);
    lines.push(`  rework rounds = rejections before acceptance, in the change's own (job,node) sequence window.`);
    lines.push(`  mean rework (known) ${summary.meanReworkKnown.toFixed(2)} over ${summary.knownCount}; first-try (known, 0 rework) ${summary.zeroReworkKnown}; total rework (known) ${summary.totalReworkKnown}.`);
    if (summary.unresolvedRejections > 0) lines.push(`  ⚠ ${summary.unresolvedRejections} rejection(s) could not be linked to an attempt ⇒ NOT attributed to any change (not folded).`);
    if (summary.flagged.length > 0) {
      lines.push(`  disproportionate (≥${th} rework rounds), most-expensive first:`);
      for (const r of summary.flagged) lines.push(`    - ${r.jobId}/${r.nodeId} (accepted ${r.acceptedResultId}, rev ${r.planRevision}): ${r.reworkRounds} rework / ${r.attempts} attempts.`);
    } else {
      lines.push(`  none at/over ${th} rework rounds (known sample).`);
    }
  }

  // SEPARATE view — honest about the non-join AND the partial/ranged read.
  if (reviewRounds === null) {
    lines.push(`review-report rounds: ${sources.reviewReports} — view unavailable (NOT reported as zero).`);
  } else {
    // VL-5 (r4): show the window in its COARSEST EXACT unit (no lossy rounding — `--days 0.001` = 86s must not print "0d" or "0.01d";
    //  0.25d = 6h exactly). s/m/h only when they divide evenly; sub-day non-round falls to seconds; ≥1 day non-round shows native days.
    const range = input.reviewWindowSec != null ? `last ${fmtWindow(input.reviewWindowSec)} (mtime)` : `all`;
    // VL-4 (r3): a PARTIAL read is NOT a uniform "lower bound" — a ticket with an unreadable ROUND is under-counted, which can make a
    //  multi-round ticket look single-pass (single-pass OVER-counts), and the median is not monotone. State these as OBSERVED over the
    //  read subset, guaranteeing no total/direction — never a blanket "lower bound".
    const partial = sources.reviewReportsComplete ? "" : ` ⚠ PARTIAL — numbers below are OBSERVED over the read subset only (NOT complete; a ticket with an unreadable round is under-counted, so single-pass/median/totals are NOT guaranteed bounds)`;
    lines.push(`review-report rounds (by ticket-NAME, NOT keyed to acceptance — a separate cost view; range: ${range}; do not join to the above)${partial}:`);
    lines.push(`  tickets ${reviewRounds.totalTickets}; single-pass ${reviewRounds.singlePass}; multi-round ${reviewRounds.multiRound}; median rounds ${reviewRounds.medianRounds}; max ${reviewRounds.maxRounds}.`);
  }
  lines.push(`($ cost omitted: tasklog has no (job,node) link to an accepted change; a fabricated join would overclaim — see eval §e③.)`);
  return lines.join("\n");
}

/** Content-addressed tag of a rendered report (SHA-256, first 128 bits) — the shell's publishOnce key stem. Identical report TEXT ⇒
 *  identical tag ⇒ a re-run DEDUPS (publishOnce "already"); a different report TEXT ⇒ a new tag. (Note: two different INPUT sets that
 *  render to the SAME summary text share a tag — correct content-addressing on the TEXT, not a hash collision.) Pure. */
export function ledgerReportTag(reportText: string): string {
  return createHash("sha256").update(reportText).digest("hex").slice(0, 32);
}
