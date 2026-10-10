// Run: packages/bus/node_modules/.bin/tsx scripts/rulings.selftest.mts
// Covers the pure helpers of the rulings CLI (arg classification, filter/grep/sort, compact + full formatting). The disk
// loader + ledger validation are the SIGNED loadLedger (tested in ruling-ledger.selftest.mts); this file does not re-test them.
import { classifyArgs, filterRulings, grepRulings, sortRulings, compactLine, fullText } from "./rulings.js";
import type { Ruling } from "../packages/bus/src/swarm/ruling-ledger.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const R = (o: Partial<Ruling> & { id: string }): Ruling => ({ series: (o.series ?? (o.id[0] as Ruling["series"])), title: o.title ?? `t-${o.id}`, statement: o.statement ?? `stmt ${o.id}`, status: o.status ?? "active", ...o });

// --- classifyArgs ---
t("classify: empty -> usage (no error)", (() => { const q = classifyArgs([]); return q.mode === "usage" && q.error === undefined; })());
t("classify: a valid id -> show", (() => { const q = classifyArgs(["R16"]); return q.mode === "show" && q.id === "R16"; })());
t("classify: sub-letter id -> show", (() => { const q = classifyArgs(["S28-b"]); return q.mode === "show" && q.id === "S28-b"; })());
t("classify: unrecognized token -> usage error", (() => { const q = classifyArgs(["bogus"]); return q.mode === "usage" && !!q.error; })());
t("classify: list bare -> list, no filters", (() => { const q = classifyArgs(["list"]); return q.mode === "list" && q.series === undefined && q.status === undefined; })());
t("classify: list --series S --status active", (() => { const q = classifyArgs(["list", "--series", "S", "--status", "active"]); return q.mode === "list" && q.series === "S" && q.status === "active"; })());
t("classify: list --series X -> usage error", (() => { const q = classifyArgs(["list", "--series", "X"]); return q.mode === "usage" && !!q.error; })());
t("classify: list --status bogus -> usage error", (() => { const q = classifyArgs(["list", "--status", "bogus"]); return q.mode === "usage" && !!q.error; })());
t("classify: list --series with no value -> usage error", (() => { const q = classifyArgs(["list", "--series"]); return q.mode === "usage" && !!q.error; })());
t("classify: list unknown option -> usage error", (() => { const q = classifyArgs(["list", "--wat"]); return q.mode === "usage" && !!q.error; })());
t("classify: grep <word> -> grep", (() => { const q = classifyArgs(["grep", "token"]); return q.mode === "grep" && q.word === "token"; })());
t("classify: grep with no word -> usage error", (() => { const q = classifyArgs(["grep"]); return q.mode === "usage" && !!q.error; })());

// --- sort (series R→S→F, number, sub-letter) ---
t("sort: R→S→F, numeric, sub-letter", sortRulings([R({ id: "S29" }), R({ id: "F45" }), R({ id: "R10" }), R({ id: "R3-b" }), R({ id: "R3" }), R({ id: "R2" })]).map((r) => r.id).join(",") === "R2,R3,R3-b,R10,S29,F45");

// --- filter ---
const set = [R({ id: "R1" }), R({ id: "R3", status: "superseded", supersededBy: "R3-b" }), R({ id: "S14" }), R({ id: "F45", status: "retired" })];
t("filter: by series S", filterRulings(set, { series: "S" }).map((r) => r.id).join(",") === "S14");
t("filter: by status active", filterRulings(set, { status: "active" }).map((r) => r.id).join(",") === "R1,S14");
t("filter: series+status", filterRulings(set, { series: "R", status: "active" }).map((r) => r.id).join(",") === "R1");
t("filter: none -> all, sorted", filterRulings(set, {}).map((r) => r.id).join(",") === "R1,R3,S14,F45");

// --- grep (statement substring, case-insensitive) ---
const g = [R({ id: "R1", statement: "the Alpha rule" }), R({ id: "R2", statement: "beta only" }), R({ id: "R3", statement: "ALPHA again" })];
t("grep: case-insensitive statement match", grepRulings(g, "alpha").map((r) => r.id).join(",") === "R1,R3");
t("grep: no match -> empty", grepRulings(g, "zzz").length === 0);
t("grep: only searches statement, not title", grepRulings([R({ id: "R1", title: "needle", statement: "hay" })], "needle").length === 0);

// --- formatting (ASCII only; no decorative unicode) ---
const asciiArrows = (s: string) => !/[→←↔⇒]/.test(s);
t("compactLine: id/status/title", compactLine(R({ id: "R1", title: "hi" })) === "R1      active     hi");
t("compactLine: shows supersededBy", /superseded by R3-b/.test(compactLine(R({ id: "R3", status: "superseded", supersededBy: "R3-b" }))));
t("compactLine: ASCII only", asciiArrows(compactLine(R({ id: "R3", status: "superseded", supersededBy: "R3-b" }))));
t("fullText: has statement + rationale blocks", (() => { const s = fullText(R({ id: "R1", statement: "ST", rationale: "WHY" })); return s.includes("statement:") && s.includes("  ST") && s.includes("rationale:") && s.includes("  WHY"); })());
t("fullText: omits empty optional fields", (() => { const s = fullText(R({ id: "R1" })); return !s.includes("rationale:") && !s.includes("supersedes:") && !s.includes("sources:"); })());
t("fullText: lists supersedes/relates/sources when present", (() => { const s = fullText(R({ id: "R3-b", supersedes: ["R3"], relates: ["R11"], sources: ["PROGRESS.md:1"] })); return s.includes("supersedes: R3") && s.includes("relates: R11") && s.includes("sources: PROGRESS.md:1"); })());
t("fullText: ASCII only", asciiArrows(fullText(R({ id: "R3", status: "superseded", supersededBy: "R3-b", supersedes: ["R2"] }))));

console.log("all rulings selftests passed");
