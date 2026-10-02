/**
 * Swarm lifecycle control: the PURE state machine + coordination decisions behind phase-2 VM-lifetime management
 * and near-death handoff. No IO — every function is a pure, immutable transform so the crash-timeline cases from
 * Codex's two design reviews (dispatcher dies at each stage, claim winner crashes, lease expiry, allocation-result-
 * unknown, successor dies before/after ACK, over-cap, work-deadline != VM-destroyed) are unit-testable without
 * touching Railway / GitHub / the relay.
 *
 * SUBSTRATE LIMIT (Codex, confirmed): Railway allocation has no fencing/idempotency key, so Git CAS + lease can
 * serialize the RECORD but cannot stop a paused-then-resumed old instance from SSH-allocating, nor un-create a VM.
 * Exactly-once allocation / airtight single-active are impossible here. Scope (user-chosen) is therefore
 * AT-LEAST-ONCE with generation-ISOLATED OUTPUT: honest claim is "may duplicate, each VM eventually expires" and
 * "old output never overwrites ACCEPTED new output" — duplicate EXECUTION is not magically safe; shared
 * un-idempotent external side-effects are an explicit NON-GOAL. This module gives the record/decision logic;
 * output isolation + command rejection are enforced at the execution end (box/dispatcher), keyed on `generation`.
 *
 * The authoritative record for one launchId lives in a persistent GitHub CONTROL repo (written by a constrained
 * identity, never the worker's work token — the box publishes a RECEIPT to its own work space and the dispatcher
 * verifies + CAS-advances CONTROL). The IO layer enforces the expected-OID conditional update when it writes a
 * transition this module computed — a plain same-OID push is NOT a lock (Codex proved both writers exit 0).
 *
 * State chain:
 *   RUNNING -> DRAINING -> CHECKPOINTED(sha,manifest) -> CLAIMED(owner,gen) -> ALLOCATING(attempt) ->
 *   RESUMED(successor,sha) -> RETIRED
 * Branches: DONE(sha) (task finished), EXPIRED (VM died — VM-terminal, NOT task-terminal; `sha` stays the canonical
 * lease-timeout reclaim of a CLAIMED/ALLOCATING record (owner gone), and allocation-result-unknown (retained).
 *
 * RPO = milestone-based: a `milestone` event updates `sha` but KEEPS state RUNNING; only the post-DRAIN
 * `checkpoint` advances to CHECKPOINTED. RPO wording is "work after the last CONFIRMED checkpoint may be lost".
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
  /** Owner generation; bumped on each (re)claim so a stale predecessor can't act as the current owner. The
   *  execution end rejects any resume/retire/receipt whose generation != this. */
  generation: number;
  /** Last CONFIRMED immutable checkpoint sha (milestone or final). Undefined until the first confirmed push. */
  sha?: string;
  /** Opaque manifest ref/summary describing the recoverable artifact set at `sha`. */
  manifest?: string;
  /** Dispatcher instance id holding the claim (CLAIMED/ALLOCATING). */
  owner?: string;
  /** Epoch seconds the claim lease expires; past it, another dispatcher may reclaim. */
  leaseUntil?: number;
  /** Allocation attempt id. RETAINED across reclaim so an unknown-result allocation is reconciled, not re-fired. */
  attempt?: string;
  /** Count of allocation attempts for this task; gates the attempt cap so "may duplicate" stays bounded. */
  attemptCount?: number;
  /** An allocation whose result is UNKNOWN (response lost / dispatcher crashed mid-allocate). Retained until a
   *  reclaiming owner reconciles it — the slot is NOT freed on timeout alone. */
  resultUnknown?: boolean;
  /** Successor launchId recorded at RESUMED. */
  successor?: string;
  /** The expected resume SHA, PINNED at claim/reclaim for THIS handoff attempt. A later checkpoint advances `sha`
   *  but must NOT move the target a successor is being verified against (Codex). Undefined => no prior work. */
  handoffSha?: string;
  /** The generation the SUCCESSOR publishes at, PINNED at `allocating` (= the owner generation then). A later reclaim
   *  bumps `generation` (owner), but the already-allocated successor still publishes to swarm/<successor>-g<successorGen>,
   *  so reconcile / await-resume must observe THAT branch, not the bumped owner generation (Codex). */
  successorGen?: number;
  /** Lifetime base: epoch seconds of the allocation REQUEST start (not the alloc ACK — that is already late). */
  allocStart: number;
  /** Bounded lifetime budget (s) from allocStart; provider expiry if known, else conservative. */
  budgetSec: number;
  /** Absolute deadline for display/dispatcher view (the BOX uses CLOCK_BOOTTIME locally, not this wall value). */
  deadlineEpoch?: number;
  /** Epoch seconds of the last write. */
  updatedAt: number;
};

// `sha` on milestone/checkpoint/done is the published git commit on the WORK branch. Ordering + no-rollback is NOT
// enforced here (git ancestry can't be checked in a pure fn): the DISPATCHER verifies, for the pinned SHA it
// fetched, that it is a descendant of the last-accepted sha (merge-base --is-ancestor) and the current generation,
// BEFORE emitting these events. See the git-channel pivot (docs/swarm/phase2-design-review*.md).
export type ControlEvent =
  | { type: "milestone"; sha: string; manifest?: string }
  | { type: "drain" }
  | { type: "checkpoint"; sha: string; manifest?: string }
  | { type: "claim"; owner: string; generation: number; leaseUntil: number }
  | { type: "reclaim"; owner: string; generation: number; leaseUntil: number }
  | { type: "allocating"; attempt: string; successor?: string }
  | { type: "alloc_unknown" }
  // alloc_failed: a RELIABLE clean failure (provider refused; box definitively NOT created) — clear attempt+successor,
  // back to CLAIMED for an immediate fresh allocate (attemptCount kept, so the cap still bounds retries). An UNKNOWN
  // result uses alloc_unknown instead (retained, reconciled later).
  | { type: "alloc_failed" }
  // reconcile a reclaimed in-flight allocation: its box was found DEAD (clear the attempt, allocate fresh) or ALIVE
  // (re-enter the await-resume wait reusing the SAME attempt — "alive" is NOT recovery-complete; only a real
  // `resumed` ACK with the expected generation/attempt/sha finishes the handoff).
  | { type: "reconcile_dead" }
  | { type: "reconcile_alive" }
  | { type: "resumed"; successor: string; sha: string; generation: number; attempt: string }
  | { type: "retire" }
  | { type: "done"; sha: string }
  | { type: "expire" }
  // A newer confirmed WORK-branch tip observed AFTER the VM already EXPIRED: advance the canonical `sha` so a
  // successor resumes from the newest confirmed work (Codex #10). VM stays terminal; the dispatcher ancestry-guards
  // the new sha, so it only moves forward and re-expire can never regress it.
  | { type: "recover_sha"; sha: string };

export type AdvanceResult = { ok: true; record: ControlRecord } | { ok: false; error: string };

/** Truly terminal for RECOVERY: a task here needs nothing more. EXPIRED is deliberately NOT here (VM died but the
 *  task may be unfinished — it must stay in the recovery scan). */
const TASK_TERMINAL: ReadonlySet<SwarmState> = new Set(["RETIRED", "DONE"]);
/** States that accept no further events at all. */
const FROZEN: ReadonlySet<SwarmState> = new Set(["RETIRED", "DONE"]);

export function isTerminal(state: SwarmState): boolean {
  return TASK_TERMINAL.has(state);
}

/** A record the dispatcher's startup scan must still act on: anything not RETIRED/DONE — crucially incl. EXPIRED. */
export function needsRecovery(record: ControlRecord): boolean {
  return !TASK_TERMINAL.has(record.state);
}

export function leaseExpired(record: ControlRecord, nowSec: number): boolean {
  return record.leaseUntil === undefined || nowSec >= record.leaseUntil;
}

/** Execution-end fence: a resume/retire command or a receipt is honored only for the CURRENT generation. */
export function isCurrentGeneration(record: ControlRecord, generation: number): boolean {
  return generation === record.generation;
}

/** Default claim lease: long enough to allocate a box + confirm a successor, short enough to recover a dead owner. */
export const DEFAULT_LEASE_SEC = 300;
/** Per-task allocation attempt cap so at-least-once stays BOUNDED (not an infinite realloc loop). */
export const MAX_ALLOC_ATTEMPTS = 3;
/** Checkpoint thresholds (seconds before deadline) for the supervisor's near-death safety push. */
export const CHECKPOINT_THRESHOLDS_SEC = [300, 120] as const;

export function allocExhausted(record: ControlRecord, cap = MAX_ALLOC_ATTEMPTS): boolean {
  return (record.attemptCount ?? 0) >= cap;
}

/**
 * Apply an event to a record, enforcing legal transitions. Pure + immutable: returns a NEW record or an error.
 * Illegal/stale events are rejected (not silently coerced) so a duplicated or superseded event can't corrupt the
 * chain or roll back a confirmed sha.
 */
export function advance(record: ControlRecord, event: ControlEvent, nowSec: number): AdvanceResult {
  const base = { ...record, updatedAt: nowSec };
  const bad = (error: string): AdvanceResult => ({ ok: false, error });
  const ok = (patch: Partial<ControlRecord>): AdvanceResult => ({ ok: true, record: { ...base, ...patch } });

  if (FROZEN.has(record.state)) return bad(`state ${record.state} is terminal and accepts no events`);

  switch (event.type) {
    case "milestone":
      // No-rollback/ordering is the dispatcher's job (git ancestry, pre-checked). Here: record the confirmed sha.
      if (record.state !== "RUNNING") return bad(`milestone only in RUNNING, not ${record.state}`);
      return ok({ sha: event.sha, manifest: event.manifest ?? record.manifest });
    case "drain":
      if (record.state === "DRAINING") return ok({}); // idempotent
      if (record.state !== "RUNNING") return bad(`drain only from RUNNING, not ${record.state}`);
      return ok({ state: "DRAINING" });
    case "checkpoint":
      if (record.state !== "DRAINING") return bad(`final checkpoint only from DRAINING, not ${record.state}`);
      return ok({ state: "CHECKPOINTED", sha: event.sha, manifest: event.manifest ?? record.manifest });
    case "claim":
      if (record.state !== "CHECKPOINTED" && record.state !== "EXPIRED")
        return bad(`claim only from CHECKPOINTED/EXPIRED, not ${record.state}`);
      // handoffSha is NOT pinned here — it is pinned per ATTEMPT at `allocating` (Codex #4). A claim/reclaim is an
      // ownership change, not a new successor; re-pinning here would move the target out from under an in-flight
      // attempt (e.g. after EXPIRED+recover, a still-alive attempt that resumed from the OLD sha would be wrongly
      // rejected). base preserves any existing handoffSha.
      return ok({ state: "CLAIMED", owner: event.owner, generation: event.generation, leaseUntil: event.leaseUntil });
    case "reclaim": {
      // Take over a CLAIMED/ALLOCATING record whose owner's lease lapsed. RETAIN attempt/attemptCount/resultUnknown
      // AND handoffSha (base preserves them) so the new owner RECONCILES the SAME in-flight attempt against its
      // original pinned target, instead of blind-retrying or re-pinning.
      if (record.state !== "CLAIMED" && record.state !== "ALLOCATING")
        return bad(`reclaim only from CLAIMED/ALLOCATING, not ${record.state}`);
      if (!leaseExpired(record, nowSec)) return bad("reclaim rejected: lease still valid");
      return ok({ state: "CLAIMED", owner: event.owner, generation: event.generation, leaseUntil: event.leaseUntil });
    }
    case "allocating":
      if (record.state !== "CLAIMED") return bad(`allocating only from CLAIMED, not ${record.state}`);
      if (record.attempt !== undefined) return bad("allocating blocked: a prior in-flight attempt must be reconciled first");
      if (allocExhausted(record)) return bad(`allocation attempt cap (${MAX_ALLOC_ATTEMPTS}) reached`);
      // PIN handoffSha to the CURRENT canonical sha for THIS new attempt (Codex #4): the successor this attempt
      // creates is told to resume from here; a later recover_sha advancing `sha` must NOT move this attempt's target.
      // The successor launchId is pinned here too (per-attempt), so a dispatcher restart re-reads WHICH box is taking
      // over from the mirror instead of a lost in-memory side-map. resumed later re-asserts the same successor.
      return ok({ state: "ALLOCATING", attempt: event.attempt, attemptCount: (record.attemptCount ?? 0) + 1, resultUnknown: false, handoffSha: record.sha, successorGen: record.generation, ...(event.successor ? { successor: event.successor } : {}) });
    case "alloc_unknown":
      // Allocation request sent, result unknown. Stay ALLOCATING; mark it so a reclaimer reconciles this attempt.
      if (record.state !== "ALLOCATING") return bad(`alloc_unknown only from ALLOCATING, not ${record.state}`);
      return ok({ resultUnknown: true });
    case "alloc_failed":
      // RELIABLE clean failure (box definitively NOT created): clear attempt/successor/successorGen back to CLAIMED so a
      // fresh allocate runs immediately. attemptCount is KEPT (the cap still bounds retries). NOT for unknown results.
      if (record.state !== "ALLOCATING") return bad(`alloc_failed only from ALLOCATING, not ${record.state}`);
      return ok({ state: "CLAIMED", attempt: undefined, successor: undefined, successorGen: undefined, resultUnknown: false });
    case "reconcile_dead":
      // Reconcile found the in-flight allocation's box DEAD: clear the attempt so a fresh allocate can proceed.
      if (record.state !== "CLAIMED" || record.attempt === undefined) return bad(`reconcile_dead needs CLAIMED with an attempt, not ${record.state}`);
      return ok({ attempt: undefined, resultUnknown: false });
    case "reconcile_alive":
      // Reconcile found the in-flight box ALIVE. That is NOT recovery-complete (Codex): re-enter the await-resume
      // wait reusing the SAME attempt (no attemptCount bump). Only a real `resumed` ACK carrying the expected
      // generation/attempt/sha finishes the handoff.
      if (record.state !== "CLAIMED" || record.attempt === undefined) return bad(`reconcile_alive needs CLAIMED with an attempt, not ${record.state}`);
      return ok({ state: "ALLOCATING" });
    case "resumed": {
      if (record.state !== "ALLOCATING") return bad(`resumed only from ALLOCATING, not ${record.state}`);
      // Reject a stale successor's ACK: it must match the CURRENT generation AND the CURRENT attempt...
      if (event.generation !== record.generation) return bad(`resumed generation ${event.generation} != ${record.generation}`);
      if (event.attempt !== record.attempt) return bad(`resumed attempt ${event.attempt} != ${record.attempt}`);
      // ...and it must have resumed from the sha we PINNED for this handoff attempt (handoffSha), NOT the live sha,
      // so a late checkpoint cannot silently change this ACK's target (Codex). Undefined handoffSha = no prior work,
      // successor starts fresh, any sha accepted.
      if (record.handoffSha !== undefined && event.sha !== record.handoffSha) return bad(`resumed sha ${event.sha} != pinned handoff ${record.handoffSha}`);
      // Do NOT move `sha`: it is the canonical confirmed checkpoint (may be NEWER than handoffSha after a recover).
      // The successor is a separate record that progresses from handoffSha; writing event.sha here could regress the
      // canonical anchor (Codex #4). Just record the successor.
      return ok({ state: "RESUMED", successor: event.successor });
    }
    case "retire":
      if (record.state !== "RESUMED") return bad(`retire only from RESUMED, not ${record.state}`);
      return ok({ state: "RETIRED" });
    case "done":
      if (record.state !== "RUNNING" && record.state !== "DRAINING" && record.state !== "CHECKPOINTED")
        return bad(`done only from RUNNING/DRAINING/CHECKPOINTED, not ${record.state}`);
      return ok({ state: "DONE", sha: event.sha });
    case "expire":
      // Any non-frozen state can expire (box died). `sha` is already the last confirmed checkpoint — leave it as the
      // single canonical recovery anchor (re-expire therefore cannot regress it).
      return ok({ state: "EXPIRED" });
    case "recover_sha":
      if (record.state !== "EXPIRED") return bad(`recover_sha only in EXPIRED, not ${record.state}`);
      return ok({ sha: event.sha }); // dispatcher ancestry-guards, so this only advances
  }
}

export type DispatchAction =
  | "none"
  | "claim"
  | "reclaim"
  | "reconcile"
  | "allocate"
  | "await_resume"
  | "retire_predecessor"
  | "give_up";

export type DispatchContext = {
  /** This dispatcher instance id. */
  self: string;
  /** Global cap on concurrent boxes. */
  cap: number;
  /** Current count of live boxes (non-terminal, incl. in-flight allocations). */
  liveCount: number;
};

/**
 * What the single-active dispatcher should attempt next for one record, given the clock + cap. Pure decision; the
 * IO layer performs it under an expected-OID conditional write and re-reads on CAS failure. A claim/reclaim is the
 * only slot-consuming step, so the cap is enforced there. `reconcile` means an in-flight allocation (attempt set)
 * must be checked BEFORE any new allocate; `give_up` means the attempt cap is hit (dispatcher should alert + park).
 */
export function nextAction(record: ControlRecord, nowSec: number, ctx: DispatchContext): DispatchAction {
  if (isTerminal(record.state)) return "none";
  const slotFree = ctx.liveCount < ctx.cap;

  switch (record.state) {
    case "RUNNING":
    case "DRAINING":
      return "none"; // box manages itself; wait for CHECKPOINTED (handoff cue) or EXPIRED
    case "CHECKPOINTED":
    case "EXPIRED":
      // An in-flight attempt (retained across expire) must still be RECONCILED even at the cap — the attempt cap
      // forbids a NEW allocation, not CHECKING whether the Nth VM is actually alive (Codex #5). Claim to take
      // ownership (claim preserves the attempt), then the CLAIMED branch returns "reconcile". NOT slotFree-gated
      // (Codex P2): claiming to reconcile an ALREADY-counted reservation is not a new slot, so gating it on
      // slotFree deadlocked an at-cap EXPIRED/CHECKPOINTED record (reconcile could never run to free the slot).
      if (record.attempt !== undefined) return "claim";
      if (allocExhausted(record)) return "give_up";
      return slotFree ? "claim" : "none";
    case "CLAIMED":
      if (record.owner === ctx.self && !leaseExpired(record, nowSec)) {
        if (record.attempt !== undefined) return "reconcile"; // carried over from a reclaimed in-flight alloc
        if (allocExhausted(record)) return "give_up";
        return "allocate";
      }
      // Reclaim takes over an ALREADY-counted reservation — it does NOT consume a new slot, so it is NOT cap-gated.
      if (leaseExpired(record, nowSec)) return "reclaim";
      return "none"; // held by someone else with a valid lease
    case "ALLOCATING":
      if (record.owner === ctx.self && !leaseExpired(record, nowSec)) return "await_resume";
      if (leaseExpired(record, nowSec)) return "reclaim";
      return "none";
    case "RESUMED":
      return "retire_predecessor"; // successor confirmed; safe to retire+scrub the old box
    default:
      return "none";
  }
}

/**
 * Dispatcher-side liveness estimate from wall clocks with a skew allowance. Conservative: "likely dead" only once
 * now exceeds deadline PLUS the allowance — a work-deadline is NOT proof the physical VM is destroyed, so this must
 * never be used to free a physical slot early (Codex pass 2). The box itself uses CLOCK_BOOTTIME for its own
 * deadline; this is only the dispatcher's outside estimate.
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

export type Handoff = { summary: string; repo?: string; branch?: string; sha?: string; generation?: number };

/** Parse a worker's `NEED HANDOFF: goal=... next=... repo=owner/repo@branch sha=<hex> gen=<n>` broadcast. */
export function parseHandoff(text: string): Handoff | null {
  const i = text.indexOf(SWARM_HANDOFF_PREFIX);
  if (i < 0) return null;
  const body = text.slice(i + SWARM_HANDOFF_PREFIX.length).trim();
  if (!body) return null;
  const repoMatch = /\brepo=(\S+)/.exec(body);
  const shaMatch = /\bsha=([0-9a-fA-F]{7,64})\b/.exec(body);
  const genMatch = /\bgen=(\d+)\b/.exec(body);
  let repo: string | undefined;
  let branch: string | undefined;
  if (repoMatch) {
    const [r, b] = repoMatch[1]!.split("@");
    repo = r;
    branch = b;
  }
  return { summary: body, repo, branch, sha: shaMatch?.[1], generation: genMatch ? Number(genMatch[1]) : undefined };
}
