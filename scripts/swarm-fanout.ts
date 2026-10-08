#!/usr/bin/env tsx
// swarm-fanout — phase-1 SELF-BUILT fan-out backend (the sovereign default), DORMANT behind SWARM_FANOUT.
//
// Composes the AS-IS spawn stack + single-flight + the herdr CLI (direct exec, herdr NOT forked, spawn.ts NOT
// touched) with the pure governance core (fanout.ts) and the visible-chain builders (fanout-herdr.ts). A member
// posts a `fanout` request; this driver resumes any prior run (FN2), validates width evidence (FN7), enforces a
// depth cap (FN6) and a budget breaker over metered usage (FN1), runs the units through a per-run pool + a
// cross-run shared lease (FN9) at the chosen display mode (a temporary herdr workspace of VISIBLE panes — FN4-B
// — or headless on degradation), classifies each unit from its REAL exit evidence (FN8), persists the aggregate
// BEFORE advancing an exactly-once receipt (FN3), and reaps only the zone it opened (F42). A single-flight lock
// serializes same-run replays and a try/finally keeps cleanup responsibility (FN2).
// Design: docs/swarm/fanout-native-design.md; pits: docs/swarm/fanout-prestudy.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { spawnAgent, despawnAgent, readRegistry } from "../packages/bus/src/spawn.js";
import { herdrServerReachable } from "../packages/bus/src/swarm/herdr.js";
import { acquireSingleFlight } from "../packages/bus/src/swarm/single-flight.js";
import {
  buildPaneRun, buildPaneSplitIn, buildPaneWaitOutput, buildWorkspaceClose, buildWorkspaceCreate,
  buildWorkspaceRename, doneMarker, paneIdFromSplit, rcFile, unitCommand, workspaceFromCreate,
} from "../packages/bus/src/swarm/fanout-herdr.js";
import {
  admitDepth, budgetExceeded, canReapZone, chooseDisplayMode, classifyExit, degradeDisplay, effectiveTier,
  elapsedTimedOut, markAborted, newLedgerRow, nextReceipt, planResume, reconcileOrphans, reduceUnits,
  validateFanoutRequest, validBudgetTicket, validRoiEstimate, widthGate, zoneName, type AggregateReceipt,
  type FanoutBudget, type FanoutRequest, type FanoutTier, type FanoutUnit, type LedgerRow, type UnitResult,
} from "../packages/bus/src/swarm/fanout.js";

export const fanoutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.SWARM_FANOUT ?? "");

const TIER_MODEL_DEFAULT: Record<FanoutTier, string> = { cheap: "claude-haiku-5-5", mid: "claude-sonnet-5-5", top: "claude-opus-5-5" };
const tierModel = (tier: FanoutTier, env: NodeJS.ProcessEnv): string => env[`FANOUT_MODEL_${tier.toUpperCase()}`] ?? TIER_MODEL_DEFAULT[tier];
const numEnv = (env: NodeJS.ProcessEnv, key: string, def: number, min: number): number => Math.max(min, Number(env[key] ?? def) || def);

const fanoutDir = (home: string): string => path.join(home, ".agenthop", "swarm", "fanout");
const runDir = (home: string, runKey: string): string => path.join(fanoutDir(home), runKey);
const ledgerPath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "ledger.json");
const aggregatePath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "aggregate.json");
const lockPath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "run.lock");
const outFile = (home: string, runKey: string, key: string): string => path.join(runDir(home, runKey), `${key}.out`);
const leasesDir = (home: string): string => path.join(fanoutDir(home), "leases");

function writeJsonAtomic(file: string, obj: unknown): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- herdr CLI (direct exec; herdr is NOT forked, spawn.ts is NOT touched) ----
const herdrBin = (env: NodeJS.ProcessEnv): string => env.HERDR_BIN || path.join(homedir(), ".local", "bin", "herdr");
function herdrExec(env: NodeJS.ProcessEnv, args: string[], timeoutMs = 45000): Promise<{ json: unknown; exitFailed: boolean }> {
  return new Promise((resolve) => {
    execFile(herdrBin(env), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      let json: unknown = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ json, exitFailed: !!err });
    });
  });
}

// ---- cross-run shared admission lease (FN9), guarded by a global single-flight lock ----
function acquireLease(home: string, cap: number, label: string): string | null {
  const dir = leasesDir(home);
  mkdirSync(dir, { recursive: true });
  const release = acquireSingleFlight(path.join(dir, ".acquire.lock"));
  if (!release) return null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".lease")) continue;
      const rec = readJson(path.join(dir, f)) as { pid?: number } | null;
      if (!rec || typeof rec.pid !== "number" || !pidAlive(rec.pid)) rmSync(path.join(dir, f), { force: true });
    }
    const live = readdirSync(dir).filter((f) => f.endsWith(".lease")).length;
    if (live >= cap) return null;
    const file = path.join(dir, `${process.pid}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lease`);
    return writeJsonAtomic(file, { pid: process.pid, label, ts: Date.now() }) ? file : null;
  } finally {
    release();
  }
}
const releaseLease = (file: string | null): void => { if (file) rmSync(file, { force: true }); };

// ---- width evidence (FN7): env carries a POINTER to the evidence file, never the evidence itself ----
function widthEvidence(env: NodeJS.ProcessEnv, runKey: string): { hasRoiEstimate: boolean; hasBudgetTicket: boolean; ticket: FanoutBudget | null } {
  const roi = env.FANOUT_ROI_FILE ? readJson(env.FANOUT_ROI_FILE) : null;
  const ticketRaw = env.FANOUT_TICKET_FILE ? readJson(env.FANOUT_TICKET_FILE) : null;
  const hasBudgetTicket = validBudgetTicket(ticketRaw, runKey);
  const t = ticketRaw as { maxTokens?: number; maxUsd?: number } | null;
  return {
    hasRoiEstimate: validRoiEstimate(roi, runKey),
    hasBudgetTicket,
    ticket: hasBudgetTicket && t ? { ...(t.maxTokens ? { maxTokens: t.maxTokens } : {}), ...(t.maxUsd ? { maxUsd: t.maxUsd } : {}) } : null,
  };
}

type Launched = { unit: FanoutUnit; row: LedgerRow; lease: string | null };

export async function runFanout(req: FanoutRequest, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<{ rows: LedgerRow[]; receipt: AggregateReceipt }> {
  // FN6: depth cap — a unit may not fan out past the cap; children carry FANOUT_DEPTH+1.
  const depth = Math.max(0, Number(env.FANOUT_DEPTH ?? 0) || 0);
  if (!admitDepth(depth)) throw new Error(`fanout depth cap reached (${depth}); not spawning a deeper generation`);

  // FN2: single-flight per runKey — serialize same-run replays; the release runs in finally.
  mkdirSync(runDir(home, req.runKey), { recursive: true });
  const releaseRun = acquireSingleFlight(lockPath(home, req.runKey));
  if (!releaseRun) throw new Error(`fanout run ${req.runKey} is already in flight (single-flight lock held)`);

  const launchedAll: Launched[] = [];
  try {
    // FN2: resume — reuse prior DONE rows by key; only the rest are to-run.
    const prior = (readJson(ledgerPath(home, req.runKey)) as { rows?: LedgerRow[]; receipt?: AggregateReceipt } | null) ?? null;
    const priorRows = prior?.rows ?? [];
    const priorReceipt = prior?.receipt;
    const { reuse, toRun } = planResume(priorRows, req.units);

    // FN7: width gate on REAL evidence bound to this run; the ticket (if valid) is the budget ceiling (FN1).
    const ev = widthEvidence(env, req.runKey);
    const gate = widthGate(req.units.length, { hasRoiEstimate: ev.hasRoiEstimate, hasBudgetTicket: ev.hasBudgetTicket });
    if (!gate.admit) throw new Error(`fanout width gate refused (${req.units.length} units): ${gate.reason}`);
    const cap: FanoutBudget = ev.ticket ?? req.budget;

    const display = chooseDisplayMode(req.units.length, await herdrServerReachable());
    const perRunCap = numEnv(env, "FANOUT_CONCURRENCY", 5, 1);
    const globalCap = numEnv(env, "FANOUT_GLOBAL_CONCURRENCY", 16, 1);
    const timeoutMs = numEnv(env, "FANOUT_UNIT_TIMEOUT_MS", 900000, 1000);
    const tokenReserve = numEnv(env, "FANOUT_UNIT_TOKEN_EST", 50000, 0); // FN1: conservative reservation per launch

    // FN4-B: open the temp zone; on any failure, degrade to headless (governance unchanged).
    let zone: string | undefined;
    let zoneId: string | undefined;
    let lastPane: string | undefined;
    let zoneOpened = false;
    if (display === "temp-workspace") {
      const created = workspaceFromCreate((await herdrExec(env, buildWorkspaceCreate())).json);
      if (created) {
        zone = zoneName(req.runKey);
        zoneId = created.workspaceId;
        lastPane = created.rootPaneId;
        zoneOpened = true;
        await herdrExec(env, buildWorkspaceRename(created.workspaceId, zone)).catch(() => undefined);
      }
    }
    const mode = degradeDisplay(display, zoneOpened); // FN4-B: zone-open fail -> headless

    const rows: LedgerRow[] = [...reuse];
    const spent = { tokens: reuse.length * tokenReserve };
    const settleOf: Array<Promise<void>> = [];

    for (let i = 0; i < toRun.length; i += perRunCap) {
      if (budgetExceeded(spent, cap)) break; // FN1 breaker
      const batch = toRun.slice(i, i + perRunCap);
      const launched: Launched[] = [];
      for (const unit of batch) {
        if (budgetExceeded(spent, cap)) break;
        // FN9: acquire a cross-run lease (bounded wait); skip to the breaker/next tick if the global cap is full.
        let lease: string | null = null;
        for (let a = 0; a < 30 && !(lease = acquireLease(home, globalCap, unit.key)); a++) await sleep(1000);
        const model = tierModel(effectiveTier(unit), env);
        const out = outFile(home, req.runKey, unit.key);
        const row = newLedgerRow(unit, unit.key, "self-built", mode, zone);
        row.startedAt = Date.now();
        row.outputPtr = out;
        rows.push(row);
        writeJsonAtomic(ledgerPath(home, req.runKey), { runKey: req.runKey, rows, receipt: { generation: priorReceipt?.generation ?? 0, delivered: false, accepted: false } }); // FN2: durable-register BEFORE spawn
        if (mode === "headless") {
          const childEnv = { ...env, ANTHROPIC_MODEL: model, FANOUT_DEPTH: String(depth + 1) }; // FN6
          const r = await spawnAgent({ tool: "claude", task: unit.prompt, visible: false, ...(unit.cwd ? { cwd: unit.cwd } : {}) }, childEnv);
          row.spawnOk = r.ok;
          if (r.launchId !== undefined) row.id = r.launchId; // the despawn handle (keep row.key as the stable content key)
          if (r.pid !== undefined) row.pid = r.pid;
          if (r.outputFile !== undefined) row.outputPtr = r.outputFile;
        } else {
          const split = paneIdFromSplit((await herdrExec(env, buildPaneSplitIn(lastPane ?? "", unit.cwd ?? process.cwd()))).json);
          if (split) { row.pane = split; lastPane = split; row.spawnOk = true; const cmd = unitCommand({ bin: "claude", model, prompt: unit.prompt, outputFile: out, key: unit.key }); await herdrExec(env, buildPaneRun(split, cmd)); }
          else { row.spawnOk = false; row.status = "failed"; row.endedAt = Date.now(); }
        }
        spent.tokens += tokenReserve; // FN1: reserve on launch
        launched.push({ unit, row, lease });
        launchedAll.push({ unit, row, lease });
      }
      // settle this batch (await completion), then write the ledger
      for (const l of launched) settleOf.push(settleUnit(env, home, req.runKey, l, timeoutMs));
      await Promise.all(settleOf.splice(0));
      writeJsonAtomic(ledgerPath(home, req.runKey), { runKey: req.runKey, rows, receipt: { generation: priorReceipt?.generation ?? 0, delivered: false, accepted: false } });
    }

    // FN1: any still-running (never-launched past the breaker) row reaches a terminal `aborted` state.
    // orphan sweep first (a running row with a dead pid -> timeout), then abort any still-running remainder.
    const livePids = new Set(readRegistry(home).map((r) => r.pid).filter((p): p is number => typeof p === "number" && pidAlive(p)));
    const finalRows = markAborted(reconcileOrphans(rows, livePids));

    const results: UnitResult[] = finalRows.map((r) => ({
      key: r.key,
      status: r.status,
      ...(r.status === "done" && r.outputPtr ? { data: r.outputPtr } : {}),
      ...(r.status !== "done" && r.status !== "running" ? { error: r.status } : {}),
    }));
    const red = reduceUnits(results);
    // FN3: persist the aggregate FIRST; only then advance the receipt, and only to accepted if the persist held.
    const persistOk = writeJsonAtomic(aggregatePath(home, req.runKey), { runKey: req.runKey, items: red.items, allTerminal: red.allTerminal });
    const receipt = nextReceipt(priorReceipt, red.allTerminal, persistOk);
    writeJsonAtomic(ledgerPath(home, req.runKey), { runKey: req.runKey, rows: finalRows, receipt });

    // F42: reap ONLY the zone we opened.
    if (zone && zoneId && canReapZone(zone, new Set([req.runKey]))) await herdrExec(env, buildWorkspaceClose(zoneId)).catch(() => undefined);
    return { rows: finalRows, receipt };
  } finally {
    // cleanup responsibility (FN2): release leases + despawn any headless child we launched, even on a throw.
    for (const l of launchedAll) {
      releaseLease(l.lease);
      if (l.row.backend === "self-built" && l.row.displayMode === "headless" && l.row.pid !== undefined) await despawnAgent(l.row.id).catch(() => {});
    }
    releaseRun();
  }
}

// Settle one launched unit: classify from REAL exit evidence (FN8), despawn/close on timeout, release its lease.
async function settleUnit(env: NodeJS.ProcessEnv, home: string, runKey: string, l: Launched, timeoutMs: number): Promise<void> {
  const { row } = l;
  if (row.status !== "running") { releaseLease(l.lease); return; }
  const out = row.outputPtr ?? outFile(home, runKey, row.key);
  const outputPresent = (): boolean => existsSync(out) && (() => { try { return statSync(out).size > 0; } catch { return false; } })();
  try {
    if (row.displayMode === "headless") {
      const started = row.startedAt ?? Date.now();
      for (;;) {
        const rec = readRegistry(home).find((r) => r.launchId === row.id || (row.pid !== undefined && r.pid === row.pid));
        const exited = rec?.exitCode !== undefined && rec?.exitCode !== null;
        const dead = row.pid !== undefined && !pidAlive(row.pid);
        if (exited || dead) { row.status = classifyExit({ spawnOk: row.spawnOk ?? true, exitCode: rec?.exitCode ?? null, outputPresent: outputPresent() }); break; }
        if (elapsedTimedOut(started, Date.now(), timeoutMs)) { await despawnAgent(row.id).catch(() => {}); row.status = "timeout"; break; }
        await sleep(2000);
      }
    } else {
      await herdrExec(env, buildPaneWaitOutput(row.pane ?? "", doneMarker(row.key), timeoutMs));
      const rc = readFileSync(rcFile(out), "utf8").trim();
      const exitCode = /^\d+$/.test(rc) ? Number(rc) : null;
      row.status = exitCode === null && !outputPresent() ? "timeout" : classifyExit({ spawnOk: row.spawnOk ?? true, exitCode, outputPresent: outputPresent() });
    }
  } catch {
    row.status = outputPresent() ? "done" : "failed";
  } finally {
    row.endedAt = Date.now();
    releaseLease(l.lease);
  }
}

// ---- CLI entry ----
async function main(): Promise<void> {
  if (!fanoutEnabled()) { console.error("swarm-fanout: SWARM_FANOUT is off (dormant). Set SWARM_FANOUT=1 to run."); process.exit(0); }
  const i = process.argv.indexOf("--request");
  if (i < 0 || i + 1 >= process.argv.length) { console.error("usage: swarm-fanout --request <request.json>"); process.exit(2); }
  const v = validateFanoutRequest(readJson(process.argv[i + 1]!));
  if (!v.ok) { console.error(`swarm-fanout: invalid request: ${v.reason}`); process.exit(2); }
  const { rows, receipt } = await runFanout(v.req);
  const done = rows.filter((r) => r.status === "done").length;
  console.error(`swarm-fanout: ${done} done / ${rows.length} total; delivered=${receipt.delivered} accepted=${receipt.accepted} gen=${receipt.generation}`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
