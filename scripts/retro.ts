#!/usr/bin/env tsx
/**
 * retro / learn — the read-only retro-learn command ring (brief FROZEN @2b46959). Thin IO shell over the pure core (retro.ts) + the
 * store (retro-store.ts). Manual-primary (Q2); SWARM_RETRO gates it (Q4, default on). It NEVER writes PROGRESS or rulings/ — the only
 * side effects are a report under console/retro-reports/, a durable draft to the coordinator inbox, and ruling SEEDS under
 * console/retro-drafts/ (the coordinator's manual `mv` is the sole path into the signed ledger).
 *
 *   tsx scripts/retro.ts retro [--days 7 | --batch N] [--coordinator <sid>] [--if-due] [--period-days 7]
 *   tsx scripts/retro.ts learn --from <console/retro-reports/<w>.json>
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeInbox, composeInboxMsg } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import {
  retroEnabled, shouldRunRetro, reworkRoundDist, clusterAilments, extractProcessGaps, buildRetroReportJson,
  renderRetroMarkdown, lessonsFromReport, isAlreadyCovered, draftRulingSeed,
  type TextLine,
} from "../packages/bus/src/swarm/retro.js";
import {
  reviewReportsDir, rulingsLedgerDir, readReviewRoundRecords, readAttempts, readProgressLines, readExistingRulings,
  writeRetroReport, writeRulingSeed, readRetroReport, readLastRunSec, writeLastRunSec,
} from "../packages/bus/src/swarm/retro-store.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function home(): string { return process.env.AH_HOME ?? homedir(); }
const argVal = (argv: string[], n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

/** Keep only PROGRESS lines in the `批-N` / `batch-N` section (from the marker to the next batch/`## ` header). Best-effort. */
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

async function runRetro(argv: string[]): Promise<number> {
  const H = home();
  const batch = argVal(argv, "--batch") ? Number(argVal(argv, "--batch")) : null;
  const days = Number(argVal(argv, "--days") ?? "7");
  const window = batch !== null ? `batch-${batch}` : `${days}d-ending-${new Date().toISOString().slice(0, 10)}`;

  if (argv.includes("--if-due")) {
    const periodSec = (Number(argVal(argv, "--period-days") ?? "7")) * 86400;
    if (!shouldRunRetro(readLastRunSec(H), nowSec(), periodSec)) { console.log(`retro: not due (last run within period). skip.`); return 0; }
  }

  // sources (FC-2 three-state)
  const reviewsRaw = readReviewRoundRecords(reviewReportsDir(H));
  // window-scope review dirs by mtime in days-mode (batch-mode keeps all; noted in the report's window label)
  let reviews = reviewsRaw.records;
  if (batch === null && reviewsRaw.status === "read") {
    const sinceSec = nowSec() - days * 86400;
    reviews = reviews.filter((r) => { try { return statSync(path.join(reviewReportsDir(H), r.dir)).mtimeMs / 1000 >= sinceSec; } catch { return false; } });
  }
  const attempts = readAttempts(H);
  const progress = readProgressLines(H);
  const progressLines = batch !== null && progress.status === "read" ? sliceBatchSection(progress.lines, batch) : progress.lines;
  const rulings = readExistingRulings(REPO);

  const json = buildRetroReportJson({
    window, nowSec: nowSec(),
    rework: reworkRoundDist(reviews),
    ailments: clusterAilments(attempts.attempts, progressLines),
    gaps: extractProcessGaps(progressLines),
    sources: { reviewReports: reviewsRaw.status, controlLog: attempts.status, progress: progress.status, rulings: rulings.status },
  });
  const md = renderRetroMarkdown(json);
  const written = writeRetroReport(H, json, md);
  console.log(written ? `retro report -> ${written}` : `retro report SKIPPED (CP-3 boundary)`);

  // deliver the draft to the coordinator inbox (durable-first; key per window so a re-run does not double-deliver)
  const coordRef = argVal(argv, "--coordinator") ?? process.env.SWARM_COORDINATOR ?? "";
  if (coordRef) {
    const coordSid = resolveSession(coordRef, listSessions(H));
    if (!coordSid) console.error(`retro: coordinator '${coordRef}' did not resolve to a live SID — report on disk only (not writing a bare-handle box).`);
    else {
      try {
        const msg = composeInboxMsg({ from: "retro", fromLabel: "swarm-retro", text: md, via: "retro", intent: "report" });
        const r = writeInbox(H, coordSid, msg, `retro-${window}`);
        console.log(`retro draft -> coordinator ${coordSid}: ${r}`);
      } catch (e) { console.error(`retro: coordinator delivery FAILED: ${(e as Error).message}`); }
    }
  } else console.log(`retro: SWARM_COORDINATOR unset — report on disk only.`);

  writeLastRunSec(H, nowSec()); // Q6 water-mark
  return 0;
}

function runLearn(argv: string[]): number {
  const H = home();
  const from = argVal(argv, "--from");
  if (!from) { console.error(`learn: --from <retro-report.json> required`); return 2; }
  const report = readRetroReport(from);
  if (!report) { console.error(`learn: cannot read a valid retro report at ${from}`); return 2; }
  const existing = readExistingRulings(REPO);
  if (existing.status === "unreadable") { console.error(`learn: the rulings ledger is UNREADABLE — refusing to draft seeds against an unknown ledger (dedup + id suggestion need it).`); return 1; }
  const lessons = lessonsFromReport(report);
  let drafted = 0, skipped = 0;
  for (const lesson of lessons) {
    if (isAlreadyCovered(lesson, existing.rulings)) { skipped++; console.log(`  skip (already covered): ${lesson.title}`); continue; }
    const seed = draftRulingSeed(lesson, existing.ids, nowSec());
    const p = writeRulingSeed(H, seed);
    if (p) { drafted++; console.log(`  seed ${seed.suggestedId} -> ${p}`); } else console.error(`  seed SKIPPED (CP-3 boundary): ${lesson.title}`);
  }
  console.log(`learn: ${drafted} seed(s) drafted, ${skipped} already-covered. Coordinator signs + manual mv into rulings/ (retro NEVER writes the ledger).`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (!retroEnabled()) { console.error(`retro: SWARM_RETRO is off (=0). Set SWARM_RETRO=1 (default on) to run.`); return 0; }
  const cmd = argv[0];
  if (cmd === "retro") return runRetro(argv.slice(1));
  if (cmd === "learn") return runLearn(argv.slice(1));
  console.error(`usage: retro [--days 7 | --batch N] [--coordinator <sid>] [--if-due]\n       learn --from <report.json>`);
  return 2;
}

if (process.argv[1] && /(^|\/)retro\.ts$/.test(process.argv[1])) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
