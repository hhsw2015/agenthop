#!/usr/bin/env tsx
/**
 * retro / learn — the read-only retro-learn command ring (brief FROZEN @2b46959). Thin IO shell over the pure core (retro.ts) + the
 * store (retro-store.ts). Manual-primary (Q2); SWARM_RETRO gates it (Q4, default on). It NEVER writes PROGRESS or rulings/ — the only
 * side effects are a report under console/retro-reports/, a durable draft to the coordinator inbox, and ruling SEEDS under
 * console/retro-drafts/ (the coordinator's manual `mv` is the sole path into the signed ledger).
 *
 * Three disciplines the review bounced (happycapy @5e7a97f):
 *   RL-P3-1  args are VALIDATED (classifyRetroArgs) BEFORE any read/write — a bad window ⇒ usage + exit 2, ZERO writes.
 *   RL-P2-1  each axis is window-scoped where it CAN be (reviews by mtime, PROGRESS by its 批-N section) and labeled honestly
 *            (axisScopes: windowed / whole / incomplete) — whole-corpus data is never printed as a windowed conclusion.
 *   RL-P2-3  the obligation model (账随实走): the water-mark advances ONLY when nothing is outstanding. A refused report write, an
 *            unresolved/failed delivery ⇒ exit 1 + the window stays un-watermarked so a later --since-last RE-covers it.
 *   RL-P2-4  ONE atomic report JSON is the source of truth; the coordinator body is rendered from the SAME json, so disk + inbox
 *            can never carry two different versions.
 *
 *   tsx scripts/retro.ts retro [--days N | --batch N | --since-last] [--coordinator <sid>] [--if-due] [--period-days N]
 *   tsx scripts/retro.ts learn --from <console/retro-reports/<w>.json>
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeInbox, composeInboxMsg } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import {
  retroEnabled, shouldRunRetro, classifyRetroArgs, reworkRoundDist, clusterAilments, extractProcessGaps, buildRetroReportJson,
  renderRetroMarkdown, lessonsFromReport, isAlreadyCovered, draftRulingSeed,
  type RetroArgs, type AxisScope, type TextLine,
} from "../packages/bus/src/swarm/retro.js";
import {
  reviewReportsDir, readReviewRoundRecords, readAttempts, readProgressLines, readExistingRulings,
  writeRetroReport, writeRulingSeed, readRetroReport, readLastRunSec, writeLastRunSec,
} from "../packages/bus/src/swarm/retro-store.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function home(): string { return process.env.AH_HOME ?? homedir(); }

const USAGE = `usage: retro retro [--days N | --batch N | --since-last] [--coordinator <sid>] [--if-due] [--period-days N]
       retro learn --from <console/retro-reports/<w>.json>`;

/** Keep only PROGRESS lines in the `批-N` / `batch-N` section (from the marker to the next batch/`## ` header). Best-effort; the scope
 *  is reported (axisScopes.progress="windowed") so an empty slice reads as "scoped, nothing here", never "whole corpus, nothing". */
function sliceBatchSection(lines: readonly TextLine[], batch: number): TextLine[] {
  const startRe = new RegExp(`(批-${batch}\\b|batch-${batch}\\b)`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (startRe.test(lines[i]!.text)) { start = i; break; }
  if (start < 0) return [];
  const out: TextLine[] = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i]!.text;
    if (i > start && (/批-\d+\b|batch-\d+\b/.test(t) || /^## /.test(t))) break;
    out.push(lines[i]!);
  }
  return out;
}

async function runRetro(a: Extract<RetroArgs, { mode: "retro" }>): Promise<number> {
  const H = home();
  const startSec = nowSec(); // RL-P2-1/3: window anchor AND the water-mark value — anything modified after we START is re-covered next run.

  if (a.ifDue) {
    if (!shouldRunRetro(readLastRunSec(H), startSec, a.periodDays * 86400)) { console.log(`retro: not due (last run within ${a.periodDays}d). skip.`); return 0; }
  }

  // --- RL-P2-1: scope each axis where it CAN be scoped; label every axis honestly (whole-corpus data is never a windowed conclusion). ---
  let windowLabel: string;
  let reviewsSince: number | null;      // mtime floor for review dirs; null = whole corpus
  let intendedReviewScope: AxisScope;
  let progressBatch: number | null = null;

  if (a.window.kind === "batch") {
    windowLabel = `batch-${a.window.batch}`;
    reviewsSince = null; intendedReviewScope = "whole";   // review dirs carry no batch tag ⇒ not scopeable by batch (labeled whole)
    progressBatch = a.window.batch;                        // PROGRESS *is* scopeable (its 批-N section)
  } else if (a.window.kind === "since-last") {
    const last = readLastRunSec(H);
    reviewsSince = last;                                   // null on the very first run ⇒ whole corpus
    intendedReviewScope = last === null ? "whole" : "windowed";
    windowLabel = last === null ? "since-last-first-run-whole" : `since-${new Date(last * 1000).toISOString().slice(0, 10)}`;
  } else {
    reviewsSince = startSec - a.window.days * 86400;
    intendedReviewScope = "windowed";
    windowLabel = `${a.window.days}d-ending-${new Date(startSec * 1000).toISOString().slice(0, 10)}`;
  }

  // sources (FC-2 three-state). reviews are mtime-windowed in the store (per-dir stat three-state ⇒ `complete` flag).
  const reviews = readReviewRoundRecords(reviewReportsDir(H), reviewsSince);
  const attempts = readAttempts(H);                        // control-log has NO timestamp ⇒ ALWAYS whole corpus (labeled)
  const progress = readProgressLines(H);
  const progressScoped = progressBatch !== null && progress.status === "read";
  const progressLines: TextLine[] = progressScoped ? sliceBatchSection(progress.lines, progressBatch!) : progress.lines;
  const rulings = readExistingRulings(REPO);

  const axisScopes: { reviews: AxisScope; controlLog: AxisScope; progress: AxisScope } = {
    reviews: reviews.complete ? intendedReviewScope : "incomplete", // a per-dir stat fault during windowing ⇒ some items unattributable
    controlLog: "whole",
    progress: progressScoped ? "windowed" : "whole",
  };

  const json = buildRetroReportJson({
    window: windowLabel, nowSec: startSec,
    rework: reworkRoundDist(reviews.records),
    ailments: clusterAilments(attempts.attempts, progressLines),
    gaps: extractProcessGaps(progressLines),
    sources: { reviewReports: reviews.status, controlLog: attempts.status, progress: progress.status, rulings: rulings.status },
    axisScopes,
  });

  // --- RL-P2-3 obligation model: collect every unmet obligation; the water-mark advances ONLY when none remain. ------------------
  const outstanding: string[] = [];
  const reportPath = writeRetroReport(H, json); // RL-P2-4: ONE atomic JSON (source of truth); null ⇒ CP-3 refused
  if (reportPath) console.log(`retro report -> ${reportPath}`);
  else { console.error(`retro report NOT saved (CP-3 boundary refused the write).`); outstanding.push("report:unwritten"); }

  const coordRef = a.coordinator ?? process.env.SWARM_COORDINATOR ?? "";
  if (!coordRef) console.log(`retro: SWARM_COORDINATOR unset — report on disk only (no delivery obligation).`);
  else if (!reportPath) outstanding.push("coordinator-delivery:skipped(no-report)"); // nothing to deliver; already counted via report:unwritten
  else {
    const coordSid = resolveSession(coordRef, listSessions(H));
    if (!coordSid) { console.error(`retro: coordinator '${coordRef}' did not resolve to a live SID — NOT writing a bare-handle box.`); outstanding.push(`coordinator-delivery:unresolved(${coordRef})`); }
    else {
      try {
        const md = renderRetroMarkdown(json); // RL-P2-4: rendered from the SAME json ⇒ body + disk cannot diverge
        const r = writeInbox(H, coordSid, composeInboxMsg({ from: "retro", fromLabel: "swarm-retro", text: md, via: "retro", intent: "report" }), `retro-${windowLabel}`);
        console.log(`retro draft -> coordinator ${coordSid}: ${r}`);
        if (r !== "published" && r !== "already") outstanding.push(`coordinator-delivery:${r}`); // deferred/pending/unknown ⇒ not confirmed
      } catch (e) { console.error(`retro: coordinator delivery FAILED: ${(e as Error).message}`); outstanding.push("coordinator-delivery:failed"); }
    }
  }

  if (outstanding.length === 0) {
    if (!writeLastRunSec(H, startSec)) console.error(`retro: water-mark NOT saved (CP-3) — next --since-last re-covers this window (idempotent, harmless).`);
    return 0;
  }
  console.error(`retro: ${outstanding.length} outstanding — water-mark NOT advanced (re-run to retry): ${outstanding.join("; ")}`);
  return 1;
}

function runLearn(from: string): number {
  const H = home();
  const report = readRetroReport(from);
  if (!report) { console.error(`learn: cannot read a valid retro report at ${from}`); return 2; }
  const existing = readExistingRulings(REPO);
  if (existing.status === "unreadable") { console.error(`learn: the rulings ledger is UNREADABLE — refusing to draft seeds against an unknown ledger (dedup + id suggestion need it).`); return 1; }
  const lessons = lessonsFromReport(report);
  let drafted = 0, skipped = 0, refused = 0;
  for (const lesson of lessons) {
    if (isAlreadyCovered(lesson, existing.rulings)) { skipped++; console.log(`  skip (already covered): ${lesson.title}`); continue; }
    const seed = draftRulingSeed(lesson, existing.ids, nowSec());
    const p = writeRulingSeed(H, seed);
    if (p) { drafted++; console.log(`  seed ${seed.suggestedId} -> ${p}`); } else { refused++; console.error(`  seed SKIPPED (CP-3 boundary): ${lesson.title}`); }
  }
  console.log(`learn: ${drafted} seed(s) drafted, ${skipped} already-covered${refused ? `, ${refused} refused (CP-3)` : ""}. Coordinator signs + manual mv into rulings/ (retro NEVER writes the ledger).`);
  return refused > 0 ? 1 : 0; // RL-P2-3: a refused seed write is an unmet obligation, not a success
}

async function main(): Promise<number> {
  // RL-P3-1: validate args FIRST (pure, zero writes). A bad window / unknown option ⇒ usage + exit 2 before any read or write.
  const args = classifyRetroArgs(process.argv.slice(2));
  if (args.mode === "usage") { if (args.error) console.error(`retro: ${args.error}`); console.error(USAGE); return 2; }
  if (!retroEnabled()) { console.error(`retro: SWARM_RETRO is off (=0). Set SWARM_RETRO=1 (default on) to run.`); return 0; }
  if (args.mode === "learn") return runLearn(args.from);
  return runRetro(args);
}

if (process.argv[1] && /(^|\/)retro\.ts$/.test(process.argv[1])) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
