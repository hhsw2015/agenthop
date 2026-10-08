import { triageRank, sortForTriage, shouldResummarize, buildSummaryRequest, SUMMARY_MIN_INTERVAL_SEC, type MemberRow } from "./viz-triage.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- triage ordering: needs-input first ---
t("rank: needs-input < working < idle < completed < failed", triageRank("needs-input") < triageRank("working") && triageRank("working") < triageRank("idle") && triageRank("idle") < triageRank("completed") && triageRank("completed") < triageRank("failed"));
t("rank: unknown sorts last", triageRank("bogus" as any) >= triageRank("failed"));
const rows: MemberRow[] = [
  { id: "a", state: "completed" },
  { id: "b", state: "needs-input" },
  { id: "c", state: "working" },
  { id: "d", state: "needs-input" },
  { id: "e", state: "idle" },
];
const sorted = sortForTriage(rows);
t("sort: needs-input rows first", sorted[0].state === "needs-input" && sorted[1].state === "needs-input");
t("sort: stable within a state (b before d)", sorted[0].id === "b" && sorted[1].id === "d");
t("sort: completed/failed last", sorted[sorted.length - 1].state === "completed");
t("sort: pure (input untouched)", rows[0].id === "a" && rows[0].state === "completed");

// --- re-summarize throttle ---
t("resummarize: never-summarized -> true", shouldResummarize(null, 1000) === true);
t("resummarize: within interval -> false", shouldResummarize(1000, 1000 + SUMMARY_MIN_INTERVAL_SEC - 1) === false);
t("resummarize: past interval -> true", shouldResummarize(1000, 1000 + SUMMARY_MIN_INTERVAL_SEC) === true);
t("resummarize: non-finite clock -> false (no spurious model call)", shouldResummarize(1000, NaN) === false);

// --- summary request builder ---
const req = buildSummaryRequest("x".repeat(5000), 2000);
t("summary: light tier (cheap)", req.tier === "light");
t("summary: clips recent output to maxChars (last N)", req.user.length === 2000);
t("summary: one-line instruction", /one short line/i.test(req.system) && /<=12 words/.test(req.system));
t("summary: empty output safe", buildSummaryRequest("").user === "");
// VT-P2-1: a zero/fractional cap must produce EMPTY output, not bypass the limit via slice(-0)
t("summary: maxChars=0 -> empty (not full via slice(-0))", buildSummaryRequest("x".repeat(20000), 0).user === "");
t("summary: maxChars=0.5 -> empty (fractional floors to 0)", buildSummaryRequest("x".repeat(20000), 0.5).user === "");
t("summary: negative maxChars -> empty", buildSummaryRequest("x".repeat(20000), -5).user === "");
t("summary: positive cap still keeps the last N", buildSummaryRequest("abcdef", 3).user === "def");

console.log("all viz-triage selftests passed");
