/**
 * Shared-budget pool IO (DA2, review fixes through DA2-R3). Single-file optimistic CAS: the pool ledger (committed draws +
 * reservations) lives in one JSON file, mutated only under a per-pool HOLDER-IDENTITY lock.
 *   SB1 — break only on a definitive ESRCH (dead holder); an invalid/out-of-range pid or any inconclusive probe never authorizes a
 *         break; unknown external locks (held or empty) stay contended; a lock this process stranded on a release fault — whether it
 *         left OUR credential file behind OR an empty dir — is tracked in-process and reclaimed on retry (SB1/R3). The retry budget
 *         is bounded: an invalid SHARED_BUDGET_LOCK_TRIES (Infinity / NaN / <=0) falls back to the finite default (SB1/R3).
 *   SB2 — write-side validation of optional fields, so a mutation can't persist a ledger the same-version reader rejects.
 *   SB3 — admission (reserve) counts committed + in-flight; a vanished reservation is MARKED settled (liability retained), never
 *         refunded; commit settles only its own consumer's reservation and is a no-op on a committed drawKey.
 *   SB4 — every successful mutation (create / reserve / commit / raise), incl. idempotent replays, re-writes the projection.
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

const RESERVATION_TTL_SEC = 3600;
const DEFAULT_LOCK_TRIES = 200; // ~200 * 15ms = 3s
/** Bounded retry budget, read at call-time. An invalid env (Infinity / NaN / <=0 / too large) falls back to the finite default
 *  so the contention loop always terminates (SB1/R3). */
function lockTries(): number {
  const n = Number(process.env.SHARED_BUDGET_LOCK_TRIES);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : DEFAULT_LOCK_TRIES;
}
const nowSec = () => Math.floor(Date.now() / 1000);

const budgetsDir = (home: string) => path.join(home, '.agenthop', 'budgets');
const projectionsDir = (home: string) => path.join(home, '.agenthop', 'console', 'budget-pools');

function assertName(name: string): void {
  if (!isValidPoolName(name)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(name)}`);
}
function poolFile(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.json`); }
function lockDir(home: string, name: string): string { return path.join(budgetsDir(home), `${name}.lock`); }
function projectionFile(home: string, name: string): string { return path.join(projectionsDir(home), `${name}.json`); }

/** Definitively dead? ONLY a validated pid probing to ESRCH authorizes a break (SB1). Invalid/out-of-range pid, EPERM (alive),
 *  or any other/unknown error => NOT dead => contend, never steal. */
function holderIsDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
const isAlive = (pid: number) => !holderIsDead(pid);

function sleepMs(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Self-stranded state this process must recover (SB1/R3): a credential file we could not remove, and an empty dir we could not drop.
const strandedCreds = new Set<string>(); // `${dir}\0${token}`
const strandedEmpty = new Set<string>(); // dir

// --- holder-identity lock (SB1/SB5) -------------------------------------------
function publishSole(dir: string, mine: string, token: string): boolean {
  // Publish our identity, then verify we are the SOLE holder (loses a race safely).
  try { writeFileSync(mine, '', { mode: 0o600 }); } catch { return false; }
  let after: string[];
  try { after = readdirSync(dir); } catch { try { rmSync(mine); } catch { /* */ } return false; }
  if (after.length === 1 && after[0] === token) return true;
  try { rmSync(mine); } catch { /* best-effort back-off */ }
  return false;
}
function acquireLock(home: string, name: string): string {
  assertName(name); // SB5: before any path op
  const dir = lockDir(home, name);
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const mine = path.join(dir, token);
  mkdirSync(budgetsDir(home), { recursive: true, mode: 0o700 });
  const tries = lockTries();
  for (let i = 0; i < tries; i++) {
    try { mkdirSync(dir); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { sleepMs(15); continue; }
      if (entries.length === 1) {
        const holder = entries[0]!;
        if (strandedCreds.has(`${dir}\0${holder}`)) {
          // OUR OWN leftover credential (a prior release fault) => reclaim it, then adopt the dir.
          try { rmSync(path.join(dir, holder)); strandedCreds.delete(`${dir}\0${holder}`); } catch { sleepMs(15); continue; }
          if (publishSole(dir, mine, token)) { strandedEmpty.delete(dir); return token; }
          sleepMs(15); continue;
        }
        if (holderIsDead(Number(holder.split('.')[0]))) {
          try { rmSync(path.join(dir, holder)); rmdirSync(dir); } catch { sleepMs(15); }
          continue;
        }
        sleepMs(15); continue; // live / inconclusive foreign holder => contend
      }
      if (entries.length === 0) {
        if (strandedEmpty.has(dir)) { // OUR OWN stranded empty dir => adopt
          if (publishSole(dir, mine, token)) { strandedEmpty.delete(dir); return token; }
          sleepMs(15); continue;
        }
        sleepMs(15); continue; // external empty => contend
      }
      sleepMs(15); continue; // ambiguous (>1) => contend
    }
    // Won a fresh mkdir.
    strandedEmpty.delete(dir);
    try { writeFileSync(mine, '', { mode: 0o600 }); }
    catch (e) { strandedEmpty.add(dir); throw e; }
    return token;
  }
  throw new Error(`shared-budget: could not acquire lock for pool ${name} within ${tries} tries`);
}
function releaseLock(home: string, name: string, token: string): void {
  const dir = lockDir(home, name);
  const mine = path.join(dir, token);
  try { if (existsSync(mine)) rmSync(mine); }
  catch { strandedCreds.add(`${dir}\0${token}`); return; } // our credential lingers => reclaim on retry (SB1/R3)
  try { rmdirSync(dir); strandedEmpty.delete(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') strandedEmpty.add(dir); }
}
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
    && (o.reserveKey === undefined || (typeof o.reserveKey === 'string' && (o.reserveKey as string).length > 0));
}
function validResShape(r: unknown): r is Reservation {
  const o = r as Record<string, unknown>;
  return !!o && typeof o.reserveKey === 'string' && o.reserveKey.length > 0 && typeof o.consumer === 'string' && o.consumer.length > 0
    && typeof o.estUsd === 'number' && Number.isFinite(o.estUsd) && o.estUsd >= 0
    && typeof o.estTokens === 'number' && Number.isInteger(o.estTokens) && o.estTokens >= 0
    && typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0
    && typeof o.atSec === 'number' && Number.isFinite(o.atSec)
    && (o.settled === undefined || typeof o.settled === 'boolean');
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

export function createPool(home: string, name: string, ceiling: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const existing = readPoolStrict(home, name);
    const state = existing ?? emptyPool(name, ceiling);
    writeLedgerAndProjection(home, name, state); // SB4: write even for an existing pool (converge projection)
    return state;
  });
}

export function reservePool(home: string, name: string, res: Reservation): PoolAdmission | null {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) return null;
    const settled = settleExpiredReservations(read, isAlive, nowSec(), RESERVATION_TTL_SEC);
    const r = pureReserve(settled, res);
    writeLedgerAndProjection(home, name, r.state); // SB4: always
    return r.ok ? { ok: true, remaining: remainingOf(r.state) } : { ok: false, exhausted: true, remaining: remainingOf(r.state) };
  });
}

export function commitDraw(home: string, name: string, draw: PoolDraw): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist (create it first)`);
    const settled = settleExpiredReservations(read, isAlive, nowSec(), RESERVATION_TTL_SEC);
    const next = pureCommit(settled, draw);
    writeLedgerAndProjection(home, name, next); // SB4: always
    return next;
  });
}

export function raisePoolCeiling(home: string, name: string, next: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const read = readPoolStrict(home, name);
    if (!read) throw new Error(`shared-budget: pool ${name} does not exist`);
    const raised = pureRaiseCeiling(read, next);
    writeLedgerAndProjection(home, name, raised);
    return raised;
  });
}

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
