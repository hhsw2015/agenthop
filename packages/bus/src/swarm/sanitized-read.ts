/**
 * sanitized-read — the PURE classifier + constants for the sanitized-read feature (brief docs/swarm/sanitized-read-brief.md;
 * approval architecture ruling B + the coordinator's 6 frozen answers). The coordinator runs a HARDENED read in its controlled
 * env and injects the output; it NEVER execs the member's command (closes TOCTOU/env/filter). This module is the PURE side —
 * the flag, the budget/size constants, the SanitizeSpec, and `planSanitize` (parse+guard a command into a sanitizable spec, or
 * null ⇒ the caller escalates to the user). The hardened read + result-tmpfile IO is sanitized-read-io.ts; the verdict seam is
 * approval-delegation.ts (classifyApproval's 4th `sanitize` class, gated on SWARM_SANITIZED_READ).
 *
 * PHASE 1b (coordinator-frozen phasing 1→2→3): SIX path-read forms — `cat` / `head` / `tail` / `wc` / `ls` / `stat`, each a bare
 * `<form> <oneArg>` through the SAME signed `cat` hardening (fdWithinCwd / O_NOFOLLOW / budget / 0600 result / single-quoted
 * rewrite) — a pure producer-table expansion (sanitized-read-io.ts keys the producer off `readKind`). `file` is DEFERRED
 * (coordinator ruling 2026-10-11: the fd-read model can't reproduce libmagic, and a hardened `/usr/bin/file` subprocess would
 * open a new exec surface beyond the sound cat path — not worth it for one low-frequency form). git is NOT here (Phase 2/3).
 */
import { SECRET_RE } from "./approval-delegation.js";

/** Dormant flip, default OFF (opt-in; NOT flagDefaultOn — a new feature in its observation window, same family as
 *  SWARM_APPROVAL_DELEGATE / SWARM_OPS_RECEIPT). Independent of SWARM_APPROVAL_DELEGATE (scope-free) — enable separately. */
export function sanitizedReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_SANITIZED_READ ?? "");
}

/** ④ budget + size bounds (coordinator-frozen). Over-budget ⇒ the coordinator records NO decision ⇒ the hook times out ⇒
 *  fail-to-USER (never hang; never auto-allow the member's original command). */
export const SANITIZED_READ_BUDGET_SEC = 10;
export const SANITIZED_READ_MAX_BYTES = 1048576; // 1 MiB output cap
export const SANITIZED_READ_TRUNCATION_MARKER = "\n[truncated at 1MiB]\n"; // appended to a truncated result tail — NEVER silent (⑥ 证据诚实)

/** The coordinator-owned result-dir name (under ~/.agenthop/swarm/). The member hook validates a sanitize rewrite's path is under
 *  this dir (anti decision-tampering — a tampered decision can't point the member's cat at an arbitrary file). */
export const SANITIZED_READ_DIRNAME = "sanitized-read";

/** A parsed sanitizable read. Phase 1b: `cat`/`head`/`tail`/`wc` (content of a regular file), `ls` (a DIRECTORY's entries), `stat`
 *  (a regular file's metadata). Every form is `<form> <oneArg>`; the IO side keys its producer off `readKind`. */
export type SanitizeSpec = { readKind: "cat" | "head" | "tail" | "wc" | "ls" | "stat"; targetArg: string };

/** Phase-1b sanitizable command forms (the table that GROWS in Phase 2/3; `cat` stays first so the later forms read as additions).
 *  `file` is deferred (see the module header). ls targets a dir; the rest target a regular file — enforced on the IO side. */
const SANITIZE_FORMS = new Set<string>(["cat", "head", "tail", "wc", "ls", "stat"]);

/**
 * PURE: parse a Bash command into a SanitizeSpec, or null (⇒ not sanitizable ⇒ the caller escalates to the user). Applies the
 * SAME structural guards as approval-delegation's `planDelegation` — DELIBERATELY DUPLICATED, NOT shared, so the v1-signed
 * `planDelegation` stays byte-unchanged (the guards are the proven set; a future refactor may extract them). Then requires
 * EXACTLY `<form> <oneArg>` (no options, no second arg). A credential-PATH target ⇒ null (the ④ conservative red-line: a
 * credential path escalates to the user, never sanitized — REUSES the existing `SECRET_RE`, no new regex). Pure.
 */
export function planSanitize(command: string): SanitizeSpec | null {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return null;            // control chars (tab \x09 + newline \x0a excepted)
  if (/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) return null; // non-ASCII/NBSP/Unicode ws
  const c = command.trim();
  if (c === "") return null;
  if (/`|\$\(/.test(c)) return null;        // command substitution
  if (/\$/.test(c)) return null;            // variable expansion — unanalyzable
  if (/['"\\]/.test(c)) return null;        // quote / backslash anomaly
  if (/[;&|<>(){}\n]/.test(c)) return null; // redirect / chain / multi-command / brace group
  if (/[*?[\]{}~]/.test(c)) return null;    // glob / brace / tilde expansion
  const tokens = c.split(/[ \t]+/).filter(t => t.length > 0); // Bash IFS word-split is space/tab only
  if (tokens.length !== 2) return null;     // EXACTLY <form> <oneArg> — Phase 1 takes no options, no second path
  const [cmd, arg] = tokens;
  if (!SANITIZE_FORMS.has(cmd)) return null; // case-SENSITIVE; only the exact lowercase form (head/tail/ls/… are later phases)
  if (arg.startsWith("-")) return null;      // an option, not a path — Phase 1 forbids options
  if (SECRET_RE.test(arg.toLowerCase())) return null; // ④ credential-path red-line (SR-P1-2: case-INSENSITIVE, matches approval's isBlacklisted — `.ENV`/`ID_RSA` must also escalate, never sanitize)
  return { readKind: cmd as SanitizeSpec["readKind"], targetArg: arg };
}
