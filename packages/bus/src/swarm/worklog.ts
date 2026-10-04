/**
 * worklog — an append-only work TIMELINE (brain: worklog-timeline, author 90b58f9c). factorylog's good idea
 * (start/report/done events in one append-only file a watcher renders) decoupled from its app and folded into
 * OUR machine: the dispatcher/sweep already pass through every coordination transition, so the WRITE POINT is
 * the machine, not the agent — agents spend zero tokens narrating what they did.
 *
 * NOT a second ledger. The source of truth stays the control-log; worklog.jsonl is a derived PROJECTION of it
 * onto a time axis, cheap to append and cheap to tail. If it is ever lost it rebuilds from the control-log
 * (scripts/worklog-backfill.ts).
 *
 * PURE module (msglog P1 lesson): no fs, no top-level side effects — selftests live in worklog.selftest.mts.
 * The FILE shape (one JSON object per line) is the WHOLE contract: the reader (scripts/projection.ts) parses
 * it independently (projection discipline C-2: read files, never import bus). The live writer (control-store
 * hook) and the one-time backfill BOTH go through the builders here, so a backfilled line and a live line are
 * byte-identical — the one thing a shared schema-as-code must guarantee.
 */

/** The three events, straight from factorylog. `progress` is a heartbeat/escalation tick between the two. */
export const WORKLOG_EVENTS = ["start", "progress", "done"] as const;
export type WorklogEventKind = (typeof WORKLOG_EVENTS)[number];

/** One worklog line. ts is unix SECONDS on the machine clock at the transform point (local log, human-read). */
export interface WorklogEvent {
  ts: number;
  event: WorklogEventKind;
  taskId: string; // the coordination/attempt id this transition belongs to (waitId, attemptId, board itemId)
  who: string; // member id that owns the work
  project: string; // jobId / board domain the work rolls up to ("where did the time go")
  title: string; // human label
  outcome?: string; // on `done`: how it ended (resolved / bypass / failed / ...)
}

/** The parsed shape the reader produces. Identical fields; kept separate so the reader can be lenient where
 *  the writer is strict (a torn tail can hand the reader a half-written line). */
export type WorklogEntry = WorklogEvent;

// one event = exactly one line (the bus oneLine rule): a newline or control char inside a string field would
// otherwise forge a second, attacker-shaped entry. Caps keep a pathological title from bloating the file.
const CAP = { taskId: 200, who: 120, project: 200, title: 300, outcome: 120 } as const;
const oneLine = (s: unknown, cap: number): string =>
  String(s ?? "")
    .replace(/[\r\n\u2028\u2029\u0085]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, cap)
    .trim();

/**
 * Validate + normalize ONE event into the JSONL line to append (ends in "\n"). Pure — returns the string, the
 * caller writes it (keeps the fs append in the IO owner's domain). A bad event kind throws: the caller is the
 * machine at a known transform point, so a bad kind is a programming error to surface, not external input to
 * tolerate. Field order is fixed so two equal events serialize to equal bytes.
 */
export function worklogLine(ev: WorklogEvent): string {
  if (!WORKLOG_EVENTS.includes(ev.event)) throw new Error(`worklog: unknown event kind ${JSON.stringify(ev.event)}`);
  const ts = Number.isFinite(ev.ts) ? Math.floor(ev.ts) : 0;
  const rec: WorklogEvent = {
    ts,
    event: ev.event,
    taskId: oneLine(ev.taskId, CAP.taskId),
    who: oneLine(ev.who, CAP.who),
    project: oneLine(ev.project, CAP.project),
    title: oneLine(ev.title, CAP.title),
    ...(ev.outcome != null ? { outcome: oneLine(ev.outcome, CAP.outcome) } : {}),
  };
  return JSON.stringify(rec) + "\n";
}

// ---- derive events from a committed CONTROL batch (the dispatcher's existing write point) -------------------
// Structural shape only — deliberately NOT importing control-log.ts's Change union. This module is cherry-picked
// across branches whose unions drift; a loose shape keeps working when a new change kind appears (it is ignored).

export interface ControlWaitLike {
  waitId?: string;
  state?: string; // open | action_pending | resolved | ...
  owner?: string;
  subject?: { jobId?: string; attemptId?: string };
  resolution?: { outcome?: string; reason?: string };
}
export interface ControlChangeLike {
  put?: string;
  wait?: ControlWaitLike;
}

const STATE_TO_EVENT: Record<string, WorklogEventKind> = {
  open: "start",
  action_pending: "progress",
  resolved: "done",
};

/**
 * Project a committed control batch into worklog lines (faithful, one line per mapped change). An escalation
 * re-open emits another `start`; a flapping wait emits repeated `progress` — the BUILDER stays faithful and the
 * READER collapses the flaps into one bar. Keeping the projection dumb and the reducer smart is the same
 * judgment-sink split the viz already uses. `nowSec` is the machine clock at commit time.
 */
export function worklogLinesFromBatch(changes: readonly ControlChangeLike[] | undefined, nowSec: number): string[] {
  const out: string[] = [];
  for (const c of changes ?? []) {
    if (c?.put !== "wait" || !c.wait) continue;
    const w = c.wait;
    const event = STATE_TO_EVENT[w.state ?? ""];
    if (!event) continue;
    out.push(
      worklogLine({
        ts: nowSec,
        event,
        taskId: w.waitId ?? "",
        who: w.owner ?? "",
        project: w.subject?.jobId ?? "",
        title: w.waitId ?? "",
        outcome: event === "done" ? w.resolution?.outcome ?? "resolved" : undefined,
      }),
    );
  }
  return out;
}

/** The file name both sides agree on; it lives beside board/ and control-log/ under the swarm dir. */
export const WORKLOG_FILE = "worklog.jsonl";
