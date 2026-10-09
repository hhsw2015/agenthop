import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCeiling, isValidPoolName, emptyPool, spentOf, inflightOf, remainingOf, isExhausted, reserve, commit, applyDraw,
  raiseCeiling, settleExpiredReservations, project, type Reservation, type PoolDraw,
} from './shared-budget.js';
import {
  createPool, readPool, reservePool, commitDraw, raisePoolCeiling, listPoolProjections,
} from './shared-budget-store.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };
const threw = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const now = () => Math.floor(Date.now() / 1000);
const res = (o: Partial<Reservation> = {}): Reservation => ({ reserveKey: 'r1', consumer: 'c1', estUsd: 10, estTokens: 0, pid: process.pid, atSec: now(), ...o });
const drw = (o: Partial<PoolDraw> = {}): PoolDraw => ({ drawKey: 'd1', consumer: 'c1', usd: 1, tokens: 100, atSec: 10, ...o });

// ---------------- pure core ----------------
t('isValidPoolName accepts safe, rejects traversal/space/empty', isValidPoolName('p_1-A') && !isValidPoolName('../x') && !isValidPoolName('a b') && !isValidPoolName(''));
t('resolveCeiling rejects both null / negative / non-int tokens', threw(() => resolveCeiling({ maxUsd: null, maxTokens: null })) && threw(() => resolveCeiling({ maxUsd: -1, maxTokens: null })) && threw(() => resolveCeiling({ maxUsd: null, maxTokens: 1.5 })));

// SB3: admission counts in-flight -> overshoot bounded by ONE ticket.
const p0 = emptyPool('camp', { maxUsd: 10, maxTokens: null });
const rA = reserve(p0, res({ reserveKey: 'a', estUsd: 10 }));
t('SB3: first reserve admitted, inflight=10', rA.ok && inflightOf(rA.state).usd === 10);
t('SB3: second reserve REFUSED (spent+inflight >= ceiling)', reserve(rA.state, res({ reserveKey: 'b', estUsd: 10 })).ok === false);
t('SB3: reserve idempotent by reserveKey', reserve(rA.state, res({ reserveKey: 'a', estUsd: 10 })).state === rA.state);

// commit settles OWN reservation; actual can differ from estimate.
const big = emptyPool('big', { maxUsd: 100, maxTokens: null });
let s = reserve(big, res({ reserveKey: 'A', consumer: 'cA', estUsd: 10 })).state;
s = reserve(s, res({ reserveKey: 'B', consumer: 'cB', estUsd: 10 })).state;
const sCommit = commit(s, drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'cA', usd: 4, tokens: 0 }));
t('commit settles own reservation (A gone, B kept), books actual 4', spentOf(sCommit).usd === 4 && sCommit.reservations.length === 1 && sCommit.reservations[0].reserveKey === 'B');

// SB3/R2: idempotent real-drawKey replay is a pure no-op — strips NO reservation.
t('SB3/R2: commit replay of a committed drawKey strips nothing', commit(sCommit, drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'cA', usd: 4 })) === sCommit);
// SB3/R2: a cross-consumer commit does NOT clear another consumer's reservation.
const xCommit = commit(sCommit, drw({ drawKey: 'dX', reserveKey: 'B', consumer: 'cEVIL', usd: 1 }));
t('SB3/R2: cross-consumer commit cannot clear B (ownership)', xCommit.reservations.some((r) => r.reserveKey === 'B'));

// SB3/R2: a vanished reservation is SETTLED to a presumed estimate, never refunded — bound holds.
const exhausted = reserve(emptyPool('ex', { maxUsd: 10, maxTokens: null }), res({ reserveKey: 'g', estUsd: 10 })).state;
const settledDead = settleExpiredReservations(exhausted, () => false, now(), 3600);
t('SB3/R2: dead reservation settled to presumed (not refunded), still exhausted', settledDead.reservations.length === 0 && spentOf(settledDead).usd === 10 && isExhausted(settledDead) && settledDead.draws[0].presumed === true);
t('SB3/R2: after settle, a new reserve is STILL refused (no headroom refunded)', reserve(settledDead, res({ reserveKey: 'h', estUsd: 1 })).ok === false);
// reconcile: the real unit later commits its actual -> presumed estimate replaced.
const reconciled = commit(settledDead, drw({ drawKey: 'real-g', reserveKey: 'g', consumer: 'c1', usd: 3, tokens: 0 }));
t('SB3/R2: real commit reconciles the presumed estimate down to actual', spentOf(reconciled).usd === 3 && !reconciled.draws.some((d) => d.presumed));
// TTL settlement even if pid alive
const ttlSettled = settleExpiredReservations(exhausted, () => true, now() + 3601, 3600);
t('settle: TTL-expired reservation settled even if pid alive', ttlSettled.reservations.length === 0 && ttlSettled.draws[0].presumed === true);
t('settle: live + fresh reservation untouched', settleExpiredReservations(exhausted, () => true, now(), 3600) === exhausted);

t('raiseCeiling reopens, refuses lower', reserve(raiseCeiling(settledDead, { maxUsd: 100, maxTokens: null }), res({ reserveKey: 'z', estUsd: 1 })).ok && threw(() => raiseCeiling(settledDead, { maxUsd: 1, maxTokens: null })));
t('project shape incl inflight + reservationCount', (() => { const p = project(sCommit, 999); return p.schema === 'budget-pool/v1' && p.inflight.usd === 10 && p.reservationCount === 1 && p.drawCount === 1; })());
t('applyDraw == direct commit', applyDraw(p0, drw()).draws.length === 1);

// SB2: write-side validation of the optional fields.
t('SB2: commit rejects non-string reserveKey', threw(() => commit(p0, drw({ reserveKey: 7 as unknown as string }))));
t('SB2: commit rejects non-boolean presumed', threw(() => commit(p0, drw({ presumed: 'yes' as unknown as boolean }))));

// ---------------- store round-trip + review regressions ----------------
const home = mkdtempSync(join(tmpdir(), 'sb-'));
try {
  // SB5
  t('SB5: traversal names rejected before any fs op', threw(() => createPool(home, '../../evil', { maxUsd: 1, maxTokens: null })) && threw(() => reservePool(home, '../x', res())) && !existsSync(join(home, 'evil.lock')));

  t('reservePool null when absent (fail-closed)', reservePool(home, 'none', res()) === null);
  t('commitDraw throws on absent pool', threw(() => commitDraw(home, 'none', drw())));

  createPool(home, 'camp', { maxUsd: 10, maxTokens: null });
  const a = reservePool(home, 'camp', res({ reserveKey: 'A', consumer: 'runA', estUsd: 10 }));
  t('SB3 store: first reserved', a!.ok === true);
  t('SB3 store: second REFUSED (in-flight counted)', reservePool(home, 'camp', res({ reserveKey: 'B', consumer: 'runB', estUsd: 10 }))!.ok === false);
  commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 }));
  t('SB3 store: after commit (3<10), headroom reopens; spent=3', reservePool(home, 'camp', res({ reserveKey: 'C', consumer: 'runC', estUsd: 5 }))!.ok === true && spentOf(readPool(home, 'camp')!).usd === 3);

  // SB4: EVERY mutation converges the projection — even an idempotent reserve/create replay repairs a lost projection.
  const projFile = join(home, '.agenthop', 'console', 'budget-pools', 'camp.json');
  rmSync(projFile);
  reservePool(home, 'camp', res({ reserveKey: 'C', consumer: 'runC', estUsd: 5 })); // idempotent reserve replay
  t('SB4: idempotent reserve replay repairs the projection', existsSync(projFile));
  rmSync(projFile);
  createPool(home, 'camp', { maxUsd: 10, maxTokens: null }); // existing-pool create replay
  t('SB4: existing-pool create replay repairs the projection', existsSync(projFile));
  rmSync(projFile);
  commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 })); // idempotent commit replay
  t('SB4: idempotent commit replay repairs the projection (spent=3)', existsSync(projFile) && JSON.parse(readFileSync(projFile, 'utf8')).spent.usd === 3);

  // SB2: an invalid optional field is rejected at the write boundary; the stored ledger stays readable.
  t('SB2: commitDraw rejects reserveKey=7 (throws)', threw(() => commitDraw(home, 'camp', drw({ drawKey: 'bad', reserveKey: 7 as unknown as string }))));
  t('SB2: ledger still readable after the rejected write', readPool(home, 'camp') !== null);
  // SB2: corrupt / double-null / negative / alias all fail-closed.
  const campFile = join(home, '.agenthop', 'budgets', 'camp.json');
  writeFileSync(campFile, '{not json');
  t('SB2: corrupt ledger -> readPool throws, createPool refuses to recreate', threw(() => readPool(home, 'camp')) && threw(() => createPool(home, 'camp', { maxUsd: 10, maxTokens: null })));
  writeFileSync(campFile, JSON.stringify({ poolName: 'Camp', ceiling: { maxUsd: 100, maxTokens: null }, draws: [], reservations: [] }));
  t('SB2: body poolName mismatch rejected (fs alias defeated)', threw(() => readPool(home, 'camp')));

  // SB1: a DEAD-pid lock is reclaimed (ESRCH); an INVALID-credential lock is NOT broken (contends -> throws fast under low tries).
  const fresh = mkdtempSync(join(tmpdir(), 'sb1-'));
  try {
    createPool(fresh, 'lk', { maxUsd: 100, maxTokens: null });
    const lock = join(fresh, '.agenthop', 'budgets', 'lk.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, '2147483647.dead'), ''); // a pid that is not a live process
    t('SB1: dead-pid lock reclaimed, reserve proceeds', reservePool(fresh, 'lk', res({ reserveKey: 'ok', estUsd: 1 }))!.ok === true);

    process.env.SHARED_BUDGET_LOCK_TRIES = '3'; // fast contention
    const lock2 = join(fresh, '.agenthop', 'budgets', 'lk.lock');
    mkdirSync(lock2, { recursive: true });
    writeFileSync(join(lock2, '0.bogus'), ''); // pid 0 = invalid credential -> must NOT authorize a break
    t('SB1/R2: invalid-credential lock is NOT stolen (contends then throws)', threw(() => reservePool(fresh, 'lk', res({ reserveKey: 'nope', estUsd: 1 }))));
    delete process.env.SHARED_BUDGET_LOCK_TRIES;
  } finally { rmSync(fresh, { recursive: true, force: true }); }

  createPool(home, 'c2', { maxUsd: 5, maxTokens: null });
  reservePool(home, 'c2', res({ reserveKey: 'X', estUsd: 5 }));
  t('c2 exhausted, raise reopens', reservePool(home, 'c2', res({ reserveKey: 'Y', estUsd: 1 }))!.ok === false && (raisePoolCeiling(home, 'c2', { maxUsd: 100, maxTokens: null }), reservePool(home, 'c2', res({ reserveKey: 'Z', estUsd: 1 }))!.ok === true));
  t('listPoolProjections skips corrupt camp, lists c2', (() => { const l = listPoolProjections(home); return l.some((p) => p.poolName === 'c2') && !l.some((p) => p.poolName === 'camp'); })());
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('\nshared-budget self-check OK');
