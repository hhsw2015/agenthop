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
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIdArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && RULING_ID_RE.test(x));
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validate ONE ruling record from untrusted input. Whole-record reject on any malformation (bad id pattern, series not
 * matching the id prefix, status not in the enum, missing/empty title or statement, an optional id-ref field that is not
 * an array of valid ids, a self-reference). Unknown extra fields are tolerated (the schema may grow) but never copied
 * into the returned record — the result carries ONLY the known fields. No silent repair. Pure. */
export function loadRuling(input: unknown): RulingLoad {
  if (!isObj(input)) return { ok: false, reason: "ruling must be a non-null object" };
  const o = input;
  if (typeof o.id !== "string" || !RULING_ID_RE.test(o.id)) return { ok: false, reason: `invalid id (want ${RULING_ID_RE})` };
  const id = o.id;
  if (typeof o.series !== "string" || !SERIES.has(o.series as RulingSeries)) return { ok: false, reason: `invalid series for ${id} (want R|S|F)` };
  if (o.series !== id[0]) return { ok: false, reason: `series "${o.series}" does not match id prefix of ${id}` };
  if (!isNonEmptyStr(o.title)) return { ok: false, reason: `missing/empty title for ${id}` };
  if (!isNonEmptyStr(o.statement)) return { ok: false, reason: `missing/empty statement for ${id}` };
  if (typeof o.status !== "string" || !STATUSES.has(o.status as RulingStatus)) return { ok: false, reason: `invalid status for ${id} (want active|superseded|retired)` };

  const out: Ruling = { id, series: o.series as RulingSeries, title: o.title, statement: o.statement, status: o.status as RulingStatus };

  if (o.rationale !== undefined) { if (typeof o.rationale !== "string") return { ok: false, reason: `rationale must be a string for ${id}` }; out.rationale = o.rationale; }
  if (o.supersedes !== undefined) { if (!isIdArray(o.supersedes)) return { ok: false, reason: `supersedes must be an array of valid ids for ${id}` }; out.supersedes = [...o.supersedes]; }
  if (o.supersededBy !== undefined) { if (typeof o.supersededBy !== "string" || !RULING_ID_RE.test(o.supersededBy)) return { ok: false, reason: `supersededBy must be a valid id for ${id}` }; out.supersededBy = o.supersededBy; }
  if (o.relates !== undefined) { if (!isIdArray(o.relates)) return { ok: false, reason: `relates must be an array of valid ids for ${id}` }; out.relates = [...o.relates]; }
  if (o.sources !== undefined) { if (!isStrArray(o.sources)) return { ok: false, reason: `sources must be an array of strings for ${id}` }; out.sources = [...o.sources]; }
  if (o.since !== undefined) { if (typeof o.since !== "string") return { ok: false, reason: `since must be a string for ${id}` }; out.since = o.since; }
  if (o.by !== undefined) { if (typeof o.by !== "string") return { ok: false, reason: `by must be a string for ${id}` }; out.by = o.by; }

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

/** Deterministic sort key for an id: series (R→S→F), then the number, then the sub-letter. Pure. */
export function idSortKey(id: string): [number, number, string] {
  const m = /^([RSF])(\d+)(?:-([a-z]))?$/.exec(id);
  if (!m) return [99, Number.MAX_SAFE_INTEGER, id]; // shouldn't happen on validated input; sorts unknowns last, deterministically
  return [SERIES_RANK[m[1] as RulingSeries], parseInt(m[2], 10), m[3] ?? ""];
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
      return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
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
