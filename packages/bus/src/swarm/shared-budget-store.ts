/**
 * Shared-budget pool IO (DA2 + DA2-R1 review fixes). Single-file optimistic CAS: the pool's ledger (committed draws + in-flight
 * reservations) lives in one JSON file, mutated only under a per-pool HOLDER-IDENTITY lock so concurrent consumers never lose an
 * update. Review fixes folded:
 *   SB1 — the lock is broken only when its published holder's pid is DEAD (pid-liveness), never by age alone, so a paused live
 *         holder can't have its confirmed draw clobbered; an unknown/empty external lock stays contended.
 *   SB2 — a corrupt or wrong-identity ledger is NEVER treated as absent (which would re-grant a full ceiling): ENOENT = absent,
 *         anything else (unparseable / invalid / body poolName != requested) THROWS; ceiling + draws are value-validated; the body
 *         name is bound to the requested name, defeating a case-insensitive-filesystem alias (Shared vs shared).
 *   SB3 — admission is a RESERVE (write under the lock) that counts committed spend + in-flight reservations, bounding overshoot to
 *         one ticket regardless of consumer count (coordinator ruling A). Crashed units are reclaimed (pid-liveness + TTL).
 *   SB4 — every mutation re-writes the projection (even an idempotent replay), so a prior projection-write fault is repaired; the
 *         lock-contention handler no longer swallows an EEXIST thrown by the critical section.
 *   SB5 — the pool name is validated BEFORE any filesystem path is touched, so an invalid name can never create/reclaim/delete a
 *         lock outside the budgets dir.
 *
 * dormant: standalone, NOT wired into fan-out (feat/fanout-native still in review); interface seams are documented in the design.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  type PoolCeiling,
  type PoolDraw,
  type PoolState,
  type Reservation,
  type PoolAdmission,
  type BudgetPoolProjection,
  isValidPoolName,
  resolveCeiling,
  emptyPool,
  reserve as pureReserve,
  commit as pureCommit,
  raiseCeiling as pureRaiseCeiling,
  pruneStaleReservations,
  remainingOf,
  project,
} from './shared-budget.js';

const RESERVATION_TTL_SEC = 3600; // backstop reclaim if a reservation's pid was reused (liveness is primary)
const LOCK_TRIES = 200;           // ~200 * 15ms = 3s max wait before giving up
const nowSec = () => Math.floor(Date.now() / 1000);

const budgetsDir = (home: string) => path.join(home, '.agenthop', 'budgets');
const projectionsDir = (home: string) => path.join(home, '.agenthop', 'console', 'budget-pools');

function assertName(name: string): void {
  if (!isValidPoolName(name)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(name)}`);
}
function poolFile(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.json`); }
function lockDir(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.lock`); }
function projectionFile(home: string, name: string): string { return path.join(projectionsDir(home), `${name}.json`); }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // synchronous sleep, no dependency
}

// --- holder-identity lock (SB1/SB5) -------------------------------------------
function acquireLock(home: string, name: string): string {
  assertName(name); // SB5: validate BEFORE any path is built or touched
  const dir = lockDir(home, name);
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  mkdirSync(budgetsDir(home), { recursive: true, mode: 0o700 });
  for (let i = 0; i < LOCK_TRIES; i++) {
    let made = false;
    try { mkdirSync(dir); made = true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Held. Break ONLY if the published holder's pid is dead (SB1 — never by age alone). Anything else contends.
      let entries: string[];
      try { entries = readdirSync(dir); } catch { sleepMs(15); continue; } // vanished mid-check => retry
      if (entries.length === 1) {
        const hpid = Number(entries[0]!.split('.')[0]);
        if (Number.isInteger(hpid) && hpid > 0 && !pidAlive(hpid)) {
          try { rmSync(path.join(dir, entries[0]!)); rmdirSync(dir); } catch { /* a peer reclaimed it first */ }
          continue; // retry fresh
        }
      }
      // live published holder, empty (mid-acquire / external stranded), or ambiguous (>1): contend, never steal.
      sleepMs(15);
      continue;
    }
    if (made) {
      try { writeFileSync(path.join(dir, token), '', { mode: 0o600 }); } // publish identity inside the lock
      catch (e) { try { rmdirSync(dir); } catch { /* best-effort */ } throw e; }
      return token;
    }
  }
  throw new Error(`shared-budget: could not acquire lock for pool ${name} within ${LOCK_TRIES} tries`);
}
function releaseLock(home: string, name: string, token: string): void {
  const dir = lockDir(home, name);
  // Only tear down if the lock is still OURS (a stale-break could have reassigned it). Never remove a successor's lock.
  try {
    if (existsSync(path.join(dir, token)) && readdirSync(dir).length === 1) {
      rmSync(path.join(dir, token));
      rmdirSync(dir);
    }
  } catch { /* best-effort */ }
}
/** Run fn under the per-pool lock. fn's own errors PROPAGATE (SB4: they are not caught by the lock-contention handler, which lives
 *  entirely inside acquireLock). */
function withLock<T>(home: string, name: string, fn: () => T): T {
  const token = acquireLock(home, name);
  try { return fn(); } finally { releaseLock(home, name, token); }
}

// --- fail-closed read + full validation (SB2) ---------------------------------
function validDrawShape(d: unknown): d is PoolDraw {
  const o = d as Record<string, unknown>;
  return !!o && typeof o.drawKey === 'string' && o.drawKey.length > 0 && typeof o.consumer === 'string' && o.consumer.length > 0
    && typeof o.usd === 'number' && Number.isFinite(o.usd) && o.usd >= 0
    && typeof o.tokens === 'number' && Number.isInteger(o.tokens) && o.tokens >= 0
    && typeof o.atSec === 'number' && Number.isFinite(o.atSec)
    && (o.reserveKey === undefined || typeof o.reserveKey === 'string');
}
function validResShape(r: unknown): r is Reservation {
  const o = r as Record<string, unknown>;
  return !!o && typeof o.reserveKey === 'string' && o.reserveKey.length > 0 && typeof o.consumer === 'string' && o.consumer.length > 0
    && typeof o.estUsd === 'number' && Number.isFinite(o.estUsd) && o.estUsd >= 0
    && typeof o.estTokens === 'number' && Number.isInteger(o.estTokens) && o.estTokens >= 0
    && typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0
    && typeof o.atSec === 'number' && Number.isFinite(o.atSec);
}
/** Parse a ledger, binding its body name to `expectedName`. Returns null only for a structurally invalid body. */
function parsePoolState(raw: unknown, expectedName: string): PoolState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.poolName !== expectedName || !isValidPoolName(o.poolName)) return null; // SB2: body must match requested (defeats fs alias)
  let ceiling: PoolCeiling;
  try { ceiling = resolveCeiling(o.ceiling as PoolCeiling); } catch { return null; } // SB2: reject double-null/negative/non-finite
  if (!Array.isArray(o.draws)) return null;
  const reservationsRaw = o.reservations === undefined ? [] : o.reservations;
  if (!Array.isArray(reservationsRaw)) return null;
  const draws: PoolDraw[] = [];
  for (const d of o.draws) { if (!validDrawShape(d)) return null; draws.push(d); }
  const reservations: Reservation[] = [];
  for (const r of reservationsRaw) { if (!validResShape(r)) return null; reservations.push(r); }
  return { poolName: o.poolName, ceiling, draws, reservations };
}
/** Read a pool, FAIL-CLOSED: ENOENT = absent (null); a real read error / unparseable / invalid body all THROW — a corrupt ledger
 *  is NEVER silently treated as absent (which would re-grant a full ceiling, SB2). */
function readPoolStrict(home: string, name: string): PoolState | null {
  assertName(name);
  let raw: string;
  try { raw = readFileSync(poolFile(home, name), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`shared-budget: pool ${name} ledger is corrupt (unparseable) — refusing to treat as absent`); }
  const st = parsePoolState(parsed, name);
  if (!st) throw new Error(`shared-budget: pool ${name} ledger is invalid or name-mismatched — refusing to treat as absent`);
  return st;
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}
function writeLedgerAndProjection(home: string, name: string, state: PoolState): void {
  writeJsonAtomic(poolFile(home, name), state);
  writeJsonAtomic(projectionFile(home, name), project(state, nowSec()));
}

// --- public API ---------------------------------------------------------------

/** Read a pool's state, or null if absent. Fail-closed on corruption (throws). */
export function readPool(home: string, name: string): PoolState | null {
  return readPoolStrict(home, name);
}

/** Create a pool (idempotent: an existing pool is returned unchanged, never clobbered — and a corrupt ledger THROWS rather than
 *  being recreated at full ceiling, SB2). Coordinator action. */
export function createPool(home: string, name: string, ceiling: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const existing = readPoolStrict(home, name);
    if (existing) return existing;
    const state = emptyPool(name, ceiling);
    writeLedgerAndProjection(home, name, state);
    return state;
  });
}

/** Admit + reserve atomically before dispatching a NEW unit (SB3 gate). Returns null when the pool is absent (caller fail-closes:
 *  an unknown pool grants no budget). Reclaims crashed units' reservations first. */
export function reservePool(home: string, name: string, res: Reservation): PoolAdmission | null {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) return null;
    const pruned = pruneStaleReservations(read, pidAlive, nowSec(), RESERVATION_TTL_SEC);
    const r = pureReserve(pruned, res);
    if (r.state !== read) writeLedgerAndProjection(home, name, r.state); // persist prune and/or the new reservation
    return r.ok ? { ok: true, remaining: remainingOf(r.state) } : { ok: false, exhausted: true, remaining: remainingOf(r.state) };
  });
}

/** Commit an actual spend (settles its reservation). Idempotent by drawKey. ALWAYS re-writes the projection so an idempotent
 *  replay converges a previously-failed projection write to the committed ledger (SB4). Throws if the pool is absent. */
export function commitDraw(home: string, name: string, draw: PoolDraw): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist (create it first)`);
    const pruned = pruneStaleReservations(read, pidAlive, nowSec(), RESERVATION_TTL_SEC);
    const next = pureCommit(pruned, draw);
    writeLedgerAndProjection(home, name, next); // always: repairs a stale projection even when the draw is an idempotent no-op
    return next;
  });
}

/** Raise a pool's ceiling (coordinator-only — ruling 5; the money-gate is the CALLER's, enforced at dispatch, not here). */
export function raisePoolCeiling(home: string, name: string, next: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist`);
    const raised = pureRaiseCeiling(read, next);
    writeLedgerAndProjection(home, name, raised);
    return raised;
  });
}

/** List every pool's projection (console). Missing dir => empty. A corrupt pool is SKIPPED from the display list (it is never
 *  granted budget — the gate paths still throw on it), so one bad ledger can't break the whole view. */
export function listPoolProjections(home: string): BudgetPoolProjection[] {
  let names: string[];
  try { names = readdirSync(budgetsDir(home)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const out: BudgetPoolProjection[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    if (!isValidPoolName(name)) continue;
    let state: PoolState | null;
    try { state = readPoolStrict(home, name); } catch { continue; } // corrupt: skip from display (never granted)
    if (state) out.push(project(state, nowSec()));
  }
  return out;
}
