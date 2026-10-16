/**
 * Soak evidence surfaces (liveness-tier §3; swarm-soak r2 needs a TIMED positive record over the whole window, or a row stays UNKNOWN).
 * Append-only JSON lines under ~/.agenthop/swarm/soak/, one record per sweep round, ISO time first:
 *   inbox-oldest.jsonl  {ts, box, oldest_age_s, live_owner, reason?}   — the inbox sentinel's view of the coordinator role box
 *   bridge-tick.jsonl   {ts, tick, moved, outcome}                     — the bridge sweep's mirror tick each round
 * A record that could not be measured says so (oldest_age_s: null + reason; tick: null) — never a made-up value.
 * Writing is best-effort for the SWEEP (it never throws into the caller) but a failure is REPORTED once per surface per
 * episode: `appendEvidence` returns false and the caller sends one S19; the next successful write re-arms the report.
 * Pure record builders + one tiny appender.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type InboxOldestRecord = { ts: string; box: string; oldest_age_s: number | null; live_owner: boolean | null; reason?: string };
export type BridgeTickRecord = { ts: string; tick: number | null; moved: boolean | null; outcome: string };

/** The role box's oldest unclaimed mail age. `oldestMtimeSec` null = the box could not be read (reason says why); an empty box = 0. */
export function inboxOldestRecord(nowMs: number, box: string, pending: { mtimeSec: number }[] | null, liveOwner: boolean | null, reason?: string): InboxOldestRecord {
  const ts = new Date(nowMs).toISOString();
  if (pending === null) return { ts, box, oldest_age_s: null, live_owner: liveOwner, reason: reason ?? "box unreadable" };
  const oldest = pending.length ? Math.min(...pending.map((p) => p.mtimeSec)) : null;
  return { ts, box, oldest_age_s: oldest === null ? 0 : Math.max(0, Math.round(nowMs / 1000 - oldest)), live_owner: liveOwner };
}

/** One bridge round: the mirror tick read this round (null = unreadable), whether it moved since the last READ tick, and the tick's
 *  outcome word. `moved` is null when either side is unknown (no previous read, or this one failed). */
export function bridgeTickRecord(nowMs: number, tick: number | null, prevTick: number | null, outcome: string): BridgeTickRecord {
  return { ts: new Date(nowMs).toISOString(), tick, moved: tick === null || prevTick === null ? null : tick !== prevTick, outcome };
}

export const soakDir = (home: string) => path.join(home, ".agenthop", "swarm", "soak");

/** Append one JSON line. Never throws; false = not written (the caller reports it once). */
export function appendEvidence(home: string, file: "inbox-oldest.jsonl" | "bridge-tick.jsonl", rec: object): boolean {
  try {
    mkdirSync(soakDir(home), { recursive: true, mode: 0o700 });
    appendFileSync(path.join(soakDir(home), file), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** One S19 per failure episode per surface: true ⇒ report now. A success clears the episode. Mutates `st`. Pure otherwise. */
export function shouldReportEvidenceFailure(st: Set<string>, file: string, ok: boolean): boolean {
  if (ok) { st.delete(file); return false; }
  if (st.has(file)) return false;
  st.add(file); return true;
}
