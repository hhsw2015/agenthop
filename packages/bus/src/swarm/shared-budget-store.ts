/**
 * Shared-budget pool IO (DA2 + DA2-R1/R2 review fixes). Single-file optimistic CAS: the pool ledger (committed draws + in-flight
 * reservations) lives in one JSON file, mutated only under a per-pool HOLDER-IDENTITY lock. Review fixes folded:
 *   SB1 — the lock is broken ONLY when its holder's pid is definitively dead (ESRCH); an invalid credential or any inconclusive
 *         probe (EPERM / RangeError / unknown) never authorizes a break; an unknown external empty lock stays contended; a lock
 *         this process stranded on a release fault is tracked in-process and adopted on retry (recovery survives the fault).
 *   SB2 — write-side validation covers the optional reserveKey/presumed fields, so a mutation can never persist a ledger the
 *         same-version reader would reject.
 *   SB3 — admission is a RESERVE that counts committed + in-flight (bound = ceiling + one ticket); a gone reservation is SETTLED to
 *         a presumed-spent estimate, never refunded; commit settles only its own reservation and is a no-op on a committed drawKey.
 *   SB4 — EVERY successful mutation (create / reserve / commit / raise), including an idempotent replay, re-writes the projection,
 *         so a prior projection-write fault is repaired on replay.
 *   SB5 — the pool name is validated before any filesystem path is touched.
 *
 * dormant: standalone, NOT wired into fan-out (feat/fanout-native still in review); interface seams documented in the design.
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
  settleExpiredReservations,
  remainingOf,
  project,
} from './shared-budget.js';

const RESERVATION_TTL_SEC = 3600; // backstop settlement if a reservation's pid was reused (liveness is primary)
const LOCK_TRIES = Number(process.env.SHARED_BUDGET_LOCK_TRIES ?? 200); // ~200 * 15ms = 3s max wait (lowered in tests)
const nowSec = () => Math.floor(Date.now() / 1000);

const budgetsDir = (home: string) => path.join(home, '.agenthop', 'budgets');
const projectionsDir = (home: string) => path.join(home, '.agenthop', 'console', 'budget-pools');

function assertName(name: string): void {
  if (!isValidPoolName(name)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(name)}`);
}
function poolFile(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.json`); }
function lockDir(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.lock`); }
function projectionFile(home: string, name: string): string { return path.join(projectionsDir(home), `${name}.json`); }

/** Definitively dead? ONLY a validated pid that probes to ESRCH ("no such process") authorizes a break (SB1). An out-of-range /
 *  non-integer credential, EPERM (alive, other user), or any other/unknown error => NOT dead => the caller contends, never steals. */
function holderIsDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
const isAlive = (pid: number) => !holderIsDead(pid);

function sleepMs(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Locks THIS process created but could not drop on release — its OWN unfinished occupancy, adoptable on retry (SB1 recovery).
const strandedLocks = new Set<string>();

// --- holder-identity lock (SB1/SB5) -------------------------------------------
function acquireLock(home: string, name: string): string {
  assertName(name); // SB5: validate BEFORE any path is built or touched
  const dir = lockDir(home, name);
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const mine = path.join(dir, token);
  mkdirSync(budgetsDir(home), { recursive: true, mode: 0o700 });
  for (let i = 0; i < LOCK_TRIES; i++) {
    try { mkdirSync(dir); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { sleepMs(15); continue; } // vanished mid-check => retry
      if (entries.length === 1) {
        const hpid = Number(entries[0]!.split('.')[0]);
        if (holderIsDead(hpid)) {
          // Clear the dead holder AND drop the dir, then retry a fresh mkdir (atomic winner). Partial failure => contend.
          try { rmSync(path.join(dir, entries[0]!)); rmdirSync(dir); } catch { sleepMs(15); }
          continue;
        }
        sleepMs(15); continue; // live / inconclusive holder => contend, never steal
      }
      if (entries.length === 0) {
        if (strandedLocks.has(dir)) {
          // OUR OWN unfinished occupancy => adopt by publishing identity straight in (no remove/recreate gap), then verify sole.
          try { writeFileSync(mine, '', { mode: 0o600 }); } catch { sleepMs(15); continue; }
          let after: string[];
          try { after = readdirSync(dir); } catch { sleepMs(15); continue; }
          if (after.length === 1 && after[0] === token) { strandedLocks.delete(dir); return token; }
          try { rmSync(mine); } catch { /* best-effort back-off */ }
          sleepMs(15); continue;
        }
        sleepMs(15); continue; // EXTERNAL empty lock => contend, never adopt (SB1)
      }
      sleepMs(15); continue; // ambiguous (>1) => contend
    }
    // Won a fresh mkdir: publish identity inside.
    strandedLocks.delete(dir);
    try { writeFileSync(mine, '', { mode: 0o600 }); }
    catch (e) { strandedLocks.add(dir); throw e; } // empty dir is ours => recoverable on retry
    return token;
  }
  throw new Error(`shared-budget: could not acquire lock for pool ${name} within ${LOCK_TRIES} tries`);
}
function releaseLock(home: string, name: string, token: string): void {
  const dir = lockDir(home, name);
  let mineGone = false;
  try { if (existsSync(path.join(dir, token))) { rmSync(path.join(dir, token)); } mineGone = true; }
  catch { /* best-effort */ }
  // Drop the (now-empty) dir only if it is ours to drop; a failure strands it for in-process recovery (SB1).
  if (mineGone) {
    try { rmdirSync(dir); strandedLocks.delete(dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') strandedLocks.add(dir); }
  }
}
/** Run fn under the per-pool lock. fn's own errors PROPAGATE (SB4: not caught by the lock-contention handler in acquireLock). */
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
    && (o.reserveKey === undefined || (typeof o.reserveKey === 'string' && (o.reserveKey as string).length > 0))
    && (o.presumed === undefined || typeof o.presumed === 'boolean');
}
function validResShape(r: unknown): r is Reservation {
  const o = r as Record<string, unknown>;
  return !!o && typeof o.reserveKey === 'string' && o.reserveKey.length > 0 && typeof o.consumer === 'string' && o.consumer.length > 0
    && typeof o.estUsd === 'number' && Number.isFinite(o.estUsd) && o.estUsd >= 0
    && typeof o.estTokens === 'number' && Number.isInteger(o.estTokens) && o.estTokens >= 0
    && typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0
    && typeof o.atSec === 'number' && Number.isFinite(o.atSec);
}
function parsePoolState(raw: unknown, expectedName: string): PoolState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.poolName !== expectedName || !isValidPoolName(o.poolName)) return null; // SB2: body binds to requested name (defeats fs alias)
  let ceiling: PoolCeiling;
  try { ceiling = resolveCeiling(o.ceiling as PoolCeiling); } catch { return null; }
  if (!Array.isArray(o.draws)) return null;
  const reservationsRaw = o.reservations === undefined ? [] : o.reservations;
  if (!Array.isArray(reservationsRaw)) return null;
  const draws: PoolDraw[] = [];
  for (const d of o.draws) { if (!validDrawShape(d)) return null; draws.push(d); }
  const reservations: Reservation[] = [];
  for (const r of reservationsRaw) { if (!validResShape(r)) return null; reservations.push(r); }
  return { poolName: o.poolName, ceiling, draws, reservations };
}
/** FAIL-CLOSED read: ENOENT = absent (null); unparseable / invalid / name-mismatched all THROW — a corrupt ledger is NEVER
 *  treated as absent (which would re-grant a full ceiling, SB2). */
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

export function readPool(home: string, name: string): PoolState | null {
  return readPoolStrict(home, name);
}

/** Create a pool (idempotent). A corrupt ledger THROWS rather than being recreated at full ceiling (SB2). ALWAYS (re)writes the
 *  projection, so a replay after a projection-write fault repairs it (SB4). Coordinator action. */
export function createPool(home: string, name: string, ceiling: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const existing = readPoolStrict(home, name);
    const state = existing ?? emptyPool(name, ceiling);
    writeLedgerAndProjection(home, name, state); // SB4: write even for an existing pool (converge projection)
    return state;
  });
}

/** Admit + reserve atomically before dispatching a NEW unit (SB3 gate). null when the pool is absent (caller fail-closes). Settles
 *  vanished units first (never refunds). ALWAYS writes the projection (SB4: an idempotent replay still converges it). */
export function reservePool(home: string, name: string, res: Reservation): PoolAdmission | null {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) return null;
    const settled = settleExpiredReservations(read, isAlive, nowSec(), RESERVATION_TTL_SEC);
    const r = pureReserve(settled, res);
    writeLedgerAndProjection(home, name, r.state); // SB4: always (covers settle, the new reservation, and a pure replay)
    return r.ok ? { ok: true, remaining: remainingOf(r.state) } : { ok: false, exhausted: true, remaining: remainingOf(r.state) };
  });
}

/** Commit an actual spend (settles its own reservation). Idempotent by drawKey. ALWAYS re-writes the projection (SB4). Throws if
 *  the pool is absent. */
export function commitDraw(home: string, name: string, draw: PoolDraw): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist (create it first)`);
    const settled = settleExpiredReservations(read, isAlive, nowSec(), RESERVATION_TTL_SEC);
    const next = pureCommit(settled, draw);
    writeLedgerAndProjection(home, name, next);
    return next;
  });
}

/** Raise a pool's ceiling (coordinator-only — ruling 5; the money-gate is the CALLER's). */
export function raisePoolCeiling(home: string, name: string, next: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist`);
    const raised = pureRaiseCeiling(read, next);
    writeLedgerAndProjection(home, name, raised);
    return raised;
  });
}

/** List every pool's projection (console). Missing dir => empty. A corrupt pool is SKIPPED from the display list (never granted;
 *  the gate paths still throw on it). */
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
    try { state = readPoolStrict(home, name); } catch { continue; }
    if (state) out.push(project(state, nowSec()));
  }
  return out;
}
