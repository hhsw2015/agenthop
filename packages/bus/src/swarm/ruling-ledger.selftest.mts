import { loadRuling, loadLedger, buildIndex, idSortKey, rulingFileRelPath, rulingLedgerEnabled, INDEX_VERSION, type Ruling } from "./ruling-ledger.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const R = (o: Partial<Ruling> & { id: string; series?: any; status?: any }): any => ({ series: o.id[0], title: "t", statement: "s", status: "active", ...o });

// --- loadRuling: happy ---
t("loadRuling: minimal valid", loadRuling(R({ id: "R16" })).ok === true);
t("loadRuling: full valid carries known fields", (() => {
  const r = loadRuling({ id: "F45", series: "F", title: "stranded", statement: "...", status: "active", rationale: "why", relates: ["R16"], sources: ["PROGRESS:120", "sha123"], since: "2026-10-09", by: "coordinator" });
  return r.ok === true && r.ok && r.ruling.rationale === "why" && r.ruling.relates?.[0] === "R16" && r.ruling.by === "coordinator";
})());
t("loadRuling: sub-letter id ok", loadRuling(R({ id: "S28-b" })).ok === true);

// --- loadRuling: rejects ---
t("reject: not an object", loadRuling(null).ok === false && loadRuling([] as any).ok === false && loadRuling("x" as any).ok === false);
t("reject: bad id pattern", loadRuling(R({ id: "X9" })).ok === false && loadRuling({ id: "R", series: "R", title: "t", statement: "s", status: "active" }).ok === false);
t("reject: series != id prefix", loadRuling({ id: "R3", series: "S", title: "t", statement: "s", status: "active" }).ok === false);
t("reject: bad status enum", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "open" }).ok === false);
t("reject: missing/empty title or statement", loadRuling({ id: "R3", series: "R", title: "", statement: "s", status: "active" }).ok === false && loadRuling({ id: "R3", series: "R", title: "t", statement: "", status: "active" }).ok === false);
t("reject: rationale non-string", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "active", rationale: 5 }).ok === false);
t("reject: supersedes not id-array", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "superseded", supersededBy: "R4", supersedes: ["nope"] }).ok === false);
t("reject: supersededBy bad id", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "superseded", supersededBy: "lower" }).ok === false);
t("reject: sources non-string-array", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "active", sources: [1, 2] }).ok === false);
t("reject: self supersededBy / supersedes / relates", loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "superseded", supersededBy: "R3" }).ok === false
  && loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "active", supersedes: ["R3"] }).ok === false
  && loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "active", relates: ["R3"] }).ok === false);
t("tolerate: unknown extra field (accepted, not copied)", (() => { const r = loadRuling({ id: "R3", series: "R", title: "t", statement: "s", status: "active", extra: "x" }); return r.ok === true && r.ok && !("extra" in r.ruling); })());

// --- loadLedger ---
const pair = [
  { id: "R3", series: "R", title: "old", statement: "s", status: "superseded", supersededBy: "R3-b" },
  { id: "R3-b", series: "R", title: "new", statement: "s", status: "active", supersedes: ["R3"] },
];
t("ledger: valid supersession pair ok", loadLedger(pair).ok === true);
t("ledger: non-array rejects", loadLedger("x" as any).ok === false);
t("ledger: a bad record rejects whole (with index)", (() => { const r = loadLedger([R({ id: "R1" }), { id: "bad" }]); return r.ok === false && /record 1/.test(r.ok ? "" : r.reason); })());
t("ledger: duplicate id rejects", loadLedger([R({ id: "R1" }), R({ id: "R1" })]).ok === false);
t("ledger: dangling supersedes rejects", loadLedger([{ id: "R3-b", series: "R", title: "n", statement: "s", status: "active", supersedes: ["R99"] }]).ok === false);
t("ledger: dangling relates rejects", loadLedger([R({ id: "R1", relates: ["R99"] })]).ok === false);
t("ledger: dangling supersededBy rejects", loadLedger([{ id: "R3", series: "R", title: "o", statement: "s", status: "superseded", supersededBy: "R99" }]).ok === false);
t("ledger: supersession not bidirectional (missing back-ref) rejects", loadLedger([
  { id: "R3", series: "R", title: "o", statement: "s", status: "superseded", supersededBy: "R3-b" },
  { id: "R3-b", series: "R", title: "n", statement: "s", status: "active" }, // lacks supersedes:["R3"]
]).ok === false);
t("ledger: forward supersedes without back supersededBy rejects", loadLedger([
  { id: "R3", series: "R", title: "o", statement: "s", status: "active" }, // lacks supersededBy
  { id: "R3-b", series: "R", title: "n", statement: "s", status: "active", supersedes: ["R3"] },
]).ok === false);
t("ledger: superseded ruling still active rejects", loadLedger([
  { id: "R3", series: "R", title: "o", statement: "s", status: "active", supersededBy: "R3-b" },
  { id: "R3-b", series: "R", title: "n", statement: "s", status: "active", supersedes: ["R3"] },
]).ok === false);

// --- idSortKey + buildIndex ordering ---
t("idSortKey: numeric not lexical (R3 < R10)", (() => { const a = idSortKey("R3"), b = idSortKey("R10"); return a[0] === b[0] && a[1] < b[1]; })());
t("idSortKey: base before sub-letter (R3 < R3-a)", idSortKey("R3")[2] < idSortKey("R3-a")[2]);
t("idSortKey: series rank R<S<F", idSortKey("R1")[0] < idSortKey("S1")[0] && idSortKey("S1")[0] < idSortKey("F1")[0]);

const many = loadLedger([R({ id: "F45" }), R({ id: "R10" }), R({ id: "S29" }), R({ id: "R3-b" }), R({ id: "R3" }), R({ id: "R2" })]);
t("buildIndex: deterministic R→S→F, numeric, sub-letter", (() => {
  if (!many.ok) return false;
  const idx = buildIndex(many.rulings, 1000);
  return idx.entries.map((e) => e.id).join(",") === "R2,R3,R3-b,R10,S29,F45";
})());
t("buildIndex: counts + version + generatedAtSec", (() => {
  if (!many.ok) return false;
  const idx = buildIndex(many.rulings, 1000.9);
  return idx.version === INDEX_VERSION && idx.count === 6 && idx.bySeriesCount.R === 4 && idx.bySeriesCount.S === 1 && idx.bySeriesCount.F === 1 && idx.generatedAtSec === 1000;
})());
t("buildIndex: non-finite nowSec -> 0", (() => { if (!many.ok) return false; return buildIndex(many.rulings, NaN).generatedAtSec === 0; })());
t("buildIndex: entry carries supersededBy", (() => { if (!loadLedger(pair).ok) return false; const idx = buildIndex((loadLedger(pair) as any).rulings, 1); const r3 = idx.entries.find((e) => e.id === "R3"); return r3?.supersededBy === "R3-b"; })());

// --- rulingFileRelPath + enabled flag ---
t("rulingFileRelPath: valid id", rulingFileRelPath("R16") === "rulings/R16.json" && rulingFileRelPath("S28-b") === "rulings/S28-b.json");
t("rulingFileRelPath: bad id throws (no path traversal)", (() => { try { rulingFileRelPath("../etc/passwd"); return false; } catch { return true; } })());
t("rulingLedgerEnabled default OFF", rulingLedgerEnabled({} as any) === false && rulingLedgerEnabled({ SWARM_RULING_LEDGER: "1" } as any) === true);

console.log("all ruling-ledger selftests passed");
