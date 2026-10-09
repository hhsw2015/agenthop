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
const DEADPID = 2147483647; // max 32-bit pid: not a live process -> probes ESRCH
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

// commit settles OWN reservation only; books actual.
let s = reserve(emptyPool('big', { maxUsd: 100, maxTokens: null }), res({ reserveKey: 'A', consumer: 'cA', estUsd: 10 })).state;
s = reserve(s, res({ reserveKey: 'B', consumer: 'cB', estUsd: 10 })).state;
const sC = commit(s, drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'cA', usd: 4, tokens: 0 }));
t('commit settles own reservation (A gone, B kept), books actual 4', spentOf(sC).usd === 4 && sC.reservations.length === 1 && sC.reservations[0].reserveKey === 'B');
t('SB3/R3: commit replay of a committed drawKey strips nothing', commit(sC, drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'cA', usd: 4 })) === sC);
t('SB3/R3: cross-consumer commit cannot clear B (ownership)', commit(sC, drw({ drawKey: 'dX', reserveKey: 'B', consumer: 'cEVIL', usd: 1 })).reservations.some((r) => r.reserveKey === 'B'));

// SB3/R3: a vanished reservation is MARKED settled (liability retained), never dropped or converted to a draw.
const exhausted = reserve(emptyPool('ex', { maxUsd: 10, maxTokens: null }), res({ reserveKey: 'g', consumer: 'cg', estUsd: 10 })).state;
const settled = settleExpiredReservations(exhausted, () => false, now(), 3600);
t('SB3/R3: dead reservation flagged settled, NOT dropped, NOT a draw', settled.reservations.length === 1 && settled.reservations[0].settled === true && settled.draws.length === 0);
t('SB3/R3: settled liability still counted (inflight=10, exhausted, no refund)', inflightOf(settled).usd === 10 && isExhausted(settled) && reserve(settled, res({ reserveKey: 'h', estUsd: 1 })).ok === false);
t('SB3/R3: settle never reduces reservation count (no double-sample drop)', settleExpiredReservations(settled, () => true, now(), 3600) === settled && settleExpiredReservations(exhausted, () => false, now(), 3600).reservations.length === 1);
// reconcile: the real owner commits its actual -> settled reservation removed, actual booked.
const reconciled = commit(settled, drw({ drawKey: 'real-g', reserveKey: 'g', consumer: 'cg', usd: 3, tokens: 0 }));
t('SB3/R3: owner commit reconciles settled estimate to actual', spentOf(reconciled).usd === 3 && reconciled.reservations.length === 0);
t('SB3/R3: cross-consumer commit cannot clear a SETTLED reservation', commit(settled, drw({ drawKey: 'x2', reserveKey: 'g', consumer: 'cEVIL', usd: 1 })).reservations.some((r) => r.reserveKey === 'g'));
t('settle idempotent (already-settled unchanged)', settleExpiredReservations(settled, () => false, now(), 3600) === settled);

t('raiseCeiling reopens, refuses lower', reserve(raiseCeiling(settled, { maxUsd: 100, maxTokens: null }), res({ reserveKey: 'z', estUsd: 1 })).ok && threw(() => raiseCeiling(settled, { maxUsd: 1, maxTokens: null })));
t('project shape incl inflight + settledCount', (() => { const p = project(settled, 9); return p.schema === 'budget-pool/v1' && p.inflight.usd === 10 && p.reservationCount === 1 && p.settledCount === 1 && p.drawCount === 0; })());
t('applyDraw == direct commit', applyDraw(p0, drw()).draws.length === 1);
t('SB2: commit rejects non-string reserveKey', threw(() => commit(p0, drw({ reserveKey: 7 as unknown as string }))));

// ---------------- store round-trip + review regressions ----------------
const home = mkdtempSync(join(tmpdir(), 'sb-'));
try {
  t('SB5: traversal names rejected before any fs op', threw(() => createPool(home, '../../evil', { maxUsd: 1, maxTokens: null })) && threw(() => reservePool(home, '../x', res())) && !existsSync(join(home, 'evil.lock')));
  t('reservePool null when absent (fail-closed)', reservePool(home, 'none', res()) === null);
  t('commitDraw throws on absent pool', threw(() => commitDraw(home, 'none', drw())));

  createPool(home, 'camp', { maxUsd: 10, maxTokens: null });
  t('SB3 store: first reserved', reservePool(home, 'camp', res({ reserveKey: 'A', consumer: 'runA', estUsd: 10 }))!.ok === true);
  t('SB3 store: second REFUSED (in-flight counted)', reservePool(home, 'camp', res({ reserveKey: 'B', consumer: 'runB', estUsd: 10 }))!.ok === false);
  commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 }));
  t('SB3 store: after commit (3<10), headroom reopens; spent=3', reservePool(home, 'camp', res({ reserveKey: 'C', consumer: 'runC', estUsd: 5 }))!.ok === true && spentOf(readPool(home, 'camp')!).usd === 3);

  // SB3 store: a dead-owner reservation is settled (not refunded) across store calls.
  createPool(home, 'dp', { maxUsd: 10, maxTokens: null });
  reservePool(home, 'dp', res({ reserveKey: 'D', consumer: 'rd', estUsd: 10, pid: DEADPID }));
  t('SB3 store: dead-owner reservation does NOT refund (still refused)', reservePool(home, 'dp', res({ reserveKey: 'E', estUsd: 1 }))!.ok === false && readPool(home, 'dp')!.reservations[0].settled === true);
  commitDraw(home, 'dp', drw({ drawKey: 'realD', reserveKey: 'D', consumer: 'rd', usd: 2, tokens: 0 }));
  t('SB3 store: owner reconciles settled -> spent=2, headroom back', spentOf(readPool(home, 'dp')!).usd === 2 && reservePool(home, 'dp', res({ reserveKey: 'F', estUsd: 1 }))!.ok === true);

  // SB4: every mutation (create/reserve/commit) repairs the projection on replay.
  const projFile = join(home, '.agenthop', 'console', 'budget-pools', 'camp.json');
  rmSync(projFile); reservePool(home, 'camp', res({ reserveKey: 'C', consumer: 'runC', estUsd: 5 })); t('SB4: idempotent reserve replay repairs projection', existsSync(projFile));
  rmSync(projFile); createPool(home, 'camp', { maxUsd: 10, maxTokens: null }); t('SB4: existing-pool create replay repairs projection', existsSync(projFile));
  rmSync(projFile); commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 })); t('SB4: idempotent commit replay repairs projection', existsSync(projFile) && JSON.parse(readFileSync(projFile, 'utf8')).spent.usd === 3);

  // SB2: invalid optional field rejected at write; ledger stays readable; corrupt/alias fail-closed.
  t('SB2: commitDraw rejects reserveKey=7', threw(() => commitDraw(home, 'camp', drw({ drawKey: 'bad', reserveKey: 7 as unknown as string }))) && readPool(home, 'camp') !== null);
  const campFile = join(home, '.agenthop', 'budgets', 'camp.json');
  writeFileSync(campFile, '{not json');
  t('SB2: corrupt -> readPool throws, createPool refuses recreate', threw(() => readPool(home, 'camp')) && threw(() => createPool(home, 'camp', { maxUsd: 10, maxTokens: null })));
  writeFileSync(campFile, JSON.stringify({ poolName: 'Camp', ceiling: { maxUsd: 100, maxTokens: null }, draws: [], reservations: [] }));
  t('SB2: body poolName mismatch rejected (fs alias defeated)', threw(() => readPool(home, 'camp')));

  // SB1: dead-pid lock reclaimed; invalid credential NOT stolen; retry budget bounded even with env=Infinity.
  const fresh = mkdtempSync(join(tmpdir(), 'sb1-'));
  try {
    createPool(fresh, 'lk', { maxUsd: 100, maxTokens: null });
    const lock = join(fresh, '.agenthop', 'budgets', 'lk.lock');
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, `${DEADPID}.dead`), '');
    t('SB1: dead-pid lock reclaimed, reserve proceeds', reservePool(fresh, 'lk', res({ reserveKey: 'ok', estUsd: 1 }))!.ok === true);
    process.env.SHARED_BUDGET_LOCK_TRIES = '3';
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, '0.bogus'), ''); // pid 0 = invalid credential
    t('SB1/R3: invalid-credential lock NOT stolen (contends then throws, bounded)', threw(() => reservePool(fresh, 'lk', res({ reserveKey: 'no', estUsd: 1 }))));
    process.env.SHARED_BUDGET_LOCK_TRIES = 'Infinity'; // SB1/R3: must fall back to a finite default, not loop forever
    t('SB1/R3: env=Infinity is bounded (reserve still terminates by throwing)', threw(() => reservePool(fresh, 'lk', res({ reserveKey: 'no2', estUsd: 1 }))));
    // SB1/R6 (reclaim boundary): an out-of-range pid credential passes Number.isInteger/>0, but process.kill throws a NON-ESRCH
    // error (ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE) — NOT proof of death ⇒ the external credential is NOT stolen (contends, then
    // throws, bounded). Only a definite ESRCH authorizes reclaiming an external holder.
    rmSync(lock, { recursive: true, force: true }); mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, '999999999999999999999.bad'), '');
    process.env.SHARED_BUDGET_LOCK_TRIES = '3';
    t('SB1/R6: out-of-range pid credential NOT stolen (non-ESRCH probe error is not death)', threw(() => reservePool(fresh, 'lk', res({ reserveKey: 'nor', estUsd: 1 }))));
    // SB1/R6 (release-path residue): OUR OWN leftover credential (a faulted release left it; the in-process stranded set is empty
    // — e.g. existsSync(mine) returned false under a real EACCES) is reclaimed by pid-in-filename on the next acquire, NOT taken
    // for a live external holder (our pid IS alive) and contended to timeout. Before R6 this threw within the retry budget; the
    // shared holder-lock reclaims it because hpid === process.pid.
    createPool(fresh, 'resid', { maxUsd: 100, maxTokens: null });
    const rlock = join(fresh, '.agenthop', 'budgets', 'resid.lock');
    mkdirSync(rlock, { recursive: true }); writeFileSync(join(rlock, `${process.pid}.stale`), '');
    process.env.SHARED_BUDGET_LOCK_TRIES = '3'; // old behavior would contend→throw within 3 tries; the fix reclaims on the first
    t('SB1/R6: own stranded credential reclaimed by pid, not contended to timeout', reservePool(fresh, 'resid', res({ reserveKey: 'ok', estUsd: 1 }))!.ok === true);
    delete process.env.SHARED_BUDGET_LOCK_TRIES;
  } finally { rmSync(fresh, { recursive: true, force: true }); }

  createPool(home, 'c2', { maxUsd: 5, maxTokens: null });
  reservePool(home, 'c2', res({ reserveKey: 'X', estUsd: 5 }));
  t('c2 exhausted, raise reopens', reservePool(home, 'c2', res({ reserveKey: 'Y', estUsd: 1 }))!.ok === false && (raisePoolCeiling(home, 'c2', { maxUsd: 100, maxTokens: null }), reservePool(home, 'c2', res({ reserveKey: 'Z', estUsd: 1 }))!.ok === true));
  t('listPoolProjections skips corrupt camp, lists c2+dp', (() => { const l = listPoolProjections(home); return l.some((p) => p.poolName === 'c2') && l.some((p) => p.poolName === 'dp') && !l.some((p) => p.poolName === 'camp'); })());
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('\nshared-budget self-check OK');
