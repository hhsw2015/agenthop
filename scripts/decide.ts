// decide — the coordinator's one-command PRODUCER for decision batches (north-star gap ③). The consume side (user verdicts) and
// the console/decisions projection + swarm-console mod cards are already live; this is the missing write end, so a thing the
// coordinator asks the user to clear (enable a flag, approve a project, sign off a risk) lands in the decision-batch STORE instead
// of only being prose in PROGRESS. ZERO new store surface: this is thin IO glue (read JSON, validate each item through the SIGNED
// validDecisionItem, call the SIGNED openBatch). The console-projection producer then mirrors it; the mod renders the cards; the
// user's digit keys clear it; consumeDecisions executes it exactly once.
//
//   decide submit <file|-> [--owner <id>] [--notify <inbox>] [--batch-id <id>] [--home <dir>]   write a batch, print its id
//   decide list [--home <dir>]                                                                  one line per batch in the store
//
// Input JSON (file or `-` for stdin) is EITHER a bare items array `[ {id,kind,summary,suggestedAction,evidenceRef?,hardGate?}, … ]`
// OR an object `{ owner?, notifyTo?, batchId?, items:[…] }`. Flags override the object's owner/notifyTo/batchId. The batch owner
// must be set (flag or JSON) — it is the coordinator identity that owns the decision. A hard-gate item can only ever be approved
// "once" (allowedScopes), enforced downstream.
//
// AGENTHOP_HOME / AH_HOME (or --home) overrides the home base (tests / sandbox). Exit: 0 ok, 2 usage/input error, 1 unexpected.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { validDecisionItem, type DecisionItem } from "../packages/bus/src/swarm/decision-batch.js";
import { openBatch, listBatches, readBatch } from "../packages/bus/src/swarm/decision-batch-store.js";

// ---- pure helpers (selftested) ----

export type Query =
  | { mode: "submit"; src: string; owner?: string; notifyTo?: string; batchId?: string; home?: string }
  | { mode: "list"; home?: string }
  | { mode: "usage"; error?: string };

/** Classify argv (already sliced past node/script) into a query. Unknown/missing ⇒ usage; a flag with no value ⇒ usage error. Pure. */
export function classifyArgs(argv: readonly string[]): Query {
  const first = argv[0];
  if (!first) return { mode: "usage" };
  if (first === "list") {
    let home: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--home") { const v = argv[++i]; if (!v) return { mode: "usage", error: "--home needs a value" }; home = v; }
      else return { mode: "usage", error: `unknown list option ${JSON.stringify(a)}` };
    }
    return { mode: "list", ...(home ? { home } : {}) };
  }
  if (first === "submit") {
    const src = argv[1];
    if (!src || src.startsWith("--")) return { mode: "usage", error: "submit needs a <file|-> source" };
    let owner: string | undefined, notifyTo: string | undefined, batchId: string | undefined, home: string | undefined;
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--owner") { const v = argv[++i]; if (!v) return { mode: "usage", error: "--owner needs a value" }; owner = v; }
      else if (a === "--notify") { const v = argv[++i]; if (!v) return { mode: "usage", error: "--notify needs a value" }; notifyTo = v; }
      else if (a === "--batch-id") { const v = argv[++i]; if (!v) return { mode: "usage", error: "--batch-id needs a value" }; batchId = v; }
      else if (a === "--home") { const v = argv[++i]; if (!v) return { mode: "usage", error: "--home needs a value" }; home = v; }
      else return { mode: "usage", error: `unknown submit option ${JSON.stringify(a)}` };
    }
    return { mode: "submit", src, ...(owner ? { owner } : {}), ...(notifyTo ? { notifyTo } : {}), ...(batchId ? { batchId } : {}), ...(home ? { home } : {}) };
  }
  return { mode: "usage", error: `unrecognized command ${JSON.stringify(first)} (expected: submit | list)` };
}

export type ParsedBatch = { owner: string; items: DecisionItem[]; notifyTo?: string; batchId?: string };
export type ParseResult = { ok: true; batch: ParsedBatch } | { ok: false; error: string };

/**
 * Parse + validate the submit input (pure). `text` is a bare items array or an object {owner?,notifyTo?,batchId?,items}. Each item
 * is validated through the SIGNED validDecisionItem (never a new parser); any invalid item rejects the WHOLE input (naming the
 * index) so a half-valid batch is never written. `overrides` (from flags) win over the object's owner/notifyTo/batchId. An empty
 * items list or a missing owner is an error. Duplicate ids are rejected (an ambiguous verdict is poison — mirrors validDecisionBatch).
 */
export function parseSubmitInput(text: string, overrides: { owner?: string; notifyTo?: string; batchId?: string }): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `input is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  let itemsRaw: unknown;
  let owner: string | undefined = overrides.owner;
  let notifyTo: string | undefined = overrides.notifyTo;
  let batchId: string | undefined = overrides.batchId;
  if (Array.isArray(raw)) {
    itemsRaw = raw;
  } else if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    itemsRaw = o.items;
    if (owner === undefined && typeof o.owner === "string") owner = o.owner;
    if (notifyTo === undefined && typeof o.notifyTo === "string") notifyTo = o.notifyTo;
    if (batchId === undefined && typeof o.batchId === "string") batchId = o.batchId;
  } else {
    return { ok: false, error: "input must be an items array or an object with an items array" };
  }
  if (!Array.isArray(itemsRaw)) return { ok: false, error: "no items array (expected a bare array or { items: [...] })" };
  if (itemsRaw.length === 0) return { ok: false, error: "items array is empty — nothing to submit" };
  if (owner === undefined || owner === "") return { ok: false, error: "owner is required (pass --owner <id> or set \"owner\" in the JSON)" };
  const items: DecisionItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < itemsRaw.length; i++) {
    const it = validDecisionItem(itemsRaw[i]);
    if (!it) return { ok: false, error: `item[${i}] is invalid (need non-empty id/kind/summary/suggestedAction; optional evidenceRef/hardGate)` };
    if (seen.has(it.id)) return { ok: false, error: `duplicate item id ${JSON.stringify(it.id)} at item[${i}] (ids must be unique)` };
    seen.add(it.id);
    items.push(it);
  }
  return { ok: true, batch: { owner, items, ...(notifyTo ? { notifyTo } : {}), ...(batchId ? { batchId } : {}) } };
}

// ---- IO ----

const USAGE = [
  "usage:",
  "  decide submit <file|-> [--owner <id>] [--notify <inbox>] [--batch-id <id>] [--home <dir>]",
  "  decide list [--home <dir>]",
  "",
  "input JSON: a bare items array, or { owner?, notifyTo?, batchId?, items:[{id,kind,summary,suggestedAction,evidenceRef?,hardGate?}] }",
].join("\n");

function resolveHome(flag?: string): string {
  return flag ?? process.env.AGENTHOP_HOME ?? process.env.AH_HOME ?? homedir();
}
function readSource(src: string): string {
  return src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
}
const nowSec = (): number => Math.floor(Date.now() / 1000);

function run(argv: readonly string[]): number {
  const q = classifyArgs(argv);
  if (q.mode === "usage") { process.stderr.write((q.error ? `decide: ${q.error}\n` : "") + USAGE + "\n"); return q.error ? 2 : 0; }
  const home = resolveHome(q.home);
  if (q.mode === "list") {
    const ids = listBatches(home);
    for (const id of ids) {
      const b = readBatch(home, id); // throws on a real read error ⇒ surfaced as exit 1
      process.stdout.write(b ? `${b.batchId.padEnd(24)} ${String(b.items.length).padStart(3)} item(s)  owner=${b.owner}\n` : `${id.padEnd(24)}  (unreadable/foreign)\n`);
    }
    process.stdout.write(`${ids.length} batch${ids.length === 1 ? "" : "es"}\n`);
    return 0;
  }
  // submit
  let text: string;
  try { text = readSource(q.src); } catch (e) { process.stderr.write(`decide: cannot read ${q.src === "-" ? "stdin" : q.src}: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  const parsed = parseSubmitInput(text, { owner: q.owner, notifyTo: q.notifyTo, batchId: q.batchId });
  if (!parsed.ok) { process.stderr.write(`decide: ${parsed.error}\n`); return 2; }
  const batch = openBatch(home, { owner: parsed.batch.owner, items: parsed.batch.items, nowSec: nowSec(), ...(parsed.batch.batchId ? { batchId: parsed.batch.batchId } : {}), ...(parsed.batch.notifyTo ? { notifyTo: parsed.batch.notifyTo } : {}) });
  process.stdout.write(`submitted ${batch.batchId} — ${batch.items.length} item(s), owner=${batch.owner}${parsed.batch.notifyTo ? `, notified ${parsed.batch.notifyTo}` : ""}\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // pipe-safe WITHOUT masking failures (same discipline as rulings.ts): swallow EPIPE but keep the already-set exit code.
  const onPipeError = (e: NodeJS.ErrnoException): void => { if (e.code === "EPIPE") process.exit(typeof process.exitCode === "number" ? process.exitCode : 0); throw e; };
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`decide: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
}
