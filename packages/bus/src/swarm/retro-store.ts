/**
 * retro-learn — IO layer (brief §5; FROZEN @2b46959). Reads the record surfaces READ-ONLY (review-reports dir names / control-log
 * attempts / PROGRESS lines / the rulings ledger), each with FC-2 three-state (read / unreadable / absent — an EACCES is never
 * "no ailments"). Writes ONLY two things, both under the swarm `console/` boundary: the retro report (console/retro-reports/) and the
 * ruling SEEDS (console/retro-drafts/). It delivers the report to the coordinator inbox durable-first.
 *
 * THE HARDENING (coordinator ruling on the freeze): there is NO function here that writes docs/swarm/rulings/ — not even a passive
 * helper. The rulings dir is opened READ-ONLY (readExistingRulings, for dedup + id suggestion). A seed's only home is
 * console/retro-drafts/; the coordinator's manual `mv` + index rebuild is the sole path into the signed ledger.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, lstatSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { loadLedger } from "./ruling-ledger.js";
import {
  parseReviewDirName, RETRO_REPORT_SCHEMA,
  type ReviewRoundRecord, type AttemptRecord, type TextLine, type SourceStatus, type RetroReportJson, type RulingSeed,
} from "./retro.js";

// --- paths (console/ write boundary + read-only source locations) ---------------------------------------------------
function swarmDir(home: string): string { return path.join(home, ".agenthop", "swarm"); }
function consoleDir(home: string): string { return path.join(swarmDir(home), "console"); }
function reportsDir(home: string): string { return path.join(consoleDir(home), "retro-reports"); }
function draftsDir(home: string): string { return path.join(consoleDir(home), "retro-drafts"); }
function controlLogDir(home: string): string { return path.join(swarmDir(home), "control-log"); }
function progressPath(home: string): string { return path.join(swarmDir(home), "PROGRESS.md"); }
function lastRunPath(home: string): string { return path.join(reportsDir(home), ".last-run"); }

/** Default review-reports location (override with RETRO_REVIEW_REPORTS_DIR). It lives OUTSIDE the agenthop home (~/Work/...). */
export function reviewReportsDir(homeForUser: string): string {
  return process.env.RETRO_REVIEW_REPORTS_DIR || path.join(homeForUser, "Work", "review-reports");
}
/** The signed ledger dir — opened READ-ONLY here (never written). Mirrors scripts/rulings.ts resolution. */
export function rulingsLedgerDir(repoDir: string): string {
  return process.env.AGENTHOP_RULINGS_DIR || path.join(repoDir, "docs", "swarm", "rulings");
}

/** CP-3 — the console output chain from .agenthop down must be real owned dirs (ancestor-chain guard; a symlinked ancestor also
 *  escapes). lstat (no-follow) each: symlink/non-dir ⇒ refuse; ENOENT ⇒ safe; other fault ⇒ refuse. */
function consoleBoundaryOk(home: string, leaf: string): boolean {
  const rel = path.relative(home, leaf);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let p = home;
  for (const seg of rel.split(path.sep)) {
    p = path.join(p, seg);
    let st;
    try { st = lstatSync(p); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; return false; }
    if (!st.isDirectory()) return false;
  }
  return true;
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// --- READ sources (FC-2 three-state) --------------------------------------------------------------------------------

/** review-reports → {records, status}. ENOENT ⇒ absent; EACCES/other readdir fault ⇒ unreadable (never silently "no reworks"). */
export function readReviewRoundRecords(dir: string, sinceSec: number | null = null): { records: ReviewRoundRecord[]; status: SourceStatus; complete: boolean } {
  let names: string[];
  try { names = readdirSync(dir); }
  // RL-P2-3 (r4): ENOENT ⇒ absent + complete (the dir genuinely has nothing to scan). ANY other readdir fault ⇒ unreadable + NOT
  // complete — the whole-dir scan attributed nothing, so it is an INCOMPLETE scan (the caller must hold the water-mark, never advance it
  // past a window it could not read).
  catch (e) { const enoent = (e as NodeJS.ErrnoException).code === "ENOENT"; return { records: [], status: enoent ? "absent" : "unreadable", complete: enoent }; }
  const records: ReviewRoundRecord[] = [];
  let complete = true; // RL-P2-2: a per-dir stat fault during window-filtering ⇒ incomplete (not a silent drop that looks like 0)
  for (const name of names) {
    const p = parseReviewDirName(name); if (!p) continue;
    if (sinceSec !== null) {
      let mtime: number;
      try { mtime = statSync(path.join(dir, name)).mtimeMs / 1000; }
      catch { complete = false; continue; } // EACCES/EIO on one dir ⇒ can't attribute it to the window ⇒ flag incomplete
      if (mtime < sinceSec) continue;
    }
    records.push({ ticket: p.ticket, sha: p.sha, dir: name });
  }
  return { records, status: "read", complete };
}

/** control-log → {attempts, status}. absent dir ⇒ absent; a corrupt/unreadable log (loadControlLog throws) ⇒ unreadable (NOT an
 *  empty ailment set). Collects every attempt entity's latest {attemptId,nodeId,status,failureClass}. */
export function readAttempts(home: string): { attempts: AttemptRecord[]; status: SourceStatus } {
  // RL-P2-2: a readdir three-state (ENOENT⇒absent, EACCES⇒unreadable) — NOT existsSync (which is a TOCTOU + treats EACCES as "gone").
  try { readdirSync(controlLogDir(home)); }
  catch (e) { return { attempts: [], status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  let state;
  try { state = loadControlLog(controlLogDir(home)); }
  catch { return { attempts: [], status: "unreadable" }; }
  const attempts: AttemptRecord[] = [];
  for (const body of Object.values(liveEntities(state))) {
    const b = body as { put?: string; attempt?: { attemptId?: unknown; nodeId?: unknown; status?: unknown; failureClass?: unknown } };
    if (b.put === "attempt" && b.attempt && typeof b.attempt.attemptId === "string") {
      attempts.push({
        attemptId: b.attempt.attemptId,
        nodeId: typeof b.attempt.nodeId === "string" ? b.attempt.nodeId : "",
        status: typeof b.attempt.status === "string" ? b.attempt.status : "",
        ...(typeof b.attempt.failureClass === "string" ? { failureClass: b.attempt.failureClass } : {}),
      });
    }
  }
  return { attempts, status: "read" };
}

/** PROGRESS.md → {lines, status}. ENOENT ⇒ absent; EACCES/other ⇒ unreadable. Each line is cited (1-based). */
export function readProgressLines(home: string): { lines: TextLine[]; status: SourceStatus } {
  let raw: string;
  try { raw = readFileSync(progressPath(home), "utf8"); }
  catch (e) { return { lines: [], status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  const lines = raw.split("\n").map((text, i) => ({ source: "PROGRESS.md", line: i + 1, text }));
  return { lines, status: "read" };
}

/** The signed ledger, READ-ONLY, for dedup + id suggestion. {rulings, ids, status}. A corrupt/EACCES ledger ⇒ unreadable (the learn
 *  face then degrades honestly rather than drafting against a guessed state). NEVER writes. */
export function readExistingRulings(repoDir: string): { rulings: { id: string; statement: string; sources?: string[]; status: string }[]; ids: string[]; status: SourceStatus } {
  const dir = rulingsLedgerDir(repoDir);
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json"); }
  catch (e) { return { rulings: [], ids: [], status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  const records: unknown[] = [];
  for (const f of files) { try { records.push(JSON.parse(readFileSync(path.join(dir, f), "utf8"))); } catch { return { rulings: [], ids: [], status: "unreadable" }; } }
  const res = loadLedger(records);
  if (!res.ok) return { rulings: [], ids: [], status: "unreadable" }; // an inconsistent ledger ⇒ don't guess; degrade
  return { rulings: res.rulings.map((r) => ({ id: r.id, statement: r.statement, sources: r.sources, status: r.status })), ids: res.rulings.map((r) => r.id), status: "read" };
}

// --- WRITE faces (console/ only; NEVER rulings/) --------------------------------------------------------------------

const slugify = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "retro";

/** RL-P2-4: write ONE atomic JSON — the single source of truth. No separate Markdown side-car: the body is DERIVED on demand
 *  (renderRetroMarkdown), so there is no second on-disk artifact to drift. The report VERSION is reportVersionTag(json) — a SHA-256 over
 *  the SIGNALS EXCLUDING generatedAtSec — and the coordinator delivery key binds to it (same signals ⇒ idempotent "already"; changed
 *  signals ⇒ a new key ⇒ a new delivery). NB: the rendered body still prints generatedAtSec, so two renders of the same signals at
 *  different times differ by that timestamp — the version tag (not byte-identity) is what ties disk and inbox. Returns the json path, or
 *  null when the CP-3 boundary refuses. */
export function writeRetroReport(home: string, json: RetroReportJson): string | null {
  if (!consoleBoundaryOk(home, reportsDir(home))) return null;
  const file = path.join(reportsDir(home), `${slugify(json.window)}.json`);
  writeJsonAtomic(file, json);
  return file;
}

/**
 * Write a ruling SEED to console/retro-drafts/ — NEVER docs/swarm/rulings/. This is the ONLY seed write face; there is no
 * rulings/-targeting function in this module by design (the hardening). CP-3 guarded. Returns the path, or null when refused.
 */
export function writeRulingSeed(home: string, seed: RulingSeed): string | null {
  if (!consoleBoundaryOk(home, draftsDir(home))) return null;
  const file = path.join(draftsDir(home), `${slugify(seed.suggestedId)}-${slugify(seed.title)}.json`);
  writeJsonAtomic(file, seed);
  return file;
}

/** Read a retro report JSON back (for `learn --from`). ENOENT ⇒ null; corrupt / wrong-schema ⇒ null. */
export function readRetroReport(file: string): RetroReportJson | null {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch { return null; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || (o as { schema?: unknown }).schema !== RETRO_REPORT_SCHEMA) return null;
  return o as RetroReportJson;
}

// --- water-mark (Q6 incremental window) -----------------------------------------------------------------------------
export function readLastRunSec(home: string): number | null {
  let raw: string;
  try { raw = readFileSync(lastRunPath(home), "utf8"); }
  catch { return null; }
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function writeLastRunSec(home: string, sec: number): boolean {
  if (!consoleBoundaryOk(home, reportsDir(home))) return false;
  writeJsonAtomic(lastRunPath(home), String(Math.floor(sec)));
  return true;
}
