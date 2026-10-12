/**
 * model-staffing — IO layer (model-staffing piece ③a, brief §5.3). Reads the capability snapshot (piece ①) + the model-market↔
 * CPA map (Q1), builds the staffing suggestions for a set of tasks, and atomically (temp + rename) writes the frozen
 * `console/model-staffing.json` projection the swarm-console renders — listing per-task suggestions + the VISIBLE unmappable
 * count (Q1). Pure read-only producer: it NEVER mutates live state, NEVER spawns, NEVER spends (brief §0/§4). The pure shape/
 * pick logic lives in `model-staffing.ts`.
 *
 * The map table (Q1) is a SHARED resource at `~/.agenthop/swarm/roles/model-market-map.json` (shared across projects, not
 * per-endpoint). readModelMarketMap prefers that home override, else falls back to the repo-shipped seed
 * (`roles/model-market-map.json`, loaded relative to this module like model-tier.ts's default table) so the feature produces
 * suggestions out of the box; a model absent from BOTH is counted unmappable by the pure core.
 *
 * CP-3: the projection lands in the SAME `console/` dir the console-projection store owns; an lstat (no-follow) boundary guard
 * refuses a redirected dir chain (never write through a pre-existing symlink).
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModelMarketSnapshot } from "./model-market-store.js";
import {
  buildStaffingProjection,
  STAFFING_SCHEMA,
  type StaffingProjection,
  type StaffingTaskInput,
} from "./model-staffing.js";

// --- paths -----------------------------------------------------------------------------------------------------------
function consoleDir(home: string): string { return path.join(home, ".agenthop", "swarm", "console"); }
function staffingPath(home: string): string { return path.join(consoleDir(home), "model-staffing.json"); }
function mapOverridePath(home: string): string { return path.join(home, ".agenthop", "swarm", "roles", "model-market-map.json"); }
function defaultMapPath(): string { return path.join(path.dirname(fileURLToPath(import.meta.url)), "roles", "model-market-map.json"); }

/** CP-3 — the console output dir must be a REAL owned directory, never a pre-existing symlink (which would land the projection
 *  write outside the boundary). lstat (NO-follow): a symlink / non-directory ⇒ REFUSE; ENOENT ⇒ safe (our mkdir makes a real
 *  dir); any other stat fault ⇒ refuse. */
function consoleBoundaryOk(home: string): boolean {
  let p = home; // MS-P2-7: check the WHOLE chain from .agenthop down, not just the leaf — a symlinked ancestor also escapes the boundary.
  for (const seg of [".agenthop", "swarm", "console"]) {
    p = path.join(p, seg);
    let st;
    try { st = lstatSync(p); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; return false; }
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** Atomic JSON write (temp + rename) so the console never reads a half-written projection. 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Parse a map file into a validated `{ marketBaseId: cpaId }` record (both strings, non-empty value), else null (absent / torn
 *  / wrong shape). The file shape is `{ schema, map: {...} }`; only the `map` object is consumed. */
/** MS-P2-6: a map file read is THREE-STATE — ENOENT (absent ⇒ try the next source), a valid `{map:{...}}` (ok, even if empty), or
 *  UNREADABLE (EACCES / corrupt JSON / wrong shape ⇒ the caller must NOT silently fall back to a different source). */
type MapRead = { kind: "ok"; map: Record<string, string> } | { kind: "absent" } | { kind: "unreadable" };
function readMapFile(file: string): MapRead {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }; } // EACCES ⇒ unreadable, NOT absent
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { kind: "unreadable" }; } // corrupt JSON ⇒ unreadable (never a silent empty map)
  // MS-P2-6 (r2): an ARRAY is not a map object — a bare-array doc, or `map: []` / `map: ["x"]`, is MALFORMED (unreadable), never a
  // valid/empty/index-keyed map. A plain object with `map: {}` stays a legitimately-empty map.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable" };
  const mapRaw = (parsed as { map?: unknown }).map;
  if (!mapRaw || typeof mapRaw !== "object" || Array.isArray(mapRaw)) return { kind: "unreadable" };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapRaw as Record<string, unknown>)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0) out[k] = v;
  }
  return { kind: "ok", map: out };
}

/** Read the model-market↔CPA map (Q1): the SHARED home override first, else the repo-shipped seed, else an empty map (every
 *  model then counts unmappable). Fully fail-soft — never throws. */
export function readModelMarketMap(home: string): Record<string, string> | null {
  const override = readMapFile(mapOverridePath(home));
  if (override.kind === "ok") return override.map;        // a valid override (incl. an intentional empty map) wins
  if (override.kind === "unreadable") return null;         // MS-P2-6: EACCES/corrupt override ⇒ UNREADABLE ⇒ skip (never fall to the seed)
  const seed = readMapFile(defaultMapPath());             // override absent ⇒ the repo-shipped seed
  if (seed.kind === "ok") return seed.map;
  if (seed.kind === "unreadable") return null;             // MS-P2-6: seed unreadable ⇒ skip
  return {};                                               // both ABSENT ⇒ empty map (every model unmappable — honest, not unreadable)
}

/**
 * Compute + atomically write `console/model-staffing.json` for a set of tasks. Reads the cached snapshot (null ⇒ each task is a
 * no-staffable "unknown", brief §3) + the Q1 map, builds the projection, writes it. CP-3: a redirected console dir ⇒ SKIP
 * (return null). Returns the projection, or null when the write was skipped. Fully self-contained; the sweep wraps it fail-soft.
 */
export function writeStaffingProjection(
  home: string,
  nowSec: number,
  input: { tasks: readonly StaffingTaskInput[]; catalog: readonly string[] },
): StaffingProjection | null {
  if (!consoleBoundaryOk(home)) return null; // CP-3: never write through a redirected console dir chain
  const cached = readModelMarketSnapshot(home, nowSec); // ENOENT/torn ⇒ null ⇒ "unknown" per task
  const mapTable = readModelMarketMap(home);
  if (mapTable === null) return null; // MS-P2-6: the map config is UNREADABLE ⇒ skip (never produce a projection on a guessed map)
  const projection = buildStaffingProjection({
    tasks: input.tasks,
    snapshot: cached ? cached.snapshot : null,
    mapTable,
    catalog: input.catalog,
    nowSec,
  });
  writeJsonAtomic(staffingPath(home), projection);
  return projection;
}

/** Read the projection back (console / tests). ENOENT ⇒ null; other read faults propagate; a corrupt / wrong-schema file ⇒ null. */
export function readStaffingProjection(home: string): StaffingProjection | null {
  let raw: string;
  try { raw = readFileSync(staffingPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || (parsed as { schema?: unknown }).schema !== STAFFING_SCHEMA) return null;
  return parsed as StaffingProjection;
}
