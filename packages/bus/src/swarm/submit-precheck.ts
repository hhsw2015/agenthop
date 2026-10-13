/**
 * submit-precheck (pure core) — a mechanical PRE-REVIEW CHECKLIST the author runs before sending a change to review (coordinator
 * single, user "改善"; the TG-bridge r15 retro's #1 fix). It front-loads the checks the review seat was doing by hand: the top
 * retro hit (fc-2-three-state, #1 in the pool) and "same defect reworked across N rounds" both trace to a read/write call site
 * whose fault-handling / atomicity was not vetted before submit. This scans ONLY the diff (this branch vs base) and, for every
 * fs read/write call site it touches, emits a CHECKLIST line — OK / MISS / REVIEW — never a pass/fail gate.
 *
 * HONESTY (this is the first requirement): it is a PROMPTER, not an oracle and not a gate.
 *  - It is TEXTUAL + heuristic (no type system, no dataflow). It can be wrong both ways. So:
 *      OK     = a RECOGNIZED safe pattern is present (wx/O_EXCL, a temp+rename/linkSync commit, a catch that distinguishes ENOENT,
 *               an explicit append-atomicity judgment). "Looks handled" — still the author's call.
 *      MISS   = a RECOGNIZED smell with no mitigating pattern in view (a bare in-place writeFileSync to a non-temp path; a catch
 *               that folds a read fault to a default with no ENOENT distinction and no rethrow). A prompt to look, not a verdict.
 *      REVIEW = cannot be mechanically judged (openSync flags, an append's single-writer/size assumption, a read with no local
 *               catch that may intentionally propagate). The DEFAULT when unsure — never a MISS on a guess (false MISS = 误杀).
 *  - It NEVER blocks a submit and NEVER edits code. The caller prints the checklist; discipline (not enforcement) drives use.
 *
 * This module is PURE (no IO): diff parse, per-call-site classification, same-family scan, the fixture-teeth prompt, and render.
 * The IO seam (run `git diff`, read files, print) lives in scripts/submit-precheck.ts.
 */

export type CallKind = "read" | "write" | "append" | "open";
export type Verdict = "OK" | "MISS" | "REVIEW";
export type CallSite = { file: string; line: number; fn: string; kind: CallKind; verdict: Verdict; note: string };

/** The fs call sites this checklist tracks (coordinator's list). openSync is split out (read/write intent depends on its flags). */
export const READ_FNS = ["readFileSync", "readdirSync", "statSync", "lstatSync"] as const;
export const WRITE_FNS = ["writeFileSync"] as const;
export const APPEND_FNS = ["appendFileSync"] as const;
const ALL_FNS = [...READ_FNS, ...WRITE_FNS, ...APPEND_FNS, "openSync"];

export function kindOf(fn: string): CallKind {
  if ((WRITE_FNS as readonly string[]).includes(fn)) return "write";
  if ((APPEND_FNS as readonly string[]).includes(fn)) return "append";
  if (fn === "openSync") return "open";
  return "read";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Unified-diff parse (pure): map each changed file to the NEW-FILE line numbers of its ADDED lines. We only classify call sites the
// change actually introduced/touched, not the whole file (the whole file is read for CONTEXT + same-family only).
// ---------------------------------------------------------------------------------------------------------------------------------
export type DiffFile = { file: string; addedLines: number[] };

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Losslessly decode a Git-quoted path (SP-1). With the default core.quotePath, Git wraps a name containing non-ASCII bytes, a
 *  double-quote, a backslash, or a control char in `"..."` with C-style escapes (`\a \b \t \n \v \f \r \" \\` and octal `\nnn`
 *  for raw bytes); the octal bytes are UTF-8. An unquoted token is returned unchanged (its bytes are already literal). Disabling
 *  quotePath does NOT cover a literal quote/control char, so we DECODE rather than suppress. */
export function unquoteGitPath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") { bytes.push(c.charCodeAt(0) & 0xff); continue; }
    const n = inner[i + 1];
    if (n === undefined) { bytes.push(0x5c); break; }
    if (n >= "0" && n <= "7") { const oct = (inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/) ?? [""])[0]; bytes.push(parseInt(oct, 8) & 0xff); i += oct.length; continue; }
    bytes.push(simple[n] ?? (n.charCodeAt(0) & 0xff)); i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse `git diff` unified output. Returns, per file (new path), the sorted new-file line numbers of added (`+`) lines. A
 *  deleted file (new path `/dev/null`) contributes nothing. Pure + deterministic. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const byFile = new Map<string, number[]>();
  let file: string | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const decoded = unquoteGitPath(raw.slice(4).replace(/\r$/, "")); // Git C-quotes non-ASCII/special names ⇒ decode losslessly (SP-1)
      file = decoded === "/dev/null" ? null : decoded.replace(/^b\//, "");
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (raw.startsWith("--- ")) continue; // old-path header — ignore (we number the NEW file)
    const m = HUNK_RE.exec(raw);
    if (m) { newLine = Number(m[1]); continue; }
    if (file === null) continue;
    if (raw.startsWith("+")) { byFile.get(file)!.push(newLine); newLine += 1; } // an added line occupies this new-file line
    else if (raw.startsWith("-")) { /* a removed line: no new-file line consumed */ }
    else if (raw.startsWith(" ")) { newLine += 1; } // context line advances the new-file counter
    // any other line (e.g. "\ No newline at end of file") does not advance
  }
  return [...byFile.entries()].filter(([, l]) => l.length > 0).map(([f, l]) => ({ file: f, addedLines: l.sort((a, b) => a - b) }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Per-call-site classification (pure, textual heuristics). `lines` is the WHOLE file (1-based access via lines[n-1]); `n` is the
// 1-based line of the call. We look at a small window for the mitigating pattern.
// ---------------------------------------------------------------------------------------------------------------------------------
const isCommentLine = (s: string): boolean => { const t = s.trim(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"); };

/** Heuristic: is position `idx` inside a string/template literal on this line? (A single-line toggle count of unescaped ` " '.)
 *  Used to DROP a call pattern that is test-DATA inside a string (e.g. a selftest's `writeFileSync(p)` fixture) rather than a real
 *  call. Imperfect for multi-line templates, but kills the common single-line fixture-string false positive. */
export function inStringLiteral(line: string, idx: number): boolean {
  let bt = 0, dq = 0, sq = 0;
  for (let i = 0; i < idx && i < line.length; i++) {
    if (line[i - 1] === "\\") continue; // escaped char — not a delimiter
    const c = line[i];
    if (c === "`") bt ^= 1; else if (c === '"') dq ^= 1; else if (c === "'") sq ^= 1;
  }
  return bt === 1 || dq === 1 || sq === 1;
}
const windowText = (lines: string[], from1: number, to1: number): string =>
  lines.slice(Math.max(0, from1 - 1), Math.min(lines.length, to1)).join("\n");

/** Classify a READ call: OK if a catch distinguishing ENOENT is in view; MISS if a catch clearly FOLDS the fault (empty/returns a
 *  default, no ENOENT, no rethrow); REVIEW otherwise (no local catch ⇒ may intentionally propagate — the author's call). */
export function classifyRead(lines: string[], n: number, fn: string): { verdict: Verdict; note: string } {
  const callLine = lines[n - 1] ?? "";
  // 以名定态 (name-implies-state — DWS-1-ADOPT material, coordinator): a readdir scan that decides a boolean from entry NAMES
  // (.some/.filter/.find + startsWith/endsWith/includes) can conflate "a name like X exists" with "a valid/complete file X is
  // present" — the exact shape of the claim-name-only adopt bug. High-signal + narrow, so flag it for review regardless of catch.
  if (fn === "readdirSync" && /\.(some|filter|find)\s*\(/.test(callLine) && /startsWith|endsWith|includes/.test(callLine))
    return { verdict: "REVIEW", note: `readdirSync: decides state from entry NAMES (以名定态) — a matching NAME is not proof of a valid/complete file; if this gates a success/delivery/"already" decision, read + VALIDATE the file's content (DWS-1-ADOPT), do not trust the name` };
  const below = windowText(lines, n, n + 10);
  const hasCatch = /\bcatch\b/.test(below);
  if (!hasCatch) return { verdict: "REVIEW", note: `${fn}: no local catch in view — does it intentionally propagate (throw = unknown), or should it distinguish ENOENT vs other?` };
  const catchBody = below.slice(below.search(/\bcatch\b/));
  if (/ENOENT/.test(catchBody)) return { verdict: "OK", note: `${fn}: catch distinguishes ENOENT (three-state)` };
  if (/\bthrow\b/.test(catchBody)) return { verdict: "REVIEW", note: `${fn}: caught + rethrows, but ENOENT not named — confirm absence vs fault are not conflated` };
  return { verdict: "MISS", note: `${fn}: a catch FOLDS the fault with no ENOENT distinction and no rethrow — a read error reads as absence/default (fc-2-three-state smell)` };
}

/** Classify a WRITE (writeFileSync): OK for wx/O_EXCL or a temp+rename/linkSync commit; MISS for a bare write to a non-temp path;
 *  REVIEW for a temp-looking write whose commit is not in view. */
export function classifyWrite(lines: string[], n: number, fn: string): { verdict: Verdict; note: string } {
  const callLine = lines[n - 1] ?? "";
  // DWS-1-OWN / DWS-1-ADOPT material (coordinator): an exclusive create is the SAFE pattern, but the two subtle bugs live in its
  // SURROUNDINGS — so OK comes with the ownership + adopt reminders a textual scan cannot fully verify.
  if (/\bwx\b|O_EXCL/.test(callLine)) return { verdict: "OK", note: `${fn}: exclusive create (wx/O_EXCL). Also confirm — cleanup unlinks ONLY a temp you exclusively created (the create loop is OUTSIDE the cleanup finally, DWS-1-OWN), and any EEXIST branch VALIDATES the target is a real deliverable before adopting (a name collision is not proof, DWS-1-ADOPT)` };
  const targetsTemp = /\btmp\b|\.tmp|temp/i.test(callLine);
  const below = windowText(lines, n, n + 6);
  const commits = /renameSync\(|linkSync\(/.test(below);
  if (targetsTemp && commits) return { verdict: "REVIEW", note: `${fn}: temp write + atomic commit (rename/link) in view, but the temp is NOT exclusively created (no wx/O_EXCL) — a default write can TRUNCATE/FOLLOW a foreign temp, a hardlink to the real record, or a symlink (DWS-3-OWN). Confirm wx-exclusive create + clean-own-only` };
  if (targetsTemp) return { verdict: "REVIEW", note: `${fn}: writes a temp, but no rename/link commit in view — confirm the atomic commit (and that the temp is wx-exclusively created + cleaned own-only)` };
  return { verdict: "MISS", note: `${fn}: bare in-place write to a final path (no wx/O_EXCL, no temp+rename) — a concurrent reader can see a torn/empty file; a rename/write race can clobber` };
}

/** Classify an appendFileSync: OK if an explicit atomicity judgment is nearby (a comment naming O_APPEND / single-writer / atomic);
 *  REVIEW otherwise (append atomicity depends on writer-count + line size vs PIPE_BUF — not mechanically decidable). */
export function classifyAppend(lines: string[], n: number, fn: string): { verdict: Verdict; note: string } {
  const around = windowText(lines, n - 8, n + 2);
  if (/O_APPEND|single[-\s]?writer|single[-\s]?active|atomic append|atomic-append/i.test(around))
    return { verdict: "OK", note: `${fn}: an explicit append judgment is recorded nearby (single-writer / O_APPEND)` };
  // SP-2: do NOT present PIPE_BUF (a PIPE/FIFO atomicity bound, not a regular-file guarantee) or temp+rename (replacement
  // visibility, not append serialization) as universal append guarantees — point at the real questions instead.
  return { verdict: "REVIEW", note: `${fn}: append atomicity not evidently judged — confirm who writes this file (a SINGLE writer, or serialized writers?), that each append is ONE write of a complete record, and the crash-torn-tail recovery (a reader must skip a partial last line). O_APPEND only positions each write at the end; it does not serialize concurrent read-modify-write appenders` };
}

export function classifyOpen(lines: string[], n: number): { verdict: Verdict; note: string } {
  const callLine = lines[n - 1] ?? "";
  const excl = /O_EXCL/.test(callLine);
  const base = `openSync: confirm the fd is closed in a finally and the read/write intent matches.`;
  const write = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC/.test(callLine);
  if (write && !excl) return { verdict: "REVIEW", note: `${base} This looks like a WRITE open WITHOUT O_EXCL — a non-exclusive create can truncate/follow a foreign temp, a hardlink to the real record, or a symlink (DWS-3-OWN); prefer O_CREAT|O_EXCL for ownership (+ O_NOFOLLOW if a symlink is a risk)` };
  return { verdict: "REVIEW", note: `${base}${excl ? " O_EXCL present (exclusive ownership)." : ""} For a READ, prefer O_NONBLOCK|O_NOFOLLOW + fstat-regular to stay FIFO-safe and not follow a symlink` };
}

/** Scan ONE file: for each tracked fs call on an ADDED line (skipping comment lines), classify it. Pure. */
export function scanFile(file: string, lines: string[], addedLines: readonly number[]): CallSite[] {
  const out: CallSite[] = [];
  const added = new Set(addedLines);
  for (const n of addedLines) {
    const text = lines[n - 1];
    if (text === undefined || isCommentLine(text)) continue;
    for (const fn of ALL_FNS) {
      const m = new RegExp(`\\b${fn}\\s*\\(`).exec(text);
      if (!m) continue;
      if (inStringLiteral(text, m.index)) continue; // a call pattern inside a string literal is test-DATA, not a live call
      const kind = kindOf(fn);
      const c = kind === "write" ? classifyWrite(lines, n, fn)
        : kind === "append" ? classifyAppend(lines, n, fn)
        : kind === "open" ? classifyOpen(lines, n)
        : classifyRead(lines, n, fn);
      out.push({ file, line: n, fn, kind, verdict: c.verdict, note: c.note });
    }
  }
  if (added.size === 0) return out; // (kept for symmetry; addedLines drives the loop)
  return out;
}

/** Same-family scan: every line in `lines` that calls `fn` (skipping imports + comment lines). Used to surface siblings of a MISS
 *  — the "fixed the credential write, missed the message write" root cause: one hit ⇒ sieve the whole family in the file. Pure. */
export function sameFamily(lines: string[], fn: string): number[] {
  const re = new RegExp(`\\b${fn}\\s*\\(`);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    if (isCommentLine(t) || /^\s*import\b/.test(t) || /\bfrom ["']node:fs["']/.test(t)) continue;
    const m = re.exec(t);
    if (m && !inStringLiteral(t, m.index)) out.push(i + 1);
  }
  return out;
}

export function summarize(sites: readonly CallSite[]): { total: number; ok: number; miss: number; review: number } {
  return {
    total: sites.length,
    ok: sites.filter((s) => s.verdict === "OK").length,
    miss: sites.filter((s) => s.verdict === "MISS").length,
    review: sites.filter((s) => s.verdict === "REVIEW").length,
  };
}

/** Is a changed path a test/fixture file? (fixture-teeth prompt applies.) */
export function isTestFile(file: string): boolean { return /\.selftest\.mts$/.test(file) || /\.test\.ts$/.test(file) || /(^|\/)test\//.test(file); }

/** One line per call site, grouped by file, with a same-family note under each MISS. Pure render. `families` maps `${file}|${fn}`
 *  to the full-file line list for that fn (the CLI fills it only for files that had a MISS, to keep it cheap). */
export function renderChecklist(sites: readonly CallSite[], families: ReadonlyMap<string, number[]>): string {
  if (sites.length === 0) return "submit-precheck: no tracked fs read/write call sites in the diff.";
  const byFile = new Map<string, CallSite[]>();
  for (const s of sites) { if (!byFile.has(s.file)) byFile.set(s.file, []); byFile.get(s.file)!.push(s); }
  const mark = (v: Verdict): string => (v === "OK" ? "OK    " : v === "MISS" ? "MISS  " : "REVIEW");
  const lines: string[] = [];
  for (const [file, fs] of byFile) {
    lines.push(file);
    for (const s of fs.sort((a, b) => a.line - b.line)) {
      lines.push(`  L${s.line}  [${mark(s.verdict)}] ${s.note}`);
      if (s.verdict === "MISS") {
        const fam = families.get(`${file}|${s.fn}`);
        if (fam && fam.length > 1) lines.push(`         same-family ${s.fn} in this file (check them too): ${fam.map((l) => "L" + l).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

/** The fixture-teeth self-check prompt (no auto-edit): if the diff touched test files, remind the author to verify each new test
 *  actually FAILS when the production change is reverted ("负例必 fail"). Returns [] when no test files changed. */
export function teethPrompt(changedFiles: readonly string[]): string[] {
  const tests = changedFiles.filter(isTestFile);
  if (tests.length === 0) return [];
  return [
    "Fixture-teeth self-check (do this by hand — the precheck does NOT edit code):",
    ...tests.map((f) => `  - ${f}: revert the production change this test guards and confirm the test goes RED; then restore.`),
    "  A test that still passes with the fix reverted has no teeth (digest/egress EL-3-GATE lesson).",
  ];
}

/** The compact summary to paste into the submission message (step ④): "N call-sites — M OK / K MISS / R REVIEW". Pure. */
export function renderSubmissionSummary(sites: readonly CallSite[]): string {
  const s = summarize(sites);
  if (s.total === 0) return "submit-precheck: 0 tracked fs call sites in the diff.";
  return `submit-precheck (prompter, not a gate): ${s.total} fs read/write call-site(s) in the diff — ${s.ok} OK / ${s.miss} MISS / ${s.review} REVIEW. (MISS = a smell to look at; REVIEW = needs human judgment.)`;
}
