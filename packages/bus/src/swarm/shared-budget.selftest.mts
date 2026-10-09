import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCeiling, isValidPoolName, emptyPool, spentOf, inflightOf, remainingOf, isExhausted, reserve, commit, applyDraw,
  raiseCeiling, pruneStaleReservations, project, type Reservation, type PoolDraw,
} from './shared-budget.js';
import {
  createPool, readPool, reservePool, commitDraw, raisePoolCeiling, listPoolProjections,
} from './shared-budget-store.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };
const threw = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
// Default atSec = now so store-path reservations aren't TTL-reclaimed (the store prunes against the real wall clock). Pure-core
// tests that exercise pruning pass an explicit atSec + injected nowSec.
const res = (o: Partial<Reservation> = {}): Reservation => ({ reserveKey: 'r1', consumer: 'c1', estUsd: 10, estTokens: 0, pid: process.pid, atSec: Math.floor(Date.now() / 1000), ...o });
const drw = (o: Partial<PoolDraw> = {}): PoolDraw => ({ drawKey: 'd1', consumer: 'c1', usd: 1, tokens: 100, atSec: 10, ...o });

// ---------------- pure core ----------------
t('isValidPoolName accepts safe, rejects traversal/space/empty', isValidPoolName('p_1-A') && !isValidPoolName('../x') && !isValidPoolName('a b') && !isValidPoolName(''));
t('resolveCeiling rejects both null / negative / non-int tokens', threw(() => resolveCeiling({ maxUsd: null, maxTokens: null })) && threw(() => resolveCeiling({ maxUsd: -1, maxTokens: null })) && threw(() => resolveCeiling({ maxUsd: null, maxTokens: 1.5 })));

const p0 = emptyPool('camp', { maxUsd: 10, maxTokens: null });
t('empty pool: 0 spent, 0 inflight, admits reserve', spentOf(p0).usd === 0 && inflightOf(p0).usd === 0 && reserve(p0, res()).ok);

// SB3: admission counts in-flight -> overshoot bounded by ONE ticket regardless of consumer count.
let s = p0;
const r1 = reserve(s, res({ reserveKey: 'a', estUsd: 10 })); s = r1.state;
t('SB3: first reserve (est 10) admitted on a $10 pool', r1.ok && inflightOf(s).usd === 10);
const r2 = reserve(s, res({ reserveKey: 'b', estUsd: 10 }));
t('SB3: second reserve REFUSED (spent+inflight >= ceiling) — not unbounded', r2.ok === false && (r2 as { exhausted?: boolean }).exhausted === true);
t('SB3: reserve idempotent by reserveKey', reserve(s, res({ reserveKey: 'a', estUsd: 10 })).state === s);

// commit settles the reservation: inflight falls, committed rises (actual can differ from estimate).
const c1 = commit(s, drw({ drawKey: 'da', reserveKey: 'a', usd: 4, tokens: 0 }));
t('commit settles reservation (inflight 10 -> 0) and books actual', inflightOf(c1).usd === 0 && spentOf(c1).usd === 4);
t('commit idempotent by drawKey', commit(c1, drw({ drawKey: 'da', reserveKey: 'a', usd: 4 })).draws.length === 1);
t('after commit, a fresh reserve admits again (headroom reopened)', reserve(c1, res({ reserveKey: 'c', estUsd: 5 })).ok);

// exhaustion via tokens (committed+inflight), ruling 3
const pTok = reserve(emptyPool('tk', { maxUsd: null, maxTokens: 500 }), res({ estTokens: 500, estUsd: 0 })).state;
t('exhausted when tokens dimension reaches ceiling', isExhausted(pTok));

// overshoot is recorded, never hidden (a committed draw past ceiling still books)
const pOver = commit(emptyPool('ov', { maxUsd: 5, maxTokens: null }), drw({ usd: 9, tokens: 0 }));
t('overshoot committed and shown (spent 9 > ceiling 5, remaining 0, exhausted)', spentOf(pOver).usd === 9 && remainingOf(pOver).usd === 0 && isExhausted(pOver));

// stale reservation reclaim (pid dead OR ttl)
const withRes = reserve(emptyPool('st', { maxUsd: 100, maxTokens: null }), res({ reserveKey: 'live', pid: process.pid, atSec: 1000 })).state;
const deadGone = pruneStaleReservations(withRes, () => false, 1000, 3600);
t('prune drops a dead-pid reservation', deadGone.reservations.length === 0);
const ttlGone = pruneStaleReservations(withRes, () => true, 1000 + 3601, 3600);
t('prune drops a TTL-expired reservation even if pid alive', ttlGone.reservations.length === 0);
t('prune keeps a live + fresh reservation', pruneStaleReservations(withRes, () => true, 1000, 3600).reservations.length === 1);

t('raiseCeiling reopens an exhausted pool, refuses to lower', reserve(raiseCeiling(pTok, { maxUsd: null, maxTokens: 2000 }), res({ estTokens: 1, estUsd: 0, reserveKey: 'z' })).ok && threw(() => raiseCeiling(pTok, { maxUsd: null, maxTokens: 10 })));

const proj = project(c1, 999);
t('project shape incl inflight + reservationCount', proj.schema === 'budget-pool/v1' && proj.generatedAtSec === 999 && proj.drawCount === 1 && proj.reservationCount === 0 && proj.inflight.usd === 0);
t('applyDraw == direct commit (idempotent)', applyDraw(p0, drw()).draws.length === 1);

// ---------------- store round-trip + review-finding regressions ----------------
const home = mkdtempSync(join(tmpdir(), 'sb-'));
try {
  // SB5: invalid name validated BEFORE any fs op — no lock created outside budgets dir.
  t('SB5: createPool rejects traversal name (throws)', threw(() => createPool(home, '../../evil', { maxUsd: 1, maxTokens: null })));
  t('SB5: reservePool rejects traversal name (throws)', threw(() => reservePool(home, '../x', res())));
  t('SB5: no stray lock dir created outside budgets', !existsSync(join(home, '.agenthop', 'evil.lock')) && !existsSync(join(home, 'evil.lock')));

  // fail-closed absence vs the reserve gate
  t('reservePool null when pool absent (fail-closed)', reservePool(home, 'none', res()) === null);
  t('commitDraw throws on absent pool', threw(() => commitDraw(home, 'none', drw())));

  const created = createPool(home, 'camp', { maxUsd: 10, maxTokens: null });
  t('createPool writes a fresh pool', created.draws.length === 0 && readPool(home, 'camp') !== null);

  // SB3 store: reserve bounds overshoot across consumers.
  const a = reservePool(home, 'camp', res({ reserveKey: 'A', consumer: 'runA', estUsd: 10 }));
  t('SB3 store: first consumer reserved', a!.ok === true);
  const b = reservePool(home, 'camp', res({ reserveKey: 'B', consumer: 'runB', estUsd: 10 }));
  t('SB3 store: second consumer REFUSED (in-flight counted)', b!.ok === false);
  commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 }));
  t('SB3 store: after commit (actual 3 < est 10), headroom reopens', reservePool(home, 'camp', res({ reserveKey: 'C', consumer: 'runC', estUsd: 5 }))!.ok === true && spentOf(readPool(home, 'camp')!).usd === 3);

  // SB4: projection repaired on idempotent replay even after the projection file is lost.
  const projFile = join(home, '.agenthop', 'console', 'budget-pools', 'camp.json');
  t('SB4: projection written', existsSync(projFile));
  rmSync(projFile); // simulate a prior projection-write fault
  commitDraw(home, 'camp', drw({ drawKey: 'dA', reserveKey: 'A', consumer: 'runA', usd: 3, tokens: 0 })); // idempotent replay
  t('SB4: idempotent replay re-creates the projection (converges to ledger)', existsSync(projFile) && JSON.parse(readFileSync(projFile, 'utf8')).spent.usd === 3);

  // SB2: corrupt / wrong-name / invalid ledgers are NEVER treated as absent (never re-granted).
  const campFile = join(home, '.agenthop', 'budgets', 'camp.json');
  writeFileSync(campFile, '{not json');
  t('SB2: corrupt JSON ledger -> readPool throws (not absent)', threw(() => readPool(home, 'camp')));
  t('SB2: corrupt ledger -> createPool throws (does not recreate at full ceiling)', threw(() => createPool(home, 'camp', { maxUsd: 10, maxTokens: null })));
  writeFileSync(campFile, JSON.stringify({ poolName: 'camp', ceiling: { maxUsd: null, maxTokens: null }, draws: [], reservations: [] }));
  t('SB2: double-null ceiling rejected', threw(() => readPool(home, 'camp')));
  writeFileSync(campFile, JSON.stringify({ poolName: 'camp', ceiling: { maxUsd: 10, maxTokens: null }, draws: [{ drawKey: 'x', consumer: 'c', usd: -5, tokens: 0, atSec: 1 }], reservations: [] }));
  t('SB2: negative spent rejected', threw(() => readPool(home, 'camp')));
  // SB2 aliasing: a file whose BODY name differs from the requested name is rejected (defeats case-insensitive fs alias).
  writeFileSync(campFile, JSON.stringify({ poolName: 'Camp', ceiling: { maxUsd: 100, maxTokens: null }, draws: [], reservations: [] }));
  t('SB2: body poolName mismatch rejected (alias defeated)', threw(() => readPool(home, 'camp')));

  // SB1: a lock held by a DEAD pid is reclaimed (liveness), so work proceeds; (no age-based steal path exists).
  const freshHome = mkdtempSync(join(tmpdir(), 'sb2-'));
  try {
    createPool(freshHome, 'lk', { maxUsd: 100, maxTokens: null });
    const lock = join(freshHome, '.agenthop', 'budgets', 'lk.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, '999999999.dead'), ''); // a holder whose pid is not alive
    const ok = reservePool(freshHome, 'lk', res({ reserveKey: 'afterbreak', estUsd: 1 }));
    t('SB1: dead-pid lock is reclaimed (liveness), reserve proceeds', ok!.ok === true);
  } finally { rmSync(freshHome, { recursive: true, force: true }); }

  // coordinator raise reopens; listing works
  createPool(home, 'camp2', { maxUsd: 5, maxTokens: null });
  reservePool(home, 'camp2', res({ reserveKey: 'X', estUsd: 5 }));
  t('camp2 exhausted by reservation', reservePool(home, 'camp2', res({ reserveKey: 'Y', estUsd: 1 }))!.ok === false);
  raisePoolCeiling(home, 'camp2', { maxUsd: 100, maxTokens: null });
  t('raisePoolCeiling reopens', reservePool(home, 'camp2', res({ reserveKey: 'Z', estUsd: 1 }))!.ok === true);
  t('listPoolProjections skips the corrupt camp, lists camp2', (() => { const l = listPoolProjections(home); return l.some((p) => p.poolName === 'camp2') && !l.some((p) => p.poolName === 'camp'); })());
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('\nshared-budget self-check OK');
