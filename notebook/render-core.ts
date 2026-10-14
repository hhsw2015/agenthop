/**
 * render-core.ts — the notebook render module (importable; no side effects) (tern-adoption line ③ B4, contract §3 Option-2 per coordinator ruling).
 * Reads the review-ledger db READ-ONLY (sqlite3 -readonly) + the morning-digest artifact, and emits a DETERMINISTIC
 * markdown digest to stdout. "Tern 出渲染,我们出数据": the Tern notebook cell just invokes this; a human/Carly eyeballs
 * the sqlite block's read-only open (non-blocking). Acceptance: two runs ⇒ byte-identical stdout.
 *
 * Presentation ONLY (contract §3): no new fact computation. The morning-digest sections are rendered VERBATIM (its
 * numbers are authoritative); the review/batch tables are the db rows as-is. The only derived text is UTC date
 * formatting of the stored epochs (deterministic, TZ-independent) and row counts of the presented tables (not
 * morning-digest figures). NULL columns (outcome/usd/rounds v1) render as "—" (an explicit unknown, never a fake 0).
 *
 * FC-2 three-state for BOTH sources: an absent/unreadable ledger db or digest is STATED, never rendered as empty data.
 *
 * Run: tsx notebook/render.mts   (env AH_HOME overrides ~; reads ~/.agenthop/carly/ledger.db + console/morning-digest/digest.json)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// The canonical read-only SELECTs — MIRROR of notebook/ledger-digest.sql (kept identical so the sqlite block and this
// render never drift). Deterministic ORDER BY ⇒ byte-stable output.
const Q_REVIEWS = "SELECT item, seat, sha, rounds, outcome, usd, ts FROM reviews ORDER BY ts, item, seat, sha;";
const Q_BATCHES = "SELECT batch, shas, merged_ts FROM batches ORDER BY merged_ts, batch;";

type Row = Record<string, string | number | null>;

/** Query the ledger db READ-ONLY. Returns rows, or a three-state marker: "absent" (no db) / "unreadable" (open/SQL fault). */
function queryReadOnly(dbPath: string, sql: string): { rows: Row[] } | { fault: "absent" | "unreadable" } {
  let out: string;
  try {
    out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message ?? "");
    // a missing db opened read-only reports "unable to open database" — distinguish absent from a real read fault by existence.
    return { fault: /unable to open/i.test(msg) ? "absent" : "unreadable" };
  }
  const trimmed = out.trim();
  if (!trimmed) return { rows: [] }; // sqlite3 -json prints nothing for an empty result set
  try { return { rows: JSON.parse(trimmed) as Row[] }; }
  catch { return { fault: "unreadable" }; }
}

/** A markdown table cell: null ⇒ "—" (explicit unknown); pipes/newlines escaped so a value never breaks the table. */
function cell(v: string | number | null): string {
  if (v === null || v === undefined) return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Deterministic UTC date (TZ-independent) for a stored epoch-seconds column; non-finite ⇒ "—". */
function utc(ts: string | number | null): string {
  const n = typeof ts === "number" ? ts : Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : "—";
}

function mdTable(headers: string[], rows: string[][]): string[] {
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  return out;
}

/** Render the reviews/batches section from a query result or its three-state fault. */
function renderDb(title: string, res: ReturnType<typeof queryReadOnly>, cols: (r: Row) => string[], headers: string[]): string[] {
  if ("fault" in res) return [`## ${title}`, "", res.fault === "absent" ? "_ledger.db absent — run `tsx tern/ledger-proj/export.mts` first._" : "_ledger.db unreadable — not rendered as empty._", ""];
  const lines = [`## ${title} (${res.rows.length})`, ""];
  if (res.rows.length === 0) { lines.push("_(no rows)_", ""); return lines; }
  return lines.concat(mdTable(headers, res.rows.map(cols)), [""]);
}

/** Render the morning-digest sections verbatim (its numbers are authoritative). FC-2: absent/unreadable/invalid stated. */
function renderDigest(digestPath: string): string[] {
  let text: string;
  try { text = readFileSync(digestPath, "utf8"); }
  catch (e) { return ["## Morning digest", "", (e as NodeJS.ErrnoException).code === "ENOENT" ? "_digest absent — not rendered as empty._" : "_digest unreadable — not rendered as empty._", ""]; }
  let obj: { schema?: string; date?: string; sections?: { title?: string; lines?: string[] }[] };
  try { obj = JSON.parse(text); } catch { return ["## Morning digest", "", "_digest malformed — not rendered as empty._", ""]; }
  if (!obj || !Array.isArray(obj.sections)) return ["## Morning digest", "", "_digest shape unrecognized — not rendered as empty._", ""];
  const out = [`## Morning digest${obj.date ? ` (${obj.date})` : ""}`, "", "_Numbers are authoritative from morning-digest; presented verbatim._", ""];
  for (const s of obj.sections) {
    out.push(`### ${cell(s.title ?? "(untitled)")}`);
    for (const line of Array.isArray(s.lines) ? s.lines : []) out.push(`- ${String(line).replace(/\r?\n/g, " ")}`);
    out.push("");
  }
  return out;
}

/** Build the full deterministic digest markdown for a home (importable; no side effects). Two calls ⇒ identical string. */
export function renderDigestReport(home: string): string {
  const dbPath = path.join(home, ".agenthop", "carly", "ledger.db");
  const digestPath = path.join(home, ".agenthop", "console", "morning-digest", "digest.json");

  const lines: string[] = [
    "# Review Ledger Digest",
    "",
    "_Source: `~/.agenthop/carly/ledger.db` (read-only) + morning-digest/v1. Presentation only — no new facts; `outcome`/`usd` are v1 NULL (shown as —)._",
    "",
  ];
  lines.push(...renderDb("Reviews", queryReadOnly(dbPath, Q_REVIEWS),
    (r) => [cell(r.item), cell(r.seat), cell(r.sha), cell(r.rounds), cell(r.outcome), cell(r.usd), utc(r.ts)],
    ["item", "seat", "sha", "rounds", "outcome", "usd", "ts (UTC)"]));
  lines.push(...renderDb("Batches", queryReadOnly(dbPath, Q_BATCHES),
    (r) => [cell(r.batch), cell(r.shas), utc(r.merged_ts)],
    ["batch", "shas", "merged (UTC)"]));
  lines.push(...renderDigest(digestPath));

  return lines.join("\n") + "\n";
}

