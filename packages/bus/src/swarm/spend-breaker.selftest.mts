import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakerEnabled, budgetRefFor, verdictFromAdmission, ticketCeiling } from './spend-breaker.js';
import { openTaskBudget, requestSpawn, recordSpend, taskBudget, presentTripToCoordinator, type SpawnRequest } from './spend-breaker-store.js';
import { spentOf, type PoolDraw } from './shared-budget.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };
const threw = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const sp = (o: Partial<SpawnRequest> = {}): SpawnRequest => ({ reserveKey: 'r1', consumer: 'c1', estUsd: 10, estTokens: 0, ...o });
const draw = (o: Partial<PoolDraw> = {}): PoolDraw => ({ drawKey: 'd1', consumer: 'c1', usd: 1, tokens: 0, atSec: 10, ...o });
const inboxFileCount = (home: string) => { try { let n = 0; for (const d of readdirSync(join(home, '.agenthop', 'inbox'), { withFileTypes: true })) if (d.isDirectory()) n += readdirSync(join(home, '.agenthop', 'inbox', d.name)).filter((f) => f.endsWith('.json')).length; return n; } catch { return 0; } };

// ---------------- pure core ----------------
t('breakerEnabled: default OFF, armed only by explicit truthy', !breakerEnabled({} as NodeJS.ProcessEnv)
  && breakerEnabled({ SWARM_SPEND_BREAKER: '1' } as unknown as NodeJS.ProcessEnv)
  && breakerEnabled({ SWARM_SPEND_BREAKER: 'true' } as unknown as NodeJS.ProcessEnv)
  && breakerEnabled({ SWARM_SPEND_BREAKER: 'on' } as unknown as NodeJS.ProcessEnv)
  && !breakerEnabled({ SWARM_SPEND_BREAKER: '0' } as unknown as NodeJS.ProcessEnv)
  && !breakerEnabled({ SWARM_SPEND_BREAKER: 'off' } as unknown as NodeJS.ProcessEnv));
t('budgetRefFor: safe id -> task-<id>', budgetRefFor('job-7_A') === 'task-job-7_A');
t('budgetRefFor: rejects traversal / space / empty / too-long', threw(() => budgetRefFor('../x')) && threw(() => budgetRefFor('a b')) && threw(() => budgetRefFor('')) && threw(() => budgetRefFor('x'.repeat(58))));
t('verdictFromAdmission: ok -> allowed', verdictFromAdmission({ ok: true, remaining: { usd: 5, tokens: null } }).allowed === true);
t('verdictFromAdmission: exhausted -> tripped', (() => { const v = verdictFromAdmission({ ok: false, exhausted: true, remaining: { usd: 0, tokens: null } }); return v.allowed === false && v.tripped === true; })());
t('verdictFromAdmission: null (unregistered) -> tripped', verdictFromAdmission(null).allowed === false);
t('ticketCeiling shape', (() => { const c = ticketCeiling(10); return c.maxUsd === 10 && c.maxTokens === null; })());

// ---------------- dormant (OFF) ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'fc4-off-'));
  try {
    delete process.env.SWARM_SPEND_BREAKER; // default OFF
    const v = requestSpawn(home, 'tk', sp());
    t('OFF: requestSpawn always allowed + dormant', v.allowed === true && (v as { dormant?: true }).dormant === true);
    t('OFF: NO pool touched (ledger absent)', taskBudget(home, 'tk') === null);
    t('OFF: recordSpend is a no-op (null)', recordSpend(home, 'tk', draw()) === null);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ---------------- armed (ON) ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'fc4-on-'));
  process.env.SWARM_SPEND_BREAKER = '1';
  try {
    openTaskBudget(home, 'big', ticketCeiling(10));
    t('ON: register budget then first reserve admitted', requestSpawn(home, 'big', sp({ reserveKey: 'A', estUsd: 10 })).allowed === true);
    const trip = requestSpawn(home, 'big', sp({ reserveKey: 'B', estUsd: 10 }));
    t('ON: a reserve over the cap TRIPS (spend-amount circuit broken)', trip.allowed === false && (trip as { tripped?: true }).tripped === true);
    t('ON: in-flight is NOT killed on a trip (reservation A retained)', taskBudget(home, 'big')!.reservations.some((r) => r.reserveKey === 'A'));
    t('ON: reserve is idempotent by reserveKey (replay A still allowed)', requestSpawn(home, 'big', sp({ reserveKey: 'A', estUsd: 10 })).allowed === true);
    // reconcile A down to a real $4 -> headroom reopens for a $5 spawn
    recordSpend(home, 'big', draw({ drawKey: 'dA', reserveKey: 'A', consumer: 'c1', usd: 4 }));
    t('ON: after commit (4<10) headroom reopens; spent=4', spentOf(taskBudget(home, 'big')!).usd === 4 && requestSpawn(home, 'big', sp({ reserveKey: 'C', estUsd: 5 })).allowed === true);

    // committed spend alone can trip (no open reserve needed)
    openTaskBudget(home, 'burn', ticketCeiling(5));
    recordSpend(home, 'burn', draw({ drawKey: 'db', consumer: 'c1', usd: 5 }));
    t('ON: committed spend at the cap trips the next spawn', requestSpawn(home, 'burn', sp({ reserveKey: 'z', estUsd: 1 })).allowed === false);

    // an UNREGISTERED ticket cannot spawn against a nonexistent budget (no cap-bypass)
    t('ON: unregistered ticket -> tripped (must openTaskBudget first)', requestSpawn(home, 'ghost', sp({ reserveKey: 'g', estUsd: 1 })).allowed === false);

    // S19: present a trip to the coordinator (durable-inbox card)
    const before = inboxFileCount(home);
    const v = requestSpawn(home, 'burn', sp({ reserveKey: 'z2', estUsd: 1 }));
    if (v.allowed === false) presentTripToCoordinator(home, 'coord-sid', 'burn', v);
    t('ON/S19: a trip presents one durable card to the coordinator', inboxFileCount(home) === before + 1);
  } finally {
    delete process.env.SWARM_SPEND_BREAKER;
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('\nspend-breaker self-check OK');
