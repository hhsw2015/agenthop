import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCeiling, isValidPoolName, emptyPool, spentOf, remainingOf, isExhausted, admit, applyDraw, raiseCeiling, project,
  type PoolDraw,
} from './shared-budget.js';
import {
  createPool, readPool, admitPool, recordDraw, raisePoolCeiling, listPoolProjections,
} from './shared-budget-store.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };
const threw = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const draw = (over: Partial<PoolDraw> = {}): PoolDraw => ({ drawKey: 'k1', consumer: 'c1', usd: 1, tokens: 100, atSec: 10, ...over });

// ---------- pure core ----------
t('isValidPoolName accepts safe, rejects traversal/space', isValidPoolName('pool-1_A') && !isValidPoolName('../x') && !isValidPoolName('a b') && !isValidPoolName(''));
t('resolveCeiling accepts one dim', resolveCeiling({ maxUsd: 5, maxTokens: null }).maxUsd === 5);
t('resolveCeiling rejects both null', threw(() => resolveCeiling({ maxUsd: null, maxTokens: null })));
t('resolveCeiling rejects negative usd', threw(() => resolveCeiling({ maxUsd: -1, maxTokens: null })));
t('resolveCeiling rejects non-integer tokens', threw(() => resolveCeiling({ maxUsd: null, maxTokens: 1.5 })));

const p0 = emptyPool('camp', { maxUsd: 10, maxTokens: 1000 });
t('empty pool spends 0', spentOf(p0).usd === 0 && spentOf(p0).tokens === 0);
t('empty pool admits', admit(p0).ok === true);

const p1 = applyDraw(p0, draw({ usd: 3, tokens: 200 }));
t('applyDraw accumulates', spentOf(p1).usd === 3 && spentOf(p1).tokens === 200);
t('applyDraw idempotent by drawKey', applyDraw(p1, draw({ usd: 3, tokens: 200 })) === p1); // same key => unchanged
t('applyDraw is immutable (p0 untouched)', spentOf(p0).usd === 0);
t('remaining never negative', remainingOf(p1).usd === 7 && remainingOf(p1).tokens === 800);

// exhaustion: usd dimension hits first (ruling 3: usd OR tokens)
const pUsd = applyDraw(p1, draw({ drawKey: 'k2', usd: 7, tokens: 1 }));
t('exhausted when usd reaches ceiling', isExhausted(pUsd) && admit(pUsd).ok === false);
// exhaustion via tokens on a fresh pool
const pTok = applyDraw(emptyPool('c2', { maxUsd: 100, maxTokens: 500 }), draw({ usd: 1, tokens: 500 }));
t('exhausted when tokens reaches ceiling', isExhausted(pTok));

// overshoot tolerated (ruling 2): a draw past the ceiling is STILL recorded; spent > ceiling is shown
const pOver = applyDraw(emptyPool('c3', { maxUsd: 5, maxTokens: null }), draw({ usd: 9, tokens: 0 }));
t('overshoot recorded, spent > ceiling, exhausted', spentOf(pOver).usd === 9 && isExhausted(pOver) && remainingOf(pOver).usd === 0);

// raiseCeiling (ruling 5 enforcement is the caller's; the pure fn just applies)
const pRaised = raiseCeiling(pUsd, { maxUsd: 100, maxTokens: 2000 });
t('raiseCeiling reopens an exhausted pool', !isExhausted(pRaised) && admit(pRaised).ok === true);
t('raiseCeiling refuses to lower', threw(() => raiseCeiling(pUsd, { maxUsd: 1, maxTokens: null })));

const proj = project(applyDraw(p1, draw({ drawKey: 'k3', consumer: 'c2', usd: 2, tokens: 50 })), 999);
t('project shape + schema', proj.schema === 'budget-pool/v1' && proj.generatedAtSec === 999 && proj.drawCount === 2);
t('project breaks down by consumer sorted by usd', proj.consumers[0].id === 'c1' && proj.consumers[0].usd === 3 && proj.consumers[1].id === 'c2');
t('project state exhausted flag', project(pUsd, 1).state === 'exhausted' && project(p0, 1).state === 'open');

// ---------- store round-trip (CAS, idempotency, projection file) ----------
const home = mkdtempSync(join(tmpdir(), 'sb-'));
try {
  t('admitPool null when pool absent (caller fail-closes)', admitPool(home, 'none') === null);
  t('recordDraw throws on absent pool', threw(() => recordDraw(home, 'none', draw())));

  const created = createPool(home, 'camp', { maxUsd: 10, maxTokens: null });
  t('createPool writes a fresh pool', created.draws.length === 0 && readPool(home, 'camp') !== null);
  t('createPool idempotent (does not clobber)', (() => { recordDraw(home, 'camp', draw({ usd: 4 })); return createPool(home, 'camp', { maxUsd: 10, maxTokens: null }).draws.length === 1; })());

  // Two consumers draw against the SAME pool (the whole point: shared ceiling).
  recordDraw(home, 'camp', draw({ drawKey: 'a', consumer: 'runA', usd: 3 }));
  recordDraw(home, 'camp', draw({ drawKey: 'b', consumer: 'runB', usd: 2 }));
  t('shared pool accumulates across consumers', spentOf(readPool(home, 'camp')!).usd === 9); // 4 + 3 + 2

  // Idempotent across a replay (reconnect records the same drawKey again).
  recordDraw(home, 'camp', draw({ drawKey: 'a', consumer: 'runA', usd: 3 }));
  t('recordDraw idempotent across replay', spentOf(readPool(home, 'camp')!).usd === 9);

  t('admitPool refuses once exhausted (9 < 10 still open, push over)', admitPool(home, 'camp')!.ok === true);
  recordDraw(home, 'camp', draw({ drawKey: 'c', consumer: 'runC', usd: 5 })); // 9 -> 14 (overshoot)
  t('admitPool refuses new after exhaustion (overshoot shown)', admitPool(home, 'camp')!.ok === false && spentOf(readPool(home, 'camp')!).usd === 14);

  // projection file written beside bandwidth-gauge
  const projFile = join(home, '.agenthop', 'console', 'budget-pools', 'camp.json');
  t('projection file exists', existsSync(projFile));
  const diskProj = JSON.parse(readFileSync(projFile, 'utf8'));
  t('projection file content valid', diskProj.schema === 'budget-pool/v1' && diskProj.state === 'exhausted' && diskProj.spent.usd === 14);

  // coordinator raises the ceiling -> reopens
  raisePoolCeiling(home, 'camp', { maxUsd: 100, maxTokens: null });
  t('raisePoolCeiling reopens', admitPool(home, 'camp')!.ok === true);

  t('listPoolProjections lists the pool', listPoolProjections(home).some((p) => p.poolName === 'camp'));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('\nshared-budget self-check OK');
