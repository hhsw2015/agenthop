import { hashFraction, scheduleJitterSec, JITTER_ABS_CAP_SEC } from "./schedule-jitter.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

t("hashFraction in [0,1)", (() => { const f = hashFraction("abc"); return f >= 0 && f < 1; })());
t("hashFraction deterministic", hashFraction("x") === hashFraction("x"));
t("hashFraction differs by id", hashFraction("a") !== hashFraction("b"));

t("jitter deterministic per id", scheduleJitterSec("job1", 600) === scheduleJitterSec("job1", 600));
t("jitter within [0, period*frac]", (() => { const j = scheduleJitterSec("job1", 600, 0.1); return j >= 0 && j <= 60; })());
t("jitter capped at abs cap", (() => { const j = scheduleJitterSec("job1", 1_000_000, 0.1); return j <= JITTER_ABS_CAP_SEC; })());
t("jitter spreads across ids", (() => { const a = scheduleJitterSec("a", 600), b = scheduleJitterSec("b", 600); return a !== b; })());
t("jitter zero for non-positive/non-finite period", scheduleJitterSec("x", 0) === 0 && scheduleJitterSec("x", Infinity) === 0 && scheduleJitterSec("x", NaN) === 0);
t("jitter integer seconds", Number.isInteger(scheduleJitterSec("job1", 600)));

console.log("all schedule-jitter selftests passed");
