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

export type WaitOutcome = { state: AgentState; outcome: "reached" | "timeout" | "error" };
export type WatchCfg = { fakeDeathSec: number; idleTimeoutSec: number; reArmSec: number; doneWakeSec: number; sampleSec: number; backoffSec: number };

/** Per-member IO, injected so the state machine is testable with no herdr and no real clock. Decisions use only VERIFIED
 *  signals: `state` (agent list), `contentHash` (a hash of the current pane content — the new-output evidence, LS2), and the
 *  `waitLeave` OUTCOME (reached/timeout/error, LS3). `paneId` is re-resolved each cycle so a rebind is followed (LS2b).
 *  `waitOutput` is only a bounded inter-sample BLOCK (its match is NOT trusted as progress). */
export interface WatchOps {
  state(): Promise<AgentState>;
  paneId(): Promise<string | null>;                                            // fresh each cycle (LS2b)
  contentHash(pane: string): Promise<string | null>;                           // hash of current pane content; null = read FAILED (not evidence, LS2)
  waitOutput(pane: string, timeoutSec: number): Promise<"output" | "timeout" | "error">; // bounded block only
  waitLeave(from: AgentState, timeoutSec: number): Promise<WaitOutcome>;       // block until state != from; reports the outcome (LS3)
  explain(): Promise<string>;
  emit(ev: SentinelEvent): void;
  now(): number;                                                               // epoch sec (silent-duration)
  sleep(sec: number): Promise<void>;                                           // bounded backoff
  stopped(): boolean;
}

/** The per-member watch loop (herdr-identified members). One blocking wait per step; branches on the VERIFIED state:
 *   blocked → explain + emit once, then block until it leaves blocked (bounded re-arm; a wait error backs off, LS3).
 *   working → sample the pane CONTENT HASH on a fresh pane (LS2/LS2b): a change resets the silence clock; no change for
 *             fakeDeathSec of REAL elapsed time ⇒ fake-death. Between samples, block on pane wait-output (positional, LS1)
 *             for sampleSec; a wait ERROR backs off instead of spinning (LS1 bounded retry). The content hash — not the
 *             wait-output match — is the progress truth, so a stale-buffer match cannot keep a hung member alive.
 *   idle → block until it leaves idle; only a REAL timeout still-idle emits idle-timeout; a wait error backs off (LS3).
 *   done/unknown → block until active again (error ⇒ backoff).
 *  Runs until ops.stopped(). Pure over the injected ops. */
export async function superviseMember(name: string, ops: WatchOps, cfg: WatchCfg): Promise<void> {
  let lastHash: string | null = null;
  let silentSince = ops.now();
  const resetSilence = (): void => { lastHash = null; silentSince = ops.now(); };
  while (!ops.stopped()) {
    const st = await ops.state();
    if (ops.stopped()) break;
    if (st === "blocked") {
      const explain = await ops.explain();
      ops.emit({ kind: "blocked", member: name, explain });
      const r = await ops.waitLeave("blocked", cfg.reArmSec); // escalate once; re-arm only after it unblocks
      if (r.outcome === "error") await ops.sleep(cfg.backoffSec);
      resetSilence();
      continue;
    }
    if (st === "working") {
      const pane = await ops.paneId(); // LS2b: a rebind is followed (never a stale cached pane)
      if (pane === null) { const r = await ops.waitLeave("working", cfg.sampleSec); if (r.outcome === "error") await ops.sleep(cfg.backoffSec); continue; }
      const h = await ops.contentHash(pane); // LS2: NEW-output evidence, not a stale-buffer match
      if (h === null) { await ops.sleep(cfg.sampleSec); continue; } // LS2: a FAILED read is not progress evidence — floor + retry, no silence move, no emit
      const t = ops.now();
      if (h !== lastHash) { lastHash = h; silentSince = t; } // new output ⇒ reset the silence clock
      else if (t - silentSince >= cfg.fakeDeathSec) {
        if (ops.stopped()) break;
        if ((await ops.state()) === "working") { ops.emit({ kind: "fake-death", member: name, silentSec: t - silentSince }); silentSince = t; } // LS2: re-check state (may have left working / been cancelled during sampling)
      }
      const r = await ops.waitOutput(pane, cfg.sampleSec); // bounded inter-sample block (positional pane, LS1)
      if (r !== "timeout") await ops.sleep(cfg.backoffSec); // LS2: sample-rate floor — a stale instant match / error must not drive rapid resampling (LS1 backoff kept)
      continue;
    }
    if (st === "idle") {
      const r = await ops.waitLeave("idle", cfg.idleTimeoutSec);
      if (r.outcome === "timeout" && r.state === "idle") ops.emit({ kind: "idle-timeout", member: name, idleSec: cfg.idleTimeoutSec }); // LS3: ONLY a real timeout
      else if (r.outcome === "error") await ops.sleep(cfg.backoffSec);
      resetSilence();
      continue;
    }
    const r = await ops.waitLeave(st, cfg.doneWakeSec); // done / unknown ⇒ block until active again
    if (r.outcome === "error") await ops.sleep(cfg.backoffSec);
    resetSilence();
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
