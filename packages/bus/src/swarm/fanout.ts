// Fan-out nativization — phase-1 PURE CORE (S14, the sovereign governance layer).
//
// WHY THIS EXISTS: fan-out (spawn N short-lived units, aggregate) is a FOUNDATIONAL scale-up capability a
// long-lived member wields as a stateless sub-tool — it never replaces members, mutual comms, or review.
// Our self-built pool is the SOVEREIGN default backend (design `docs/swarm/fanout-native-design.md`): it
// carries the width guardrail, tiered dispatch, the run ledger, the budget breaker, and the exactly-once
// aggregate ITSELF, so governance is ours regardless of which backend runs the units. This module is that
// governance, as pure functions over plain data — no IO. The dispatcher (scripts/swarm-fanout.ts) wires the
// temp-workspace / headless execution around it; everything here is selftested and deterministic.
//
// COST IS THE #1 CONSTRAINT (user): width is graded (allow / ROI-required / ticket-gated), every unit runs at
// the cheapest tier its task-class allows, and a per-run budget breaker aborts on overrun.

// ---------- cost tiers + task classes ----------
export type FanoutTier = "cheap" | "mid" | "top";
export type TaskClass = "scan" | "extract" | "format" | "judge" | "synthesize" | "aggregate" | "adjudicate";

// Route a unit's INTENT to the cheapest capable tier: scan/extract/format = cheap (Haiku-level); judge/
// synthesize = mid (Sonnet-level); a top model (Opus/Fable) only at the aggregation/adjudication point.
const CLASS_TIER: Record<TaskClass, FanoutTier> = {
  scan: "cheap", extract: "cheap", format: "cheap",
  judge: "mid", synthesize: "mid",
  aggregate: "top", adjudicate: "top",
};
export function classToTier(c: TaskClass): FanoutTier {
  return CLASS_TIER[c];
}

// ---------- request schema + validation ----------
export type FanoutUnit = { key: string; prompt: string; taskClass: TaskClass; tier?: FanoutTier; cwd?: string };
export type FanoutMode = "fresh" | "keep_alive";
export type FanoutBudget = { maxTokens?: number; maxUsd?: number };
export type FanoutRequest = {
  runKey: string;
  units: FanoutUnit[];
  mode: FanoutMode;
  reduce: string;
  budget: FanoutBudget;
};

const TASK_CLASSES = new Set<string>(["scan", "extract", "format", "judge", "synthesize", "aggregate", "adjudicate"]);
const TIERS = new Set<string>(["cheap", "mid", "top"]);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// A runKey becomes a filename segment (the ledger path), so it MUST be a safe slug — no separators, no
// traversal (round-1 FN5). Enforced at validation so a crafted runKey can never escape the fanout dir.
export function isSafeRunKey(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..");
}

export type ValidationResult = { ok: true; req: FanoutRequest } | { ok: false; reason: string };

// Validate an untrusted `fanout` request. Keys are content-addressed and MUST be unique (a duplicate key is a
// conflict, never a silent overwrite — the oh-my-openagent idempotency lesson).
export function validateFanoutRequest(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "request is not an object" };
  const r = raw as Record<string, unknown>;
  if (!isStr(r.runKey)) return { ok: false, reason: "runKey missing or empty" };
  if (!isSafeRunKey(r.runKey)) return { ok: false, reason: "runKey must be a safe slug (alphanumeric . _ - ; no separators or traversal)" };
  if (!Array.isArray(r.units) || r.units.length === 0) return { ok: false, reason: "units must be a non-empty array" };
  if (r.mode !== "fresh" && r.mode !== "keep_alive") return { ok: false, reason: "mode must be fresh|keep_alive" };
  if (!isStr(r.reduce)) return { ok: false, reason: "reduce rule missing" };
  const budget = (r.budget ?? {}) as Record<string, unknown>;
  if (budget.maxTokens !== undefined && !isNonNeg(budget.maxTokens)) return { ok: false, reason: "budget.maxTokens must be >= 0" };
  if (budget.maxUsd !== undefined && !isNonNeg(budget.maxUsd)) return { ok: false, reason: "budget.maxUsd must be >= 0" };
  const seen = new Set<string>();
  const units: FanoutUnit[] = [];
  for (const u of r.units as unknown[]) {
    if (typeof u !== "object" || u === null) return { ok: false, reason: "a unit is not an object" };
    const uo = u as Record<string, unknown>;
    if (!isStr(uo.key)) return { ok: false, reason: "a unit key is missing or empty" };
    if (seen.has(uo.key)) return { ok: false, reason: `duplicate unit key: ${uo.key}` };
    seen.add(uo.key);
    if (!isStr(uo.prompt)) return { ok: false, reason: `unit ${uo.key}: prompt missing` };
    if (!TASK_CLASSES.has(uo.taskClass as string)) return { ok: false, reason: `unit ${uo.key}: bad taskClass` };
    if (uo.tier !== undefined && !TIERS.has(uo.tier as string)) return { ok: false, reason: `unit ${uo.key}: bad tier` };
    if (uo.cwd !== undefined && !isStr(uo.cwd)) return { ok: false, reason: `unit ${uo.key}: cwd must be a string` };
    units.push({
      key: uo.key,
      prompt: uo.prompt,
      taskClass: uo.taskClass as TaskClass,
      ...(uo.tier !== undefined ? { tier: uo.tier as FanoutTier } : {}),
      ...(uo.cwd !== undefined ? { cwd: uo.cwd as string } : {}),
    });
  }
  const budgetClean: FanoutBudget = {
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens as number } : {}),
    ...(budget.maxUsd !== undefined ? { maxUsd: budget.maxUsd as number } : {}),
  };
  return { ok: true, req: { runKey: r.runKey, units, mode: r.mode, reduce: r.reduce, budget: budgetClean } };
}

// An explicit tier overrides the class default; otherwise the class decides.
export function effectiveTier(u: FanoutUnit): FanoutTier {
  return u.tier ?? classToTier(u.taskClass);
}

// ---------- width guardrail (cost = #1 constraint) ----------
export const WIDTH_ALLOW_MAX = 8; // 8 or fewer: allow + account
export const WIDTH_ROI_MAX = 32; // 9..32: an ROI estimate must ride the request; above 32: a budget-ticket gate
export const PANE_BUDGET = 16; // per temp-workspace pane cap; a wider batch degrades to headless

export type WidthClass = "allow" | "roi-required" | "ticket-gated";
export function widthClass(n: number): WidthClass {
  if (n <= WIDTH_ALLOW_MAX) return "allow";
  if (n <= WIDTH_ROI_MAX) return "roi-required";
  return "ticket-gated";
}

export type WidthGateInput = { hasRoiEstimate: boolean; hasBudgetTicket: boolean };
export type WidthGate = { admit: boolean; cls: WidthClass; reason: string };

// A wide fan-out must pay for its width before any spawn: 9..32 needs an ROI estimate; over 32 needs a
// user-visible budget ticket. 8 or fewer is always admitted (still accounted).
export function widthGate(n: number, input: WidthGateInput): WidthGate {
  const cls = widthClass(n);
  if (cls === "allow") return { admit: true, cls, reason: "8 or fewer: allowed + accounted" };
  if (cls === "roi-required")
    return input.hasRoiEstimate
      ? { admit: true, cls, reason: "9 to 32: ROI estimate present" }
      : { admit: false, cls, reason: "9 to 32 requires an ROI estimate (speedup- and cost-ratio)" };
  return input.hasBudgetTicket
    ? { admit: true, cls, reason: "over 32: budget ticket present" }
    : { admit: false, cls, reason: "over 32 requires a user-visible budget-ticket gate" };
}

// ---------- display mode (temp-workspace default; headless degradation) ----------
export type DisplayMode = "temp-workspace" | "headless";

// The self-built pool shows units as VISIBLE panes in a temporary herdr workspace by default; it degrades to
// headless when herdr is unreachable or the batch exceeds the per-zone pane budget. Governance is identical
// either way — degradation changes display, never the guardrail/ledger/aggregate.
export function chooseDisplayMode(n: number, herdrReachable: boolean): DisplayMode {
  if (!herdrReachable) return "headless";
  if (n > PANE_BUDGET) return "headless";
  return "temp-workspace";
}

export function zoneName(runKey: string): string {
  return `fanout-${runKey}`;
}

// FN4-B degradation: a requested temp-workspace falls back to headless if the zone could not be opened —
// governance (guardrail/ledger/aggregate) is identical, only the display changes.
export function degradeDisplay(requested: DisplayMode, zoneOpened: boolean): DisplayMode {
  return requested === "temp-workspace" && !zoneOpened ? "headless" : requested;
}

// FN4-B hang detection: a unit that has run past its timeout is timed out.
export function elapsedTimedOut(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt > timeoutMs;
}

// ---------- ledger ----------
export type UnitStatus = "running" | "done" | "failed" | "timeout" | "delivery_uncertain" | "aborted";
export type Backend = "self-built" | "native";
export type LedgerRow = {
  id: string;
  key: string;
  backend: Backend;
  displayMode: DisplayMode;
  zone?: string;
  pane?: string;
  pid?: number;
  spawnOk?: boolean;
  tier: FanoutTier;
  status: UnitStatus;
  startedAt?: number;
  endedAt?: number;
  outputPtr?: string;
  tokens?: number;
};

export function newLedgerRow(u: FanoutUnit, id: string, backend: Backend, displayMode: DisplayMode, zone?: string): LedgerRow {
  return {
    id,
    key: u.key,
    backend,
    displayMode,
    ...(zone !== undefined ? { zone } : {}),
    tier: effectiveTier(u),
    status: "running",
  };
}

export const TERMINAL: ReadonlySet<UnitStatus> = new Set<UnitStatus>(["done", "failed", "timeout", "delivery_uncertain", "aborted"]);
export function isTerminal(s: UnitStatus): boolean {
  return TERMINAL.has(s);
}

// One-line progress for the status-digest: "N done / M total" (plus how many are still running / failed).
export type Progress = { done: number; failed: number; running: number; total: number; line: string };
export function progress(rows: readonly LedgerRow[]): Progress {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed" || r.status === "timeout" || r.status === "delivery_uncertain" || r.status === "aborted").length;
  const running = rows.filter((r) => r.status === "running").length;
  return { done, failed, running, total, line: `${done} done / ${total} total` };
}

// ---------- reduce + exactly-once receipt ----------
export type UnitResult = { key: string; status: UnitStatus; data?: unknown; error?: string };
export type ReducedItem = { key: string; data?: unknown; error?: string };

// Collect terminal units into one keyed aggregate. A failed/timeout unit becomes `{key,error}` and blocks
// nothing; a delivery_uncertain unit is QUARANTINED (reported as an error, never auto-retried — it demands a
// fresh key). A still-running unit is NOT in the aggregate and makes it not-ready.
export type Reduced = { items: ReducedItem[]; allTerminal: boolean };
export function reduceUnits(results: readonly UnitResult[]): Reduced {
  const items: ReducedItem[] = [];
  let allTerminal = true;
  for (const r of results) {
    if (!isTerminal(r.status)) {
      allTerminal = false;
      continue;
    }
    if (r.status === "done") items.push({ key: r.key, data: r.data });
    else if (r.status === "delivery_uncertain") items.push({ key: r.key, error: "delivery_uncertain (quarantined; needs a fresh key)" });
    else items.push({ key: r.key, error: r.error ?? r.status });
  }
  return { items, allTerminal };
}

// Exactly-once delivery of the aggregate (oh-my-openagent's ack/fail receipt): deliver ONLY when every unit
// is terminal; a failed delivery re-arms on the next pass (new generation); once accepted it never
// re-delivers.
export type AggregateReceipt = { generation: number; delivered: boolean; accepted: boolean };
export function nextReceipt(prev: AggregateReceipt | undefined, allTerminal: boolean, ackOk: boolean): AggregateReceipt {
  const gen = prev?.generation ?? 0;
  if (!allTerminal) return { generation: gen, delivered: false, accepted: false };
  if (prev?.delivered && prev.accepted) return prev; // idempotent: already delivered and acked
  // first delivery, or re-arm after a prior unacked delivery
  return { generation: gen + 1, delivered: true, accepted: ackOk };
}

// ---------- budget breaker ----------
export type Spent = { tokens?: number; usd?: number };

// The per-run breaker: abort remaining spawns once either ceiling is reached (the gap every surveyed fan-out
// tool shares; ours by construction).
export function budgetExceeded(spent: Spent, cap: FanoutBudget): boolean {
  if (cap.maxTokens !== undefined && (spent.tokens ?? 0) >= cap.maxTokens) return true;
  if (cap.maxUsd !== undefined && (spent.usd ?? 0) >= cap.maxUsd) return true;
  return false;
}

// ---------- lifecycle reconciliation (orphan sweep, zone ownership, depth cap) ----------
export const DEFAULT_MAX_DEPTH = 2; // a fan-out unit may not itself fan out beyond this depth (recursion-bomb guard)

// A unit may spawn its own sub-units only while under the depth cap — stops agent-spawns-agent runaway.
export function admitDepth(currentDepth: number, maxDepth: number = DEFAULT_MAX_DEPTH): boolean {
  return currentDepth < maxDepth;
}

// Orphan sweep: a unit still marked running whose OS pid is no longer live is orphaned → mark it timeout (the
// caller archives its log). A running unit with a live pid, or any already-terminal unit, is unchanged.
// Immutable — returns a new row array.
export function reconcileOrphans(rows: readonly LedgerRow[], livePids: ReadonlySet<number>): LedgerRow[] {
  return rows.map((r) =>
    r.status === "running" && r.pid !== undefined && !livePids.has(r.pid) ? { ...r, status: "timeout" as UnitStatus } : r,
  );
}

// F42 reap-only-own: close ONLY a temp zone THIS run opened — it must carry the `fanout-` prefix AND its
// runKey must be one we own. Never reap a foreign zone, and never the main workspace.
export function canReapZone(zone: string, ourRunKeys: ReadonlySet<string>): boolean {
  if (!zone.startsWith("fanout-")) return false;
  return ourRunKeys.has(zone.slice("fanout-".length));
}

// ---------- terminal classification + evidence + resume (round-1 FN8/FN7/FN2/FN1) ----------

// FN8: classify a unit's terminal status from its REAL exit evidence, never from pid-gone alone. A failed
// spawn or a non-zero exit is failed; a clean (or unknown) exit is done ONLY with output evidence — an empty
// yield is not silently a success.
export function classifyExit(opts: { spawnOk: boolean; exitCode?: number | null; outputPresent: boolean }): "done" | "failed" {
  if (!opts.spawnOk) return "failed";
  if (opts.exitCode !== undefined && opts.exitCode !== null && opts.exitCode !== 0) return "failed";
  return opts.outputPresent ? "done" : "failed";
}

// FN7: the width ROI tier needs a REAL estimate bound to this run (env may carry a pointer to it, never be the
// evidence). A valid estimate names the runKey and gives positive speedup- and cost-ratios.
export type RoiEstimate = { runKey: string; speedupRatio: number; costRatio: number };
export function validRoiEstimate(obj: unknown, runKey: string): boolean {
  const o = obj as Partial<RoiEstimate> | null;
  return !!o && o.runKey === runKey && typeof o.speedupRatio === "number" && o.speedupRatio > 0 && typeof o.costRatio === "number" && o.costRatio > 0;
}

// FN7: the over-32 tier needs a valid budget ticket bound to this run (a real ceiling, not a bare flag).
export type BudgetTicket = { runKey: string; maxTokens?: number; maxUsd?: number; issuedAt: number };
export function validBudgetTicket(obj: unknown, runKey: string): boolean {
  const o = obj as Partial<BudgetTicket> | null;
  if (!o || o.runKey !== runKey || typeof o.issuedAt !== "number") return false;
  return (typeof o.maxTokens === "number" && o.maxTokens > 0) || (typeof o.maxUsd === "number" && o.maxUsd > 0);
}

// FN2: resume — reuse the prior ledger's DONE rows by content-addressed key; everything else is to-run. A
// completed unit is never re-run (no double-spend on a same-runKey replay).
export function planResume(prior: readonly LedgerRow[], units: readonly FanoutUnit[]): { reuse: LedgerRow[]; toRun: FanoutUnit[] } {
  const doneByKey = new Map(prior.filter((r) => r.status === "done").map((r) => [r.key, r] as const));
  const reuse: LedgerRow[] = [];
  const toRun: FanoutUnit[] = [];
  for (const u of units) {
    const d = doneByKey.get(u.key);
    if (d) reuse.push(d);
    else toRun.push(u);
  }
  return { reuse, toRun };
}

// FN1: on the budget breaker, a still-running (or never-launched) row reaches a TERMINAL `aborted` state — it
// must not vanish, so the aggregate stays honest and the receipt is not falsely accepted over missing units.
// Immutable.
export function markAborted(rows: readonly LedgerRow[]): LedgerRow[] {
  return rows.map((r) => (r.status === "running" ? { ...r, status: "aborted" as UnitStatus } : r));
}
