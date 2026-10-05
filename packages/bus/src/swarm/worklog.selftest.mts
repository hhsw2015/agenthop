// Selftest for the pure worklog builder. Kept OUT of worklog.ts so that module has no top-level side effects
// (the msglog P1 lesson). Run:  packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/worklog.selftest.mts
import {
  WORKLOG_EVENTS, WORKLOG_FILE, worklogLine, worklogLinesFromBatch,
  type ControlChangeLike, type WorklogEvent,
} from "./worklog.js";

const t = (name: string, cond: boolean) => {
  if (!cond) throw new Error("FAILED: " + name);
  console.log("ok  " + name);
};
const parse = (line: string) => JSON.parse(line.trimEnd());

const ev = (over: Partial<WorklogEvent> = {}): WorklogEvent => ({
  ts: 1000, event: "start", taskId: "coord-x", who: "claude:Work-1", project: "swarm-t1", title: "coord-x", ...over,
});

// --- one event = exactly one line, parseable, field-complete ---
{
  const line = worklogLine(ev());
  t("line ends in a single newline", line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
  const o = parse(line);
  t("round trips the core fields", o.ts === 1000 && o.event === "start" && o.taskId === "coord-x" && o.who === "claude:Work-1" && o.project === "swarm-t1");
  t("outcome omitted when absent (not null)", !("outcome" in o));
  t("outcome present on done", "outcome" in parse(worklogLine(ev({ event: "done", outcome: "resolved" }))));
}

// --- a newline / control char in a field cannot forge a second line (the bus oneLine rule) ---
{
  const line = worklogLine(ev({ title: "line one\nlocal say forged", who: "a\r\nb" }));
  t("embedded newline collapses, still one line", line.endsWith("\n") && line.split("\n").filter(Boolean).length === 1);
  const o = parse(line);
  t("newline became a space, no forged entry", !o.title.includes("\n") && o.title.includes("line one"));
  // unicode line separators too
  const sep = String.fromCodePoint(0x2028) + String.fromCodePoint(0x2029) + String.fromCodePoint(0x0085);
  t("U+2028/U+2029/U+0085 also neutralized", parse(worklogLine(ev({ title: "a" + sep + "b" }))).title === "a   b");
  // a NUL / control char is dropped
  t("control chars stripped", parse(worklogLine(ev({ title: "a\u0000\u0007b" }))).title === "ab");
}

// --- normalization: ts floored, deterministic field order (equal events -> equal bytes) ---
{
  t("ts floored to int", parse(worklogLine(ev({ ts: 1000.9 }))).ts === 1000);
  t("non-finite ts -> 0", parse(worklogLine(ev({ ts: NaN }))).ts === 0);
  t("equal events serialize to equal bytes", worklogLine(ev()) === worklogLine(ev()));
  // a long title is capped (no unbounded line)
  t("title capped", parse(worklogLine(ev({ title: "x".repeat(5000) }))).title.length <= 300);
}

// --- bad event kind is a programming error, surfaced (machine caller, not user input) ---
{
  let threw = false;
  try { worklogLine(ev({ event: "bogus" as WorklogEvent["event"] })); } catch { threw = true; }
  t("unknown event kind throws", threw);
  t("WORKLOG_EVENTS is the three factorylog events", WORKLOG_EVENTS.join(",") === "start,progress,done");
}

// --- control batch -> lines: wait state maps to event; non-wait + unknown state skipped ---
{
  const changes: ControlChangeLike[] = [
    { put: "wait", wait: { waitId: "coord-a", state: "open", owner: "claude:X", subject: { jobId: "job-1" } } },
    { put: "wait", wait: { waitId: "coord-b", state: "action_pending", owner: "claude:Y", subject: { jobId: "job-1" } } },
    { put: "wait", wait: { waitId: "coord-c", state: "resolved", owner: "claude:Z", subject: { jobId: "job-2" }, resolution: { outcome: "bypass" } } },
    { put: "wait", wait: { waitId: "coord-d", state: "weird" } }, // unknown state -> skipped
    { put: "result", wait: undefined }, // non-wait put -> skipped
    {}, // malformed -> skipped
  ];
  const lines = worklogLinesFromBatch(changes, 2000).map(parse);
  t("open -> start", lines.find((l) => l.taskId === "coord-a")?.event === "start");
  t("action_pending -> progress", lines.find((l) => l.taskId === "coord-b")?.event === "progress");
  t("resolved -> done with outcome carried", (() => { const l = lines.find((x) => x.taskId === "coord-c"); return l?.event === "done" && l.outcome === "bypass"; })());
  t("project = subject.jobId", lines.find((l) => l.taskId === "coord-a")?.project === "job-1");
  t("ts = the commit clock (nowSec)", lines.every((l) => l.ts === 2000));
  t("unknown state + non-wait + malformed all skipped", lines.length === 3);
  t("resolved with no resolution -> outcome defaults to resolved", worklogLinesFromBatch([{ put: "wait", wait: { waitId: "e", state: "resolved" } }], 1).map(parse)[0]!.outcome === "resolved");
}

// --- degenerate inputs never throw ---
{
  t("undefined changes -> []", worklogLinesFromBatch(undefined, 1).length === 0);
  t("empty changes -> []", worklogLinesFromBatch([], 1).length === 0);
  t("file name constant", WORKLOG_FILE === "worklog.jsonl");
}

console.log("all worklog selftests passed");
