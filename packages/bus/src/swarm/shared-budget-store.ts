/**
 * Shared-budget pool IO (DA2). Single-file optimistic CAS (coordinator ruling 1): the pool's accounted spend lives in one JSON
 * file, and every mutation runs under a short per-pool lock (atomic mkdir — the decision-batch family's lock idiom) so concurrent
 * consumers never lose an update (the whole point: N consumers must not each believe they hold the full ceiling). ENOENT = absent
 * (never folded onto a real read error, which THROWS). Reads need no lock. The projection (frozen budget-pool/v1 read contract)
 * is written atomically beside bandwidth-gauge after every mutation.
 *
 * dormant: this layer is standalone — it is NOT wired into fan-out (feat/fanout-native is still in review). The seam is marked at
 * the two interface points (admit before dispatch; recordDraw after a unit completes) in the design doc; actual wiring is a later
 * slice once fan-out merges.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  type PoolCeiling,
  type PoolDraw,
  type PoolState,
  type PoolAdmission,
  type BudgetPoolProjection,
  isValidPoolName,
  emptyPool,
  applyDraw,
  admit,
  raiseCeiling as raiseCeilingPure,
  project,
} from './shared-budget.js';

const budgetsDir = (home: string) => path.join(home, '.agenthop', 'budgets');
const projectionsDir = (home: string) => path.join(home, '.agenthop', 'console', 'budget-pools');

function assertName(name: string): void {
  if (!isValidPoolName(name)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(name)}`);
}
function poolFile(home: string, name: string): string {
  assertName(name);
  return path.join(budgetsDir(home), `${name}.json`);
}
function lockDir(home: string, name: string): string {
  return path.join(budgetsDir(home), `${name}.lock`);
}
function projectionFile(home: string, name: string): string {
  assertName(name);
  return path.join(projectionsDir(home), `${name}.json`);
}

// --- validation of the on-disk shape (readable-but-corrupt => null, like the family) ---
function validPoolState(raw: unknown): PoolState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.poolName !== 'string' || !isValidPoolName(o.poolName)) return null;
  const c = o.ceiling as Record<string, unknown> | undefined;
  if (!c || (typeof c.maxUsd !== 'number' && c.maxUsd !== null) || (typeof c.maxTokens !== 'number' && c.maxTokens !== null)) return null;
  if (!Array.isArray(o.draws)) return null;
  for (const d of o.draws) {
    const dd = d as Record<string, unknown>;
    if (typeof dd.drawKey !== 'string' || typeof dd.consumer !== 'string' || typeof dd.usd !== 'number' || typeof dd.tokens !== 'number' || typeof dd.atSec !== 'number') return null;
  }
  return { poolName: o.poolName, ceiling: { maxUsd: c.maxUsd as number | null, maxTokens: c.maxTokens as number | null }, draws: o.draws as PoolDraw[] };
}

function readJsonOrNull<T>(file: string, validate: (raw: unknown) => T | null): T | null {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } // ENOENT = absent; EACCES/... = real error
  try { return validate(JSON.parse(raw)); } catch { return null; } // readable-but-corrupt => null
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// --- per-pool lock (atomic mkdir; bounded spin; stale break) -------------------
const LOCK_STALE_MS = 10_000; // a lock dir older than this = a dead holder; break it
const LOCK_TRIES = 50;        // ~50 * 20ms = 1s max wait before giving up
function sleepMs(ms: number): void {
  // Synchronous sleep without a dependency: wait on a private SharedArrayBuffer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock<T>(home: string, name: string, fn: () => T): T {
  const dir = lockDir(home, name);
  mkdirSync(budgetsDir(home), { recursive: true, mode: 0o700 });
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      mkdirSync(dir); // atomic: succeeds only for the winner
      try { return fn(); } finally { try { rmdirSync(dir); } catch { /* best-effort */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Held: break it if stale (dead holder), else spin briefly and retry.
      try { if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) { rmdirSync(dir); continue; } } catch { /* vanished mid-check => retry */ }
      sleepMs(20);
    }
  }
  throw new Error(`shared-budget: could not acquire lock for pool ${name} within ${LOCK_TRIES} tries`);
}

// --- public API ---------------------------------------------------------------

/** Read a pool's state, or null if it does not exist. No lock (a torn read is impossible — writes are atomic rename). */
export function readPool(home: string, name: string): PoolState | null {
  return readJsonOrNull(poolFile(home, name), validPoolState);
}

/** Create a pool with a ceiling (idempotent: an existing pool is returned unchanged, never clobbered). Coordinator action. */
export function createPool(home: string, name: string, ceiling: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const existing = readPool(home, name);
    if (existing) return existing; // never clobber accrued draws
    const state = emptyPool(name, ceiling);
    writeJsonAtomic(poolFile(home, name), state);
    writeJsonAtomic(projectionFile(home, name), project(state, Math.floor(Date.now() / 1000)));
    return state;
  });
}

/** Admission for a consumer about to dispatch NEW work. Returns null when the pool does not exist (caller fail-closes:
 *  referencing an unknown pool grants no budget). No lock needed (read-only). */
export function admitPool(home: string, name: string): PoolAdmission | null {
  const state = readPool(home, name);
  return state ? admit(state) : null;
}

/** Record an actual spend under the CAS lock (idempotent by drawKey). Throws if the pool does not exist (create it first).
 *  Re-writes the projection. A draw that overshoots the ceiling is still recorded (ruling 2). */
export function recordDraw(home: string, name: string, draw: PoolDraw): PoolState {
  return withLock(home, name, () => {
    const state = readPool(home, name);
    if (!state) throw new Error(`shared-budget: pool ${name} does not exist (create it first)`);
    const next = applyDraw(state, draw);
    if (next !== state) {
      writeJsonAtomic(poolFile(home, name), next);
      writeJsonAtomic(projectionFile(home, name), project(next, Math.floor(Date.now() / 1000)));
    }
    return next;
  });
}

/** Raise a pool's ceiling (coordinator-only — ruling 5; the gate is the CALLER's, enforced at dispatch, not here). */
export function raisePoolCeiling(home: string, name: string, next: PoolCeiling): PoolState {
  return withLock(home, name, () => {
    const state = readPool(home, name);
    if (!state) throw new Error(`shared-budget: pool ${name} does not exist`);
    const raised = raiseCeilingPure(state, next);
    writeJsonAtomic(poolFile(home, name), raised);
    writeJsonAtomic(projectionFile(home, name), project(raised, Math.floor(Date.now() / 1000)));
    return raised;
  });
}

/** List every pool's projection (console). Missing dir => empty. */
export function listPoolProjections(home: string): BudgetPoolProjection[] {
  let names: string[];
  try { names = readdirSync(budgetsDir(home)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const out: BudgetPoolProjection[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    if (!isValidPoolName(name)) continue;
    const state = readPool(home, name);
    if (state) out.push(project(state, Math.floor(Date.now() / 1000)));
  }
  return out;
}
