// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/sanitized-read.selftest.mts
// Pins the PURE sanitized-read classifier: planSanitize (cat/head/tail/wc/ls/stat <file> ⇒ spec; file(deferred)/options/2-args/
// metachar/glob/$/quote/credential ⇒ null), the consts, and the dormant flag.
import { planSanitize, sanitizedReadEnabled, SANITIZED_READ_BUDGET_SEC, SANITIZED_READ_MAX_BYTES, SANITIZED_READ_TRUNCATION_MARKER, SANITIZED_READ_DIRNAME } from "./sanitized-read.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// ── planSanitize: the Phase-1b forms `<form> <oneArg>` for form ∈ {cat,head,tail,wc,ls,stat} ──────────────────
t("cat <relpath> ⇒ spec", (() => { const s = planSanitize("cat notes.txt"); return s !== null && "targetArg" in s && s.readKind === "cat" && s.targetArg === "notes.txt"; })());
t("cat <abspath> ⇒ spec", (() => { const s = planSanitize("cat /w/sub/file"); return s !== null && "targetArg" in s && s.targetArg === "/w/sub/file"; })());
t("cat with inner tabs still one arg ⇒ spec", (() => { const s = planSanitize("cat\tnotes.txt"); return s !== null && "targetArg" in s && s.targetArg === "notes.txt"; })());
for (const k of ["head", "tail", "wc", "ls", "stat"] as const) {
  t(`${k} <arg> ⇒ spec (readKind=${k})`, (() => { const s = planSanitize(`${k} notes.txt`); return s !== null && "targetArg" in s && s.readKind === k && s.targetArg === "notes.txt"; })());
}
t("ls <dir> ⇒ spec (dir target)", (() => { const s = planSanitize("ls src/sub"); return s !== null && "targetArg" in s && s.readKind === "ls" && s.targetArg === "src/sub"; })());

// ── not sanitizable ⇒ null (⇒ escalate to the user) ───────────────────────────────────────────────────────────
for (const c of [
  "cat",                 // no arg
  "cat a b",             // two args
  "cat -n notes.txt",    // option
  "cat --number f",      // long option
  "file notes.txt",      // `file` is DEFERRED (coordinator ruling — not in the form table)
  "head -n 5 f",         // option (+ 3 tokens) — BARE forms only
  "tail -f log",         // option (+ 3 tokens)
  "wc -l f",             // option
  "ls -la dir",          // option (+ 3 tokens)
  "ls",                  // no arg
  "stat",                // no arg
  "git show HEAD",       // git ⇒ not Phase 1b (Phase 2/3)
  "cat a; rm b",         // chain
  "cat a | wc",          // pipe
  "cat a && b",          // chain
  "cat $HOME/x",         // var expansion
  "cat `id`",            // command substitution
  "cat $(id)",           // command substitution
  "cat *.txt",           // glob
  "cat f?",              // glob
  "cat ~/f",             // tilde
  "cat 'f'",             // quote
  "cat \"f\"",           // quote
  "cat f\\x",            // backslash
  "cat > out",           // redirect
  "",                    // empty
  "   ",                 // whitespace
  "cat a\rb",            // control char (CR)
  "cat a b",        // NBSP
]) {
  t(`not sanitizable ⇒ null: ${JSON.stringify(c)}`, planSanitize(c) === null);
}

// ── ④ credential red-line: a credential-PATH target ⇒ null (escalate, never sanitize) ─────────────────────────
for (const c of ["cat .env", "cat sub/.env.local", "cat id_rsa", "cat deploy/id_ed25519", "cat x.pem", "cat secrets.txt", "cat ../credentials", "cat .ssh/config", "cat .npmrc", "cat app.key", "cat mytoken.json", "cat passwd.bak",
                 "cat .ENV", "cat ID_RSA", "cat Secrets.TXT", "cat sub/.SSH/config", // SR-P1-2: credential check is CASE-INSENSITIVE
                 "head .env", "tail secrets.log", "wc app.key", "stat id_rsa", "ls .ssh", "ls .aws", "ls deploy/.SSH"]) { // the guard applies to EVERY form's target (incl. the ls dir)
  t(`credential path ⇒ null (escalate): ${c}`, planSanitize(c) === null);
}

// ── Phase 2: git committed-history planner (log/show/diff/branch, NON-content) ────────────────────────────────
const g = (cmd: string) => planSanitize(cmd);
t("git log ⇒ spec", (() => { const s = g("git log"); return s !== null && s.readKind === "git" && s.subcmd === "log" && s.flags.length === 0 && s.operands.length === 0; })());
t("git log --oneline --stat ⇒ flags", (() => { const s = g("git log --oneline --stat"); return s !== null && s.readKind === "git" && s.flags.join(",") === "--oneline,--stat"; })());
t("git log -5 ⇒ numeric flag", (() => { const s = g("git log -5"); return s !== null && s.readKind === "git" && s.flags[0] === "-5"; })());
t("git log main ⇒ rev operand", (() => { const s = g("git log main"); return s !== null && s.readKind === "git" && s.operands[0] === "main"; })());
t("git log HEAD~3 ⇒ rev operand (tilde/caret ok)", (() => { const s = g("git log HEAD~3"); return s !== null && s.readKind === "git" && s.operands[0] === "HEAD~3"; })());
t("git show --stat HEAD ⇒ spec", (() => { const s = g("git show --stat HEAD"); return s !== null && s.readKind === "git" && s.subcmd === "show" && s.operands[0] === "HEAD"; })());
t("git diff --stat HEAD~1 HEAD ⇒ 2 revs", (() => { const s = g("git diff --stat HEAD~1 HEAD"); return s !== null && s.readKind === "git" && s.operands.length === 2; })());
t("git diff --name-only a..b ⇒ range operand", (() => { const s = g("git diff --name-only a..b"); return s !== null && s.readKind === "git" && s.operands[0] === "a..b"; })());

for (const c of [
  "git",                       // no subcommand
  "git status -s",             // status DEFERRED — member-repo live-state (family ruling)
  "git remote -v",             // remote DEFERRED — member-repo live-state (family ruling)
  "git branch",                // branch DEFERRED — member-repo live-state (current */upstream/worktree/symref) outside the clone model (family ruling 2026-10-11)
  "git branch -a",             // branch DEFERRED (family ruling) — even the plain ref listing escalates
  "git branch --list",         // branch DEFERRED (family ruling)
  "git log -p",                // content (patch)
  "git log --patch",           // content
  "git log -U3",               // content (unified)
  "git show",                  // bare show = content ⇒ require a stat flag
  "git show HEAD",             // show with a rev but NO stat flag = content
  "git diff",                  // bare diff = content
  "git diff HEAD~1 HEAD",      // diff with revs but NO stat flag = content
  "git log --format=%H",       // flag not in the closed table
  "git log --pretty=oneline",  // flag not in the table
  "git show --stat HEAD:secret.txt", // rev:path CONTENT form (has `:`)
  "git log --stat -- file",    // `--` pathspec separator
  "git diff --stat ../etc",    // operand not rev-ish (leading `.`/path)
  "git log --stat /etc/passwd",// absolute-path operand (not a rev)
  "git log *.c",               // glob
  "git show --stat $(id)",     // command substitution
  "git log --stat; rm x",      // chain
  "git log --stat | cat",      // pipe
  "git push",                  // not a read subcommand
  "git diff --stat HEAD a b",  // > 2 operands for diff
]) {
  t(`git not sanitizable ⇒ null: ${JSON.stringify(c)}`, planSanitize(c) === null);
}

// ── consts (coordinator-frozen) ───────────────────────────────────────────────────────────────────────────────
t("budget = 10s", SANITIZED_READ_BUDGET_SEC === 10);
t("max bytes = 1 MiB", SANITIZED_READ_MAX_BYTES === 1048576);
t("truncation marker is explicit (never silent)", /truncated at 1MiB/.test(SANITIZED_READ_TRUNCATION_MARKER));
t("result dirname", SANITIZED_READ_DIRNAME === "sanitized-read");

// ── dormant flag: default OFF, opt-in ─────────────────────────────────────────────────────────────────────────
t("flag default OFF", sanitizedReadEnabled({}) === false);
t("flag ON (1/true/yes/on)", ["1", "true", "yes", "on"].every(v => sanitizedReadEnabled({ SWARM_SANITIZED_READ: v }) === true));
t("flag OFF (garbage)", sanitizedReadEnabled({ SWARM_SANITIZED_READ: "garbage" }) === false);

console.log("all sanitized-read selftests passed");
