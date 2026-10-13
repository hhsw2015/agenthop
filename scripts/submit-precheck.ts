// submit-precheck — a mechanical pre-review CHECKLIST (coordinator single; user "改善"; TG-bridge r15 retro #1). Run it on your
// branch BEFORE sending a change to review: it scans ONLY the diff (this branch vs base) and, for every fs read/write call site the
// change touches, prints OK / MISS / REVIEW + a same-family note on a MISS + a fixture-teeth reminder + a one-line summary to paste
// into the submission message. It is a PROMPTER, never a gate: it does not block, does not edit, and always exits 0 (bar usage).
// The pure core (diff parse + classification + render) is in packages/bus/src/swarm/submit-precheck.ts.
//
//   submit-precheck [base]            checklist for HEAD+worktree vs <base> (default: main)
//   submit-precheck --summary [base]  print ONLY the one-line submission summary (for step ④ injection)
//
// Exit: 0 always (prompter) except 2 on a usage/git error. ASCII only.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseUnifiedDiff, scanFile, sameFamily, teethPrompt, renderChecklist, renderSubmissionSummary, type CallSite } from "../packages/bus/src/swarm/submit-precheck.js";

function git(args: string[]): string {
  try { return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new Error(`git ${args.join(" ")} failed: ${e instanceof Error ? e.message : e}`); }
}

function main(): void {
  const argv = process.argv.slice(2);
  const summaryOnly = argv[0] === "--summary";
  const rest = summaryOnly ? argv.slice(1) : argv;
  if (rest.length > 1) { console.error("usage: submit-precheck [base] | submit-precheck --summary [base]"); process.exitCode = 2; return; }
  const base = rest[0] ?? "main";

  let mergeBase: string;
  try { mergeBase = git(["merge-base", base, "HEAD"]).trim(); }
  catch (e) { console.error(`submit-precheck: cannot find a merge-base with ${JSON.stringify(base)}: ${e instanceof Error ? e.message : e}`); process.exitCode = 2; return; }

  let diff: string;
  try { diff = git(["diff", mergeBase]); } // merge-base vs working tree: committed + uncommitted changes to TRACKED files
  catch (e) { console.error(`submit-precheck: ${e instanceof Error ? e.message : e}`); process.exitCode = 2; return; }

  const files = parseUnifiedDiff(diff);
  // `git diff` omits UNTRACKED (brand-new, not-yet-added) files — but a new module is exactly what an author checks before submit.
  // Treat each untracked file as all-added (every line is new) so a fresh file's call sites are scanned too.
  let untracked: string[] = [];
  try { untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter(Boolean); }
  catch { /* best-effort: if this fails, we still have the tracked diff */ }
  for (const f of untracked) {
    if (files.some((d) => d.file === f)) continue;
    let n = 0;
    try { n = readFileSync(f, "utf8").split("\n").length; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`submit-precheck: skipping unreadable ${f}\n`); continue; } // ENOENT = raced away ⇒ skip; other fault ⇒ surfaced
    files.push({ file: f, addedLines: Array.from({ length: n }, (_, i) => i + 1) });
  }
  const sites: CallSite[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f.file, "utf8"); } // read the NEW content from the working tree
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`submit-precheck: skipping unreadable ${f.file}\n`); continue; } // ENOENT = deleted in worktree ⇒ nothing to classify; other fault ⇒ surfaced, not swallowed
    sites.push(...scanFile(f.file, text.split("\n"), f.addedLines));
  }

  // same-family lists only for files that had a MISS (keep it cheap): map `${file}|${fn}` -> all same-fn lines in that file.
  const families = new Map<string, number[]>();
  const fileText = new Map<string, string[]>();
  for (const s of sites) {
    if (s.verdict !== "MISS") continue;
    const key = `${s.file}|${s.fn}`;
    if (families.has(key)) continue;
    let lines = fileText.get(s.file);
    if (!lines) { try { lines = readFileSync(s.file, "utf8").split("\n"); fileText.set(s.file, lines); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`submit-precheck: skipping unreadable ${s.file}\n`); continue; } }
    families.set(key, sameFamily(lines, s.fn));
  }

  const summary = renderSubmissionSummary(sites);
  if (summaryOnly) { console.log(summary); return; }

  console.log(`submit-precheck: ${files.length} changed file(s) vs ${base} (merge-base ${mergeBase.slice(0, 9)}). PROMPTER, not a gate.\n`);
  console.log(renderChecklist(sites, families));
  const teeth = teethPrompt(files.map((f) => f.file));
  if (teeth.length > 0) { console.log("\n" + teeth.join("\n")); }
  console.log("\n" + summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
