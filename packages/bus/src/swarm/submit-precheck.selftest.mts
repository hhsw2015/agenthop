// Selftest for submit-precheck (pure core): diff parse, per-call-site classification, same-family, teeth prompt, render.
//   npx tsx packages/bus/src/swarm/submit-precheck.selftest.mts
import { parseUnifiedDiff, scanFile, sameFamily, summarize, isTestFile, teethPrompt, renderChecklist, renderSubmissionSummary, classifyRead, classifyWrite, classifyAppend, classifyOpen, kindOf, inStringLiteral, type CallSite } from "./submit-precheck.js";

let pass = 0;
const t = (n: string, c: boolean): void => { if (!c) { console.error(`FAIL ${n}`); process.exit(1); } pass++; console.log(`ok  ${n}`); };
const L = (s: string): string[] => s.split("\n"); // build a "file" from a template string

// ── parseUnifiedDiff: added lines are numbered in the NEW file; context advances, deletions do not; /dev/null contributes nothing ──
{
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,2 +1,3 @@",
    " line1",
    "+added2",
    " line3",
    "@@ -10,2 +11,2 @@",
    "-gone",
    "+added11",
    " ctx12",
  ].join("\n");
  const r = parseUnifiedDiff(diff);
  t("parseUnifiedDiff: one file", r.length === 1 && r[0]!.file === "f.ts");
  t("parseUnifiedDiff: added new-file line numbers (context advances, deletion does not)", JSON.stringify(r[0]!.addedLines) === JSON.stringify([2, 11]));
}
{
  const diff = ["--- a/old.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-x"].join("\n");
  t("parseUnifiedDiff: a deleted file (new path /dev/null) contributes nothing", parseUnifiedDiff(diff).length === 0);
}
{
  const diff = ["+++ b/a.ts", "@@ -0,0 +1,1 @@", "+readFileSync(p)", "+++ b/b.ts", "@@ -0,0 +1,1 @@", "+writeFileSync(q, d)"].join("\n");
  const r = parseUnifiedDiff(diff);
  t("parseUnifiedDiff: two files, each with its own added lines", r.length === 2 && r[0]!.file === "a.ts" && r[1]!.file === "b.ts" && r[0]!.addedLines[0] === 1 && r[1]!.addedLines[0] === 1);
}

// ── kindOf ──
t("kindOf: write/append/open/read", kindOf("writeFileSync") === "write" && kindOf("appendFileSync") === "append" && kindOf("openSync") === "open" && kindOf("readFileSync") === "read" && kindOf("lstatSync") === "read");

// ── classifyRead: ENOENT catch ⇒ OK; folding catch ⇒ MISS; no catch / rethrow ⇒ REVIEW ──
t("read OK: a catch distinguishes ENOENT", classifyRead(L(`const x = readFileSync(p);\n} catch (e) { if (e.code === "ENOENT") return null; throw e; }`), 1, "readFileSync").verdict === "OK");
t("read MISS: a catch folds the fault (return default, no ENOENT, no throw)", classifyRead(L(`const x = readFileSync(p);\n} catch { return []; }`), 1, "readFileSync").verdict === "MISS");
t("read REVIEW: no local catch (may propagate)", classifyRead(L(`const x = readFileSync(p);\nconst y = 1;`), 1, "readFileSync").verdict === "REVIEW");
t("read REVIEW: caught + rethrows but ENOENT not named", classifyRead(L(`const x = readFileSync(p);\n} catch (e) { log(e); throw e; }`), 1, "readFileSync").verdict === "REVIEW");

// ── classifyWrite: wx/O_EXCL ⇒ OK; temp+rename ⇒ OK; temp w/o commit ⇒ REVIEW; bare final-path ⇒ MISS ──
t("write OK: wx exclusive create", classifyWrite(L(`writeFileSync(tmp, d, { flag: "wx", mode: 0o600 });`), 1, "writeFileSync").verdict === "OK");
t("write REVIEW: temp + renameSync commit but NO wx-exclusive create (DWS-3-OWN: default write can truncate/follow a foreign temp)", classifyWrite(L(`writeFileSync(tmp, d);\nrenameSync(tmp, file);`), 1, "writeFileSync").verdict === "REVIEW");
t("write REVIEW: temp write, no commit in view", classifyWrite(L(`writeFileSync(tmp, d);\nconst y = 1;`), 1, "writeFileSync").verdict === "REVIEW");
t("write MISS: bare in-place write to a final path", classifyWrite(L(`writeFileSync(p, JSON.stringify(v), { mode: 0o600 });`), 1, "writeFileSync").verdict === "MISS");

// ── classifyAppend: explicit judgment ⇒ OK; none ⇒ REVIEW ──
t("append OK: a single-writer/O_APPEND judgment is recorded nearby", classifyAppend(L(`// single-writer owner log, O_APPEND atomic\nappendFileSync(log, line);`), 2, "appendFileSync").verdict === "OK");
t("append REVIEW: no atomicity judgment nearby", classifyAppend(L(`appendFileSync(log, line);`), 1, "appendFileSync").verdict === "REVIEW");

// ── classifyOpen: always REVIEW (flags/fd lifecycle not mechanically decidable) ──
t("open REVIEW", classifyOpen(L(`const fd = openSync(p, 0);`), 1).verdict === "REVIEW");

// ── scanFile: only ADDED lines, skip comment lines, classify each tracked call ──
{
  const file = [
    `import { writeFileSync, readFileSync } from "node:fs";`, // 1 (import — but only classified if on an added line)
    `// writeFileSync(x) in a comment`,                        // 2 (comment ⇒ skipped even if added)
    `writeFileSync(p, d, { mode: 0o600 });`,                   // 3 bare ⇒ MISS
    `const x = readFileSync(q);`,                              // 4 no catch ⇒ REVIEW
    `appendFileSync(log, line);`,                              // 5 ⇒ REVIEW (but NOT added ⇒ skipped)
  ];
  const sites = scanFile("f.ts", file, [2, 3, 4]); // lines 2(comment),3,4 are "added"; 5 is not
  t("scanFile: comment line skipped, only added non-comment calls classified", sites.length === 2);
  const byLine = new Map(sites.map((s) => [s.line, s] as const));
  t("scanFile: L3 bare write ⇒ MISS", byLine.get(3)?.verdict === "MISS");
  t("scanFile: L4 read no-catch ⇒ REVIEW", byLine.get(4)?.verdict === "REVIEW");
  t("scanFile: L5 not added ⇒ absent", !byLine.has(5));
}

// ── inStringLiteral + scanFile skips a call pattern that is test-DATA inside a string (the selftest-fixture false positive) ──
t("inStringLiteral: inside backticks ⇒ true, outside ⇒ false", inStringLiteral("foo(`writeFileSync(x)`)", "foo(`".length) === true && inStringLiteral("writeFileSync(x)", 0) === false);
{
  const file = [
    `classifyWrite(["writeFileSync(p, d);"], 1, "writeFileSync");`, // 1: the fs call is INSIDE a string ⇒ test data ⇒ skipped
    `writeFileSync(real, d);`,                                       // 2: a real call ⇒ MISS
  ];
  const sites = scanFile("x.selftest.mts", file, [1, 2]);
  t("scanFile: a call inside a string literal is NOT classified (fixture-string false positive dropped)", sites.length === 1 && sites[0]!.line === 2);
}

// ── sameFamily: all calls to a fn, skipping imports + comments ──
{
  const file = [
    `import { writeFileSync } from "node:fs";`,  // 1 import ⇒ skip
    `writeFileSync(a, 1);`,                       // 2
    `// writeFileSync(x) note`,                   // 3 comment ⇒ skip
    `  writeFileSync(b, 2);`,                     // 4
  ];
  t("sameFamily: lists call lines, skips import + comment", JSON.stringify(sameFamily(file, "writeFileSync")) === JSON.stringify([2, 4]));
}

// ── summarize + renderSubmissionSummary ──
{
  const sites: CallSite[] = [
    { file: "f.ts", line: 3, fn: "writeFileSync", kind: "write", verdict: "MISS", note: "n" },
    { file: "f.ts", line: 4, fn: "readFileSync", kind: "read", verdict: "REVIEW", note: "n" },
    { file: "f.ts", line: 5, fn: "writeFileSync", kind: "write", verdict: "OK", note: "n" },
  ];
  const s = summarize(sites);
  t("summarize: counts", s.total === 3 && s.ok === 1 && s.miss === 1 && s.review === 1);
  t("renderSubmissionSummary: mentions counts + prompter-not-a-gate", /3 fs/.test(renderSubmissionSummary(sites)) && /1 OK \/ 1 MISS \/ 1 REVIEW/.test(renderSubmissionSummary(sites)) && /not a gate/.test(renderSubmissionSummary(sites)));
  t("renderSubmissionSummary: empty ⇒ 0 call sites", /0 tracked/.test(renderSubmissionSummary([])));
}

// ── renderChecklist: groups by file + shows a same-family note under a MISS ──
{
  const sites: CallSite[] = [{ file: "f.ts", line: 3, fn: "writeFileSync", kind: "write", verdict: "MISS", note: "bare write" }];
  const fam = new Map<string, number[]>([["f.ts|writeFileSync", [3, 9, 12]]]);
  const out = renderChecklist(sites, fam);
  t("renderChecklist: shows the MISS line + the same-family siblings", /L3/.test(out) && /MISS/.test(out) && /same-family writeFileSync/.test(out) && /L9, L12/.test(out));
  t("renderChecklist: empty ⇒ a clear 'none' line", /no tracked fs/.test(renderChecklist([], new Map())));
}

// ── isTestFile + teethPrompt ──
t("isTestFile: .test.ts / .selftest.mts / test/ dir", isTestFile("a.test.ts") && isTestFile("x/y.selftest.mts") && isTestFile("packages/bus/test/z.ts") && !isTestFile("packages/bus/src/inbox.ts"));
{
  const p = teethPrompt(["packages/bus/src/inbox.ts", "packages/bus/test/inbox.test.ts"]);
  t("teethPrompt: lists the changed test file + the revert-to-RED reminder", p.length > 0 && p.some((l) => /inbox\.test\.ts/.test(l)) && p.some((l) => /RED/.test(l)));
  t("teethPrompt: no test files ⇒ empty", teethPrompt(["packages/bus/src/inbox.ts"]).length === 0);
}

console.log(`\nall submit-precheck selftests passed (${pass})`);
