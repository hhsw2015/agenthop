/**
 * L4 (long-run-liveness, 2026-10-16) — coordinator progress watch. The overnight stall had a LIVE coordinator (beat fresh) that did not
 * advance for 6.5h; the existing watchdogs only judge death (beat stale). This judges "alive but not advancing" from files alone
 * (I3: pure reads, constant time, no waiting, no external CLI):
 *   stalled ⇔ beat fresh (< BEAT_STALE_SEC) ∧ ( handoff mtime older than HANDOFF_STALE_SEC
 *                                             ∨ ≥ MAIL_MIN real (non-observer) unclaimed mails, the oldest older than MAIL_OLD_SEC )
 * A stale/absent beat is NOT reported here — that is death, owned by the existing paths (no double report).
 * Carly: carly-patrol.beat older than CARLY_STALE_SEC ⇒ alert.
 * Each alert fires once per DEDUP_SEC while it persists; when it clears, one "resolved" line. Pure core + injected IO.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { BEAT_STALE_SEC, readBeatSec, coordinatorBeatPath, carlyPatrolBeatPath } from "./carly-sweep.js";

export const HANDOFF_STALE_SEC = 2 * 3600;
export const MAIL_MIN = 3;
export const MAIL_OLD_SEC = 3600;
export const CARLY_STALE_SEC = 30 * 60;
export const DEDUP_SEC = 30 * 60;

export type ProgressFacts = {
  nowSec: number;
  beatSec: number | null;          // coordinator.beat (null = absent/unreadable)
  handoffMtimeSec: number | null;  // coordinator-handoff.md mtime (null = absent/unreadable)
  mails: Array<{ fromLabel: string; mtimeSec: number }> | null; // unclaimed mails in the coordinator role box (null = unreadable)
  carlyBeatSec: number | null;     // carly-patrol.beat
};
export type Alert = { key: "coordinator-stalled" | "carly-stale"; text: string };

/** Senders whose mail is machine traffic, not work waiting for the coordinator (the dispatcher's own notices). */
export const MACHINE_SENDERS: readonly string[] = ["swarm-observer", "swarm-sweep", "swarm-admission", "idle-explainer", "inbox-sentinel"];

const h = (s: number) => `${(s / 3600).toFixed(1)}h`;

/** Which alerts hold right now. Pure. A fact that cannot be read never PROVES a stall (FC-2): an unreadable handoff/box counts as
 *  "no evidence", not as "old". */
export function judgeProgress(f: ProgressFacts): Alert[] {
  const out: Alert[] = [];
  const beatFresh = f.beatSec !== null && f.nowSec - f.beatSec < BEAT_STALE_SEC;
  if (beatFresh) {
    const handoffAge = f.handoffMtimeSec === null ? null : f.nowSec - f.handoffMtimeSec;
    const real = (f.mails ?? []).filter((m) => !MACHINE_SENDERS.includes(m.fromLabel));
    const oldest = real.length ? f.nowSec - Math.min(...real.map((m) => m.mtimeSec)) : 0;
    const handoffStale = handoffAge !== null && handoffAge > HANDOFF_STALE_SEC;
    const boxStale = real.length >= MAIL_MIN && oldest > MAIL_OLD_SEC;
    if (handoffStale || boxStale) {
      out.push({ key: "coordinator-stalled", text: `[dispatcher] coordinator-stalled: beat fresh but no progress — handoff ${handoffAge === null ? "unreadable" : h(handoffAge)} old / `
        + `role box ${real.length} real mail(s), oldest ${h(oldest)} — continue the cycle per skill §1b; do not wait for the user` });
    }
  }
  if (f.carlyBeatSec === null || f.nowSec - f.carlyBeatSec > CARLY_STALE_SEC) {
    out.push({ key: "carly-stale", text: `[dispatcher] carly-stale: carly-patrol.beat ${f.carlyBeatSec === null ? "absent/unreadable" : `${h(f.nowSec - f.carlyBeatSec)} old`} (> ${CARLY_STALE_SEC / 60}min)` });
  }
  return out;
}

export type WatchState = { firedAt: Map<string, number> };
export function initialWatchState(): WatchState { return { firedAt: new Map() }; }

/** Decide what to emit this round: an alert fires when it starts and again every DEDUP_SEC while it holds; an alert that was active
 *  and no longer holds yields one "resolved". Mutates `st`. Pure otherwise. */
export function planEmits(st: WatchState, alerts: Alert[], nowSec: number): { fire: Alert[]; resolved: string[] } {
  const fire: Alert[] = [];
  const now = new Set<string>(alerts.map((a) => a.key));
  for (const a of alerts) {
    const last = st.firedAt.get(a.key);
    if (last === undefined || nowSec - last >= DEDUP_SEC) { fire.push(a); st.firedAt.set(a.key, nowSec); }
  }
  const resolved: string[] = [];
  for (const k of [...st.firedAt.keys()]) if (!now.has(k)) { resolved.push(k); st.firedAt.delete(k); }
  return { fire, resolved };
}

// ---------------- real IO ----------------
const mtimeSec = (f: string): number | null => { try { return Math.floor(statSync(f).mtimeMs / 1000); } catch { return null; } };

/** Unclaimed mails in a durable inbox dir: top-level *.json only (processed/ and dot-dirs are not unclaimed). null = unreadable. */
export function readBoxMails(dir: string): ProgressFacts["mails"] {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null; }
  const out: Array<{ fromLabel: string; mtimeSec: number }> = [];
  for (const n of names) {
    const f = path.join(dir, n);
    const m = mtimeSec(f);
    if (m === null) continue; // claimed between readdir and stat
    let label = "";
    try { const j = JSON.parse(readFileSync(f, "utf8")) as { fromLabel?: unknown }; label = typeof j.fromLabel === "string" ? j.fromLabel : ""; } catch { /* unreadable body still counts as real mail */ }
    out.push({ fromLabel: label, mtimeSec: m });
  }
  return out;
}

export function readProgressFacts(home: string, coordinatorBox: string | null, nowSec: number): ProgressFacts {
  return {
    nowSec,
    beatSec: readBeatSec(coordinatorBeatPath(home)),
    handoffMtimeSec: mtimeSec(path.join(home, ".agenthop", "swarm", "coordinator-handoff.md")),
    mails: coordinatorBox === null ? null : readBoxMails(path.join(home, ".agenthop", "inbox", coordinatorBox)),
    carlyBeatSec: readBeatSec(carlyPatrolBeatPath(home)),
  };
}

/** L0 alert file the Carly/TG side scans: ~/.agenthop/carly/alerts/<key>-<ts>.json (temp + rename). */
export function writeL0Alert(home: string, a: Alert, nowSec: number): string {
  const dir = path.join(home, ".agenthop", "carly", "alerts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = a.key.replace(/-/g, "_");
  const f = path.join(dir, `${key}-${nowSec}.json`);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ kind: key, ts: nowSec, source: "dispatcher", text: a.text })}\n`, { mode: 0o600 });
  renameSync(tmp, f);
  return f;
}

/** The Tern block whose process tree runs `sid` as its claude agent (fresh `--session-id` or `--resume`), via the same exact-argv
 *  resolver as presence. Pure over injected inventory: `blocks` = live (block id, root pid) pairs; `resolve(root)` = the agent pid
 *  for `sid` under that root or null. Exactly one block ⇒ its id; none or several ⇒ null (never guess where to type). */
export function blockForSession(blocks: Array<{ id: string; rootPid: number }>, resolve: (rootPid: number) => number | null): string | null {
  const hits = blocks.filter((b) => resolve(b.rootPid) !== null);
  return hits.length === 1 ? hits[0]!.id : null;
}
