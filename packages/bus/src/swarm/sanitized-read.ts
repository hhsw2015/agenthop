/**
 * sanitized-read — the PURE classifier + constants for the sanitized-read feature (brief docs/swarm/sanitized-read-brief.md;
 * approval architecture ruling B + the coordinator's 6 frozen answers). The coordinator runs a HARDENED read in its controlled
 * env and injects the output; it NEVER execs the member's command (closes TOCTOU/env/filter). This module is the PURE side —
 * the flag, the budget/size constants, the SanitizeSpec, and `planSanitize` (parse+guard a command into a sanitizable spec, or
 * null ⇒ the caller escalates to the user). The hardened read + result-tmpfile IO is sanitized-read-io.ts; the verdict seam is
 * approval-delegation.ts (classifyApproval's 4th `sanitize` class, gated on SWARM_SANITIZED_READ).
 *
 * PHASE 1 (coordinator-frozen phasing 1→2→3): ONE read form — `cat <file>`. The form table (SANITIZE_FORMS) grows in Phase 2/3
 * (git is NOT here). A readKind→producer table on the IO side keys off `readKind`.
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

/** A parsed sanitizable read. Phase 1: only `cat <oneArg>`. */
export type SanitizeSpec = { readKind: "cat"; targetArg: string };

/** Phase-1 sanitizable command forms (the table that GROWS in Phase 2/3; keep `cat` the first entry so later forms are additions). */
const SANITIZE_FORMS = new Set<string>(["cat"]);

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
  if (SECRET_RE.test(arg)) return null;      // ④ credential-path red-line ⇒ escalate, never sanitize (reuse SECRET_RE)
  return { readKind: cmd as "cat", targetArg: arg };
}
