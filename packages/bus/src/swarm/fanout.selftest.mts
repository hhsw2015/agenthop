// Selftest for the pure fanout core. IO (spawn/herdr/ledger) is thin glue over these decisions.
//   npx tsx packages/bus/src/swarm/fanout.selftest.mts
// Each pre-study pit (docs/swarm/fanout-prestudy.md §2) is a NAMED counterexample below.
import {
  admitDepth, budgetExceeded, canReapZone, chooseDisplayMode, classifyExit, classToTier, degradeDisplay,
  effectiveTier, elapsedTimedOut, isSafeRunKey, isTerminal, markAborted, newLedgerRow, nextReceipt, parseDepth,
  planResume, progress, reconcileOrphans, reduceUnits, reservationFits, reserveValid, validateFanoutRequest,
  validBudgetTicket, validRoiEstimate, widthClass, widthGate, zoneName, type FanoutUnit, type LedgerRow, type UnitResult,
} from "./fanout.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

const unit = (key: string, taskClass: FanoutUnit["taskClass"] = "scan", extra: Partial<FanoutUnit> = {}): FanoutUnit => ({ key, prompt: "p", taskClass, ...extra });
const okReq = () => ({ runKey: "r1", units: [unit("u1"), unit("u2", "judge")], mode: "fresh", reduce: "collect", budget: { maxTokens: 1000 } });

// --- validation (pit 2.2: duplicate key) ---
{
  const v = validateFanoutRequest(okReq());
  t("valid request validates", v.ok === true);
  t("non-object rejected", validateFanoutRequest(null).ok === false);
  t("missing runKey rejected", validateFanoutRequest({ ...okReq(), runKey: "" }).ok === false);
  t("empty units rejected", validateFanoutRequest({ ...okReq(), units: [] }).ok === false);
  t("bad mode rejected", validateFanoutRequest({ ...okReq(), mode: "x" }).ok === false);
  t("missing reduce rejected", validateFanoutRequest({ ...okReq(), reduce: 1 }).ok === false);
  t("negative budget rejected", validateFanoutRequest({ ...okReq(), budget: { maxTokens: -1 } }).ok === false);
  t("DUPLICATE unit key rejected (pit 2.2)", validateFanoutRequest({ ...okReq(), units: [unit("dup"), unit("dup")] }).ok === false);
  t("runKey path-traversal rejected (FN5)", validateFanoutRequest({ ...okReq(), runKey: "../outside" }).ok === false);
  t("isSafeRunKey: plain slug ok", isSafeRunKey("r1") && isSafeRunKey("a.b-c_d"));
  t("isSafeRunKey: traversal/separator/empty/leading-dot rejected (FN5)", !isSafeRunKey("../x") && !isSafeRunKey("a/b") && !isSafeRunKey("..") && !isSafeRunKey("") && !isSafeRunKey(".hidden"));
  t("unit KEY path-traversal rejected (FN5 round-3)", validateFanoutRequest({ ...okReq(), units: [unit("../foreign")] }).ok === false);
  t("case-insensitive duplicate unit keys rejected (FN5 round-4)", validateFanoutRequest({ ...okReq(), units: [unit("item"), unit("ITEM")] }).ok === false);
  t("visible:true accepted (FN4 opt-in)", validateFanoutRequest({ ...okReq(), visible: true }).ok === true);
  t("visible non-boolean rejected (FN4)", validateFanoutRequest({ ...okReq(), visible: "yes" }).ok === false);
  t("bad taskClass rejected", validateFanoutRequest({ ...okReq(), units: [unit("u", "nope" as unknown as FanoutUnit["taskClass"])] }).ok === false);
  t("unit missing prompt rejected", validateFanoutRequest({ runKey: "r", units: [{ key: "u", taskClass: "scan" }], mode: "fresh", reduce: "c", budget: {} }).ok === false);
}

// --- tiering ---
{
  t("scan -> cheap", classToTier("scan") === "cheap");
  t("extract/format -> cheap", classToTier("extract") === "cheap" && classToTier("format") === "cheap");
  t("judge/synthesize -> mid", classToTier("judge") === "mid" && classToTier("synthesize") === "mid");
  t("aggregate/adjudicate -> top", classToTier("aggregate") === "top" && classToTier("adjudicate") === "top");
  t("explicit tier overrides the class", effectiveTier(unit("u", "scan", { tier: "top" })) === "top");
  t("no explicit tier -> class default", effectiveTier(unit("u", "judge")) === "mid");
}

// --- width guardrail (cost = #1) ---
{
  t("8 -> allow", widthClass(8) === "allow");
  t("9 -> roi-required", widthClass(9) === "roi-required");
  t("32 -> roi-required", widthClass(32) === "roi-required");
  t("33 -> ticket-gated", widthClass(33) === "ticket-gated");
  t("allow admits unconditionally", widthGate(8, { hasRoiEstimate: false, hasBudgetTicket: false }).admit === true);
  t("9-32 WITHOUT ROI refused", widthGate(20, { hasRoiEstimate: false, hasBudgetTicket: false }).admit === false);
  t("9-32 WITH ROI admitted", widthGate(20, { hasRoiEstimate: true, hasBudgetTicket: false }).admit === true);
  t("over 32 WITHOUT ticket refused", widthGate(100, { hasRoiEstimate: true, hasBudgetTicket: false }).admit === false);
  t("over 32 WITH ticket admitted", widthGate(100, { hasRoiEstimate: false, hasBudgetTicket: true }).admit === true);
}

// --- display mode (temp-workspace default; headless degradation) ---
{
  t("visible opt-in + reachable + small -> temp-workspace", chooseDisplayMode(8, true, true) === "temp-workspace");
  t("NO opt-in -> headless even when reachable (FN4 default)", chooseDisplayMode(8, true, false) === "headless");
  t("opt-in but herdr unreachable -> headless", chooseDisplayMode(4, false, true) === "headless");
  t("opt-in but over pane budget (17) -> headless", chooseDisplayMode(17, true, true) === "headless");
  t("opt-in + exactly 16 -> temp-workspace", chooseDisplayMode(16, true, true) === "temp-workspace");
  t("zoneName prefixes fanout-", zoneName("abc") === "fanout-abc");
  t("zone-open fail degrades temp-workspace to headless (FN4-B)", degradeDisplay("temp-workspace", false) === "headless");
  t("zone opened keeps temp-workspace", degradeDisplay("temp-workspace", true) === "temp-workspace");
  t("headless stays headless under degrade", degradeDisplay("headless", false) === "headless");
  t("unit past its timeout is timed out (FN4-B hang)", elapsedTimedOut(0, 1000, 500) === true);
  t("unit within its timeout is not", elapsedTimedOut(0, 400, 500) === false);
}

// --- reduce + holes + quarantine (pit 2.1) ---
{
  const results: UnitResult[] = [
    { key: "a", status: "done", data: 1 },
    { key: "b", status: "failed", error: "boom" },
    { key: "c", status: "timeout" },
    { key: "d", status: "delivery_uncertain" },
  ];
  const red = reduceUnits(results);
  t("all terminal -> allTerminal true", red.allTerminal === true);
  t("done -> {key,data}", red.items.find((i) => i.key === "a")?.data === 1);
  t("failed -> {key,error} (blocks nothing)", red.items.find((i) => i.key === "b")?.error === "boom");
  t("timeout -> {key,error}", (red.items.find((i) => i.key === "c")?.error ?? "").length > 0);
  t("delivery_uncertain QUARANTINED as error, never respawned (pit 2.1)", (red.items.find((i) => i.key === "d")?.error ?? "").includes("quarantined"));
  const partial = reduceUnits([{ key: "a", status: "done", data: 1 }, { key: "b", status: "running" }]);
  t("a running unit makes it NOT all-terminal", partial.allTerminal === false);
  t("a running unit is excluded from the aggregate", !partial.items.some((i) => i.key === "b"));
}

// --- exactly-once receipt (pit 2.3) ---
{
  t("not all terminal -> not delivered", nextReceipt(undefined, false, true).delivered === false);
  const first = nextReceipt(undefined, true, true);
  t("first delivery when all terminal -> gen 1, delivered, accepted", first.generation === 1 && first.delivered && first.accepted);
  t("already delivered+accepted -> unchanged (NO re-deliver, pit 2.3)", nextReceipt(first, true, true) === first);
  const unacked = { generation: 1, delivered: true, accepted: false };
  const rearm = nextReceipt(unacked, true, true);
  t("unacked prior delivery RE-ARMS to a new generation", rearm.generation === 2 && rearm.delivered && rearm.accepted);
  const accepted = { generation: 1, delivered: true, accepted: true };
  t("an ACCEPTED receipt is FINAL even if a later pass is not-all-terminal (FN3)", nextReceipt(accepted, false, false) === accepted);
  t("an accepted receipt is not re-delivered when still all-terminal", nextReceipt(accepted, true, true) === accepted);
}

// --- progress line ---
{
  const rows: LedgerRow[] = [
    { id: "1", key: "a", backend: "self-built", displayMode: "temp-workspace", tier: "cheap", status: "done" },
    { id: "2", key: "b", backend: "self-built", displayMode: "temp-workspace", tier: "cheap", status: "running" },
    { id: "3", key: "c", backend: "self-built", displayMode: "temp-workspace", tier: "mid", status: "failed" },
  ];
  const p = progress(rows);
  t("progress counts", p.done === 1 && p.running === 1 && p.failed === 1 && p.total === 3);
  t("progress line is N done / M total", p.line === "1 done / 3 total");
}

// --- budget breaker (pit 2.5) ---
{
  t("tokens over cap -> exceeded", budgetExceeded({ tokens: 1000 }, { maxTokens: 1000 }) === true);
  t("usd over cap -> exceeded", budgetExceeded({ usd: 5 }, { maxUsd: 5 }) === true);
  t("under cap -> not exceeded", budgetExceeded({ tokens: 10 }, { maxTokens: 1000 }) === false);
  t("no cap -> never exceeded", budgetExceeded({ tokens: 1e9 }, {}) === false);
}

// --- depth cap (pit 2.4: recursion bomb) ---
{
  t("under depth cap admits", admitDepth(0) === true && admitDepth(1) === true);
  t("at depth cap refuses (stops agent-spawns-agent)", admitDepth(2) === false);
  t("custom cap honored", admitDepth(3, 5) === true && admitDepth(5, 5) === false);
  t("parseDepth absent/empty -> 0 root (FN6)", parseDepth(undefined) === 0 && parseDepth("") === 0);
  t("parseDepth valid integer", parseDepth("2") === 2);
  t("parseDepth NaN -> null (rejected, not coerced, FN6)", parseDepth("x") === null);
  t("parseDepth negative -> null", parseDepth("-1") === null);
  t("parseDepth non-integer -> null", parseDepth("1.5") === null);
}

// --- orphan sweep (pit 2.4: orphan process) ---
{
  const rows: LedgerRow[] = [
    { id: "1", key: "a", backend: "self-built", displayMode: "headless", tier: "cheap", status: "running", pid: 100 },
    { id: "2", key: "b", backend: "self-built", displayMode: "headless", tier: "cheap", status: "running", pid: 200 },
    { id: "3", key: "c", backend: "self-built", displayMode: "headless", tier: "cheap", status: "done", pid: 300 },
    { id: "4", key: "d", backend: "self-built", displayMode: "headless", tier: "cheap", status: "running" },
  ];
  const swept = reconcileOrphans(rows, new Set([100]));
  t("running + live pid -> unchanged", swept[0]!.status === "running");
  t("running + DEAD pid -> timeout (orphan swept)", swept[1]!.status === "timeout");
  t("already-terminal -> unchanged", swept[2]!.status === "done");
  t("running with no pid yet -> unchanged (not swept)", swept[3]!.status === "running");
  t("sweep is immutable (original untouched)", rows[1]!.status === "running");
}

// --- reap-only-own zone (pit 2.6: F42) ---
{
  const ours = new Set(["r1", "r2"]);
  t("own fanout zone -> reapable", canReapZone("fanout-r1", ours) === true);
  t("foreign fanout zone (runKey not ours) -> NOT reapable (pit 2.6)", canReapZone("fanout-rX", ours) === false);
  t("non-fanout zone (e.g. w1) -> NOT reapable", canReapZone("w1", ours) === false);
  t("empty-prefix guard", canReapZone("fanout-", ours) === false);
}

// --- ledger row construction ---
{
  const row = newLedgerRow(unit("u", "judge"), "id-1", "self-built", "temp-workspace", "fanout-r1");
  t("new row starts running, tier from class, zone set", row.status === "running" && row.tier === "mid" && row.zone === "fanout-r1");
}

// --- FN8: classify terminal status from real exit evidence ---
{
  t("failed spawn -> failed", classifyExit({ spawnOk: false, outputPresent: true }) === "failed");
  t("non-zero exit (42) -> failed (FN8)", classifyExit({ spawnOk: true, exitCode: 42, outputPresent: true }) === "failed");
  t("clean exit + output -> done", classifyExit({ spawnOk: true, exitCode: 0, outputPresent: true }) === "done");
  t("clean exit + NO output -> failed (empty yield not a silent success)", classifyExit({ spawnOk: true, exitCode: 0, outputPresent: false }) === "failed");
  t("unknown exit + output -> FAILED (no success without an explicit 0 exit, FN8)", classifyExit({ spawnOk: true, outputPresent: true }) === "failed");
  t("null exit + output -> failed (FN8)", classifyExit({ spawnOk: true, exitCode: null, outputPresent: true }) === "failed");
  t("unknown exit + no output -> failed", classifyExit({ spawnOk: true, outputPresent: false }) === "failed");
}

// --- FN7: width evidence must be real + bound to the run (not a bare flag) ---
{
  t("valid ROI estimate bound to runKey", validRoiEstimate({ runKey: "r1", speedupRatio: 3, costRatio: 1.2 }, "r1") === true);
  t("ROI estimate for a different run rejected", validRoiEstimate({ runKey: "rX", speedupRatio: 3, costRatio: 1.2 }, "r1") === false);
  t("ROI estimate missing a ratio rejected", validRoiEstimate({ runKey: "r1", speedupRatio: 3 }, "r1") === false);
  t("ROI estimate null rejected", validRoiEstimate(null, "r1") === false);
  t("valid budget ticket bound to runKey", validBudgetTicket({ runKey: "r1", maxTokens: 1000, issuedAt: 1 }, "r1") === true);
  t("budget ticket for a different run rejected", validBudgetTicket({ runKey: "rX", maxTokens: 1000, issuedAt: 1 }, "r1") === false);
  t("budget ticket with no ceiling rejected", validBudgetTicket({ runKey: "r1", issuedAt: 1 }, "r1") === false);
  t("budget ticket null rejected", validBudgetTicket(null, "r1") === false);
  t("Infinity maxTokens rejected (FN7)", validBudgetTicket({ runKey: "r1", maxTokens: Infinity, issuedAt: 1 }, "r1") === false);
  t("NaN maxUsd rejected (FN7)", validBudgetTicket({ runKey: "r1", maxUsd: NaN, issuedAt: 1 }, "r1") === false);
  t("Infinity ROI ratio rejected (FN7)", validRoiEstimate({ runKey: "r1", speedupRatio: Infinity, costRatio: 1 }, "r1") === false);
  t("mixed ticket: a non-finite maxTokens is rejected even with a valid maxUsd (FN7 round-4)", validBudgetTicket({ runKey: "r1", maxTokens: Infinity, maxUsd: 1, issuedAt: 1 }, "r1") === false);
}

// --- FN1 round-4: reservation validity (estimate required for a capped domain) + fit (equal allowed) ---
{
  t("reserveValid: finite non-neg, no caps -> ok", reserveValid({ tokens: 5, usd: 0 }, {}).ok === true);
  t("reserveValid: negative reserve rejected (FN1)", reserveValid({ tokens: -1, usd: 0 }, {}).ok === false);
  t("reserveValid: NaN reserve rejected", reserveValid({ tokens: NaN, usd: 0 }, {}).ok === false);
  t("reserveValid: capped USD but no estimate -> refuse (FN1)", reserveValid({ tokens: 5, usd: 0 }, { maxUsd: 1 }).ok === false);
  t("reserveValid: capped USD WITH estimate -> ok", reserveValid({ tokens: 5, usd: 0.01 }, { maxUsd: 1 }).ok === true);
  t("reserveValid: capped tokens but no estimate -> refuse", reserveValid({ tokens: 0, usd: 0 }, { maxTokens: 8 }).ok === false);
  t("reservationFits: exactly-equal is allowed (FN1)", reservationFits({ tokens: 0, usd: 0 }, { tokens: 8, usd: 0 }, { maxTokens: 8 }) === true);
  t("reservationFits: over the token cap rejected", reservationFits({ tokens: 4, usd: 0 }, { tokens: 8, usd: 0 }, { maxTokens: 8 }) === false);
  t("reservationFits: over the USD cap rejected", reservationFits({ tokens: 0, usd: 1 }, { tokens: 0, usd: 0.5 }, { maxUsd: 1 }) === false);
}

// --- FN2: resume reuses prior DONE rows by key, never re-runs them ---
{
  const prior: LedgerRow[] = [
    { id: "1", key: "a", backend: "self-built", displayMode: "headless", tier: "cheap", status: "done", outputPtr: "/o/a" },
    { id: "2", key: "b", backend: "self-built", displayMode: "headless", tier: "cheap", status: "failed" },
  ];
  const { reuse, toRun } = planResume(prior, [unit("a"), unit("b"), unit("c")]);
  t("a prior DONE unit is reused, not re-run (FN2)", reuse.length === 1 && reuse[0]!.key === "a");
  t("a prior FAILED unit + a new unit are to-run", toRun.map((u) => u.key).sort().join(",") === "b,c");
}

// --- FN1: budget-abort marks un-launched/running units terminal (aborted), never vanishing ---
{
  const rows: LedgerRow[] = [
    { id: "1", key: "a", backend: "self-built", displayMode: "headless", tier: "cheap", status: "done" },
    { id: "2", key: "b", backend: "self-built", displayMode: "headless", tier: "cheap", status: "running" },
  ];
  const aborted = markAborted(rows);
  t("running -> aborted on breaker (FN1)", aborted[1]!.status === "aborted");
  t("done -> unchanged", aborted[0]!.status === "done");
  t("aborted is terminal", isTerminal("aborted") === true);
  t("markAborted is immutable", rows[1]!.status === "running");
  t("a LIVE-pid running row is NOT aborted (FN2 round-4)", markAborted([{ id: "x", key: "x", backend: "self-built", displayMode: "headless", tier: "cheap", status: "running", pid: 12345 }])[0]!.status === "running");
  const red = reduceUnits([{ key: "b", status: "aborted" }]);
  t("aborted reduces to an error item (honest aggregate)", (red.items[0]?.error ?? "").length > 0 && red.allTerminal === true);
  t("aborted counts as failed in progress", progress(aborted).failed === 1);
}

console.log("all fanout selftests passed");
