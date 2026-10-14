/**
 * Carly projection PURE core (dialog-officer M2-a, deliverable ③). Carly (the dialog-officer front desk) owns two human-facing
 * files in her home — `~/.agenthop/carly/HEARTBEAT.md` and `MEMORY.md`. The SWARM writes ONE managed region in each, delimited by
 * HTML-comment markers; everything OUTSIDE that region is HERS and is left byte-for-byte untouched (dual-write isolation — the
 * same ownership discipline Carly experiment ④ surfaced for the tern boards). This module owns the FROZEN markers + schema + the
 * PURE shape builders; the IO half (reads the durable sources, writes atomically) lives in the `-store` sibling.
 *
 * HEARTBEAT schema is FROZEN BY CARLY (contract amendment, she scans it with a model-free check): the managed region is ONE
 * entry PER LINE, exactly four pipe-separated fields — `id | deadlineISO | waitingFor(user|seat) | one-line ask`. We therefore
 * guarantee each entry renders as exactly those four fields on one line, and no field may contain a `|` or a newline (both would
 * break her parser), so data pipes are substituted and every field is flattened to one line.
 *
 * Invariants:
 *  - DUAL-WRITE ISOLATION: `spliceManagedBlock` replaces ONLY the span between (and including) the markers; bytes before BEGIN
 *    and after END are preserved exactly. No markers yet ⇒ the block is APPENDED (her prior content is never rewritten).
 *  - IDEMPOTENT: each managed region is a pure function of its normalized inputs (no wall clock, no list-position hashing), so a
 *    rerun with equal inputs yields byte-identical files.
 *  - HONEST EMPTY: an empty queue renders a single "(none)" line (zero pipe-fields ⇒ her scan reads zero entries), never a stale value.
 *
 * Pure: no fs, no clock, no top-level side effects.
 */

export const SWARM_BEGIN = "<!-- swarm begin -->" as const;
export const SWARM_END = "<!-- swarm end -->" as const;

/** One HEARTBEAT entry in Carly's FROZEN scan schema: `id | deadlineISO | waitingFor | ask`. `deadlineISO` is an ISO-8601 string
 *  (or "" ⇒ rendered "-"); `waitingFor` is "user" or a seat id (who the ask is blocked on); `ask` is the one-line request. */
export type HeartbeatEntry = { id: string; deadlineISO: string; waitingFor: string; ask: string };

/** The normalized, already-read inputs the two managed regions render from. The `-store` IO adapts the real durable sources
 *  (ruling-ledger pending list → heartbeat entries; idle-explainer → alerts; morning-digest → a one-line digest) into this shape
 *  so the pure builders never depend on their internal schemas. NO timestamps here (a wall clock would break byte-idempotency). */
export type CarlyStatus = {
  heartbeat: HeartbeatEntry[]; // the awaiting-ruling queue (HEARTBEAT.md, frozen 4-field schema)
  alerts: string[];            // alerts Carly should surface (MEMORY.md)
  digest: string | null;       // an already-rendered one-line digest summary (MEMORY.md), or null
};

/** Flatten to a single line (any newline/CR/line-separator ⇒ a visible glyph) and trim — a managed line is ALWAYS one line, so a
 *  multi-line field can neither break the marker structure nor smuggle a `<!-- swarm end -->` from data. */
const NEWLINES = new RegExp("[\r\n\u0085\u2028\u2029]+", "g");
function oneLine(s: string): string {
  // also neutralize HTML-comment tokens so NO data field can forge a `<!-- swarm end -->` the splice would mistake for the real marker.
  return String(s).replace(NEWLINES, " / ").replace(/<!--/g, "<! --").replace(/-->/g, "-- >").trim();
}

/** A single pipe-schema FIELD: one line, and any `|` replaced by `/` so the four-field split stays unambiguous for her scanner. */
function field(s: string): string {
  return oneLine(s).replace(/\|/g, "/");
}

/** Build the HEARTBEAT managed-region body (FROZEN schema): one `id | deadlineISO | waitingFor | ask` line per entry, in the given
 *  order (the ledger already orders them). An empty queue renders a single "(none)" line (no pipes ⇒ zero entries to her scan).
 *  Pure + deterministic. */
export function buildHeartbeatBody(entries: HeartbeatEntry[]): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map((e) => `${field(e.id)} | ${field(e.deadlineISO) || "-"} | ${field(e.waitingFor) || "-"} | ${field(e.ask)}`)
    .join("\n");
}

/** Build the MEMORY managed-region body: alerts then a one-line digest, each section explicit-"(none)" when empty. Pure. The
 *  usage note (deliverable ④) is appended by the store so it, too, lives inside the managed region (swarm-owned, regenerated). */
export function buildMemoryBody(status: Pick<CarlyStatus, "alerts" | "digest">): string {
  const lines: string[] = ["### Alerts"];
  if (status.alerts.length === 0) lines.push("- (none)");
  else for (const a of status.alerts) lines.push("- " + oneLine(a));
  lines.push("", "### Digest");
  lines.push(status.digest && status.digest.trim() !== "" ? oneLine(status.digest) : "(none)");
  return lines.join("\n");
}

/** Wrap a managed body in the frozen markers: exactly `BEGIN\n<body>\nEND` (no trailing newline — the splice owns surrounding
 *  newlines so reruns stay byte-stable). */
export function wrapManagedBlock(body: string): string {
  return SWARM_BEGIN + "\n" + body + "\n" + SWARM_END;
}

/**
 * DUAL-WRITE splice: return `existing` with its managed block replaced by `block` (already marker-wrapped).
 *  - Both markers present (BEGIN before END) ⇒ replace from BEGIN through END inclusive; bytes before/after are exact.
 *  - No complete marker pair ⇒ APPEND the block (blank-line separated iff `existing` is non-empty), her content byte-for-byte. A
 *    lone BEGIN or END (corrupt half-marker) counts as "no pair" ⇒ append, never destroy her bytes.
 * Pure. Idempotent: re-splicing an already-current file with the same block yields the identical string.
 */
export function spliceManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(SWARM_BEGIN);
  const end = existing.indexOf(SWARM_END, begin + SWARM_BEGIN.length);
  if (begin !== -1 && end !== -1) {
    return existing.slice(0, begin) + block + existing.slice(end + SWARM_END.length);
  }
  if (existing === "") return block + "\n";
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}
