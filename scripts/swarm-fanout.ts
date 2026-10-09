#!/usr/bin/env tsx
// swarm-fanout — phase-1 SELF-BUILT fan-out backend (the sovereign default), DORMANT behind SWARM_FANOUT.
//
// Composes the AS-IS spawn stack + single-flight + the herdr CLI (direct exec; herdr NOT forked, spawn.ts NOT
// touched) with the pure governance core (fanout.ts) and the visible-chain builders (fanout-herdr.ts). Headless
// is the DEFAULT; the temp-workspace VISIBLE chain is an explicit opt-in (request `visible:true`). All IO
// decisions (budget, resume, depth, exit classification, display) come from the tested pure layer.
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
  admitDepth, canReapZone, chooseDisplayMode, classifyExit, degradeDisplay, effectiveTier,
  elapsedTimedOut, markAborted, newLedgerRow, nextReceipt, parseDepth, planResume, reconcileOrphans, reduceUnits,
  leaseOccupied, reservationFits, reserveValid, resumeVerdict, validSpent, validateFanoutRequest, validBudgetTicket, validRoiEstimate, widthGate, zoneName,
  type AggregateReceipt, type DisplayMode, type FanoutBudget, type FanoutRequest, type FanoutUnit, type FanoutTier,
  type LedgerRow, type Spent, type UnitResult,
} from "../packages/bus/src/swarm/fanout.js";

export const fanoutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.SWARM_FANOUT ?? "");

const TIER_MODEL_DEFAULT: Record<FanoutTier, string> = { cheap: "claude-haiku-5-5", mid: "claude-sonnet-5-5", top: "claude-opus-5-5" };
const tierModel = (tier: FanoutTier, env: NodeJS.ProcessEnv): string => env[`FANOUT_MODEL_${tier.toUpperCase()}`] ?? TIER_MODEL_DEFAULT[tier];
const numEnv = (env: NodeJS.ProcessEnv, key: string, def: number, min: number): number => Math.max(min, Number(env[key] ?? def) || def);

const fanoutDir = (home: string): string => path.join(home, ".agenthop", "swarm", "fanout");
const runDir = (home: string, runKey: string): string => path.join(fanoutDir(home), runKey);
const ledgerPath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "ledger.json");
const aggregatePath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "aggregate.json");
const cleanupPendingPath = (home: string, zoneId: string): string => path.join(fanoutDir(home), "cleanup-pending", `${zoneId}.json`); // FN4: per-ZONE (never overwrites across leaked zones)
const lockPath = (home: string, runKey: string): string => path.join(runDir(home, runKey), "run.lock");
const outFile = (home: string, runKey: string, key: string, attempt: string): string => path.join(runDir(home, runKey), `${key}.${attempt}.out`);
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
type LedgerState = { runKey: string; rows: LedgerRow[]; receipt?: AggregateReceipt; spent?: Spent };
const LEDGER_STATUSES: ReadonlySet<string> = new Set<string>(["running", "done", "failed", "timeout", "delivery_uncertain", "aborted"]);
// FN2: distinguish MISSING (fresh run, null) from CORRUPT/unreadable (throw — prior state is unknown, never
// treat it as "no prior run" and re-spawn everything). A directory at the path is EISDIR -> corrupt -> throw.
function readLedgerState(home: string, runKey: string): LedgerState | null {
  const p = ledgerPath(home, runKey);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`fanout ledger unreadable (${p}): ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`fanout ledger corrupt (${p}); refusing to start (prior state unknown)`);
  }
  // FN2: validate SHAPE + IDENTITY — null/{}/an array/a foreign runKey is corrupt, never a fresh run.
  const o = parsed as Partial<LedgerState> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o) || o.runKey !== runKey || !Array.isArray(o.rows)) {
    throw new Error(`fanout ledger malformed or foreign (${p}); refusing to start`);
  }
  // FN2: validate EACH inner row's shape/status AND the cumulative spend. A crafted row (illegal status, non-number
  // pid) or a negative/NaN spent must REFUSE the launch — never flow into resume/reservation math as trustworthy.
  for (const r of o.rows as unknown[]) {
    const rr = r as Partial<LedgerRow> | null;
    if (typeof rr !== "object" || rr === null || typeof rr.key !== "string" || typeof rr.status !== "string" || !LEDGER_STATUSES.has(rr.status)) {
      throw new Error(`fanout ledger has a malformed row (${p}); refusing to start`);
    }
    if (rr.pid !== undefined && typeof rr.pid !== "number") throw new Error(`fanout ledger row pid corrupt (${p}); refusing to start`);
  }
  // FN2: a PRESENT spent must satisfy the numeric structure (both tokens+usd finite non-neg) — an array, `{}`, or a
  // partial object is corrupt and REFUSES the launch; it is never silently read as zero.
  if (o.spent !== undefined && !validSpent(o.spent)) {
    throw new Error(`fanout ledger spent corrupt (${p}); refusing to start`);
  }
  return o as LedgerState;
}
const writeLedger = (home: string, runKey: string, rows: readonly LedgerRow[], receipt: AggregateReceipt | undefined, spent: Spent): boolean =>
  writeJsonAtomic(ledgerPath(home, runKey), { runKey, rows, receipt, spent, updatedAt: Date.now() });

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readFileOrNull = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJsonOrNull = (p: string): unknown => { const s = readFileOrNull(p); if (s === null) return null; try { return JSON.parse(s); } catch { return null; } };
const outputPresentAt = (p: string | undefined): boolean => { if (!p) return false; try { return existsSync(p) && statSync(p).size > 0; } catch { return false; } };
// FN2: the registry exit code for a SPECIFIC launch, matched by launchId ONLY — a pid is recyclable, so another launch
// that reused this pid (and happens to sort first in an unordered readRegistry) must NEVER confirm this one. No launchId
// -> no registry evidence. Used by EVERY settle entry (live settle + resume reconcile) so terminal state is always bound
// to the same launch, not just on the resume path.
const exitForLaunch = (home: string, launchId: string | undefined): number | null | undefined =>
  launchId === undefined ? undefined : readRegistry(home).find((r) => r.launchId === launchId)?.exitCode;

// FN2: reconcile a prior RUNNING row against REAL terminal evidence before a resume decides anything. A crash can
// leave a row "running" whether it never launched, is still live, already finished, or launched-but-unconfirmed —
// blind re-run double-spends. Verdict from: live pid (alive) | headless registry exit or visible rc sidecar
// (done on 0+output, else failed-terminal/retry) | no terminal record at all (uncertain -> quarantine, never re-run).
function reconcileRunning(home: string, pr: LedgerRow): "alive" | "done" | "failed-terminal" | "uncertain" {
  const alive = pr.pid !== undefined && pidAlive(pr.pid);
  // FN2: terminal evidence is bound to the SAME launch (exitForLaunch = launchId match only). No launchId/none matches
  // -> no registry evidence; fall to the launch-bound rc sidecar (its path is unique per launch, FN8), else uncertain.
  let exit: number | null | undefined = alive ? undefined : exitForLaunch(home, pr.id);
  if (!alive && (exit === undefined || exit === null) && pr.outputPtr) {
    const rc = readFileOrNull(rcFile(pr.outputPtr));
    if (rc !== null && /^\d+$/.test(rc.trim())) exit = Number(rc.trim());
  }
  return resumeVerdict({ alive, exitCode: exit, outputPresent: outputPresentAt(pr.outputPtr) }); // FN2: pure, tested mapping
}

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
      const rec = readJsonOrNull(path.join(dir, f)) as { pid?: number; childPid?: number; zoneId?: string; rcPath?: string } | null;
      // FN9: a lease binds the ACTUAL execution — a slot frees ONLY on POSITIVE terminal evidence (leaseOccupied, pure),
      // never on driver death nor on the ABSENCE of a cleanup todo. headless -> the child's death; visible -> THIS launch's
      // rc sidecar exists (the command exited). An explicit close removes the lease out-of-band.
      const occupied = leaseOccupied(rec, {
        childAlive: rec?.childPid !== undefined && pidAlive(rec.childPid),
        driverAlive: typeof rec?.pid === "number" && pidAlive(rec.pid),
        rcPresent: typeof rec?.rcPath === "string" && existsSync(rec.rcPath),
      });
      if (!occupied) rmSync(path.join(dir, f), { force: true });
    }
    if (readdirSync(dir).filter((f) => f.endsWith(".lease")).length >= cap) return null;
    const file = path.join(dir, `${process.pid}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lease`);
    return writeJsonAtomic(file, { pid: process.pid, label, ts: Date.now() }) ? file : null;
  } finally {
    release();
  }
}
const releaseLease = (file: string | null): void => { if (file) rmSync(file, { force: true }); };
// FN9: bind the lease to the detached child's pid, so capacity is not released until the child's terminal state. Returns
// whether the identity write was DURABLE — a failed write must be visible to the caller so it can undo the launch (a bare
// lease would be reaped on driver death while the child still runs).
function bindLeaseChild(file: string | null, childPid: number): boolean {
  if (!file) return false;
  const rec = readJsonOrNull(file) as Record<string, unknown> | null;
  return rec !== null && writeJsonAtomic(file, { ...rec, childPid });
}
// FN9: bind a VISIBLE lease to its ZONE + THIS launch's rc sidecar path, so its capacity obligation survives the driver's
// exit — acquireLease holds the slot until the rc proves the command EXITED (positive terminal evidence), never on driver
// death or on a missing/unwritable cleanup todo. An explicit close removes the lease out-of-band.
function bindLeaseZone(file: string | null, zoneId: string, rcPath: string): boolean {
  if (!file) return false;
  const rec = readJsonOrNull(file) as Record<string, unknown> | null;
  return rec !== null && writeJsonAtomic(file, { ...rec, zoneId, rcPath }); // FN9: a failed identity write must STOP the launch (caller checks)
}

// ---- width evidence (FN7): env carries a POINTER to the evidence file, never the evidence itself ----
function widthEvidence(env: NodeJS.ProcessEnv, runKey: string): { hasRoiEstimate: boolean; hasBudgetTicket: boolean; ticket: FanoutBudget | null } {
  const roi = env.FANOUT_ROI_FILE ? readJsonOrNull(env.FANOUT_ROI_FILE) : null;
  const ticketRaw = env.FANOUT_TICKET_FILE ? readJsonOrNull(env.FANOUT_TICKET_FILE) : null;
  const hasBudgetTicket = validBudgetTicket(ticketRaw, runKey);
  const t = ticketRaw as { maxTokens?: number; maxUsd?: number } | null;
  return {
    hasRoiEstimate: validRoiEstimate(roi, runKey),
    hasBudgetTicket,
    ticket: hasBudgetTicket && t ? { ...(t.maxTokens ? { maxTokens: t.maxTokens } : {}), ...(t.maxUsd ? { maxUsd: t.maxUsd } : {}) } : null,
  };
}

type Launched = { row: LedgerRow; lease: string | null };

export async function runFanout(req: FanoutRequest, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<{ rows: LedgerRow[]; receipt: AggregateReceipt }> {
  // FN6: strict depth — reject a present-but-invalid value; absent = root (0).
  const depth = parseDepth(env.FANOUT_DEPTH);
  if (depth === null) throw new Error(`invalid FANOUT_DEPTH=${JSON.stringify(env.FANOUT_DEPTH)} (must be a non-negative integer)`);
  if (!admitDepth(depth)) throw new Error(`fanout depth cap reached (${depth}); not spawning a deeper generation`);

  mkdirSync(runDir(home, req.runKey), { recursive: true });
  const releaseRun = acquireSingleFlight(lockPath(home, req.runKey)); // FN2: serialize same-run replays
  if (!releaseRun) throw new Error(`fanout run ${req.runKey} is already in flight (single-flight lock held)`);

  const launchedAll: Launched[] = [];
  let zoneId: string | undefined;
  let zone: string | undefined;
  try {
    // FN2: resume — corrupt ledger throws; reuse prior DONE by key; carry a still-live or quarantined prior row.
    const prior = readLedgerState(home, req.runKey);
    if (prior?.receipt?.accepted) return { rows: prior.rows ?? [], receipt: prior.receipt }; // FN3: an accepted run is immutable — never modify its results or receipt
    const priorRows = prior?.rows ?? [];
    const priorReceipt = prior?.receipt;
    const spent = { tokens: prior?.spent?.tokens ?? 0, usd: prior?.spent?.usd ?? 0 }; // FN1: durable cumulative spend (concrete numbers)
    const priorByKey = new Map(priorRows.map((r) => [r.key, r] as const));
    const { reuse, toRun: resumeToRun } = planResume(priorRows, req.units);
    const carry: LedgerRow[] = [];
    const toRun: FanoutUnit[] = [];
    for (const u of resumeToRun) {
      const pr = priorByKey.get(u.key);
      if (!pr) { toRun.push(u); continue; } // no prior attempt -> fresh launch
      if (pr.status === "delivery_uncertain") { carry.push(pr); continue; } // already quarantined — never auto-re-run
      if (pr.status === "running") {
        const v = reconcileRunning(home, pr); // FN2: confirm from real evidence; never blind re-run a prior running row
        if (v === "alive") { carry.push(pr); continue; } // still in flight
        if (v === "done") { carry.push({ ...pr, status: "done", endedAt: pr.endedAt ?? Date.now() }); continue; } // actually completed -> reuse
        if (v === "uncertain") { carry.push({ ...pr, status: "delivery_uncertain", endedAt: Date.now() }); continue; } // launched-but-unconfirmed -> quarantine
        toRun.push(u); continue; // confirmed terminal non-zero -> safe retry
      }
      toRun.push(u); // terminal non-done (failed/timeout/aborted) -> retry
    }

    // FN7: width gate on real evidence bound to this run; a valid ticket is the budget ceiling (FN1).
    const ev = widthEvidence(env, req.runKey);
    const gate = widthGate(req.units.length, { hasRoiEstimate: ev.hasRoiEstimate, hasBudgetTicket: ev.hasBudgetTicket });
    if (!gate.admit) throw new Error(`fanout width gate refused (${req.units.length} units): ${gate.reason}`);
    const cap: FanoutBudget = ev.ticket ?? req.budget;
    // FN1: validate the per-launch reservation up front — a capped domain with no positive estimate is refused.
    const reserve = { tokens: numEnv(env, "FANOUT_UNIT_TOKEN_EST", 50000, 0), usd: Number(env.FANOUT_UNIT_USD_EST ?? 0) || 0 };
    const rv = reserveValid(reserve, cap);
    if (!rv.ok) throw new Error(`fanout reservation invalid: ${rv.reason}`);

    // FN4: headless default; the temp-workspace visible chain is an explicit opt-in.
    const requested: DisplayMode = chooseDisplayMode(req.units.length, await herdrServerReachable(), req.visible === true);
    let lastPane: string | undefined;
    let zoneOpened = false;
    if (requested === "temp-workspace") {
      const created = workspaceFromCreate((await herdrExec(env, buildWorkspaceCreate())).json);
      if (created) {
        zone = zoneName(req.runKey);
        zoneId = created.workspaceId;
        lastPane = created.rootPaneId;
        zoneOpened = true;
        await herdrExec(env, buildWorkspaceRename(created.workspaceId, zone)).catch(() => undefined);
      }
    }
    const mode = degradeDisplay(requested, zoneOpened); // FN4 degradation

    // FN1/FN2: register a row for EVERY to-run unit BEFORE any spawn; a failed register must NOT launch.
    const rows: LedgerRow[] = [...reuse, ...carry];
    const runnable: Launched[] = [];
    for (const u of toRun) {
      const row = newLedgerRow(u, u.key, "self-built", mode, zone);
      // FN8: a UNIQUE per-launch evidence path. An old attempt's rc/output can never share this path, so success is
      // bound to THIS launch by construction — no fragile stale-file delete (whose failure could pass off old evidence).
      row.outputPtr = outFile(home, req.runKey, u.key, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      rows.push(row);
      runnable.push({ row, lease: null });
    }
    if (!writeLedger(home, req.runKey, rows, priorReceipt, spent)) throw new Error("fanout: could not durably register the run ledger; not launching");

    const perRunCap = numEnv(env, "FANOUT_CONCURRENCY", 5, 1);
    const globalCap = numEnv(env, "FANOUT_GLOBAL_CONCURRENCY", 16, 1);
    const timeoutMs = numEnv(env, "FANOUT_UNIT_TIMEOUT_MS", 900000, 1000);

    let bi = 0;
    while (bi < runnable.length) {
      const batch = runnable.slice(bi, bi + perRunCap);
      bi += perRunCap;
      const settles: Array<Promise<void>> = [];
      for (const l of batch) {
        // FN1: the reservation must FIT before launch (pre-check spent + reserve; exactly-equal allowed, over rejected).
        if (!reservationFits(spent, reserve, cap)) { bi = runnable.length; break; }
        // FN9: acquire a cross-run lease; NEVER launch without one.
        let lease: string | null = null;
        for (let a = 0; a < 30 && !(lease = acquireLease(home, globalCap, l.row.key)); a++) await sleep(1000);
        if (!lease) { bi = runnable.length; break; } // no admission -> stop launching (remaining stay running -> aborted)
        l.lease = lease;
        // FN9: for a VISIBLE unit, persist the lease identity (zoneId + THIS launch's rcPath) BEFORE anything is launched. A
        // failed identity write would leave a bare driver-pid lease that another run reaps on driver death while the pane runs
        // -> binding failure STOPS the launch (nothing spawned yet; the slot is released and the unit fails).
        if (mode !== "headless" && zoneId !== undefined && !bindLeaseZone(lease, zoneId, rcFile(l.row.outputPtr!))) {
          releaseLease(lease); l.lease = null; l.row.status = "failed"; l.row.endedAt = Date.now(); launchedAll.push(l); continue; // identity not durable -> do not launch
        }
        spent.tokens += reserve.tokens; spent.usd += reserve.usd; // FN1: reserve BEFORE spawn
        if (!writeLedger(home, req.runKey, rows, priorReceipt, spent)) { releaseLease(lease); l.lease = null; bi = runnable.length; break; } // durable spend; fail -> no launch
        l.row.startedAt = Date.now();
        const model = tierModel(effectiveTier(unitOfRow(req, l.row)), env);
        if (mode === "headless") {
          const r = await spawnAgent({ tool: "claude", task: promptOfRow(req, l.row), visible: false, ...(cwdOfRow(req, l.row) ? { cwd: cwdOfRow(req, l.row)! } : {}) }, { ...env, ANTHROPIC_MODEL: model, FANOUT_DEPTH: String(depth + 1) });
          l.row.spawnOk = r.ok;
          if (r.launchId !== undefined) l.row.id = r.launchId;
          // FN9: bind the child's life to the lease. If the identity write FAILS the child is untracked (a bare lease is reaped
          // on driver death while the child runs) -> UNDO the launch: despawn the child + fail the unit, so no executed slot
          // outlives its binding. (Headless must undo post-spawn; visible is stopped pre-launch above.)
          if (r.pid !== undefined) { l.row.pid = r.pid; if (!bindLeaseChild(lease, r.pid)) { await despawnAgent(l.row.id).catch(() => {}); l.row.status = "failed"; l.row.endedAt = Date.now(); releaseLease(lease); l.lease = null; } }
          if (r.outputFile !== undefined) l.row.outputPtr = r.outputFile;
          if (!r.ok) { l.row.status = "failed"; l.row.endedAt = Date.now(); } // FN8: launch failure keeps its reason immediately
          else if (r.pid === undefined) { l.row.status = "delivery_uncertain"; l.row.endedAt = Date.now(); } // FN2: launched but no handle -> quarantine, never re-run
        } else {
          const split = paneIdFromSplit((await herdrExec(env, buildPaneSplitIn(lastPane ?? "", cwdOfRow(req, l.row) ?? process.cwd()))).json);
          if (split) {
            l.row.pane = split; lastPane = split; l.row.spawnOk = true;
            const cmd = unitCommand({ bin: "claude", model, prompt: promptOfRow(req, l.row), outputFile: l.row.outputPtr!, key: l.row.key, childDepth: depth + 1 });
            await herdrExec(env, buildPaneRun(split, cmd));
          } else { l.row.spawnOk = false; l.row.status = "failed"; l.row.endedAt = Date.now(); }
        }
        launchedAll.push(l);
        settles.push(settleUnit(env, home, l, timeoutMs));
      }
      await Promise.all(settles);
      writeLedger(home, req.runKey, rows, priorReceipt, spent);
    }

    // orphan sweep, then abort any still-running remainder (never-launched past the breaker/lease).
    const livePids = new Set(readRegistry(home).map((r) => r.pid).filter((p): p is number => typeof p === "number" && pidAlive(p)));
    const finalRows = markAborted(reconcileOrphans(rows, livePids));

    const results: UnitResult[] = finalRows.map((r) => ({
      key: r.key,
      status: r.status,
      ...(r.status === "done" && r.outputPtr ? { data: r.outputPtr } : {}),
      ...(r.status !== "done" && r.status !== "running" ? { error: r.status } : {}),
    }));
    const red = reduceUnits(results);
    // FN3: persist the aggregate FIRST; advance the receipt from the PRIOR one (nextReceipt never downgrades accepted).
    const persistOk = writeJsonAtomic(aggregatePath(home, req.runKey), { runKey: req.runKey, items: red.items, allTerminal: red.allTerminal });
    const receipt = nextReceipt(priorReceipt, red.allTerminal, persistOk);
    writeLedger(home, req.runKey, finalRows, receipt, spent);
    return { rows: finalRows, receipt };
  } finally {
    for (const l of launchedAll) {
      // FN9 HEADLESS: confirm the child is gone before releasing its slot. A failed/unconfirmed despawn keeps the lease
      // bound to the child pid (acquireLease reaps it when the child dies) rather than freeing capacity while it runs.
      if (l.row.displayMode !== "headless") continue; // VISIBLE leases are released ONLY after a confirmed zone close (below)
      if (l.row.pid !== undefined && pidAlive(l.row.pid)) await despawnAgent(l.row.id).catch(() => {});
      if (l.row.pid === undefined || !pidAlive(l.row.pid)) { releaseLease(l.lease); l.lease = null; }
    }
    // FN4: reap ONLY the zone we opened, in finally (exception-safe); a failed close leaves a durable cleanup todo.
    let zoneClosed = !(zone && zoneId); // nothing opened ⇒ nothing to close
    if (zone && zoneId && canReapZone(zone, new Set([req.runKey]))) {
      const { exitFailed } = await herdrExec(env, buildWorkspaceClose(zoneId)).catch(() => ({ exitFailed: true, json: null }));
      zoneClosed = !exitFailed;
      if (exitFailed) {
        const wrote = writeJsonAtomic(cleanupPendingPath(home, zoneId), { zone, zoneId, runKey: req.runKey, note: "workspace close failed; a later sweep must reap it", ts: Date.now() });
        if (!wrote) console.error(`swarm-fanout: LEAKED zone ${zoneId} (${zone}) — close failed AND the cleanup todo could not be recorded; manual reap required`); // FN4: explicit hand-back, never silent
      }
    }
    // FN9 VISIBLE: a pane has no pid, so "no pid" must NOT mean "released". Free a still-held visible slot ONLY once its
    // pane is gone — i.e. the zone close CONFIRMED (settleUnit already released any unit whose rc proved it exited). A
    // failed close RETAINS the lease (capacity obligation); it is driver-pid-bound, so acquireLease reaps it when this
    // driver exits — never freeing the slot while an unclosed pane may still be running.
    if (zoneClosed) for (const l of launchedAll) { if (l.row.displayMode !== "headless") { releaseLease(l.lease); l.lease = null; } }
    releaseRun();
  }
}

const unitOfRow = (req: FanoutRequest, row: LedgerRow): FanoutUnit => req.units.find((u) => u.key === row.key)!;
const promptOfRow = (req: FanoutRequest, row: LedgerRow): string => unitOfRow(req, row).prompt;
const cwdOfRow = (req: FanoutRequest, row: LedgerRow): string | undefined => unitOfRow(req, row).cwd;

// Settle one launched unit: classify from REAL exit evidence (FN8), despawn/close on timeout, release its lease.
async function settleUnit(env: NodeJS.ProcessEnv, home: string, l: Launched, timeoutMs: number): Promise<void> {
  const row = l.row;
  if (row.status !== "running") { releaseLease(l.lease); l.lease = null; return; }
  const out = row.outputPtr!; // always set at registration (FN8 unique per-launch path)
  const outputPresent = (): boolean => { try { return existsSync(out) && statSync(out).size > 0; } catch { return false; } };
  try {
    if (row.displayMode === "headless") {
      const started = row.startedAt ?? Date.now();
      for (;;) {
        // FN2: exit evidence bound to THIS launch by launchId ONLY (never a recycled-pid match from an unordered registry).
        const ec = exitForLaunch(home, row.id);
        const exited = ec !== undefined && ec !== null;
        const dead = row.pid !== undefined && !pidAlive(row.pid); // liveness only; a dead pid with no THIS-launch exit -> classifyExit(null) = failed (never a false done)
        if (exited || dead) { row.status = classifyExit({ spawnOk: row.spawnOk ?? true, exitCode: ec ?? null, outputPresent: outputPresent() }); break; }
        if (elapsedTimedOut(started, Date.now(), timeoutMs)) { await despawnAgent(row.id).catch(() => {}); row.status = "timeout"; break; }
        await sleep(2000);
      }
    } else {
      const wait = await herdrExec(env, buildPaneWaitOutput(row.pane ?? "", doneMarker(row.key), timeoutMs));
      const rcRaw = readFileOrNull(rcFile(out));
      const exitCode = rcRaw !== null && /^\d+$/.test(rcRaw.trim()) ? Number(rcRaw.trim()) : null;
      // FN8: no rc evidence (and no completion) -> timeout; otherwise classify on the real exit code (null -> failed).
      row.status = exitCode === null && wait.exitFailed ? "timeout" : classifyExit({ spawnOk: row.spawnOk ?? true, exitCode, outputPresent: outputPresent() });
    }
  } catch {
    row.status = "failed"; // FN8: an exception is never a success
  } finally {
    row.endedAt = Date.now();
    // FN9: free capacity ONLY on a CONFIRMED terminal. Headless: the child pid is gone (a timeout despawn that did
    // not kill it leaves the child alive — keep the lease bound to its pid for acquireLease's stale-reap). Visible
    // (no pid): the command wrote its rc sidecar, i.e. it actually EXITED — a missing pid is NOT "ended", and a
    // still-running/lingering pane holds the slot until the run's outer finally confirms the zone close.
    const terminal = row.displayMode === "headless" ? (row.pid === undefined || !pidAlive(row.pid)) : readFileOrNull(rcFile(out)) !== null;
    if (terminal) { releaseLease(l.lease); l.lease = null; }
  }
}

// ---- CLI entry ----
async function main(): Promise<void> {
  if (!fanoutEnabled()) { console.error("swarm-fanout: SWARM_FANOUT is off (dormant). Set SWARM_FANOUT=1 to run."); process.exit(0); }
  const i = process.argv.indexOf("--request");
  if (i < 0 || i + 1 >= process.argv.length) { console.error("usage: swarm-fanout --request <request.json>"); process.exit(2); }
  const v = validateFanoutRequest(readJsonOrNull(process.argv[i + 1]!));
  if (!v.ok) { console.error(`swarm-fanout: invalid request: ${v.reason}`); process.exit(2); }
  const { rows, receipt } = await runFanout(v.req);
  const done = rows.filter((r) => r.status === "done").length;
  console.error(`swarm-fanout: ${done} done / ${rows.length} total; delivered=${receipt.delivered} accepted=${receipt.accepted} gen=${receipt.generation}`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
