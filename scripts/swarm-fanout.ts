#!/usr/bin/env tsx
// swarm-fanout — phase-1 SELF-BUILT fan-out backend (the sovereign default), DORMANT behind SWARM_FANOUT.
//
// It composes the AS-IS spawn stack (`spawnAgent`/`despawnAgent`/`readRegistry`) with the pure governance core
// (`packages/bus/src/swarm/fanout.ts`) — it modifies no AS-IS component. A member posts a `fanout` request; this
// driver runs the units through a concurrency-leased pool at the chosen display mode (a temporary herdr
// workspace of visible panes by default; headless on herdr-unreachable or an over-budget pane count), enforces
// the width guardrail + the budget breaker, keeps a run ledger, reduces to one exactly-once aggregate, and
// reaps ONLY the zone it opened (F42). Completion harvest below is the headless path (pid-exit + outputFile);
// the visible/temp-workspace path spawns panes into the zone and shares the ledger (live pane-harvest is the
// documented live-run refinement). Design: docs/swarm/fanout-native-design.md; pits: docs/swarm/fanout-prestudy.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnAgent, despawnAgent, readRegistry, type SpawnResult } from "../packages/bus/src/spawn.js";
import { herdrServerReachable } from "../packages/bus/src/swarm/herdr.js";
import {
  budgetExceeded, canReapZone, chooseDisplayMode, effectiveTier, newLedgerRow, nextReceipt, reconcileOrphans,
  reduceUnits, validateFanoutRequest, widthGate, zoneName,
  type AggregateReceipt, type DisplayMode, type FanoutRequest, type FanoutTier, type FanoutUnit, type LedgerRow,
  type UnitResult,
} from "../packages/bus/src/swarm/fanout.js";

export const fanoutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.SWARM_FANOUT ?? "");

// Tier -> model, routed model-agnostically through CPA (phase-1: via env; the model-tiers.json integration is
// phase-2). Cheapest default per tier; override with FANOUT_MODEL_CHEAP / _MID / _TOP.
const TIER_MODEL_DEFAULT: Record<FanoutTier, string> = { cheap: "claude-haiku-5-5", mid: "claude-sonnet-5-5", top: "claude-opus-5-5" };
export const tierModel = (tier: FanoutTier, env: NodeJS.ProcessEnv = process.env): string =>
  env[`FANOUT_MODEL_${tier.toUpperCase()}`] ?? TIER_MODEL_DEFAULT[tier];

const concurrencyCap = (env: NodeJS.ProcessEnv = process.env): number => Math.max(1, Number(env.FANOUT_CONCURRENCY ?? 5) || 5);
const unitTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => Math.max(1000, Number(env.FANOUT_UNIT_TIMEOUT_MS ?? 900000) || 900000);
const fanoutDir = (home: string): string => path.join(home, ".agenthop", "swarm", "fanout");
const ledgerPath = (home: string, runKey: string): string => path.join(fanoutDir(home), `${runKey}.json`);

function writeLedger(home: string, runKey: string, rows: readonly LedgerRow[], receipt: AggregateReceipt): void {
  mkdirSync(fanoutDir(home), { recursive: true });
  writeFileSync(ledgerPath(home, runKey), JSON.stringify({ runKey, rows, receipt, updatedAt: Date.now() }, null, 2));
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function spawnUnit(unit: FanoutUnit, display: DisplayMode, zone: string | undefined, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  const spawnEnv = { ...env, ANTHROPIC_MODEL: tierModel(effectiveTier(unit), env) };
  return spawnAgent(
    { tool: "claude", task: unit.prompt, visible: display === "temp-workspace", ...(unit.cwd ? { cwd: unit.cwd } : {}), ...(zone ? { workspace: zone } : {}) },
    spawnEnv,
  );
}

// A headless unit is done when its pid has exited AND its output file has content; it times out past the cap.
function harvestStatus(row: LedgerRow, timeoutMs: number): "running" | "done" | "timeout" {
  const started = row.startedAt ?? Date.now();
  if (Date.now() - started > timeoutMs) return "timeout";
  if (row.pid !== undefined && pidAlive(row.pid)) return "running";
  const out = row.outputPtr;
  if (out && existsSync(out) && statSync(out).size > 0) return "done";
  return row.pid !== undefined ? "done" : "running"; // pid gone + no/empty output still settles (empty yield)
}

export async function runFanout(req: FanoutRequest, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<{ rows: LedgerRow[]; receipt: AggregateReceipt }> {
  const n = req.units.length;
  const gate = widthGate(n, {
    hasRoiEstimate: /^(1|true|yes|on)$/i.test(env.FANOUT_ROI ?? ""),
    hasBudgetTicket: /^(1|true|yes|on)$/i.test(env.FANOUT_TICKET ?? ""),
  });
  if (!gate.admit) throw new Error(`fanout width gate refused (${n} units): ${gate.reason}`);

  const display = chooseDisplayMode(n, await herdrServerReachable());
  const zone = display === "temp-workspace" ? zoneName(req.runKey) : undefined;
  const cap = concurrencyCap(env);
  const timeoutMs = unitTimeoutMs(env);
  const spent = { tokens: 0 };

  const rows: LedgerRow[] = [];
  let next = 0; // index of the next unit to spawn
  const live = (): LedgerRow[] => rows.filter((r) => r.status === "running");

  while (next < req.units.length || live().length > 0) {
    // fill the pool, honoring the budget breaker (abort remaining spawns on overrun)
    while (live().length < cap && next < req.units.length && !budgetExceeded(spent, req.budget)) {
      const u = req.units[next]!;
      next += 1;
      const r = await spawnUnit(u, display, zone, env);
      const row = newLedgerRow(u, r.launchId ?? u.key, "self-built", display, zone);
      row.startedAt = Date.now();
      if (r.pid !== undefined) row.pid = r.pid;
      if (r.windowId !== undefined) row.pane = r.windowId;
      if (r.outputFile !== undefined) row.outputPtr = r.outputFile;
      rows.push(row);
    }
    if (budgetExceeded(spent, req.budget)) break;
    // harvest: settle finished/timed-out units; despawn a timed-out unit by its exact handle
    for (const row of live()) {
      const s = harvestStatus(row, timeoutMs);
      if (s === "running") continue;
      if (s === "timeout") await despawnAgent(row.id).catch(() => {});
      row.status = s;
      row.endedAt = Date.now();
    }
    writeLedger(home, req.runKey, rows, { generation: 0, delivered: false, accepted: false });
    if (live().length >= cap || (next >= req.units.length && live().length > 0)) await sleep(2000);
  }

  // orphan sweep: a still-running row whose pid is no longer in the live registry becomes timeout
  const livePids = new Set(readRegistry(home).map((r) => r.pid).filter((p): p is number => typeof p === "number" && pidAlive(p)));
  const swept = reconcileOrphans(rows, livePids);

  const results: UnitResult[] = swept.map((row) => ({
    key: row.key,
    status: row.status,
    ...(row.status === "done" && row.outputPtr ? { data: row.outputPtr } : {}),
    ...(row.status === "failed" || row.status === "timeout" ? { error: row.status } : {}),
  }));
  const red = reduceUnits(results);
  const receipt = nextReceipt(undefined, red.allTerminal, true);
  writeLedger(home, req.runKey, swept, receipt);

  // reap ONLY the zone we opened (F42): despawn each unit we launched into it; never touch a foreign zone or w1
  if (zone && canReapZone(zone, new Set([req.runKey]))) {
    for (const row of swept) await despawnAgent(row.id).catch(() => {});
  }
  return { rows: swept, receipt };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- CLI entry ----
async function main(): Promise<void> {
  if (!fanoutEnabled()) {
    console.error("swarm-fanout: SWARM_FANOUT is off (dormant). Set SWARM_FANOUT=1 to run.");
    process.exit(0);
  }
  const i = process.argv.indexOf("--request");
  if (i < 0 || i + 1 >= process.argv.length) {
    console.error("usage: swarm-fanout --request <request.json>");
    process.exit(2);
  }
  const raw: unknown = JSON.parse(readFileSync(process.argv[i + 1]!, "utf8"));
  const v = validateFanoutRequest(raw);
  if (!v.ok) {
    console.error(`swarm-fanout: invalid request: ${v.reason}`);
    process.exit(2);
  }
  const { rows, receipt } = await runFanout(v.req);
  const done = rows.filter((r) => r.status === "done").length;
  console.error(`swarm-fanout: ${done} done / ${rows.length} total; delivered=${receipt.delivered} gen=${receipt.generation}`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
