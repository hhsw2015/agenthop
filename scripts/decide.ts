// decide — the coordinator's one-command PRODUCER for decision batches (north-star gap ③). The consume side (consumeDecisions,
// which reads the user's verdicts) and the console/decisions projection + swarm-console mod cards are already live; this is the
// missing write end, so a thing the coordinator asks the user to clear (enable a flag, approve a project, sign off a risk) lands
// in the decision-batch STORE instead of only being prose in PROGRESS. ZERO new store WRITE surface: this is thin IO glue (read
// JSON, validate each item through the SIGNED validDecisionItem, call the SIGNED openBatch). The console-projection producer then
// mirrors it; the mod renders the cards; the user's digit keys clear it; consumeDecisions returns the resolved verdicts; the
// coordinator carries out the business action. Three distinct roles: PRODUCE (decide) / CONSUME (consumeDecisions) / ACT
// (coordinator) — decide is only the first.
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
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validDecisionItem, type DecisionItem } from "../packages/bus/src/swarm/decision-batch.js";
import { openBatch, listBatchesStrict, readBatch, newBatchId } from "../packages/bus/src/swarm/decision-batch-store.js";

/** The store's own batchId guard (decision-batch-store.ts SAFE_BATCH_ID), mirrored so an unsafe --batch-id is rejected at exit 2
 *  BEFORE openBatch — otherwise openBatch's assert throws and the generic catch would falsely report a "saved" batch. */
const SAFE_BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---- pure helpers (selftested) ----

export type Query =
  | { mode: "submit"; src: string; owner?: string; notifyTo?: string; batchId?: string; home?: string }
  | { mode: "list"; home?: string }
  | { mode: "usage"; error?: string };

/** Classify argv (already sliced past node/script) into a query. Unknown/missing ⇒ usage; a flag with no value ⇒ usage error. Pure. */
export function classifyArgs(argv: readonly string[]): Query {
  const first = argv[0];
  if (!first) return { mode: "usage" };
  // DEC-P2-4: a flag's value must be a REAL value, never the NEXT flag — `--owner --notify` must error, not take "--notify" as
  // the owner. `-` (stdin) is still a legal value; only a `--`-prefixed token is rejected as a swallowed option.
  const isValue = (v: string | undefined): v is string => v !== undefined && v !== "" && !v.startsWith("--");
  if (first === "list") {
    let home: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--home") { const v = argv[++i]; if (!isValue(v)) return { mode: "usage", error: "--home needs a value" }; home = v; }
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
      if (a === "--owner") { const v = argv[++i]; if (!isValue(v)) return { mode: "usage", error: "--owner needs a value" }; owner = v; }
      else if (a === "--notify") { const v = argv[++i]; if (!isValue(v)) return { mode: "usage", error: "--notify needs a value" }; notifyTo = v; }
      else if (a === "--batch-id") { const v = argv[++i]; if (!isValue(v)) return { mode: "usage", error: "--batch-id needs a value" }; batchId = v; }
      else if (a === "--home") { const v = argv[++i]; if (!isValue(v)) return { mode: "usage", error: "--home needs a value" }; home = v; }
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
    // DEC-P2-4: a DECLARED field with the wrong type is an ERROR, never silently dropped to a default (a numeric batchId must not
    // fall through to a random id; a non-string notifyTo must not be treated as "no notify"). Unknown keys (e.g. _comment) are ignored.
    if (o.owner !== undefined && typeof o.owner !== "string") return { ok: false, error: "\"owner\" must be a string" };
    if (o.notifyTo !== undefined && typeof o.notifyTo !== "string") return { ok: false, error: "\"notifyTo\" must be a string" };
    if (o.batchId !== undefined && typeof o.batchId !== "string") return { ok: false, error: "\"batchId\" must be a string" };
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

/** Single-quote a value for a copy-paste shell hint (wraps and escapes embedded quotes). */
function shq(v: string): string { return `'${v.replace(/'/g, "'\\''")}'`; }

/** DEC-P2-1: the recovery hint reconstructs the user's ORIGINAL command — the same source and EVERY flag they passed (owner,
 *  notify, home) — and only APPENDS the resolved --batch-id. Dropping a flag breaks the retry: without --owner it exits 2
 *  (owner missing); without the original --home it idempotently rebuilds the SAME id in the DEFAULT dir and notifies there,
 *  never finishing the original dir's notify. A stdin source cannot be replayed, so it is called out. */
export function retryHint(q: Extract<Query, { mode: "submit" }>, batchId: string): string {
  const parts = ["decide submit", shq(q.src)];
  if (q.owner) parts.push("--owner", shq(q.owner));     // only if it was a FLAG; a JSON owner is re-read from the same source
  if (q.notifyTo) parts.push("--notify", shq(q.notifyTo));
  if (q.home) parts.push("--home", shq(q.home));         // the original data root — the id is only idempotent WITH it
  parts.push("--batch-id", batchId);
  const base = parts.join(" ");
  return q.src === "-" ? `${base}   (re-provide the original input on stdin — it cannot be replayed)` : base;
}

/** DEC-P2-2: read the store's OWN notify credential (`notified.sent`, written AFTER a confirmed send) read-only, so the CLI
 *  reports the ACTUAL delivered target — not the requested one. A re-notify to a different target on an existing batch is an
 *  at-most-once no-op, so the credential still names the FIRST target; we must report that fact, never the request. Fail-soft:
 *  absent/unreadable ⇒ null (delivery unconfirmed). Precedent: console-projection-store reads the store's consumed.json directly. */
function notifiedTarget(home: string, batchId: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, ".agenthop", "console", "decision-batches", batchId, "notified.sent"), "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && typeof (raw as { to?: unknown }).to === "string" ? (raw as { to: string }).to : null;
  } catch { return null; }
}

function run(argv: readonly string[]): number {
  const q = classifyArgs(argv);
  if (q.mode === "usage") { process.stderr.write((q.error ? `decide: ${q.error}\n` : "") + USAGE + "\n"); return q.error ? 2 : 0; }
  const home = resolveHome(q.home);
  if (q.mode === "list") {
    // DEC-P2-3: listBatchesStrict PROPAGATES a real read error (a plain file at the batch root ⇒ throw ⇒ exit 1), so an unknown
    // state is never shown as the same "0 batches" as a confirmed-empty store. ENOENT (no dir yet) ⇒ [] ⇒ a legitimate empty.
    const ids = listBatchesStrict(home);
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
  // DEC-P2-4: reject an unsafe user-supplied batchId BEFORE the write (else openBatch's assert throws and the generic catch would
  // falsely report a "saved" batch). A generated id is always safe.
  if (parsed.batch.batchId !== undefined && !SAFE_BATCH_ID.test(parsed.batch.batchId)) {
    process.stderr.write(`decide: invalid batchId ${JSON.stringify(parsed.batch.batchId)} — allowed [A-Za-z0-9_-], 1-64 chars\n`);
    return 2;
  }
  // DEC-P2-1: resolve a reusable, concrete batchId BEFORE the call, so a post-save (notify) failure can hand back the exact id to
  // retry with — openBatch writes the batch, THEN notifies, and a notify throw would otherwise leave a saved batch under a random
  // id the caller never saw (a retry would make a SECOND batch for the same thing).
  const batchId = parsed.batch.batchId ?? newBatchId();
  const notifyTo = parsed.batch.notifyTo;
  let batch;
  try {
    batch = openBatch(home, { batchId, owner: parsed.batch.owner, items: parsed.batch.items, nowSec: nowSec(), ...(notifyTo ? { notifyTo } : {}) });
  } catch (e) {
    // The batch may already be SAVED (openBatch writes before it notifies). Hand back the id so the retry reuses it (idempotent on
    // batchId — never a duplicate), and reconstruct the ORIGINAL command + --batch-id so the retry hits the same dir/owner/notify.
    const saved = (() => { try { return readBatch(home, batchId) !== null; } catch { return false; } })();
    process.stderr.write(`decide: openBatch failed for ${batchId}: ${e instanceof Error ? e.message : String(e)}\n` +
      (saved ? `decide: the batch WAS saved; the notify phase failed. Retry to finish the notify (idempotent):\n  ${retryHint(q, batchId)}\n` : "") );
    return 1;
  }
  // DEC-P2-2: report the ACTUAL notify credential, not the requested target.
  let note = "";
  if (notifyTo) {
    const actual = notifiedTarget(home, batchId);
    note = actual === null ? ` · notify ${notifyTo} UNCONFIRMED (no sent credential found)`
      : actual === notifyTo ? ` · notified ${actual}`
      : ` · notified ${actual} (this batch's existing ping; your --notify ${notifyTo} was a no-op — re-notify is at-most-once)`;
  }
  process.stdout.write(`submitted ${batch.batchId} — ${batch.items.length} item(s), owner=${batch.owner}${note}\n`);
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
