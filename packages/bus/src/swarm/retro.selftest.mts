// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/retro.selftest.mts
// retro-learn (brief FROZEN @2b46959; r2 after happycapy @5e7a97f). Pins the pure extraction + arg validation + ruling-seed drafting
// AND the IO store (FC-2 three-state reads, console-only writes). The KEY hardening assertion: a ruling seed lands in
// console/retro-drafts/, and NO code path writes the signed rulings/ ledger (the coordinator's manual mv is the only entry).
//
// RL-P2-6: the 3 zero-bug fixture classes are REAL subprocesses of scripts/retro.ts (node --import tsx --import <preload>), not
// pure-function stand-ins. A test-only preload freezes nothing but monkeypatches fs.renameSync to SIGKILL after the report commit
// (crash), to pause there for a deterministic two-writer interleave (concurrency), or fs.statSync to inject a per-dir EIO. We assert
// subprocess exit codes / signals, the report version, the delivery credential (dedup ⇒ exactly one message), and the outstanding
// obligation (a crash before the water-mark leaves it un-advanced so --since-last re-covers).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  retroEnabled, shouldRunRetro, classifyRetroArgs, parseReviewDirName, reworkRoundDist, clusterAilments, extractProcessGaps,
  buildRetroReportJson, renderRetroMarkdown, reportVersionTag, nextSeriesId, isAlreadyCovered, coveringRulingId, draftRulingSeed, lessonsFromReport,
  RULING_SEED_SCHEMA, type ReviewRoundRecord, type AttemptRecord, type TextLine, type RetroReportJson, type Lesson,
} from "./retro.js";
import {
  readReviewRoundRecords, readAttempts, readProgressLines, readExistingRulings, writeRetroReport, writeRulingSeed,
  readRetroReport, readLastRunSec, writeLastRunSec,
} from "./retro-store.js";
import { inboxDirName } from "../inbox.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "retro-selftest-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");
const reportsDirP = (h: string) => path.join(swarm(h), "console", "retro-reports");
const draftsDirP = (h: string) => path.join(swarm(h), "console", "retro-drafts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));
const envSave = { AGENTHOP_RULINGS_DIR: process.env.AGENTHOP_RULINGS_DIR, RETRO_REVIEW_REPORTS_DIR: process.env.RETRO_REVIEW_REPORTS_DIR };

// report-json builder with sane defaults (so each test only states what it exercises)
const allRead = { reviewReports: "read", controlLog: "read", progress: "read", rulings: "read" } as const;
const wholeScopes = { reviews: "whole", controlLog: "whole", progress: "whole" } as const;
type BJ = Parameters<typeof buildRetroReportJson>[0];
const bj = (over: Partial<BJ> = {}): RetroReportJson =>
  buildRetroReportJson({ window: "w", nowSec: 1, rework: reworkRoundDist([]), ailments: { structured: [], heuristic: [] }, gaps: [], sources: allRead, axisScopes: wholeScopes, ...over });

// --- REAL subprocess harness (RL-P2-6) ------------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));          // packages/bus/src/swarm
const BUS_DIR = path.resolve(HERE, "../..");                        // packages/bus (where `tsx` resolves)
const REPO = path.resolve(HERE, "../../../..");                     // repo root
const SCRIPT = path.join(REPO, "scripts", "retro.ts");
const PRELOAD = path.join(scratch, "preload.mjs");
const COORD = "11111111-2222-3333-4444-555555555555";

writeFileSync(PRELOAD, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const crashBase = process.env.RETRO_TEST_CRASH_AFTER, crashMark = process.env.RETRO_TEST_CRASH_MARK;
const pauseBase = process.env.RETRO_TEST_PAUSE_AFTER, pauseMark = process.env.RETRO_TEST_PAUSE_MARK, release = process.env.RETRO_TEST_RELEASE;
if (crashBase || pauseBase) {
  const rename = fs.renameSync;
  fs.renameSync = function (a, b) {
    const r = rename.call(this, a, b); const bs = String(b);
    if (crashBase && bs.endsWith('/' + crashBase)) { if (crashMark) fs.writeFileSync(crashMark, JSON.stringify({ pid: process.pid, committed: bs })); process.kill(process.pid, 'SIGKILL'); }
    if (pauseBase && bs.endsWith('/' + pauseBase)) {
      if (pauseMark) fs.writeFileSync(pauseMark, JSON.stringify({ pid: process.pid, committed: bs }));
      const deadline = Date.now() + 8000;
      while (!(release && fs.existsSync(release))) { if (Date.now() > deadline) throw new Error('bounded barrier timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
    }
    return r;
  };
}
const statTarget = process.env.RETRO_TEST_STAT_FAULT;
if (statTarget) { const stat = fs.statSync; fs.statSync = function (p, ...a) { if (String(p) === statTarget) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' }); return stat.call(this, p, ...a); }; }
syncBuiltinESMExports();
`);

function childEnv(h: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.NODE_OPTIONS; // the child loads tsx + the preload via argv (--import); don't double-register via an inherited NODE_OPTIONS
  return { ...e, SWARM_RETRO: "1", AH_HOME: h, SWARM_COORDINATOR: "", AGENTHOP_RULINGS_DIR: path.join(h, "no-rulings"), RETRO_REVIEW_REPORTS_DIR: path.join(h, "no-reviews"), ...extra };
}
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", PRELOAD, SCRIPT, ...args], { cwd: BUS_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "", err = ""; child.stdout.on("data", (b) => (out += b)); child.stderr.on("data", (b) => (err += b));
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}
function seedCoord(h: string): void { mkdirSync(path.join(h, ".agenthop", "presence"), { recursive: true }); writeFileSync(path.join(h, ".agenthop", "presence", `${COORD}.pid`), "12345"); }
const inboxCount = (h: string): number => { try { return readdirSync(path.join(h, ".agenthop", "inbox", inboxDirName(COORD))).filter((f) => f.endsWith(".json")).length; } catch { return 0; } };
const reportFiles = (h: string): string[] => { try { return readdirSync(reportsDirP(h)).filter((f) => f.endsWith(".json")); } catch { return []; } };

try {
  // ── flags + throttle ────────────────────────────────────────────────────────────────────────────────────────────
  t("retroEnabled default ON + kill-switch", retroEnabled({}) && !retroEnabled({ SWARM_RETRO: "0" }));
  t("shouldRunRetro: never-run ⇒ due; within ⇒ not; elapsed ⇒ due; bad ⇒ false", shouldRunRetro(null, 1000, 60) && !shouldRunRetro(1000, 1030, 60) && shouldRunRetro(1000, 1100, 60) && !shouldRunRetro(null, NaN, 60) && !shouldRunRetro(null, 1000, 0));

  // ── RL-P3-1: argument validation (pure; a bad window never produces a report or advances the water-mark) ───────────
  t("args: --days nonsense / 0 / -1 / 3.5 ⇒ usage", ["nonsense", "0", "-1", "3.5", ""].every((v) => classifyRetroArgs(["retro", "--days", v]).mode === "usage"));
  t("args: --days 7 ⇒ retro/days/7; no window ⇒ default days 7", (() => {
    const a = classifyRetroArgs(["retro", "--days", "7"]), b = classifyRetroArgs(["retro"]);
    return a.mode === "retro" && a.window.kind === "days" && a.window.days === 7 && b.mode === "retro" && b.window.kind === "days" && b.window.days === 7;
  })());
  t("args: --batch 3 ⇒ batch; --since-last ⇒ since-last", (() => {
    const a = classifyRetroArgs(["retro", "--batch", "3"]), b = classifyRetroArgs(["retro", "--since-last"]);
    return a.mode === "retro" && a.window.kind === "batch" && a.window.batch === 3 && b.mode === "retro" && b.window.kind === "since-last";
  })());
  t("args: windows mutually exclusive ⇒ usage", classifyRetroArgs(["retro", "--days", "7", "--batch", "3"]).mode === "usage" && classifyRetroArgs(["retro", "--batch", "3", "--since-last"]).mode === "usage");
  t("args: unknown option / unknown command ⇒ usage", classifyRetroArgs(["retro", "--bogus"]).mode === "usage" && classifyRetroArgs(["frobnicate"]).mode === "usage");
  t("args: learn requires --from", classifyRetroArgs(["learn"]).mode === "usage" && classifyRetroArgs(["learn", "--from", "x.json"]).mode === "learn");
  t("args: --period-days validated", classifyRetroArgs(["retro", "--period-days", "nope"]).mode === "usage");
  t("args: a value is not mistaken for a flag (--coordinator sid then --batch)", (() => { const a = classifyRetroArgs(["retro", "--coordinator", "sid-123", "--batch", "2"]); return a.mode === "retro" && a.coordinator === "sid-123" && a.window.kind === "batch"; })());
  t("args[RL-P3-1 r3]: a bare value flag (missing value) ⇒ usage", classifyRetroArgs(["retro", "--days"]).mode === "usage" && classifyRetroArgs(["retro", "--coordinator"]).mode === "usage" && classifyRetroArgs(["retro", "--period-days"]).mode === "usage");
  t("args[RL-P3-1 r3]: a value flag swallowing the next flag ⇒ usage", classifyRetroArgs(["retro", "--coordinator", "--days", "7"]).mode === "usage");
  t("args[RL-P3-1 r3]: learn rejects foreign/unknown options ⇒ usage", classifyRetroArgs(["learn", "--from", "x.json", "--bogus"]).mode === "usage" && classifyRetroArgs(["learn", "--days", "7"]).mode === "usage");
  t("args[RL-P3-1 r3]: a positional arg ⇒ usage", classifyRetroArgs(["retro", "stray"]).mode === "usage" && classifyRetroArgs(["learn", "--from"]).mode === "usage");

  // ── AXIS 1: rework-round distribution ───────────────────────────────────────────────────────────────────────────
  t("parseReviewDirName: ticket+sha (ticket may have hyphens)", (() => { const p = parseReviewDirName("approval-delegation-io-e5a40c2-review-evidence"); return p?.ticket === "approval-delegation-io" && p.sha === "e5a40c2"; })());
  t("parseReviewDirName: non-review ⇒ null", parseReviewDirName("random-folder") === null);
  t("reworkRoundDist: distinct shas per ticket = rounds", (() => {
    const recs: ReviewRoundRecord[] = [
      { ticket: "a", sha: "1111111", dir: "" }, { ticket: "a", sha: "2222222", dir: "" }, { ticket: "a", sha: "2222222", dir: "" },
      { ticket: "b", sha: "3333333", dir: "" },
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
  t("isAlreadyCovered: shared source ⇒ true; novel ⇒ false", (() => {
    const existing = [{ statement: "guard FC-2 three-state everywhere", sources: ["control-log:attempt:x"], status: "active" }];
    const covered: Lesson = { identity: "failureClass:x", series: "F", title: "t", statement: "z", sources: ["control-log:attempt:x"] };
    const novel: Lesson = { identity: "failureClass:y", series: "F", title: "t", statement: "something entirely different here", sources: ["PROGRESS.md:999"] };
    return isAlreadyCovered(covered, existing) && !isAlreadyCovered(novel, existing);
  })());
  t("isAlreadyCovered: identity token in a ruling statement covers (no shared source needed)", isAlreadyCovered(
    { identity: "failureClass:timeout", series: "F", title: "t", statement: "x", sources: ["PROGRESS.md:1"] },
    [{ statement: "[failureClass:timeout] 复发 3 次 (窗口 w) — 根治", sources: [], status: "active" }]));
  t("isAlreadyCovered: a SUPERSEDED ruling does not cover (only active)", !isAlreadyCovered({ identity: "failureClass:z", series: "F", title: "t", statement: "z", sources: ["s1"] }, [{ statement: "x", sources: ["s1"], status: "superseded" }]));
  t("RL-P2-5 r3: coveringRulingId returns the covering ruling ID (traceability)", coveringRulingId({ identity: "failureClass:timeout", series: "F", title: "t", statement: "x", sources: ["control-log:attempt:a1"] }, [{ id: "F7", statement: "unrelated", sources: ["control-log:attempt:a1"], status: "active" }]) === "F7");
  t("RL-P2-5 r3: coveringRulingId null when novel", coveringRulingId({ identity: "failureClass:novel", series: "F", title: "t", statement: "x", sources: ["PROGRESS.md:1"] }, [{ id: "F7", statement: "unrelated", sources: ["control-log:attempt:a1"], status: "active" }]) === null);
  t("RL-P2-4 r3: reportVersionTag ignores generatedAtSec, differs on signals", (() => {
    const mk = (nowSec: number, recs: Parameters<typeof reworkRoundDist>[0]) => bj({ nowSec, rework: reworkRoundDist(recs) });
    const a1 = mk(1, []), a2 = mk(9999, []), b = mk(1, [{ ticket: "t", sha: "1111111", dir: "" }]);
    return reportVersionTag(a1) === reportVersionTag(a2) && reportVersionTag(a1) !== reportVersionTag(b);
  })());
  // RL-P2-5 REGRESSION: same window, DIFFERENT ailments, DIFFERENT sources — the ledger covers only ONE; the other must still draft.
  t("RL-P2-5: same-window different-ailment are NOT both swallowed by a shared window template", (() => {
    const r = bj({ window: "7d-ending-2026-10-12", ailments: { structured: [{ failureClass: "business-fail", count: 2, attempts: ["a1"] }, { failureClass: "permanent", count: 3, attempts: ["a2"] }], heuristic: [] } });
    const ls = lessonsFromReport(r);
    const existing = [{ statement: "[failureClass:business-fail] 复发 2 次 (窗口 7d-ending-2026-10-12) — 根治", sources: [], status: "active" }]; // covers business-fail by IDENTITY only
    const covered = ls.filter((l) => isAlreadyCovered(l, existing));
    const novel = ls.filter((l) => !isAlreadyCovered(l, existing));
    return covered.length === 1 && covered[0]!.identity === "failureClass:business-fail" && novel.length === 1 && novel[0]!.identity === "failureClass:permanent";
  })());
  t("draftRulingSeed: draft:true + suggestedId (NOT a valid ledger id field) + no signed status", (() => {
    const seed = draftRulingSeed({ identity: "gap:g", series: "F", title: "T", statement: "S", sources: ["PROGRESS.md:1"] }, ["F21"], 100);
    return seed.schema === RULING_SEED_SCHEMA && seed.draft === true && seed.suggestedId === "F22" && !("id" in seed) && !("status" in seed);
  })());
  t("lessonsFromReport: structured ailment ⇒ F lesson; gap ⇒ S lesson (identity set, window not the prefix)", (() => {
    const r = bj({ ailments: { structured: [{ failureClass: "timeout", count: 3, attempts: ["a1"] }], heuristic: [] }, gaps: [{ slug: "gate-escape", source: "PROGRESS.md", line: 7, text: "x" }] });
    const ls = lessonsFromReport(r);
    const f = ls.find((l) => l.series === "F"), s = ls.find((l) => l.series === "S");
    return f?.identity === "failureClass:timeout" && f.statement.startsWith("[failureClass:timeout]") && s?.identity === "gap:gate-escape" && s.statement.startsWith("[gap:gate-escape]");
  })());

  // ── report render: unreadable ≠ empty; heuristic checks ITS source; axisScopes stated (RL-P2-1/P2-2) ─────────────
  t("render: unreadable source ⇒ '无结论', not a false empty", (() => {
    const md = renderRetroMarkdown(bj({ sources: { ...allRead, reviewReports: "unreadable" } }));
    return md.includes("源 unreadable — 无结论") && md.includes("草稿 (draft)");
  })());
  t("render[RL-P2-2]: PROGRESS unreadable ⇒ heuristic section says 无结论 (not '无命中')", (() => {
    const md = renderRetroMarkdown(bj({ sources: { ...allRead, progress: "unreadable" } }));
    return md.includes("非「无命中」");
  })());
  t("render[RL-P2-1]: axisScopes line present + whole/incomplete labeled", (() => {
    const md = renderRetroMarkdown(bj({ axisScopes: { reviews: "windowed", controlLog: "whole", progress: "incomplete" } }));
    return md.includes("轴覆盖") && md.includes("control-log=whole") && md.includes("PROGRESS=incomplete");
  })());

  // ── STORE: FC-2 three-state reads + mtime windowing ─────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(scratch, "reviews-"));
    mkdirSync(path.join(dir, "ticketA-1111111-review-evidence"), { recursive: true });
    mkdirSync(path.join(dir, "ticketA-2222222-review-x"), { recursive: true });
    mkdirSync(path.join(dir, "not-a-review"), { recursive: true });
    const r = readReviewRoundRecords(dir);
    t("store: readReviewRoundRecords reads + parses (ignores non-review) + complete", r.status === "read" && r.records.length === 2 && r.complete === true);
    t("store: readReviewRoundRecords absent ⇒ absent (complete)", (() => { const a = readReviewRoundRecords(path.join(scratch, "nope-reviews")); return a.status === "absent" && a.complete === true; })());
    const future = Math.floor(Date.now() / 1000) + 3600; // a future floor ⇒ nothing in window
    t("store: readReviewRoundRecords mtime window excludes older dirs", readReviewRoundRecords(dir, future).records.length === 0);
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

  // ── STORE: write faces (console only) + round-trip (RL-P2-4 single JSON) ─────────────────────────────────────────
  {
    const h = freshHome();
    const file = writeRetroReport(h, bj({ window: "7d-x", nowSec: 5 }));
    t("store: writeRetroReport writes ONE json under console/retro-reports (RL-P2-4)", file !== null && file.endsWith(path.join("retro-reports", "7d-x.json")) && reportFiles(h).length === 1);
    t("store: readRetroReport round-trips the json", readRetroReport(path.join(reportsDirP(h), "7d-x.json"))?.window === "7d-x");
    t("store: water-mark write+read", writeLastRunSec(h, 999) && readLastRunSec(h) === 999);
  }

  // ── THE HARDENING: a seed goes to console/retro-drafts/, and the rulings ledger is NEVER written ─────────────────
  {
    const h = freshHome();
    const rdir = mkdtempSync(path.join(scratch, "ledger-untouched-")); process.env.AGENTHOP_RULINGS_DIR = rdir;
    const seed = draftRulingSeed({ identity: "failureClass:timeout", series: "F", title: "repeat timeout", statement: "S", sources: ["control-log:attempt:a1"] }, ["F21"], 1);
    const p = writeRulingSeed(h, seed);
    t("hardening: seed path is console/retro-drafts/, NOT rulings/", p !== null && p.includes(path.join("console", "retro-drafts")) && !p.includes(`${path.sep}rulings${path.sep}`));
    t("hardening: the rulings ledger dir is UNTOUCHED by a seed write (zero code path)", readdirSync(rdir).length === 0);
    delete process.env.AGENTHOP_RULINGS_DIR;
  }

  // ── STORE unit: torn report ⇒ null; stray tmp ignored; CP-3 ancestor symlink refused ────────────────────────────
  {
    const h = freshHome(); mkdirSync(reportsDirP(h), { recursive: true });
    writeFileSync(path.join(reportsDirP(h), "w.json"), '{"schema":"retro-report/v1","window":"w",'); // torn
    t("store: torn report ⇒ readRetroReport null", readRetroReport(path.join(reportsDirP(h), "w.json")) === null);
    writeFileSync(path.join(reportsDirP(h), "w.json.tmp-dead"), "garbage");
    writeRetroReport(h, bj({ window: "w", nowSec: 9 }));
    t("store: good write after a crash reads cleanly; stray tmp ignored", readRetroReport(path.join(reportsDirP(h), "w.json"))?.generatedAtSec === 9);
  }
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-"));
    symlinkSync(ext, swarm(h)); // .agenthop/swarm -> ext (ancestor redirect)
    t("CP-3: symlinked swarm ancestor ⇒ writeRetroReport refused", writeRetroReport(h, bj()) === null);
    t("CP-3: writeRulingSeed refused", writeRulingSeed(h, draftRulingSeed({ identity: "gap:x", series: "F", title: "t", statement: "s", sources: [] }, [], 1)) === null);
    t("CP-3: writeLastRunSec refused", writeLastRunSec(h, 1) === false);
    t("CP-3: NO escape writes at the redirect target", !existsSync(path.join(ext, "console", "retro-reports", "w.json")) && !existsSync(path.join(ext, "console")));
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // RL-P2-6 — the 3 zero-bug fixtures as REAL subprocesses of scripts/retro.ts
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  // FIXTURE 1 — crash-recovery: SIGKILL right after the report commit ⇒ report on disk, delivery + water-mark NOT done ⇒ the
  // obligation is recoverable (water-mark un-advanced), and a repair run completes it with exactly-once delivery.
  {
    const h = freshHome(); seedCoord(h);
    const crashMark = path.join(scratch, "crash-stage.json");
    const r1 = await runCli(["retro", "--batch", "7", "--coordinator", COORD], childEnv(h, { RETRO_TEST_CRASH_AFTER: "batch-7.json", RETRO_TEST_CRASH_MARK: crashMark }));
    t("fixture[crash]: child killed by SIGKILL after the report commit stage", r1.signal === "SIGKILL" && existsSync(crashMark));
    t("fixture[crash]: report IS on disk (committed before the kill)", readRetroReport(path.join(reportsDirP(h), "batch-7.json")) !== null);
    t("fixture[crash]: water-mark NOT advanced (crash before it) ⇒ recoverable obligation", readLastRunSec(h) === null);
    t("fixture[crash]: delivery did NOT happen before the kill (inbox empty)", inboxCount(h) === 0);
    const r2 = await runCli(["retro", "--batch", "7", "--coordinator", COORD], childEnv(h));
    t("fixture[crash]: repair run exits 0", r2.code === 0);
    t("fixture[crash]: repair advances the water-mark + delivers exactly once", readLastRunSec(h) !== null && inboxCount(h) === 1);
  }

  // FIXTURE 2 — restart-idempotency: the SAME window run twice ⇒ one report, one delivery (the dedup key is the credential).
  {
    const h = freshHome(); seedCoord(h);
    const a1 = await runCli(["retro", "--batch", "7", "--coordinator", COORD], childEnv(h));
    const a2 = await runCli(["retro", "--batch", "7", "--coordinator", COORD], childEnv(h));
    t("fixture[restart]: both runs exit 0", a1.code === 0 && a2.code === 0);
    t("fixture[restart]: idempotent delivery — exactly ONE message after two runs", inboxCount(h) === 1);
    t("fixture[restart]: second run reports 'already' (not a re-publish)", a2.out.includes("already"));
    t("fixture[restart]: single valid report; water-mark advanced", readRetroReport(path.join(reportsDirP(h), "batch-7.json"))?.window === "batch-7" && reportFiles(h).length === 1 && readLastRunSec(h) !== null);
  }

  // FIXTURE 3 — concurrency-race with DIFFERENT data per writer (RL-P2-4 / P2-6): writer A (1-ticket) pauses right after committing its
  // report; writer B (2-ticket) runs fully; then A resumes. Each distinct report VERSION publishes under its own content-tagged key, so
  // disk + inbox can never carry mismatched versions — the on-disk report's rendered body MUST equal one delivered inbox message.
  {
    const h = freshHome(); seedCoord(h);
    const revA = mkdtempSync(path.join(scratch, "revA-")); mkdirSync(path.join(revA, "tktA-1111111-review-x"), { recursive: true });
    const revB = mkdtempSync(path.join(scratch, "revB-")); mkdirSync(path.join(revB, "tktA-1111111-review-x"), { recursive: true }); mkdirSync(path.join(revB, "tktB-2222222-review-y"), { recursive: true });
    const pauseMark = path.join(scratch, "race-stage.json"), release = path.join(scratch, "race-release");
    const A = runCli(["retro", "--batch", "9", "--coordinator", COORD], childEnv(h, { RETRO_REVIEW_REPORTS_DIR: revA, RETRO_TEST_PAUSE_AFTER: "batch-9.json", RETRO_TEST_PAUSE_MARK: pauseMark, RETRO_TEST_RELEASE: release }));
    { const deadline = Date.now() + 8000; while (!existsSync(pauseMark)) { if (Date.now() > deadline) throw new Error("FAILED: fixture[race] writer A never reached the barrier"); await sleep(10); } }
    const B = await runCli(["retro", "--batch", "9", "--coordinator", COORD], childEnv(h, { RETRO_REVIEW_REPORTS_DIR: revB }));
    writeFileSync(release, "go");
    const ra = await A;
    t("fixture[race]: both concurrent writers exit 0", ra.code === 0 && B.code === 0);
    const disk = readRetroReport(path.join(reportsDirP(h), "batch-9.json"));
    t("fixture[race]: ONE coherent report (atomic rename ⇒ never torn), valid", disk?.window === "batch-9");
    t("fixture[race]: no leftover .tmp in retro-reports", readdirSync(reportsDirP(h)).every((f) => !f.includes(".tmp-")));
    const inboxP = path.join(h, ".agenthop", "inbox", inboxDirName(COORD));
    const bodies = readdirSync(inboxP).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(inboxP, f), "utf8")).text as string);
    t("fixture[race] RL-P2-4: two DISTINCT versions ⇒ delivered once each (2 messages)", bodies.length === 2);
    t("fixture[race] RL-P2-6: the on-disk report VERSION was delivered (a matching inbox body exists)", disk !== null && bodies.includes(renderRetroMarkdown(disk)));
  }

  // FIXTURE 4 — RL-P2-1/P2-2 via subprocess: a per-dir stat EIO during windowing ⇒ axisScopes.reviews="incomplete" (not a false 0).
  {
    const h = freshHome();
    const rev = path.join(h, "reviews"); const faultDir = path.join(rev, "tkt-aaaaaaa-review-x");
    mkdirSync(faultDir, { recursive: true });
    const rc = await runCli(["retro", "--days", "3650"], childEnv(h, { RETRO_REVIEW_REPORTS_DIR: rev, RETRO_TEST_STAT_FAULT: faultDir }));
    t("fixture[stat-fault] RL-P2-3 r3: incomplete scan ⇒ exit 1 + water-mark NOT advanced", rc.code === 1 && readLastRunSec(h) === null);
    const files = reportFiles(h);
    const rep = files.length === 1 ? readRetroReport(path.join(reportsDirP(h), files[0]!)) : null;
    t("fixture[stat-fault]: review axis labeled 'incomplete' (per-dir stat fault ⇒ unattributable)", rep?.axisScopes.reviews === "incomplete");
  }

  // FIXTURE 5 — RL-P3-1 end-to-end: a bad window exits 2 and writes NOTHING (no report, no water-mark).
  {
    const h = freshHome();
    const rc = await runCli(["retro", "--days", "nonsense", "--coordinator", COORD], childEnv(h));
    t("fixture[bad-args]: exit 2, ZERO writes (no report dir, no water-mark)", rc.code === 2 && reportFiles(h).length === 0 && readLastRunSec(h) === null);
  }

  console.log("\nretro-learn selftest: ALL PASS");
} finally {
  if (envSave.AGENTHOP_RULINGS_DIR === undefined) delete process.env.AGENTHOP_RULINGS_DIR; else process.env.AGENTHOP_RULINGS_DIR = envSave.AGENTHOP_RULINGS_DIR;
  if (envSave.RETRO_REVIEW_REPORTS_DIR === undefined) delete process.env.RETRO_REVIEW_REPORTS_DIR; else process.env.RETRO_REVIEW_REPORTS_DIR = envSave.RETRO_REVIEW_REPORTS_DIR;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
