// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/retro.selftest.mts
// retro-learn (brief FROZEN @2b46959). Pins the pure extraction + ruling-seed drafting AND the IO store (FC-2 three-state reads,
// console-only writes), with the 3 zero-bug fixture classes over the write faces (drafts + report + water-mark). The KEY hardening
// assertion: a ruling seed lands in console/retro-drafts/, and NO code path writes the signed rulings/ ledger (the coordinator's
// manual mv is the only entry). Evidence honesty: structured vs heuristic signals are layered; unreadable ≠ empty.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  retroEnabled, shouldRunRetro, parseReviewDirName, reworkRoundDist, clusterAilments, extractProcessGaps,
  buildRetroReportJson, renderRetroMarkdown, nextSeriesId, isAlreadyCovered, draftRulingSeed, lessonsFromReport,
  RULING_SEED_SCHEMA, type ReviewRoundRecord, type AttemptRecord, type TextLine, type RetroReportJson, type Lesson,
} from "./retro.js";
import {
  readReviewRoundRecords, readAttempts, readProgressLines, readExistingRulings, writeRetroReport, writeRulingSeed,
  readRetroReport, readLastRunSec, writeLastRunSec,
} from "./retro-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "retro-selftest-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");
const reportsDirP = (h: string) => path.join(swarm(h), "console", "retro-reports");
const draftsDirP = (h: string) => path.join(swarm(h), "console", "retro-drafts");
const envSave = { AGENTHOP_RULINGS_DIR: process.env.AGENTHOP_RULINGS_DIR, RETRO_REVIEW_REPORTS_DIR: process.env.RETRO_REVIEW_REPORTS_DIR };

try {
  // ── flags + throttle ────────────────────────────────────────────────────────────────────────────────────────────
  t("retroEnabled default ON + kill-switch", retroEnabled({}) && !retroEnabled({ SWARM_RETRO: "0" }));
  t("shouldRunRetro: never-run ⇒ due; within ⇒ not; elapsed ⇒ due; bad ⇒ false", shouldRunRetro(null, 1000, 60) && !shouldRunRetro(1000, 1030, 60) && shouldRunRetro(1000, 1100, 60) && !shouldRunRetro(null, NaN, 60) && !shouldRunRetro(null, 1000, 0));

  // ── AXIS 1: rework-round distribution ───────────────────────────────────────────────────────────────────────────
  t("parseReviewDirName: ticket+sha (ticket may have hyphens)", (() => { const p = parseReviewDirName("approval-delegation-io-e5a40c2-review-evidence"); return p?.ticket === "approval-delegation-io" && p.sha === "e5a40c2"; })());
  t("parseReviewDirName: non-review ⇒ null", parseReviewDirName("random-folder") === null);
  t("reworkRoundDist: distinct shas per ticket = rounds", (() => {
    const recs: ReviewRoundRecord[] = [
      { ticket: "a", sha: "1111111", dir: "" }, { ticket: "a", sha: "2222222", dir: "" }, { ticket: "a", sha: "2222222", dir: "" }, // a: 2 rounds (dup sha collapses)
      { ticket: "b", sha: "3333333", dir: "" }, // b: 1 round
    ];
    const d = reworkRoundDist(recs);
    return d.totalTickets === 2 && d.perTicket[0]!.ticket === "a" && d.perTicket[0]!.rounds === 2 && d.singlePass === 1 && d.multiRound === 1 && d.maxRounds === 2;
  })());

  // ── AXIS 2: repeated ailments (structured + heuristic, layered) ─────────────────────────────────────────────────
  t("clusterAilments: structured failureClass tally (recurring only)", (() => {
    const at: AttemptRecord[] = [{ attemptId: "a1", nodeId: "n", status: "ABANDONED", failureClass: "timeout" }, { attemptId: "a2", nodeId: "n", status: "ABANDONED", failureClass: "timeout" }, { attemptId: "a3", nodeId: "n", status: "ABANDONED", failureClass: "oneoff" }];
    const c = clusterAilments(at, [], 2);
    return c.structured.length === 1 && c.structured[0]!.failureClass === "timeout" && c.structured[0]!.count === 2;
  })());
  t("clusterAilments: heuristic keyword tally with source refs (待人核)", (() => {
    const lines: TextLine[] = [{ source: "PROGRESS.md", line: 10, text: "读错空集 again" }, { source: "PROGRESS.md", line: 55, text: "silent empty set here" }, { source: "PROGRESS.md", line: 9, text: "unrelated" }];
    const c = clusterAilments([], lines, 2);
    const re = c.heuristic.find((h) => h.slug === "read-error-as-empty");
    return re !== undefined && re.count === 2 && re.hits.length === 2 && re.hits[0]!.line === 10;
  })());

  // ── AXIS 3: process gaps (line-cited) ───────────────────────────────────────────────────────────────────────────
  t("extractProcessGaps: line-cited gap signals", (() => {
    const lines: TextLine[] = [{ source: "PROGRESS.md", line: 7, text: "tsc 红出门了" }, { source: "PROGRESS.md", line: 8, text: "normal" }, { source: "PROGRESS.md", line: 9, text: "吞错继续 in hot path" }];
    const g = extractProcessGaps(lines);
    return g.length === 2 && g[0]!.line === 7 && g[1]!.slug === "swallow-in-hot-path";
  })());

  // ── learn: seeds (draft, NOT a ledger record) + dedup + id suggestion ───────────────────────────────────────────
  t("nextSeriesId: max+1 per series", nextSeriesId("F", ["F21", "F24", "S9", "R16"]) === "F25" && nextSeriesId("S", ["F21", "S9", "S12"]) === "S13" && nextSeriesId("R", []) === "R1");
  t("isAlreadyCovered: shared source OR statement overlap ⇒ true; novel ⇒ false", (() => {
    const existing = [{ statement: "guard FC-2 three-state everywhere", sources: ["control-log:attempt:x"], status: "active" }];
    const covered: Lesson = { series: "F", title: "t", statement: "z", sources: ["control-log:attempt:x"] };
    const novel: Lesson = { series: "F", title: "t", statement: "something entirely different here", sources: ["PROGRESS.md:999"] };
    return isAlreadyCovered(covered, existing) && !isAlreadyCovered(novel, existing);
  })());
  t("isAlreadyCovered: a SUPERSEDED ruling does not cover (only active)", !isAlreadyCovered({ series: "F", title: "t", statement: "z", sources: ["s1"] }, [{ statement: "x", sources: ["s1"], status: "superseded" }]));
  t("draftRulingSeed: draft:true + suggestedId (NOT a valid ledger id field) + no signed status", (() => {
    const seed = draftRulingSeed({ series: "F", title: "T", statement: "S", sources: ["PROGRESS.md:1"] }, ["F21"], 100);
    return seed.schema === RULING_SEED_SCHEMA && seed.draft === true && seed.suggestedId === "F22" && !("id" in seed) && !("status" in seed);
  })());
  t("lessonsFromReport: structured ailment ⇒ F lesson; gap ⇒ S lesson", (() => {
    const r: RetroReportJson = buildRetroReportJson({ window: "w", nowSec: 1, rework: reworkRoundDist([]), ailments: { structured: [{ failureClass: "timeout", count: 3, attempts: ["a1"] }], heuristic: [] }, gaps: [{ slug: "gate-escape", source: "PROGRESS.md", line: 7, text: "x" }], sources: { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } });
    const ls = lessonsFromReport(r);
    return ls.some((l) => l.series === "F" && l.statement.includes("timeout")) && ls.some((l) => l.series === "S" && l.title.includes("gate-escape"));
  })());

  // ── report render: unreadable ≠ empty (evidence honesty) ────────────────────────────────────────────────────────
  t("renderRetroMarkdown: unreadable source ⇒ '无结论', not a false empty", (() => {
    const r = buildRetroReportJson({ window: "w", nowSec: 1, rework: reworkRoundDist([]), ailments: { structured: [], heuristic: [] }, gaps: [], sources: { reviewReports: "unreadable", controlLog: "read", progress: "read", rulings: "read" } });
    const md = renderRetroMarkdown(r);
    return md.includes("源 unreadable — 无结论") && md.includes("草稿 (draft)");
  })());

  // ── STORE: FC-2 three-state reads ───────────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(scratch, "reviews-"));
    mkdirSync(path.join(dir, "ticketA-1111111-review-evidence"), { recursive: true });
    mkdirSync(path.join(dir, "ticketA-2222222-review-x"), { recursive: true });
    mkdirSync(path.join(dir, "not-a-review"), { recursive: true });
    const r = readReviewRoundRecords(dir);
    t("store: readReviewRoundRecords reads + parses (ignores non-review)", r.status === "read" && r.records.length === 2);
    t("store: readReviewRoundRecords absent ⇒ absent", readReviewRoundRecords(path.join(scratch, "nope-reviews")).status === "absent");
  }
  {
    const h = freshHome();
    t("store: readAttempts absent control-log ⇒ absent", readAttempts(h).status === "absent");
    mkdirSync(path.join(swarm(h), "control-log"), { recursive: true });
    writeFileSync(path.join(swarm(h), "control-log", "1.json"), "{not json");
    t("store: readAttempts corrupt control-log ⇒ unreadable (not empty)", readAttempts(h).status === "unreadable");
  }
  {
    const h = freshHome();
    t("store: readProgressLines absent ⇒ absent", readProgressLines(h).status === "absent");
    mkdirSync(swarm(h), { recursive: true }); writeFileSync(path.join(swarm(h), "PROGRESS.md"), "line1\nline2");
    const pl = readProgressLines(h);
    t("store: readProgressLines reads line-cited", pl.status === "read" && pl.lines.length === 2 && pl.lines[0]!.line === 1);
  }
  {
    process.env.AGENTHOP_RULINGS_DIR = path.join(scratch, "no-such-rulings-dir");
    t("store: readExistingRulings absent dir ⇒ absent", readExistingRulings("/irrelevant").status === "absent");
    const rdir = mkdtempSync(path.join(scratch, "rulings-")); process.env.AGENTHOP_RULINGS_DIR = rdir;
    writeFileSync(path.join(rdir, "F1.json"), JSON.stringify({ id: "F1", series: "F", title: "t", statement: "s", status: "active" }));
    const er = readExistingRulings("/irrelevant");
    t("store: readExistingRulings reads valid ledger", er.status === "read" && er.ids.includes("F1"));
    writeFileSync(path.join(rdir, "bad.json"), "{not json");
    t("store: readExistingRulings corrupt ⇒ unreadable (never guess)", readExistingRulings("/irrelevant").status === "unreadable");
    delete process.env.AGENTHOP_RULINGS_DIR;
  }

  // ── STORE: write faces (console only) + round-trip ──────────────────────────────────────────────────────────────
  {
    const h = freshHome();
    const r = buildRetroReportJson({ window: "7d-x", nowSec: 5, rework: reworkRoundDist([]), ailments: { structured: [], heuristic: [] }, gaps: [], sources: { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } });
    const md = writeRetroReport(h, r, renderRetroMarkdown(r));
    t("store: writeRetroReport writes under console/retro-reports", md !== null && md.includes("retro-reports") && existsSync(path.join(reportsDirP(h), "7d-x.json")));
    t("store: readRetroReport round-trips the json", readRetroReport(path.join(reportsDirP(h), "7d-x.json"))?.window === "7d-x");
    t("store: water-mark write+read", writeLastRunSec(h, 999) && readLastRunSec(h) === 999);
  }

  // ── THE HARDENING: a seed goes to console/retro-drafts/, and the rulings ledger is NEVER written ─────────────────
  {
    const h = freshHome();
    const rdir = mkdtempSync(path.join(scratch, "ledger-untouched-")); process.env.AGENTHOP_RULINGS_DIR = rdir;
    const seed = draftRulingSeed({ series: "F", title: "repeat timeout", statement: "S", sources: ["control-log:attempt:a1"] }, ["F21"], 1);
    const p = writeRulingSeed(h, seed);
    t("hardening: seed path is console/retro-drafts/, NOT rulings/", p !== null && p.includes(path.join("console", "retro-drafts")) && !p.includes(`${path.sep}rulings${path.sep}`));
    t("hardening: the rulings ledger dir is UNTOUCHED by a seed write (zero code path)", readdirSync(rdir).length === 0);
    delete process.env.AGENTHOP_RULINGS_DIR;
  }

  // ── ZERO-BUG FIXTURE 1: crash-recovery (torn report ⇒ null; leftover tmp ignored; good write recovers) ───────────
  {
    const h = freshHome(); mkdirSync(reportsDirP(h), { recursive: true });
    writeFileSync(path.join(reportsDirP(h), "w.json"), '{"schema":"retro-report/v1","window":"w",'); // torn
    t("fixture[crash]: torn report ⇒ readRetroReport null", readRetroReport(path.join(reportsDirP(h), "w.json")) === null);
    writeFileSync(path.join(reportsDirP(h), "w.json.tmp-dead"), "garbage");
    const r = buildRetroReportJson({ window: "w", nowSec: 9, rework: reworkRoundDist([]), ailments: { structured: [], heuristic: [] }, gaps: [], sources: { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } });
    writeRetroReport(h, r, renderRetroMarkdown(r));
    t("fixture[crash]: good write after a crash reads cleanly; stray tmp ignored", readRetroReport(path.join(reportsDirP(h), "w.json"))?.generatedAtSec === 9);
  }

  // ── ZERO-BUG FIXTURE 2: restart-idempotency (re-run same window ⇒ same report; water-mark last-wins) ─────────────
  {
    const h = freshHome();
    const mk = () => buildRetroReportJson({ window: "w2", nowSec: 1000, rework: reworkRoundDist([{ ticket: "a", sha: "1111111", dir: "" }]), ailments: clusterAilments([{ attemptId: "a1", nodeId: "n", status: "x", failureClass: "f" }, { attemptId: "a2", nodeId: "n", status: "x", failureClass: "f" }], [], 2), gaps: [], sources: { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } });
    t("fixture[idem]: same inputs ⇒ byte-identical report json (deterministic)", JSON.stringify(mk()) === JSON.stringify(mk()));
    writeRetroReport(h, mk(), "md1"); writeRetroReport(h, mk(), "md2");
    t("fixture[idem]: re-write same window ⇒ last-wins, still valid", readRetroReport(path.join(reportsDirP(h), "w2.json"))?.window === "w2");
    writeLastRunSec(h, 100); writeLastRunSec(h, 200);
    t("fixture[idem]: water-mark last-wins", readLastRunSec(h) === 200);
  }

  // ── ZERO-BUG FIXTURE 3: concurrency-race (interleaved seed writes atomic; CP-3 ancestor symlink refused) ─────────
  {
    const h = freshHome();
    for (let i = 0; i < 12; i++) { const p = writeRulingSeed(h, draftRulingSeed({ series: "F", title: `t${i}`, statement: "s", sources: [] }, [], i)); if (p === null) throw new Error("FAILED: fixture[race] seed write refused unexpectedly"); }
    t("fixture[race]: interleaved seed writes all land under retro-drafts", readdirSync(draftsDirP(h)).filter((f) => f.endsWith(".json")).length >= 12);
  }
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-"));
    symlinkSync(ext, swarm(h)); // .agenthop/swarm -> ext (ancestor redirect)
    const r = buildRetroReportJson({ window: "w", nowSec: 1, rework: reworkRoundDist([]), ailments: { structured: [], heuristic: [] }, gaps: [], sources: { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } });
    t("fixture[race]: CP-3 symlinked swarm ancestor ⇒ writeRetroReport refused", writeRetroReport(h, r, "md") === null);
    t("fixture[race]: CP-3 ⇒ writeRulingSeed refused", writeRulingSeed(h, draftRulingSeed({ series: "F", title: "t", statement: "s", sources: [] }, [], 1)) === null);
    t("fixture[race]: CP-3 ⇒ writeLastRunSec refused", writeLastRunSec(h, 1) === false);
    t("fixture[race]: NO escape writes at the redirect target", !existsSync(path.join(ext, "console", "retro-reports", "w.json")) && !existsSync(path.join(ext, "console")));
  }

  console.log("\nretro-learn selftest: ALL PASS");
} finally {
  if (envSave.AGENTHOP_RULINGS_DIR === undefined) delete process.env.AGENTHOP_RULINGS_DIR; else process.env.AGENTHOP_RULINGS_DIR = envSave.AGENTHOP_RULINGS_DIR;
  if (envSave.RETRO_REVIEW_REPORTS_DIR === undefined) delete process.env.RETRO_REVIEW_REPORTS_DIR; else process.env.RETRO_REVIEW_REPORTS_DIR = envSave.RETRO_REVIEW_REPORTS_DIR;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
