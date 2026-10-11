// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/sanitized-read.selftest.mts
// Pins the PURE sanitized-read classifier: planSanitize (cat<file>⇒spec; options/2-args/metachar/glob/$/quote/credential ⇒ null),
// the consts, and the dormant flag.
import { planSanitize, sanitizedReadEnabled, SANITIZED_READ_BUDGET_SEC, SANITIZED_READ_MAX_BYTES, SANITIZED_READ_TRUNCATION_MARKER, SANITIZED_READ_DIRNAME } from "./sanitized-read.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// ── planSanitize: the one Phase-1 form `cat <oneArg>` ─────────────────────────────────────────────────────────
t("cat <relpath> ⇒ spec", (() => { const s = planSanitize("cat notes.txt"); return s !== null && s.readKind === "cat" && s.targetArg === "notes.txt"; })());
t("cat <abspath> ⇒ spec", (() => { const s = planSanitize("cat /w/sub/file"); return s !== null && s.targetArg === "/w/sub/file"; })());
t("cat with inner tabs still one arg ⇒ spec", (() => { const s = planSanitize("cat\tnotes.txt"); return s !== null && s.targetArg === "notes.txt"; })());

// ── not sanitizable ⇒ null (⇒ escalate to the user) ───────────────────────────────────────────────────────────
for (const c of [
  "cat",                 // no arg
  "cat a b",             // two args
  "cat -n notes.txt",    // option
  "cat --number f",      // long option
  "head notes.txt",      // not cat (Phase 2/3)
  "tail -f log",         // not cat
  "ls",                  // not cat
  "stat f",              // not cat
  "git show HEAD",       // git ⇒ not Phase 1
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
for (const c of ["cat .env", "cat sub/.env.local", "cat id_rsa", "cat deploy/id_ed25519", "cat x.pem", "cat secrets.txt", "cat ../credentials", "cat .ssh/config", "cat .npmrc", "cat app.key", "cat mytoken.json", "cat passwd.bak"]) {
  t(`credential path ⇒ null (escalate): ${c}`, planSanitize(c) === null);
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
