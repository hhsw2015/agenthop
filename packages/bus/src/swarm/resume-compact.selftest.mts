import { shouldResumeCompact, RESUME_IDLE_SEC, RESUME_TOKEN_FLOOR } from "./resume-compact.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const idle = RESUME_IDLE_SEC + 1;
const heavy = RESUME_TOKEN_FLOOR + 1;

t("both exceeded -> compact", shouldResumeCompact({ idleSec: idle, tokens: heavy }) === true);
t("idle only (small) -> no compact", shouldResumeCompact({ idleSec: idle, tokens: RESUME_TOKEN_FLOOR - 1 }) === false);
t("heavy only (recent) -> no compact", shouldResumeCompact({ idleSec: RESUME_IDLE_SEC - 1, tokens: heavy }) === false);
t("neither -> no compact", shouldResumeCompact({ idleSec: 0, tokens: 0 }) === false);

// strict boundaries (must be strictly greater)
t("idle exactly at floor -> no compact", shouldResumeCompact({ idleSec: RESUME_IDLE_SEC, tokens: heavy }) === false);
t("tokens exactly at floor -> no compact", shouldResumeCompact({ idleSec: idle, tokens: RESUME_TOKEN_FLOOR }) === false);

// fail-closed on unusable inputs (never drop history on a bad measurement)
t("NaN idle -> no compact", shouldResumeCompact({ idleSec: NaN, tokens: heavy }) === false);
t("Infinity tokens -> no compact", shouldResumeCompact({ idleSec: idle, tokens: Infinity }) === false);

// custom floors respected
t("custom floors honored", shouldResumeCompact({ idleSec: 11, tokens: 11, idleFloorSec: 10, tokenFloor: 10 }) === true);
t("custom floors below -> no compact", shouldResumeCompact({ idleSec: 10, tokens: 10, idleFloorSec: 10, tokenFloor: 10 }) === false);
t("bad custom floor falls back to default", shouldResumeCompact({ idleSec: idle, tokens: heavy, idleFloorSec: NaN, tokenFloor: NaN }) === true);

console.log("all resume-compact selftests passed");
