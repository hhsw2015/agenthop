/**
 * L4 (long-run-liveness, 2026-10-16) — coordinator progress watch. The overnight stall had a LIVE coordinator (beat fresh) that did not
 * advance for 6.5h; the existing watchdogs only judge death (beat stale). This judges "alive but not advancing" from files alone
 * (I3: pure reads, constant time, no waiting):
 *   stalled ⇔ beat fresh (< BEAT_STALE_SEC) ∧ ( handoff mtime older than HANDOFF_STALE_SEC
 *                                             ∨ ≥ MAIL_MIN real unclaimed mails, the oldest older than MAIL_OLD_SEC )
 * A stale/absent beat is NOT reported here — that is death, owned by the existing paths (no double report).
 * Carly: carly-patrol.beat older than CARLY_STALE_SEC ⇒ alert.
 *
 * r2 (Chief Review 0582ae3 + Second Voice be7f170):
 *   - three-state facts: a source that cannot be read is UNKNOWN, never "fine" and never "stalled" (PW-SOURCE-UNKNOWN). A judgement
 *     is "on" / "off" / "unknown" per alert; "unknown" keeps whatever episode is open and never emits "resolved".
 *   - real mail is decided from the message's own sender fields (`from` / `fromLabel`); a message whose sender cannot be read is
 *     UNKNOWN, so it can neither make nor break the ≥ MAIL_MIN threshold on its own.
 *   - delivery is committed only on success (PW-EMIT-COMMIT): an episode stays OWED until at least one surface delivered; owed
 *     retries back off (RETRY_SEC) instead of waiting out the 30min re-alert window. The same holds for the "resolved" notice
 *     (r3, PW-EMIT-COMMIT-RESOLVE): recovery and its notice are tracked apart; the notice stays owed until delivered.
 *   - r3: every read is bounded (regular files only, non-blocking, capped size/count, deadline) and the block lookup holds unless
 *     uniqueness is proven over the whole inventory (PW-LOCATOR-UNKNOWN).
 * Each delivered alert re-fires every DEDUP_SEC while it holds; one "resolved" only on affirmative recovery. Pure core + injected IO.
 */
import { readdirSync, readFileSync, statSync, lstatSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, renameSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { BEAT_STALE_SEC, coordinatorBeatPath, carlyPatrolBeatPath } from "./carly-sweep.js";
import type { Resolved } from "./seat-presence.js";

export const HANDOFF_STALE_SEC = 2 * 3600;
export const MAIL_MIN = 3;
export const MAIL_OLD_SEC = 3600;
export const CARLY_STALE_SEC = 30 * 60;
export const DEDUP_SEC = 30 * 60;
export const RETRY_SEC = 60;

/** A fact read three ways: a value, "absent" (ENOENT — a real, known absence), or "unknown" (it exists but could not be read). */
export type Fact<T> = T | "absent" | "unknown";
export type Mail = { sender: string | null; mtimeSec: number }; // sender null = unreadable body ⇒ unknown provenance
export type ProgressFacts = {
  nowSec: number;
  beatSec: Fact<number>;
  handoffMtimeSec: Fact<number>;
  mails: Fact<Mail[]>;
  carlyBeatSec: Fact<number>;
};
export type AlertKey = "coordinator-stalled" | "carly-stale";
/** `mark` = a monotone progress marker (coordinator: handoff mtime; carly: her beat). `boxOn` = the role-box condition alone.
 *  Recovery needs affirmative evidence of progress, never just "the computed age dropped" (a clock change does that). */
export type Judgement = { key: AlertKey; verdict: "on" | "off" | "unknown"; text: string; mark?: number | null; boxOn?: boolean | null; markOn?: boolean | null };

/** Machine senders: the dispatcher's own notices are not work waiting for the coordinator. Matched on `from` OR `fromLabel`. */
export const MACHINE_SENDERS: readonly string[] = ["swarm-observer", "swarm-sweep", "swarm-admission", "idle-explainer", "inbox-sentinel"];
const isMachine = (sender: string) => MACHINE_SENDERS.includes(sender) || /^disp-\d+$/.test(sender);

const h = (s: number) => `${(s / 3600).toFixed(1)}h`;

/** Pure. Each alert gets a three-state verdict; "unknown" only when the answer really depends on a fact we could not read. */
export function judgeProgress(f: ProgressFacts): Judgement[] {
  const out: Judgement[] = [];
  // --- coordinator ---
  const ck: AlertKey = "coordinator-stalled";
  // judge-death branch. UNKNOWN beat ⇒ verdict unknown (keeps any open episode; never "dead", never "fine")
  if (f.beatSec === "unknown") out.push({ key: ck, verdict: "unknown", text: "beat unreadable" });
  // ENOENT/stale beat = death, reported by the death paths, not by this watch ⇒ "unknown" here: no alert from us, and an open
  // stalled episode is NOT resolved by the coordinator dying
  else if (f.beatSec === "absent" || f.nowSec - f.beatSec >= BEAT_STALE_SEC) out.push({ key: ck, verdict: "unknown", text: "beat stale/absent (death — owned by the death paths)" });
  else {
    // handoff: on / off / unknown. UNKNOWN (EIO/EACCES) ⇒ unknown; only ENOENT counts as a known "no handoff yet" (off)
    const hv: "on" | "off" | "unknown" = f.handoffMtimeSec === "unknown" ? "unknown"
      : f.handoffMtimeSec === "absent" ? "off" : f.nowSec - f.handoffMtimeSec > HANDOFF_STALE_SEC ? "on" : "off";
    // box: count real mail. UNKNOWN box ⇒ unknown. Unknown-provenance mail can only make the verdict unknown, never "on" or "off"
    let bv: "on" | "off" | "unknown"; let real = 0; let oldest = 0; let unknownMail = 0;
    if (f.mails === "unknown") bv = "unknown";
    else {
      const ms = f.mails === "absent" ? [] : f.mails;
      const realM = ms.filter((m) => m.sender !== null && !isMachine(m.sender));
      unknownMail = ms.filter((m) => m.sender === null).length;
      real = realM.length;
      oldest = real ? f.nowSec - Math.min(...realM.map((m) => m.mtimeSec)) : 0;
      const oldReal = realM.filter((m) => f.nowSec - m.mtimeSec > MAIL_OLD_SEC).length;
      if (real >= MAIL_MIN && oldReal >= 1) bv = "on";
      else {
        // could the unknown-sender mail tip it over? only then is the box verdict unknown
        const couldOld = ms.some((m) => m.sender === null && f.nowSec - m.mtimeSec > MAIL_OLD_SEC) || oldReal >= 1;
        bv = unknownMail > 0 && real + unknownMail >= MAIL_MIN && couldOld ? "unknown" : "off";
      }
    }
    // judge-recovery: "off" needs BOTH sides affirmatively fine; any unknown side ⇒ unknown (never a recovery)
    const verdict = hv === "on" || bv === "on" ? "on" : hv === "unknown" || bv === "unknown" ? "unknown" : "off";
    const ha = typeof f.handoffMtimeSec === "number" ? h(f.nowSec - f.handoffMtimeSec) : f.handoffMtimeSec;
    out.push({ key: ck, verdict, mark: typeof f.handoffMtimeSec === "number" ? f.handoffMtimeSec : null, boxOn: bv === "unknown" ? null : bv === "on",
      markOn: hv === "unknown" ? null : hv === "on", text: `[dispatcher] coordinator-stalled: beat fresh but no progress — handoff ${ha} old / role box ${real} real mail(s)`
      + `${unknownMail ? ` (+${unknownMail} unreadable)` : ""}, oldest ${h(oldest)} — continue the cycle per skill §1b; do not wait for the user` });
  }
  // --- carly ---
  const cb = f.carlyBeatSec;
  // carly: UNKNOWN beat ⇒ unknown (no alert, no recovery); ENOENT ⇒ on (a known missing patrol)
  if (cb === "unknown") out.push({ key: "carly-stale", verdict: "unknown", text: "carly beat unreadable" });
  else out.push({ key: "carly-stale", verdict: cb === "absent" || f.nowSec - cb > CARLY_STALE_SEC ? "on" : "off", mark: cb === "absent" ? null : cb,
    text: `[dispatcher] carly-stale: carly-patrol.beat ${cb === "absent" ? "absent" : `${h(f.nowSec - cb)} old`} (> ${CARLY_STALE_SEC / 60}min)` });
  return out;
}

/** Per alert: an open episode (`open`), whether its current alert is still owed, when it was last delivered / attempted. */
export type EpisodeState = { open: boolean; owed: boolean; deliveredAt: number | null; attemptAt: number | null;
  /** progress marker and box condition when the episode opened: recovery = the marker ADVANCED past it, or (an episode opened by the
   *  box alone) the box is affirmatively off */
  openMark: number | null; openedByBoxOnly: boolean };
/** `resolveOwed`: episodes that recovered and whose "resolved" notice is not yet DELIVERED (PW-EMIT-COMMIT-RESOLVE) — the physical
 *  recovery and the notice are tracked separately; key → last attempt time (null = not attempted yet). */
export type WatchState = { ep: Map<AlertKey, EpisodeState>; resolveOwed: Map<AlertKey, number | null> };
export function initialWatchState(): WatchState { return { ep: new Map(), resolveOwed: new Map() }; }

/** What to attempt this round. Mutates only the episode open/owed bookkeeping; delivery success is committed by `commitDelivery`.
 *  - on: open an episode (owed), or re-owe it every DEDUP_SEC after the last delivery; an owed alert is (re)attempted at most every
 *    RETRY_SEC.
 *  - off: an open episode closes ⇒ one "resolved" (affirmative recovery).
 *  - unknown: nothing changes — no new alert, no resolved, no reset. Pure. */
export function planEmits(st: WatchState, js: Judgement[], nowSec: number): { attempt: Judgement[]; resolved: AlertKey[] } {
  const attempt: Judgement[] = []; const resolved: AlertKey[] = [];
  for (const j of js) {
    const e = st.ep.get(j.key) ?? { open: false, owed: false, deliveredAt: null, attemptAt: null, openMark: null, openedByBoxOnly: false };
    if (j.verdict === "on") {
      if (!e.open) {
        e.open = true; e.owed = true; e.deliveredAt = null; e.attemptAt = null; e.openMark = j.mark ?? null;
        // opened by the box alone ⇔ the box is on and the marker alone would not have been (handoff fresh enough)
        e.openedByBoxOnly = j.boxOn === true && j.markOn === false;
      }
      else if (!e.owed && e.deliveredAt !== null && nowSec - e.deliveredAt >= DEDUP_SEC) e.owed = true;
      if (e.owed && (e.attemptAt === null || nowSec - e.attemptAt >= RETRY_SEC)) { e.attemptAt = nowSec; attempt.push(j); }
      st.ep.set(j.key, e);
    } else if (j.verdict === "off" && e.open) {
      // judge-recovery: "off" alone is not enough — require progress evidence (marker advanced past the one at open, or a box-only
      // episode whose box is now affirmatively off). Otherwise (e.g. the clock moved, the file did not) treat it as unknown: keep.
      const advanced = typeof j.mark === "number" && (e.openMark === null || j.mark > e.openMark);
      const boxCleared = e.openedByBoxOnly && j.boxOn === false;
      if (advanced || boxCleared) {
        st.ep.delete(j.key);
        if (e.deliveredAt !== null) st.resolveOwed.set(j.key, null); // never "resolved" an alert nobody was told about
      }
    }
  }
  // owed "resolved" notices: (re)attempted every RETRY_SEC until delivered; a NEW episode of the same key supersedes the old notice
  for (const [k, last] of st.resolveOwed) {
    if (st.ep.get(k)?.open) { st.resolveOwed.delete(k); continue; }
    if (last === null || nowSec - last >= RETRY_SEC) { st.resolveOwed.set(k, nowSec); resolved.push(k); }
  }
  return { attempt, resolved };
}

/** The "resolved" notice for `key` was delivered (≥ 1 surface) ⇒ the obligation is done; not delivered ⇒ it stays owed. Pure. */
export function commitResolved(st: WatchState, key: AlertKey, delivered: boolean): void {
  if (delivered) st.resolveOwed.delete(key);
}

/** Record the outcome of an attempt: delivered on ≥ 1 surface ⇒ no longer owed (the 30min window starts now); else stays owed and
 *  is retried after RETRY_SEC. Pure. */
export function commitDelivery(st: WatchState, key: AlertKey, delivered: boolean, nowSec: number): void {
  const e = st.ep.get(key);
  if (!e) return;
  if (delivered) { e.owed = false; e.deliveredAt = nowSec; }
}

// ---------------- real IO ----------------
function statMtime(f: string): Fact<number> {
  try { const st = lstatSync(f); return st.isFile() ? Math.floor(st.mtimeMs / 1000) : "unknown"; } // not a regular file ⇒ unknown
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}
/** The single-integer beat (shell `date +%s`). absent = ENOENT; unknown = unreadable or not an integer. */
export function readBeat(f: string): Fact<number> {
  let text: string;
  // regular file only, non-blocking, at most 64 bytes (a beat is one integer): a FIFO / device here can never stall the sweep
  try {
    const st = lstatSync(f); if (!st.isFile()) return "unknown";
    const fd = openSync(f, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    try { const buf = Buffer.alloc(64); text = buf.subarray(0, readSync(fd, buf, 0, 64, 0)).toString("utf8"); } finally { closeSync(fd); }
  } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
  const n = Number((text.split("\n")[0] ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : "unknown";
}

/** Unclaimed mails in a durable inbox dir: top-level *.json only (processed/ and dot-dirs are not unclaimed). The sender is the
 *  message's `fromLabel` (or `from` when there is no label); a body that cannot be read/parsed has sender null (unknown). */
/** Mail bodies larger than this are not read (a sender field sits at the top of a few-KB message): the mail counts, sender unknown. */
export const MAIL_BODY_MAX = 64 * 1024;

/** Unclaimed mails in a durable inbox dir: top-level *.json only (processed/ and dot-dirs are not unclaimed). Bounded: lstat only
 *  (a FIFO / device / symlink is never opened — PW-SV-SWEEP-BUDGET), at most `max` mails opened, each read capped at MAIL_BODY_MAX
 *  with O_NONBLOCK, and the whole scan stops at `deadlineMs`. A box bigger than `max`, or a scan cut by the deadline, is UNKNOWN
 *  (the round cannot prove the threshold either way; next round scans again). The sender is the message's `fromLabel` (or `from`);
 *  a body that cannot be read/parsed has sender null (unknown). */
export function readBoxMails(dir: string, max = MAIL_SCAN_MAX, deadlineMs = Date.now() + FACTS_BUDGET_MS, clock: () => number = Date.now): Fact<Mail[]> {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
  if (names.length > max) return "unknown";
  const out: Mail[] = [];
  for (const n of names) {
    if (clock() > deadlineMs) return "unknown";
    const f = path.join(dir, n);
    let st;
    try { st = lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; return "unknown"; }
    if (!st.isFile()) return "unknown"; // a FIFO / symlink / dir in the box: cannot be judged without risk of blocking
    const m = Math.floor(st.mtimeMs / 1000);
    let sender: string | null = null;
    if (st.size <= MAIL_BODY_MAX) {
      let fd: number | null = null;
      try {
        fd = openSync(f, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
        const buf = Buffer.alloc(st.size); const got = readSync(fd, buf, 0, st.size, 0);
        const j = JSON.parse(buf.subarray(0, got).toString("utf8")) as { fromLabel?: unknown; from?: unknown };
        sender = typeof j.fromLabel === "string" && j.fromLabel ? j.fromLabel : typeof j.from === "string" && j.from ? j.from : null;
      } catch { sender = null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
    }
    out.push({ sender, mtimeSec: m });
  }
  return out;
}

export function readProgressFacts(home: string, coordinatorBox: string | null, nowSec: number): ProgressFacts {
  return {
    nowSec,
    beatSec: readBeat(coordinatorBeatPath(home)),
    handoffMtimeSec: statMtime(path.join(home, ".agenthop", "swarm", "coordinator-handoff.md")),
    mails: coordinatorBox === null ? "unknown" : readBoxMails(path.join(home, ".agenthop", "inbox", coordinatorBox)),
    carlyBeatSec: readBeat(carlyPatrolBeatPath(home)),
  };
}

/** L0 alert file the Carly/TG side scans: ~/.agenthop/carly/alerts/<key>-<ts>.json (temp + rename). Throws on failure. */
export function writeL0Alert(home: string, a: { key: AlertKey; text: string }, nowSec: number): string {
  const dir = path.join(home, ".agenthop", "carly", "alerts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = a.key.replace(/-/g, "_");
  const f = path.join(dir, `${key}-${nowSec}.json`);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ kind: key, ts: nowSec, source: "dispatcher", text: a.text })}\n`, { mode: 0o600 });
  renameSync(tmp, f);
  return f;
}

// ---------------- the coordinator's block (PW-COORDINATOR-OWNERSHIP + PW-LOCATOR-UNKNOWN + PW-SWEEP-BUDGET) ----------------
/** A bounded runner: every call is given the REMAINING budget as its own timeout and spends what it actually took; a call that did
 *  not finish within what was left, or any call once the budget is spent, returns null (refused / over budget) — never a result. */
export type Budget = { leftMs: number; calls: number };
/** Whole-step budgets (liveness-tier §2.5). The progress-watch step per round is bounded by FACTS_BUDGET_MS (fact reads: beat, handoff,
 *  carly beat, role-box scan) + BLOCK_BUDGET_MS (ls + process per block + ps) + TYPE_BUDGET_MS (two sends) + the S19/L0 writes
 *  (local files) ⇒ ≤ ~6.5s worst case, independent of the number of mails or blocks. */
export const FACTS_BUDGET_MS = 1_000;
export const BLOCK_BUDGET_MS = 3_000;
export const TYPE_BUDGET_MS = 2_000;
/** inbox-sentinel role-box credit: ps + every exact-argv query within this; past it ⇒ unknown ⇒ not credited. */
export const ROLE_BOX_BUDGET_MS = 1_500;
/** At most this many mails are opened per round; the rest of a larger box is UNKNOWN for this round (scan resumes next round). */
export const MAIL_SCAN_MAX = 50;

export function budgeted(run: (args: string[], timeoutMs: number) => { ok: boolean; stdout: string; timedOut?: boolean }, b: Budget, clock: () => number = Date.now) {
  return (args: string[]): { ok: boolean; stdout: string } | null => {
    if (b.leftMs <= 0) return null;
    const t0 = clock(); const r = run(args, b.leftMs); const took = Math.max(1, clock() - t0);
    b.leftMs -= took; b.calls++;
    if (r.timedOut || b.leftMs < 0) return null; // finished late or was cut at the budget ⇒ not a result
    return { ok: r.ok, stdout: r.stdout };
  };
}

/** The ONE block to type into, or why there is none.
 *  Authority (coordinator rulings 2026-10-16): the live coordinator session is roles/coordinator.sid (read by the caller), and the
 *  agent for it is found from the PROCESS TABLE (resolveAgentPid over each live block's tern root, exact argv) — never from the
 *  presence .pid file (a projection; a stale or bus-written pid proves nothing about the current process).
 *  Uniqueness must be PROVEN over the whole inventory: any block whose child cannot be read (process call failed / bad JSON / no
 *  child / argv unreadable / budget spent) makes the answer HOLD — that block could be a second match (PW-LOCATOR-UNKNOWN). */
export function findCoordinatorBlock(
  coordinatorSid: string | null,
  tern: (args: string[]) => { ok: boolean; stdout: string } | null, // null = refused / over budget
  agentUnder: (rootPid: number) => Resolved,                       // three-state: match / none / unknown / ambiguous
): { block: string } | { none: string } {
  if (!coordinatorSid) return { none: "no live coordinator session (roles/coordinator.sid missing/stale/not a sid)" };
  const ls = tern(["ls", "--json"]);
  if (ls === null) return { none: "tern budget spent" };
  if (!ls.ok) return { none: "tern ls did not answer" };
  let ids: number[];
  try {
    ids = [];
    for (const se of (JSON.parse(ls.stdout) as { sessions: Array<{ tabs: Array<{ blocks: Array<{ id: number; live: boolean }> }> }> }).sessions)
      for (const t of se.tabs) for (const b of t.blocks) if (b.live === true && Number.isSafeInteger(b.id)) ids.push(b.id);
  } catch { return { none: "tern ls unparseable" }; }
  const hits: string[] = [];
  for (const id of ids) {
    const pr = tern(["process", String(id), "--json"]);
    if (pr === null) return { none: `tern budget spent before block ${id} was checked — HOLD` };
    if (!pr.ok) return { none: `tern process ${id} did not answer — HOLD (cannot prove uniqueness)` };
    let root: unknown;
    try { root = (JSON.parse(pr.stdout) as { child?: { pid?: unknown } }).child?.pid; } catch { return { none: `tern process ${id} unparseable — HOLD` }; }
    if (!Number.isSafeInteger(root)) return { none: `block ${id} has no readable child — HOLD` };
    const a = agentUnder(root as number);
    // UNKNOWN (an argv we could not read, or the budget ended first) ⇒ HOLD: that block might run the coordinator too
    if (a.kind === "unknown") return { none: `${a.why} under block ${id} — HOLD` };
    if (a.kind === "ambiguous") return { none: `several processes run ${coordinatorSid} under block ${id} — HOLD` };
    if (a.kind === "match") hits.push(String(id));
  }
  return hits.length === 1 ? { block: hits[0]! } : { none: `${hits.length} blocks run ${coordinatorSid}` };
}

/** inbox-sentinel (#1116 nit): the coordinator ROLE box (SWARM_COORDINATOR) is drained by whichever session is the live coordinator,
 *  whose own sid is a different key — so the sentinel saw "no live session owns this box" and alerted every minute. The role box is
 *  owned iff roles/coordinator.sid names a live coordinator whose claude is found in the PROCESS TABLE (the presence .pid is a
 *  projection and is not used). Anything missing / stale / not a sid / not found / unknown ⇒ false: the sentinel keeps its old
 *  verdict (never loosened). Pure over injected facts. */
export function roleBoxOwned(liveSid: string | null, agent: Fact<number>): boolean {
  return liveSid !== null && typeof agent === "number";
}

/** The agent process for a sid among candidate root pids: none ⇒ "absent", exactly one distinct pid ⇒ it, several ⇒ "unknown". Pure. */
export function agentAmong(roots: number[], resolve: (root: number) => Resolved): Fact<number> {
  const pids = new Set<number>();
  for (const r of roots) {
    const x = resolve(r);
    if (x.kind === "unknown" || x.kind === "ambiguous") return "unknown"; // never folded into "absent"
    if (x.kind === "match") pids.add(x.pid);
  }
  return pids.size === 0 ? "absent" : pids.size === 1 ? [...pids][0]! : "unknown";
}
