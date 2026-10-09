/**
 * ruling-ledger — a retrievable, structured projection of the swarm's rulings (R22 Top-5 last item).
 *
 * PROGRESS.md scatters the ruling codes (R1-R26 architecture/behavior rules, S11-S29 messaging/social disciplines,
 * F17-F45 fix/incident findings) through narrative text: no glossary, no lookup by id, no way to ask "is this one
 * superseded?". This promotes them into a structured ledger — one file per ruling at `~/.agenthop/swarm/rulings/<id>.json`
 * plus a rebuilt `index.json`.
 *
 * The ledger is a DOWNSTREAM PROJECTION, not a new authority: PROGRESS.md stays the narrative source; the ledger is the
 * by-id index. When the two disagree, PROGRESS wins until the ledger is re-derived (the same discipline as memory: the
 * document is authoritative, the index follows). This module ships only the schema + validation + index builder (pure
 * core). Parsing PROGRESS, back-filling the ~80 codes, a query CLI, and a viz surface are deliberate seams left for later.
 *
 * Fail-closed, like every other loader here: one malformed record rejects the WHOLE ledger (no partial trust), and
 * nothing is silently repaired (mirrors loadPlan / loadGrillTree).
 *
 * Pure core below (selftested); the IO shell (scan the dir, read+validate each file, atomically write the index) is
 * dormant (`SWARM_RULING_LEDGER` off).
 */

// ============================================================================================================
// Pure core (selftested in ruling-ledger.selftest.mts)
// ============================================================================================================

export type RulingSeries = "R" | "S" | "F";
export type RulingStatus = "active" | "superseded" | "retired";

export interface Ruling {
  id: string;
  series: RulingSeries;
  title: string;
  statement: string;
  status: RulingStatus;
  rationale?: string;
  supersedes?: string[];
  supersededBy?: string;
  relates?: string[];
  sources?: string[];
  since?: string;
  by?: string;
}

/** Canonical id: a series letter, a number, an optional `-<lowercase>` sub-letter. No path characters are possible, so
 *  `rulingFileRelPath` cannot be made to traverse. */
export const RULING_ID_RE = /^[RSF]\d+(-[a-z])?$/;
const SERIES = new Set<RulingSeries>(["R", "S", "F"]);
const STATUSES = new Set<RulingStatus>(["active", "superseded", "retired"]);

export type RulingLoad = { ok: true; ruling: Ruling } | { ok: false; reason: string };
export type LedgerLoad = { ok: true; rulings: Ruling[] } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate an array field POSITIONALLY and return a fresh copy built from the SAME indexed reads that were checked
 * (RL-P2-1 / RL-P2-2): never `.every` (an input can override it, and it SKIPS sparse holes), never spread / iteration (a
 * custom iterator could yield values other than the indexed ones). A sparse hole, a non-string, or a value failing `ok`
 * rejects the WHOLE field (null). The returned copy is exactly what was validated, so re-validating the output passes. */
function copyValidatedStrArray(v: unknown, ok: (s: string) => boolean): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const el: unknown = v[i]; // ONE indexed read — validate AND copy the SAME value (no re-read, no iterator)
    if (typeof el !== "string" || !ok(el)) return null; // a sparse hole reads as undefined ⇒ rejected
    out.push(el);
  }
  return out;
}

/**
 * Validate ONE ruling record from untrusted input. Whole-record reject on any malformation (bad id pattern, series not
 * matching the id prefix, status not in the enum, missing/empty title or statement, an optional id-ref field that is not
 * an array of valid ids, a self-reference). Unknown extra fields are tolerated (the schema may grow) but never copied
 * into the returned record — the result carries ONLY the known fields. No silent repair.
 *
 * RL-P2-2: every field is read EXACTLY ONCE into a local const, then validated AND assigned from that SAME const — a
 * getter can never return one value to the validator and another to the result. Array copies are built positionally
 * (copyValidatedStrArray), so the returned array is exactly what was checked. Pure. */
export function loadRuling(input: unknown): RulingLoad {
  if (!isObj(input)) return { ok: false, reason: "ruling must be a non-null object" };
  const o = input;
  const id = o.id;
  if (typeof id !== "string" || !RULING_ID_RE.test(id)) return { ok: false, reason: `invalid id (want ${RULING_ID_RE})` };
  const series = o.series;
  if (typeof series !== "string" || !SERIES.has(series as RulingSeries)) return { ok: false, reason: `invalid series for ${id} (want R|S|F)` };
  if (series !== id[0]) return { ok: false, reason: `series "${series}" does not match id prefix of ${id}` };
  const title = o.title;
  if (typeof title !== "string" || title.length === 0) return { ok: false, reason: `missing/empty title for ${id}` };
  const statement = o.statement;
  if (typeof statement !== "string" || statement.length === 0) return { ok: false, reason: `missing/empty statement for ${id}` };
  const status = o.status;
  if (typeof status !== "string" || !STATUSES.has(status as RulingStatus)) return { ok: false, reason: `invalid status for ${id} (want active|superseded|retired)` };

  const out: Ruling = { id, series: series as RulingSeries, title, statement, status: status as RulingStatus };

  const rationale = o.rationale;
  if (rationale !== undefined) { if (typeof rationale !== "string") return { ok: false, reason: `rationale must be a string for ${id}` }; out.rationale = rationale; }
  const supersedes = o.supersedes;
  if (supersedes !== undefined) { const c = copyValidatedStrArray(supersedes, (s) => RULING_ID_RE.test(s)); if (!c) return { ok: false, reason: `supersedes must be an array of valid ids for ${id}` }; out.supersedes = c; }
  const supersededBy = o.supersededBy;
  if (supersededBy !== undefined) { if (typeof supersededBy !== "string" || !RULING_ID_RE.test(supersededBy)) return { ok: false, reason: `supersededBy must be a valid id for ${id}` }; out.supersededBy = supersededBy; }
  const relates = o.relates;
  if (relates !== undefined) { const c = copyValidatedStrArray(relates, (s) => RULING_ID_RE.test(s)); if (!c) return { ok: false, reason: `relates must be an array of valid ids for ${id}` }; out.relates = c; }
  const sources = o.sources;
  if (sources !== undefined) { const c = copyValidatedStrArray(sources, () => true); if (!c) return { ok: false, reason: `sources must be an array of strings for ${id}` }; out.sources = c; }
  const since = o.since;
  if (since !== undefined) { if (typeof since !== "string") return { ok: false, reason: `since must be a string for ${id}` }; out.since = since; }
  const by = o.by;
  if (by !== undefined) { if (typeof by !== "string") return { ok: false, reason: `by must be a string for ${id}` }; out.by = by; }

  // A ruling cannot reference itself (supersede/be-superseded-by/relate-to itself).
  if (out.supersededBy === id) return { ok: false, reason: `${id} cannot be superseded by itself` };
  if (out.supersedes?.includes(id)) return { ok: false, reason: `${id} cannot supersede itself` };
  if (out.relates?.includes(id)) return { ok: false, reason: `${id} cannot relate to itself` };

  return { ok: true, ruling: out };
}

/**
 * Validate the WHOLE ledger from a list of untrusted records. Fail-closed — any defect rejects the entire ledger:
 *  - each record must pass loadRuling;
 *  - ids unique;
 *  - cross-reference integrity: every id in supersedes / supersededBy / relates must EXIST in the ledger (a dangling ref
 *    means a corrupt ledger — a reference to a ruling that is not here);
 *  - supersession is bidirectional: A.supersededBy === B  ⟺  B.supersedes includes A;
 *  - status consistency: a ruling that HAS a supersededBy must NOT be "active" (superseded yet still active = contradiction).
 * Returns the validated rulings in input order. Pure. */
export function loadLedger(records: readonly unknown[]): LedgerLoad {
  if (!Array.isArray(records)) return { ok: false, reason: "ledger must be an array of records" };
  const rulings: Ruling[] = [];
  const byId = new Map<string, Ruling>();
  for (let i = 0; i < records.length; i++) {
    const r = loadRuling(records[i]);
    if (!r.ok) return { ok: false, reason: `record ${i}: ${r.reason}` };
    if (byId.has(r.ruling.id)) return { ok: false, reason: `duplicate id ${r.ruling.id}` };
    byId.set(r.ruling.id, r.ruling);
    rulings.push(r.ruling);
  }
  const has = (id: string): boolean => byId.has(id);
  for (const r of rulings) {
    for (const s of r.supersedes ?? []) if (!has(s)) return { ok: false, reason: `${r.id} supersedes unknown ruling ${s}` };
    for (const rel of r.relates ?? []) if (!has(rel)) return { ok: false, reason: `${r.id} relates to unknown ruling ${rel}` };
    if (r.supersededBy !== undefined) {
      if (!has(r.supersededBy)) return { ok: false, reason: `${r.id} superseded by unknown ruling ${r.supersededBy}` };
      const b = byId.get(r.supersededBy)!;
      if (!(b.supersedes ?? []).includes(r.id)) return { ok: false, reason: `supersession not bidirectional: ${r.id}.supersededBy=${b.id} but ${b.id}.supersedes lacks ${r.id}` };
      if (r.status === "active") return { ok: false, reason: `${r.id} has supersededBy=${r.supersededBy} but is still active (superseded yet active = contradiction)` };
    }
  }
  // The other direction of the iff: every A in B.supersedes must point back via A.supersededBy === B.
  for (const b of rulings) {
    for (const aId of b.supersedes ?? []) {
      const a = byId.get(aId)!; // existence already checked above
      if (a.supersededBy !== b.id) return { ok: false, reason: `supersession not bidirectional: ${b.id}.supersedes includes ${aId} but ${aId}.supersededBy is ${a.supersededBy ?? "unset"}` };
    }
  }
  return { ok: true, rulings };
}

export interface IndexEntry {
  id: string;
  series: RulingSeries;
  title: string;
  status: RulingStatus;
  supersededBy?: string;
}
export interface Index {
  version: number;
  generatedAtSec: number;
  count: number;
  bySeriesCount: Record<RulingSeries, number>;
  entries: IndexEntry[];
}

export const INDEX_VERSION = 1;
const SERIES_RANK: Record<RulingSeries, number> = { R: 0, S: 1, F: 2 };

/** Deterministic sort key for an id: series (R→S→F), then the number, then the sub-letter. The number is a BigInt so it
 *  compares LOSSLESSLY across the whole accepted domain (`\d+` is unbounded — parseInt collapses values past 2^53 and
 *  turns a 300-digit number into Infinity, which would misorder or degrade to input order, RL-P2-3). Pure. */
export function idSortKey(id: string): [number, bigint, string] {
  const m = /^([RSF])(\d+)(?:-([a-z]))?$/.exec(id);
  if (!m) return [99, -1n, id]; // shouldn't happen on validated input; sorts unknowns last, deterministically
  return [SERIES_RANK[m[1] as RulingSeries], BigInt(m[2]), m[3] ?? ""];
}

/** Build the index projection from validated rulings — a pure, deterministically-ordered rebuild (never hand-edited).
 *  `nowSec` stamps generatedAtSec (floored; non-finite ⇒ 0). Pure. */
export function buildIndex(rulings: readonly Ruling[], nowSec: number): Index {
  const bySeriesCount: Record<RulingSeries, number> = { R: 0, S: 0, F: 0 };
  for (const r of rulings) bySeriesCount[r.series]++;
  const entries: IndexEntry[] = rulings
    .map((r) => ({ id: r.id, series: r.series, title: r.title, status: r.status, ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}) }))
    .sort((a, b) => {
      const ka = idSortKey(a.id), kb = idSortKey(b.id);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1; // BigInt compare (lossless)
      return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
    });
  return { version: INDEX_VERSION, generatedAtSec: Number.isFinite(nowSec) ? Math.floor(nowSec) : 0, count: rulings.length, bySeriesCount, entries };
}

/** The per-ruling file path relative to the agenthop home. Validates the id (so a bad id can't path-traverse). Pure. */
export function rulingFileRelPath(id: string): string {
  if (!RULING_ID_RE.test(id)) throw new Error(`rulingFileRelPath: invalid id ${JSON.stringify(id)}`);
  return `rulings/${id}.json`;
}

// ============================================================================================================
// IO shell — scan the dir + validate each + atomically write the index (dormant: SWARM_RULING_LEDGER off)
// ============================================================================================================

/** ruling-ledger wiring flip, default OFF (dormant-ahead-of-use). */
export function rulingLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_RULING_LEDGER ?? "");
}
