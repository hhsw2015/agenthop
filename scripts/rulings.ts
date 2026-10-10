// rulings — a one-command reader over the structured ruling ledger (docs/swarm/rulings/), so citing a ruling is a command
// instead of grepping PROGRESS. Reads the committed per-ruling JSON files and validates them through the SIGNED pure core
// (loadLedger / idSortKey from ruling-ledger) — ZERO new parser here: the CLI is thin IO glue (scan the dir, JSON.parse each
// file) plus filter/format. The whole set is validated as a ledger (cross-refs resolve, supersession is bidirectional), so a
// cite is never shown from an inconsistent ledger.
//
//   rulings <id>                              full text of one ruling (e.g. rulings R16)
//   rulings list [--series R|S|F] [--status active|superseded|retired]   compact one-line-per-ruling list
//   rulings grep <word>                       compact list of rulings whose statement contains <word> (case-insensitive)
//
// AGENTHOP_RULINGS_DIR overrides the ledger directory (tests). Exit: 0 ok, 2 usage/not-found, 1 unexpected.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLedger, idSortKey, RULING_ID_RE, type Ruling, type RulingSeries, type RulingStatus } from "../packages/bus/src/swarm/ruling-ledger.js";

const SERIES = new Set<RulingSeries>(["R", "S", "F"]);
const STATUSES = new Set<RulingStatus>(["active", "superseded", "retired"]);

// ---- pure helpers (selftested) ----

export type Query =
  | { mode: "show"; id: string }
  | { mode: "list"; series?: RulingSeries; status?: RulingStatus }
  | { mode: "grep"; word: string }
  | { mode: "usage"; error?: string };

/** Classify argv (already sliced past the node/script) into a query. Unknown/missing ⇒ usage; a bad flag value ⇒ usage with
 *  an error so the caller can exit non-zero. Pure. */
export function classifyArgs(argv: readonly string[]): Query {
  const first = argv[0];
  if (!first) return { mode: "usage" };
  if (first === "list") {
    let series: RulingSeries | undefined;
    let status: RulingStatus | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--series") { const v = argv[++i]; if (!v || !SERIES.has(v as RulingSeries)) return { mode: "usage", error: `--series must be one of R|S|F` }; series = v as RulingSeries; }
      else if (a === "--status") { const v = argv[++i]; if (!v || !STATUSES.has(v as RulingStatus)) return { mode: "usage", error: `--status must be one of active|superseded|retired` }; status = v as RulingStatus; }
      else return { mode: "usage", error: `unknown list option ${JSON.stringify(a)}` };
    }
    return { mode: "list", series, status };
  }
  if (first === "grep") {
    const word = argv[1];
    if (!word) return { mode: "usage", error: "grep needs a <word>" };
    if (argv.length > 2) return { mode: "usage", error: `grep takes exactly one <word> (got extra: ${argv.slice(2).join(" ")})` }; // RCLI-P2-1: never silently drop trailing args
    return { mode: "grep", word };
  }
  if (RULING_ID_RE.test(first)) {
    if (argv.length > 1) return { mode: "usage", error: `unexpected argument(s) after ${first}: ${argv.slice(1).join(" ")}` }; // RCLI-P2-1
    return { mode: "show", id: first };
  }
  return { mode: "usage", error: `unrecognized argument ${JSON.stringify(first)}` };
}

/** Deterministic ledger order (series R→S→F, then number, then sub-letter) — reuses the signed idSortKey. Pure. */
export function sortRulings(rulings: readonly Ruling[]): Ruling[] {
  return [...rulings].sort((a, b) => {
    const ka = idSortKey(a.id), kb = idSortKey(b.id);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1; // BigInt (lossless)
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
}

export function filterRulings(rulings: readonly Ruling[], q: { series?: RulingSeries; status?: RulingStatus }): Ruling[] {
  return sortRulings(rulings.filter((r) => (!q.series || r.series === q.series) && (!q.status || r.status === q.status)));
}

/** grep over the STATEMENT full text (case-insensitive substring), sorted. Pure. */
export function grepRulings(rulings: readonly Ruling[], word: string): Ruling[] {
  const w = word.toLowerCase();
  return sortRulings(rulings.filter((r) => r.statement.toLowerCase().includes(w)));
}

/** One compact line: id / status / title (+ supersededBy when set). ASCII only. Pure. */
export function compactLine(r: Ruling): string {
  const sup = r.supersededBy ? `  (superseded by ${r.supersededBy})` : "";
  return `${r.id.padEnd(7)} ${r.status.padEnd(10)} ${r.title}${sup}`;
}

/** Full text of one ruling — every present field, labeled, statement/rationale on their own lines. ASCII only. Pure. */
export function fullText(r: Ruling): string {
  const lines: string[] = [];
  lines.push(`${r.id}  [${r.status}]${r.supersededBy ? `  (superseded by ${r.supersededBy})` : ""}`);
  lines.push(`title: ${r.title}`);
  const meta = [r.by ? `by ${r.by}` : "", r.since ? `since ${r.since}` : ""].filter(Boolean).join("   ");
  if (meta) lines.push(meta);
  lines.push("statement:");
  lines.push(`  ${r.statement}`);
  if (r.rationale) { lines.push("rationale:"); lines.push(`  ${r.rationale}`); }
  if (r.supersedes?.length) lines.push(`supersedes: ${r.supersedes.join(", ")}`);
  if (r.relates?.length) lines.push(`relates: ${r.relates.join(", ")}`);
  if (r.sources?.length) lines.push(`sources: ${r.sources.join(", ")}`);
  return lines.join("\n");
}

// ---- IO ----

const USAGE = [
  "usage:",
  "  rulings <id>                                            full text of one ruling",
  "  rulings list [--series R|S|F] [--status active|superseded|retired]   compact list",
  "  rulings grep <word>                                     search ruling statements",
].join("\n");

function rulingsDir(): string {
  if (process.env.AGENTHOP_RULINGS_DIR) return process.env.AGENTHOP_RULINGS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
  return path.join(here, "..", "docs", "swarm", "rulings");
}

/** Scan the ledger dir, JSON.parse each ruling file, and validate the whole set through the signed loadLedger. The *.json
 *  parse is the only IO glue; all record validation + cross-ref checks live in loadLedger (zero new parser). Throws on a
 *  malformed file (named) or an inconsistent ledger. */
function loadAll(dir: string): Ruling[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").sort(); }
  catch (e) { throw new Error(`cannot read ledger dir ${dir}: ${e instanceof Error ? e.message : e}`); }
  const records: unknown[] = files.map((f) => {
    try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")); }
    catch (e) { throw new Error(`bad JSON in ${f}: ${e instanceof Error ? e.message : e}`); }
  });
  const res = loadLedger(records);
  if (!res.ok) throw new Error(`ledger invalid: ${res.reason}`);
  return res.rulings;
}

function run(argv: readonly string[]): number {
  const q = classifyArgs(argv);
  if (q.mode === "usage") { process.stderr.write((q.error ? `rulings: ${q.error}\n` : "") + USAGE + "\n"); return q.error ? 2 : 0; }
  const rulings = loadAll(rulingsDir());
  if (q.mode === "show") {
    const r = rulings.find((x) => x.id === q.id);
    if (!r) { process.stderr.write(`rulings: no ruling ${q.id}\n`); return 2; }
    process.stdout.write(fullText(r) + "\n");
    return 0;
  }
  const matched = q.mode === "grep" ? grepRulings(rulings, q.word) : filterRulings(rulings, q);
  for (const r of matched) process.stdout.write(compactLine(r) + "\n");
  process.stdout.write(`${matched.length} ruling${matched.length === 1 ? "" : "s"}\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // RCLI-P2-2b / R2-P2-1: pipe-safe WITHOUT masking failures. A reader that closes early (`rulings list | head`, or a closed
  // stderr on an error path) makes the next write emit EPIPE; swallow it so Node does not throw an unhandled 'error' and crash
  // with a stack trace — but exit with the ALREADY-DETERMINED code, never an unconditional 0. The code is set synchronously by
  // the try/catch below before any stream 'error' fires (stream errors are async), so a usage/ledger failure keeps its 2/1 even
  // when it is the STDERR pipe that broke; a successful query whose stdout closed early still exits 0. (A non-EPIPE stream error
  // is genuinely exceptional — surface it.)
  const onPipeError = (e: NodeJS.ErrnoException): void => {
    if (e.code === "EPIPE") process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    throw e;
  };
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  // RCLI-P2-2: set exitCode and let Node exit NATURALLY — a forced process.exit() truncates a piped stdout mid-write (stdout to
  // a pipe is async). All IO here is synchronous, so nothing keeps the loop alive; Node drains stdout/stderr then exits with the
  // code. This guarantees piped output equals fullText() byte-for-byte, and that an error message is written in full.
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`rulings: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
}
