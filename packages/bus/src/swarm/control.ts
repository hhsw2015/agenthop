/**
 * Swarm lifecycle control: the PURE state machine + coordination decisions behind phase-2 VM-lifetime management
 * and near-death handoff. No IO — every function is a pure, immutable transform so the crash-timeline cases Codex
 * flagged (dispatcher dies at each stage, claim winner crashes, lease expiry, over-cap) are unit-testable without
 * touching Railway / GitHub / the relay.
 *
 * The authoritative record for one launchId lives in a persistent GitHub CONTROL repo (written by a constrained
 * identity, NOT the worker's contents token). The IO layer (swarm-dispatch.ts) enforces the expected-OID
 * conditional update (git ref CAS / force-with-lease) when it writes a transition this module computed — Codex
 * proved a plain same-OID push lets two writers both exit 0, so "push ok" is not a lock; the CAS is what serializes.
 *
 * State chain (Codex-reviewed):
 *   RUNNING -> DRAINING -> CHECKPOINTED(sha,manifest) -> CLAIMED(owner,gen) -> ALLOCATING(attempt)
 *           -> RESUMED(successor,sha) -> RETIRED
 * Branches: DONE (task finished), EXPIRED(lastConfirmedSha) (box died without a clean handoff), and lease-timeout
 * reclaim of a CLAIMED/ALLOCATING record whose owner went away.
 *
 * RPO = milestone-based: a `milestone` event updates `sha` but KEEPS state RUNNING (routine save); only the
 * post-DRAIN `checkpoint` advances to CHECKPOINTED (the handoff cue). Only artifacts written to disk and confirmed
 * (sha recorded) are recoverable — model context is not.
 */

export type SwarmState =
  | "RUNNING"
  | "DRAINING"
  | "CHECKPOINTED"
  | "CLAIMED"
  | "ALLOCATING"
  | "RESUMED"
  | "RETIRED"
  | "DONE"
  | "EXPIRED";

export type ControlRecord = {
  launchId: string;
  state: SwarmState;
  /** Owner generation; bumped on each claim so a stale predecessor can't act as the current owner. */
  generation: number;
  /** Last CONFIRMED immutable checkpoint sha (milestone or final). Undefined until the first confirmed push. */
  sha?: string;
  /** Opaque manifest ref/summary describing the recoverable artifact set at `sha`. */
  manifest?: string;
  /** Dispatcher instance id holding the claim (CLAIMED/ALLOCATING). */
  owner?: string;
  /** Epoch seconds the claim lease expires; past it, another dispatcher may reclaim. */
  leaseUntil?: number;
  /** Allocation attempt id (idempotency / reconciliation of an unknown-result allocate). */
  attempt?: string;
  /** Successor launchId recorded at RESUMED. */
  successor?: string;
  /** EXPIRED carries the last confirmed sha so a successor can still be allocated from it. */
  lastConfirmedSha?: string;
  /** Lifetime base: epoch seconds of the allocation REQUEST start (not the alloc ACK — that is already late). */
  allocStart: number;
  /** Bounded lifetime budget (s) from allocStart; provider expiry if known, else conservative. */
  budgetSec: number;
  /** Epoch seconds of the last write. */
  updatedAt: number;
};

export type ControlEvent =
  | { type: "milestone"; sha: string; manifest?: string }
  | { type: "drain" }
  | { type: "checkpoint"; sha: string; manifest?: string }
  | { type: "claim"; owner: string; generation: number; leaseUntil: number }
  | { type: "reclaim"; owner: string; generation: number; leaseUntil: number }
  | { type: "allocating"; attempt: string }
  | { type: "resumed"; successor: string; sha: string }
  | { type: "retire" }
  | { type: "done"; sha: string }
  | { type: "expire"; lastConfirmedSha?: string };

export type AdvanceResult = { ok: true; record: ControlRecord } | { ok: false; error: string };

const TERMINAL: ReadonlySet<SwarmState> = new Set(["RETIRED", "DONE"]);

export function isTerminal(state: SwarmState): boolean {
  return TERMINAL.has(state);
}

export function leaseExpired(record: ControlRecord, nowSec: number): boolean {
  return record.leaseUntil === undefined || nowSec >= record.leaseUntil;
}

/** Default claim lease: long enough to allocate a box + confirm a successor, short enough to recover a dead owner. */
export const DEFAULT_LEASE_SEC = 300;
/** Checkpoint thresholds (seconds before deadline) for the supervisor's near-death safety push. */
export const CHECKPOINT_THRESHOLDS_SEC = [300, 120] as const;

/**
 * Apply an event to a record, enforcing legal transitions. Pure + immutable: returns a NEW record or an error.
 * Illegal transitions are rejected (not silently coerced) so a buggy/duplicated event can't corrupt the chain.
 */
export function advance(record: ControlRecord, event: ControlEvent, nowSec: number): AdvanceResult {
  const base = { ...record, updatedAt: nowSec };
  const bad = (error: string): AdvanceResult => ({ ok: false, error });
  const ok = (patch: Partial<ControlRecord>): AdvanceResult => ({ ok: true, record: { ...base, ...patch } });

  if (isTerminal(record.state)) return bad(`terminal state ${record.state} accepts no events`);

  switch (event.type) {
    case "milestone":
      // Routine save: record the confirmed sha, stay RUNNING. Legal only while actively running.
      if (record.state !== "RUNNING") return bad(`milestone only in RUNNING, not ${record.state}`);
      return ok({ sha: event.sha, manifest: event.manifest ?? record.manifest });
    case "drain":
      if (record.state === "DRAINING") return ok({}); // idempotent
      if (record.state !== "RUNNING") return bad(`drain only from RUNNING, not ${record.state}`);
      return ok({ state: "DRAINING" });
    case "checkpoint":
      // Final (post-drain) checkpoint = the handoff cue.
      if (record.state !== "DRAINING") return bad(`final checkpoint only from DRAINING, not ${record.state}`);
      return ok({ state: "CHECKPOINTED", sha: event.sha, manifest: event.manifest ?? record.manifest });
    case "claim":
      if (record.state !== "CHECKPOINTED" && record.state !== "EXPIRED")
        return bad(`claim only from CHECKPOINTED/EXPIRED, not ${record.state}`);
      return ok({ state: "CLAIMED", owner: event.owner, generation: event.generation, leaseUntil: event.leaseUntil });
    case "reclaim":
      // Take over a CLAIMED/ALLOCATING record whose owner's lease lapsed (owner crashed/partitioned).
      if (record.state !== "CLAIMED" && record.state !== "ALLOCATING")
        return bad(`reclaim only from CLAIMED/ALLOCATING, not ${record.state}`);
      if (!leaseExpired(record, nowSec)) return bad("reclaim rejected: lease still valid");
      return ok({ state: "CLAIMED", owner: event.owner, generation: event.generation, leaseUntil: event.leaseUntil, attempt: undefined });
    case "allocating":
      if (record.state !== "CLAIMED") return bad(`allocating only from CLAIMED, not ${record.state}`);
      return ok({ state: "ALLOCATING", attempt: event.attempt });
    case "resumed":
      if (record.state !== "ALLOCATING") return bad(`resumed only from ALLOCATING, not ${record.state}`);
      return ok({ state: "RESUMED", successor: event.successor, sha: event.sha });
    case "retire":
      if (record.state !== "RESUMED") return bad(`retire only from RESUMED, not ${record.state}`);
      return ok({ state: "RETIRED" });
    case "done":
      if (record.state !== "RUNNING" && record.state !== "DRAINING" && record.state !== "CHECKPOINTED")
        return bad(`done only from RUNNING/DRAINING/CHECKPOINTED, not ${record.state}`);
      return ok({ state: "DONE", sha: event.sha });
    case "expire":
      // Any non-terminal state can expire (box died). Preserve the last confirmed sha for successor allocation.
      return ok({ state: "EXPIRED", lastConfirmedSha: event.lastConfirmedSha ?? record.sha });
  }
}

export type DispatchAction =
  | "none"
  | "claim"
  | "reclaim"
  | "allocate"
  | "await_resume"
  | "retire_predecessor";

export type DispatchContext = {
  /** This dispatcher instance id. */
  self: string;
  /** Global cap on concurrent boxes. */
  cap: number;
  /** Current count of live boxes (RUNNING/DRAINING/... non-terminal, incl. in-flight allocations). */
  liveCount: number;
};

/**
 * What the single-active dispatcher should attempt next for one record, given the clock + cap. Pure decision; the
 * IO layer performs it under an expected-OID conditional write and re-reads on CAS failure. A claim/reclaim is the
 * ONLY slot-consuming step, so the cap is enforced there.
 */
export function nextAction(record: ControlRecord, nowSec: number, ctx: DispatchContext): DispatchAction {
  if (isTerminal(record.state)) return "none";
  const slotFree = ctx.liveCount < ctx.cap;

  switch (record.state) {
    case "RUNNING":
    case "DRAINING":
      return "none"; // box is managing itself; wait for CHECKPOINTED (handoff cue) or EXPIRED
    case "CHECKPOINTED":
    case "EXPIRED":
      return slotFree ? "claim" : "none"; // needs a successor; consume a slot only if the cap allows
    case "CLAIMED":
      if (record.owner === ctx.self && !leaseExpired(record, nowSec)) return "allocate";
      if (leaseExpired(record, nowSec)) return slotFree ? "reclaim" : "none";
      return "none"; // held by someone else with a valid lease
    case "ALLOCATING":
      if (record.owner === ctx.self && !leaseExpired(record, nowSec)) return "await_resume";
      if (leaseExpired(record, nowSec)) return slotFree ? "reclaim" : "none";
      return "none";
    case "RESUMED":
      return "retire_predecessor"; // successor confirmed; safe to retire+scrub the old box
    default:
      return "none";
  }
}

/**
 * Dispatcher-side liveness estimate for a box, from wall clocks with a skew allowance. Conservative: a box is
 * "likely dead" only once now exceeds its deadline PLUS the allowance (never retire early on a fast dispatcher
 * clock). The box itself uses a monotonic sleep-accumulator for its own deadline — this is only the dispatcher's
 * outside view for recovery decisions.
 */
export function likelyExpired(record: ControlRecord, nowSec: number, skewSec = 120): boolean {
  return nowSec > record.allocStart + record.budgetSec + skewSec;
}

/** Thresholds newly crossed (<= remaining) and not yet fired; most-urgent first. Caller records all returned as fired. */
export function thresholdsDue(
  remainingSec: number,
  fired: ReadonlySet<number>,
  thresholds: readonly number[] = CHECKPOINT_THRESHOLDS_SEC,
): number[] {
  return thresholds.filter((t) => remainingSec <= t && !fired.has(t)).sort((a, b) => a - b);
}

// --- Bus message prefixes + parsing (the structured handoff contract; not free text) ---

export const SWARM_CHECKPOINT_PREFIX = "[[swarm:checkpoint]] ";
export const SWARM_RESUME_PREFIX = "[[swarm:resume]] ";
export const SWARM_HANDOFF_PREFIX = "NEED HANDOFF:";

export type Handoff = { summary: string; repo?: string; branch?: string; sha?: string };

/** Parse a worker's `NEED HANDOFF: goal=... next=... repo=owner/repo@branch sha=<hex>` broadcast. */
export function parseHandoff(text: string): Handoff | null {
  const i = text.indexOf(SWARM_HANDOFF_PREFIX);
  if (i < 0) return null;
  const body = text.slice(i + SWARM_HANDOFF_PREFIX.length).trim();
  if (!body) return null;
  const repoMatch = /\brepo=(\S+)/.exec(body);
  const shaMatch = /\bsha=([0-9a-fA-F]{7,64})\b/.exec(body);
  let repo: string | undefined;
  let branch: string | undefined;
  if (repoMatch) {
    const [r, b] = repoMatch[1]!.split("@");
    repo = r;
    branch = b;
  }
  return { summary: body, repo, branch, sha: shaMatch?.[1] };
}
