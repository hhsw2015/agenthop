/**
 * CPA model-catalog cache — IO layer (model-staffing §③, the CPA-available constraint source). Fetches the CPA endpoint's model
 * list (the OpenAI-compatible `GET /models`) and caches the available ids, so pickModel's catalog constraint reads a durable
 * snapshot instead of making a live call on every sweep. Mirrors `model-market-store.ts`'s pullModelMarket discipline exactly:
 * an injectable fetcher (tests never hit the network), FC-2 three-state, atomic temp+rename write, CP-3 boundary guard.
 *
 * Q4 note: the capability PROFILE (model-market snapshot) is ONE SHARED copy across projects, but the CATALOG is PER-CPA-ENDPOINT
 * — it is whatever THIS endpoint actually serves. Both live under `~/.agenthop/swarm/model-market/`; a different endpoint ⇒ a
 * different `catalog.json` (keyed implicitly by the home + its cpa.json baseUrl). Endpoint + auth resolution mirrors
 * `t3-draft-live.ts`: CPA_BASE_URL env → the home's `~/.agenthop/cpa.json` baseUrl → the local default; an OPTIONAL
 * `authorization: Bearer ${CPA_API_KEY}` header (no header when the key is absent).
 *
 * FC-2 THREE-STATE (brief §3): fetch throws / non-2xx ⇒ KEEP the last catalog; parse-fail / EMPTY ids ⇒ KEEP the last catalog
 * (never overwrite a real catalog with `[]`, which would make every model look unavailable ⇒ a false no-staffable everywhere).
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { staleSec } from "./model-market.js";

export const MODEL_CATALOG_SCHEMA = "model-market-catalog/v1" as const;

/** The cached per-endpoint catalog: the CPA-available model ids, the ENDPOINT they were fetched from (MS-P2-1 — so a read can refuse
 *  a cache minted for a DIFFERENT endpoint), + when we fetched them (for staleness). */
export type ModelCatalogSnapshot = { schema: typeof MODEL_CATALOG_SCHEMA; fetchedAtSec: number; endpoint: string; ids: string[] };

const LOCAL_DEFAULT_CPA = "http://127.0.0.1:8787/v1";

function marketDir(home: string): string { return path.join(home, ".agenthop", "swarm", "model-market"); }
function catalogPath(home: string): string { return path.join(marketDir(home), "catalog.json"); }
function cpaConfigPath(home: string): string { return path.join(home, ".agenthop", "cpa.json"); }

/** The CPA API base, resolved like `t3-draft-live.ts::cpaBaseUrl`: CPA_BASE_URL env first, then the home's `cpa.json` baseUrl,
 *  then the local default. Change the endpoint via env or that config — never a code edit. */
export function cpaBaseUrl(home: string): string | null {
  if (process.env.CPA_BASE_URL) return process.env.CPA_BASE_URL;
  let raw: string;
  try { raw = readFileSync(cpaConfigPath(home), "utf8"); }
  // MS-P2-6: ENOENT (no config file) ⇒ the local default is correct; a NON-ENOENT read fault (EACCES) ⇒ null = UNREADABLE (a real
  // config exists but we can't read it ⇒ the endpoint identity is UNKNOWN ⇒ the caller must refuse, never silently use the default).
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? LOCAL_DEFAULT_CPA : null; }
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { return null; } // corrupt JSON ⇒ unreadable, refuse
  // MS-P2-6 (r2): a parsed-but-MALFORMED config is NOT "no config" — it is unreadable. Only a plain object may override; a non-object
  // doc (array/number/string/null) ⇒ null. A valid object with NO baseUrl key ⇒ the default (a real config that just doesn't
  // override). A baseUrl key PRESENT but not a non-empty string (17 / "" / [] / {}) ⇒ null (declared-but-malformed, never the default).
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  if (!("baseUrl" in (cfg as Record<string, unknown>))) return LOCAL_DEFAULT_CPA;
  const b = (cfg as { baseUrl?: unknown }).baseUrl;
  return typeof b === "string" && b.length > 0 ? b : null;
}

/** CP-3 — the market output dir must be a REAL owned directory, never redirected by a pre-existing symlink. lstat (NO-follow):
 *  a symlink / non-directory ⇒ REFUSE; ENOENT ⇒ safe (our mkdir makes a real dir); any other stat fault ⇒ refuse. */
function catalogBoundaryOk(home: string): boolean {
  let p = home; // MS-P2-7: check the WHOLE chain from .agenthop down, not just the leaf — a symlinked ancestor also escapes the boundary.
  for (const seg of [".agenthop", "swarm", "model-market"]) {
    p = path.join(p, seg);
    let st;
    try { st = lstatSync(p); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; return false; }
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** Atomic JSON write (temp + rename) so a reader never sees a half-written catalog (and two concurrent writers both land a
 *  COMPLETE file; the last rename wins). 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** An injectable raw fetcher — the selftest supplies a synthetic / throwing / garbage one so it NEVER hits the live network.
 *  `base` is the resolved CPA base; `key` is the optional bearer token (undefined ⇒ no auth header). */
export type CatalogFetcher = (base: string, key: string | undefined) => Promise<unknown>;

/** The real fetcher: a read-only GET of the OpenAI-compatible `/models` (the `t3-draft-live.ts` form). A non-2xx / transport
 *  error THROWS ⇒ pullCpaCatalog treats it as "source unreachable" (CP-2: keep last). */
const realCatalogFetcher: CatalogFetcher = async (base, key) => {
  const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`CPA catalog ${res.status}`);
  return res.json();
};

/** Parse the OpenAI-compatible `/models` body (`{ data: [{ id }, …] }`) into the id list; a non-object / missing-data / per-entry
 *  non-string id is dropped. Pure. Exported for the selftest. */
export function parseCatalogIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const m of data) {
    const id = m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

/** The outcome of a catalog pull (mirror of PullResult). `written` true only when a fresh catalog replaced the cache. */
export type CatalogPullResult = { written: boolean; reason?: string };

/**
 * Pull the CPA catalog and, on success, atomically replace the cache. FC-2 THREE-STATE:
 *   - fetch throws / non-2xx ⇒ { written:false, reason:"unreachable" }   (KEEP last)
 *   - parse-fail / 0 ids     ⇒ { written:false, reason:"parse-fail/empty" } (KEEP last — never overwrite a real catalog with [])
 *   - ok                     ⇒ { written:true }                            (fresh catalog, fetchedAtSec = nowSec)
 * CP-3: a redirected output dir ⇒ { written:false, reason:"boundary" }. Fully self-contained; the sweep wraps it fail-soft.
 */
export async function pullCpaCatalog(home: string, nowSec: number, fetcher: CatalogFetcher = realCatalogFetcher): Promise<CatalogPullResult> {
  if (!catalogBoundaryOk(home)) return { written: false, reason: "boundary" }; // CP-3
  const base = cpaBaseUrl(home);
  if (base === null) return { written: false, reason: "config-unreadable" }; // MS-P2-6: never pull from a guessed default endpoint
  const key = process.env.CPA_API_KEY || undefined; // OPTIONAL — no header when absent
  let raw: unknown;
  try { raw = await fetcher(base, key); }
  catch (e) { return { written: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` }; } // CP-2: keep last
  const ids = parseCatalogIds(raw);
  if (ids.length === 0) return { written: false, reason: "parse-fail/empty" }; // CP-2: never overwrite a real catalog with []
  // MS-P2-1: stamp the ENDPOINT so a later read can refuse a cache minted for a different endpoint.
  writeJsonAtomic(catalogPath(home), { schema: MODEL_CATALOG_SCHEMA, fetchedAtSec: Number.isFinite(nowSec) ? nowSec : 0, endpoint: base, ids });
  return { written: true };
}

/**
 * Read the cached catalog + its age. ENOENT (no cache) ⇒ null; a corrupt / torn / wrong-schema file ⇒ null (crash-recovery: a
 * half-written file never masquerades as a catalog). Any OTHER read fault PROPAGATES (house style). Returns {ids, staleSec}.
 */
export function readCatalog(home: string, nowSec: number): { ids: string[]; staleSec: number } | null {
  const base = cpaBaseUrl(home);
  if (base === null) return null; // MS-P2-6: the current endpoint is unknown (config unreadable) ⇒ cannot trust ANY cache for it
  let raw: string;
  try { raw = readFileSync(catalogPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; } // torn / corrupt ⇒ no usable cache
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.schema !== MODEL_CATALOG_SCHEMA || typeof p.fetchedAtSec !== "number" || !Number.isFinite(p.fetchedAtSec) || !Array.isArray(p.ids)) return null;
  if (typeof p.endpoint !== "string" || p.endpoint !== base) return null; // MS-P2-1: cache minted for a DIFFERENT (or no) endpoint ⇒ not valid here
  const ids = p.ids.filter((x): x is string => typeof x === "string");
  return { ids, staleSec: staleSec({ fetchedAtSec: p.fetchedAtSec }, nowSec) };
}
