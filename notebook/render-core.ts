/**
 * render-core.ts — the notebook render module (importable; no side effects). tern-adoption line ③ B4 (contract §3
 * Option-2). Reads the review-ledger db READ-ONLY (sqlite3 -readonly) + the morning-digest artifact and builds a
 * DETERMINISTIC markdown digest. "Tern 出渲染,我们出数据" — the Tern notebook cell invokes render.mts; a human/Carly
 * eyeballs the sqlite block's read-only open (non-blocking).
 *
 * Presentation ONLY (contract §3): no new fact computation. The morning-digest sections are rendered VERBATIM (its
 * numbers are authoritative); the review/batch tables are the db rows as-is. The only derived text is fixed-UTC date
 * formatting of stored epochs and row counts of the presented tables (not morning-digest figures).
 *
 * Reliability (r2 — codex:Work review 8c26550 found these):
 *  - B4-DB-FC2: an EXISTING-but-unreadable db is NOT labelled absent — only ENOENT proves absent; any other open/read
 *    fault ⇒ "unreadable" (three-state). (was: any "unable to open" stderr ⇒ absent)
 *  - B4-UTC-NULL: a NULL epoch renders "—" (null checked BEFORE date conversion); a REAL 0 epoch still renders its
 *    Unix-epoch date (never fabricate a 1970 date for an unknown). (was: Number(null)=0 ⇒ fake 1970)
 *  - B4-DIGEST-SCHEMA: the digest is validated by the canonical morning-digest/v1 reader (readDigestProjection) —
 *    foreign schema / malformed sections / object-typed lines ⇒ a stated state, NEVER rendered as authoritative, and
 *    NEVER crash-drops the ledger tables. (was: only "sections is array" checked ⇒ TypeError / foreign-as-authoritative)
 *  - B4-DB-SNAPSHOT: reviews + batches come from ONE sqlite3 read-only connection (a single json_object query) ⇒ a
 *    consistent snapshot; a mid-run atomic rename can never mix an old-reviews + new-batches report. (was: two processes)
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { readDigestProjection } from "../packages/bus/src/swarm/morning-digest-store.js";

type Row = Record<string, string | number | null>;
type Snapshot = { reviews: Row[]; batches: Row[] };

// ONE read-only query returns BOTH tables as a single JSON object ⇒ a CONSISTENT snapshot (one connection). Each table
// is ordered inside its subquery (byte-stable output). NULLs are preserved as JSON null by json_object. This is the
// programmatic MIRROR of notebook/ledger-digest.sql's two SELECTs (same columns + order), folded into one snapshot read.
const SNAPSHOT_SQL =
  "SELECT json_object(" +
  "'reviews',(SELECT json_group_array(json_object('item',item,'seat',seat,'sha',sha,'rounds',rounds,'outcome',outcome,'usd',usd,'ts',ts)) FROM (SELECT * FROM reviews ORDER BY ts,item,seat,sha))," +
  "'batches',(SELECT json_group_array(json_object('batch',batch,'shas',shas,'merged_ts',merged_ts)) FROM (SELECT * FROM batches ORDER BY merged_ts,batch))" +
  ") AS snap;";

/** Read BOTH tables from ONE read-only connection. Three-state: "absent" ONLY when the db file does not exist (ENOENT);
 *  any other open/read/SQL fault ⇒ "unreadable" (never silently absent/empty). */
export function readLedgerSnapshot(dbPath: string): Snapshot | { fault: "absent" | "unreadable" } {
  let out: string;
  try {
    out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, SNAPSHOT_SQL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // absent IFF the file truly does not exist; a present-but-unreadable db (EACCES / corrupt) is "unreadable", NOT absent.
    let absent = false;
    try { statSync(dbPath); } catch (se) { if ((se as NodeJS.ErrnoException).code === "ENOENT") absent = true; }
    return { fault: absent ? "absent" : "unreadable" };
  }
  try {
    const outer = JSON.parse(out.trim()) as { snap: string }[];
    const snap = JSON.parse(outer[0]!.snap) as Snapshot;
    return { reviews: snap.reviews ?? [], batches: snap.batches ?? [] };
  } catch {
    return { fault: "unreadable" }; // a db that exists but has no reviews/batches tables is malformed for our purpose
  }
}

/** A markdown table cell: null ⇒ "—" (explicit unknown); pipes/newlines escaped so a value never breaks the table. */
function cell(v: string | number | null): string {
  if (v === null || v === undefined) return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Deterministic UTC date for a stored epoch-seconds column. NULL/undefined ⇒ "—" (checked BEFORE conversion, so a
 *  NULL never becomes 1970); a REAL numeric 0 ⇒ the Unix-epoch date (a genuine value, not an unknown). */
function utc(ts: string | number | null): string {
  if (ts === null || ts === undefined) return "—";
  const n = typeof ts === "number" ? ts : Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : "—";
}

function mdTable(headers: string[], rows: string[][]): string[] {
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  return out;
}

/** Render one table section from the shared snapshot (or the shared fault). */
function renderTable(title: string, snap: Snapshot | { fault: "absent" | "unreadable" }, pick: (s: Snapshot) => Row[], cols: (r: Row) => string[], headers: string[]): string[] {
  if ("fault" in snap) return [`## ${title}`, "", snap.fault === "absent" ? "_ledger.db absent — run `tsx tern/ledger-proj/export.mts` first._" : "_ledger.db unreadable — not rendered as empty._", ""];
  const rows = pick(snap);
  const lines = [`## ${title} (${rows.length})`, ""];
  if (rows.length === 0) { lines.push("_(no rows)_", ""); return lines; }
  return lines.concat(mdTable(headers, rows.map(cols)), [""]);
}

/** Render the morning-digest sections using the CANONICAL morning-digest/v1 validator (readDigestProjection). A
 *  valid projection renders its sections verbatim (numbers authoritative); absent/corrupt/unknown ⇒ a stated state,
 *  never authoritative, never crashing the ledger tables above. */
function renderDigest(home: string): string[] {
  const st = readDigestProjection(home);
  if (st.kind === "valid") {
    const out = [`## Morning digest (${st.projection.date})`, "", "_Numbers are authoritative from morning-digest; presented verbatim._", ""];
    for (const s of st.projection.sections) {
      out.push(`### ${cell(s.title)}`);
      for (const line of s.lines) out.push(`- ${String(line).replace(/\r?\n/g, " ")}`);
      out.push("");
    }
    return out;
  }
  const note =
    st.kind === "absent" ? "_digest absent — not rendered as empty._" :
    st.kind === "corrupt" ? "_digest malformed/unsupported schema — not rendered as authoritative._" :
    "_digest unreadable — not rendered as empty._"; // "unknown" (boundary/read fault)
  return ["## Morning digest", "", note, ""];
}

/** Build the full deterministic digest markdown for a home (importable; no side effects). Two calls ⇒ identical string. */
export function renderDigestReport(home: string): string {
  const dbPath = path.join(home, ".agenthop", "carly", "ledger.db");
  const snap = readLedgerSnapshot(dbPath); // ONE snapshot shared by both tables (consistent view)

  const lines: string[] = [
    "# Review Ledger Digest",
    "",
    "_Source: `~/.agenthop/carly/ledger.db` (read-only, one snapshot) + morning-digest/v1. Presentation only — no new facts; `outcome`/`usd` are v1 NULL (shown as —)._",
    "",
  ];
  lines.push(...renderTable("Reviews", snap, (s) => s.reviews,
    (r) => [cell(r.item), cell(r.seat), cell(r.sha), cell(r.rounds), cell(r.outcome), cell(r.usd), utc(r.ts)],
    ["item", "seat", "sha", "rounds", "outcome", "usd", "ts (UTC)"]));
  lines.push(...renderTable("Batches", snap, (s) => s.batches,
    (r) => [cell(r.batch), cell(r.shas), utc(r.merged_ts)],
    ["batch", "shas", "merged (UTC)"]));
  lines.push(...renderDigest(home));

  return lines.join("\n") + "\n";
}
