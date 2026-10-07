/**
 * live-sentinel (S14) — the dispatcher's live member sentinel, driven by herdr's BLOCKING primitives (not tick-polling):
 *   - primitive ① `agent wait --until` (herdrWait/waitLeave): block until a member leaves its state; the idle / done-wake watch.
 *   - primitive ② `pane wait-output` (herdrWaitOutput): block until the pane emits; a WORKING member that prints nothing
 *     before the timeout is a fake-death.
 *   - primitive ④ `agent explain` (herdrExplain): characterize a block for the S19 approval.
 * (primitive ③ `agent prompt --wait` / herdrPromptWait is the decision inject-back, driven from the IO shell.)
 *
 * Two layers:
 *  - superviseMember: the per-member async STATE MACHINE over an injected WatchOps (one blocking wait per step, no racing ⇒
 *    no orphan child execs). herdr-IDENTIFIED members get this full watch. Pure logic over injected ops ⇒ unit-tested with
 *    scripted responses, no herdr and no real clock.
 *  - decideLiveSentinel: the PURE fallback for a bus-presence-only member herdr cannot wait on — it is covered for `blocked`
 *    (self-reported status) and `idle-timeout` (status-file age) only; no screen ⇒ no fake-death. Mirrors inbox-sentinel.ts.
 *
 * Decisions trust only VERIFIED signals (the agent-list state, the status file) — never an unparsed herdr wait receipt.
 */
import type { AgentState } from "./herdr.js";

export type SentinelKind = "blocked" | "fake-death" | "idle-timeout";

export type SentinelEvent =
  | { kind: "blocked"; member: string; explain: string }
  | { kind: "fake-death"; member: string; silentSec: number }
  | { kind: "idle-timeout"; member: string; idleSec: number };

export type WatchCfg = { fakeDeathSec: number; idleTimeoutSec: number; reArmSec: number; doneWakeSec: number };

/** Per-member IO, injected so the state machine is testable. All waits BLOCK (herdr-side) and return the member's CURRENT
 *  verified state; `waitOutput` returns only the coarse output/timeout/error classification. `stopped` is the abort check. */
export interface WatchOps {
  state(): Promise<AgentState>;
  waitLeave(from: AgentState, timeoutSec: number): Promise<AgentState>;      // block until state != from (or timeout) ⇒ current state
  waitOutput(timeoutSec: number): Promise<"output" | "timeout" | "error">;  // block until pane output (or timeout)
  explain(): Promise<string>;
  emit(ev: SentinelEvent): void;
  stopped(): boolean;
}

/** The per-member watch loop (herdr-identified members). One blocking wait per step; branches on the VERIFIED state:
 *   blocked  → explain + emit, then block until it leaves blocked (bounded re-arm) so a single block escalates once.
 *   working  → wait for output; a timeout with the member STILL working ⇒ fake-death emit (output / state-change ⇒ re-loop,
 *              which also catches a new block once its prompt renders).
 *   idle     → wait to leave idle; still idle after the timeout ⇒ idle-timeout emit.
 *   done/unknown → block until it becomes active again, then re-loop.
 *  Runs until ops.stopped(). Pure over the injected ops. */
export async function superviseMember(name: string, ops: WatchOps, cfg: WatchCfg): Promise<void> {
  while (!ops.stopped()) {
    const st = await ops.state();
    if (ops.stopped()) break;
    if (st === "blocked") {
      const explain = await ops.explain();
      ops.emit({ kind: "blocked", member: name, explain });
      await ops.waitLeave("blocked", cfg.reArmSec); // escalate once; re-arm only after it unblocks (bounded)
      continue;
    }
    if (st === "working") {
      const r = await ops.waitOutput(cfg.fakeDeathSec);
      if (r === "timeout") {
        if (ops.stopped()) break;
        if ((await ops.state()) === "working") ops.emit({ kind: "fake-death", member: name, silentSec: cfg.fakeDeathSec });
      }
      continue; // output / error / state-change ⇒ re-classify next loop
    }
    if (st === "idle") {
      const after = await ops.waitLeave("idle", cfg.idleTimeoutSec);
      if (after === "idle") ops.emit({ kind: "idle-timeout", member: name, idleSec: cfg.idleTimeoutSec });
      continue;
    }
    await ops.waitLeave(st, cfg.doneWakeSec); // done / unknown ⇒ block until active again
  }
}

// --- bus-presence-only fallback (members herdr cannot wait on) --------------------------------------------------------

/** One presence-only member's observation (no herdr screen). `idleSec` = status-file age when self-reported idle. */
export type MemberObs = { member: string; reportedStatus?: string; idleSec?: number };

export type SentinelCfg = { idleTimeoutSec: number };

export type SentinelAlert = { member: string; kind: SentinelKind; reason: string };

/** PURE fallback decision for presence-only members: blocked (self-report) or idle-timeout (status age past threshold). No
 *  screen ⇒ no fake-death. An undefined duration is never convicted (status age alone is not liveness). At most one per member. */
export function decideLiveSentinel(members: readonly MemberObs[], cfg: SentinelCfg): SentinelAlert[] {
  const out: SentinelAlert[] = [];
  for (const o of members) {
    if (o.reportedStatus === "blocked") { out.push({ member: o.member, kind: "blocked", reason: "self-reported blocked (not herdr-identified)" }); continue; }
    if (o.reportedStatus === "idle" && o.idleSec !== undefined && o.idleSec >= cfg.idleTimeoutSec) {
      out.push({ member: o.member, kind: "idle-timeout", reason: `self-reported idle with no check-in for ${o.idleSec}s (>= ${cfg.idleTimeoutSec}s)` });
    }
  }
  return out;
}
