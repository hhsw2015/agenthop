/**
 * model-market capability-profile cache — IO layer (model-staffing piece ①, brief §2①). Fetches the upstream
 * `model-market-full.json` (read-only GET), parses + trims it through the pure core, and atomically (temp + rename) writes a
 * bounded snapshot under the NEW shared `~/.agenthop/swarm/model-market/` dir. The snapshot is ONE SHARED copy across projects
 * (coordinator freeze Q4: a capability profile is cross-project; only the CPA catalog is per-endpoint). The pure shape/trim/age
 * logic lives in `model-market.ts`. Mirrors the dual-bandwidth / console-projection store style.
 *
 * FC-2 THREE-STATE (CP-2 discipline, brief §3):
 *   - fetch ok + parse ok (≥1 model)        ⇒ WRITE a new snapshot (stamped fetchedAtSec = now).
 *   - source unreachable (fetch throws/!ok)  ⇒ KEEP the last snapshot (return written:false) — never overwrite with nothing.
 *   - parse-fail / EMPTY (0 models)          ⇒ KEEP the last snapshot — a torn/garbage body is never written as a fake profile.
 * The READ side (readModelMarketSnapshot) returns {snapshot, staleSec} or null when no usable cache exists, so staffing can
 * distinguish "stale but present" from "unknown" (no snapshot ⇒ no suggestion, brief §3).
 *
 * CP-3: the output dir chain must be REAL owned directories — a pre-existing symlink on `model-market/` would land our write
 * outside the boundary, so lstat (no-follow) guards it (same guard console-projection-store uses on `console/`).
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseModelMarket, validSnapshot, staleSec, type ModelMarketSnapshot } from "./model-market.js";

/** The upstream capability-profile file. Data host (pulse-2x5.pages.dev) differs from the discovery host
 *  (pulse.playingapi.indevs.in/llms.txt) — brief §0 records both; this is the file the data actually lives at. Override via
 *  AGENTHOP_MODEL_MARKET_URL (tests / a relocation) — never a code edit. */
export const MODEL_MARKET_URL = process.env.AGENTHOP_MODEL_MARKET_URL || "https://pulse-2x5.pages.dev/data/model-market-full.json";

function marketDir(home: string): string { return path.join(home, ".agenthop", "swarm", "model-market"); }
function snapshotPath(home: string): string { return path.join(marketDir(home), "snapshot.json"); }

/** CP-3 — the market output dir must be a REAL owned directory, never redirected by a pre-existing symlink (which would land
 *  the snapshot write outside the boundary). lstat (NO-follow): a symlink or any non-directory ⇒ REFUSE; ENOENT ⇒ not created
 *  yet ⇒ safe (our mkdir makes a real dir); any other stat fault ⇒ refuse (never risk an unvetted write). */
function marketBoundaryOk(home: string): boolean {
  let st;
  try { st = lstatSync(marketDir(home)); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } // ENOENT ⇒ safe; any other fault ⇒ refuse
  return st.isDirectory();
}

/** Atomic JSON write (temp + rename) so a reader never sees a half-written snapshot — the same temp+rename the console store
 *  uses, and the mechanism the concurrency-race fixture leans on (two writers both land a COMPLETE file; the last rename wins). */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** An injectable raw fetcher — the selftest supplies a synthetic / throwing / garbage one so it NEVER hits the live network. */
export type RawFetcher = (url: string) => Promise<unknown>;

/** The real fetcher: a read-only GET via global fetch (the `t3-draft-live.ts` form). A non-2xx or a transport error THROWS ⇒
 *  pullModelMarket treats it as "source unreachable" (CP-2: keep last). */
const realFetcher: RawFetcher = async (url) => {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`model-market ${res.status}`);
  return res.json();
};

/** The outcome of a pull attempt. `written` is true ONLY when a fresh snapshot replaced the cache; `reason` records WHY a pull
 *  kept the last snapshot instead (CP-2 three-state, for the sweep's once-per-interval log). */
export type PullResult = { written: boolean; reason?: string };

/**
 * Pull the upstream capability profile and, on success, atomically replace the snapshot. FC-2 THREE-STATE:
 *   - fetch throws / non-2xx      ⇒ { written:false, reason:"unreachable" }  (KEEP last)
 *   - parse-fail / 0 models       ⇒ { written:false, reason:"parse-fail" }   (KEEP last — never a fabricated empty profile)
 *   - ok                          ⇒ { written:true }                          (fresh snapshot, fetchedAtSec = nowSec)
 * CP-3: a redirected output dir ⇒ { written:false, reason:"boundary" }. Fully self-contained; the sweep wraps it fail-soft.
 */
export async function pullModelMarket(home: string, nowSec: number, fetcher: RawFetcher = realFetcher, url: string = MODEL_MARKET_URL): Promise<PullResult> {
  if (!marketBoundaryOk(home)) return { written: false, reason: "boundary" }; // CP-3: never write through a redirected dir chain
  let raw: unknown;
  try { raw = await fetcher(url); }
  catch (e) { return { written: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` }; } // CP-2: keep last
  const snap = parseModelMarket(raw, nowSec);
  if (!snap || snap.models.length === 0) return { written: false, reason: "parse-fail/empty" }; // CP-2: never overwrite with empty/partial
  writeJsonAtomic(snapshotPath(home), snap);
  return { written: true };
}

/**
 * Read the cached snapshot + its age. ENOENT (no cache yet) ⇒ null; a corrupt / torn / structurally-invalid file ⇒ null (treated
 * as "no usable cache" — the crash-recovery path: a half-written file never masquerades as a profile). Any OTHER read fault
 * (EACCES/…) PROPAGATES (house style: a read error is never silently "no cache") — the sweep's try/catch isolates it. Returns the
 * snapshot object + its staleSec (the cache age the consumer judges freshness by).
 */
export function readModelMarketSnapshot(home: string, nowSec: number): { snapshot: ModelMarketSnapshot; staleSec: number } | null {
  let raw: string;
  try { raw = readFileSync(snapshotPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; } // torn / corrupt JSON ⇒ no usable cache (crash-recovery)
  const snap = validSnapshot(parsed);
  if (!snap) return null;
  return { snapshot: snap, staleSec: staleSec(snap, nowSec) };
}
