/**
 * sanitized-read — the PURE classifier + constants for the sanitized-read feature (brief docs/swarm/sanitized-read-brief.md;
 * approval architecture ruling B + the coordinator's 6 frozen answers). The coordinator runs a HARDENED read in its controlled
 * env and injects the output; it NEVER execs the member's command (closes TOCTOU/env/filter). This module is the PURE side —
 * the flag, the budget/size constants, the SanitizeSpec, and `planSanitize` (parse+guard a command into a sanitizable spec, or
 * null ⇒ the caller escalates to the user). The hardened read + result-tmpfile IO is sanitized-read-io.ts; the verdict seam is
 * approval-delegation.ts (classifyApproval's 4th `sanitize` class, gated on SWARM_SANITIZED_READ).
 *
 * PHASE 1b: FIVE path-read forms (`cat`/`head`/`tail`/`wc`/`ls`/`stat`) through the signed `cat` hardening (fdWithinCwd / O_NOFOLLOW
 * / budget / 0600 result / single-quoted rewrite) — sanitized-read-io.ts keys the producer off `readKind`. `file` is DEFERRED
 * (coordinator 2026-10-11: the fd-read model can't reproduce libmagic; a hardened `/usr/bin/file` subprocess is a new exec surface).
 *
 * PHASE 2: git COMMITTED-HISTORY reads (`log`/`show`/`diff`, NON-content) — the coordinator runs them HARDENED in a THROWAWAY
 * `--mirror` clone (env scrubbed, `-c` family, `--no-pager`, no checkout/upload-pack ⇒ no config exec) and injects the output
 * (sanitized-read-git.ts). The closed flag table is REUSED from the frozen git-recall brief. `branch`/`remote`/`status` are DEFERRED
 * by the coordinator's FAMILY ruling (member-repo LIVE-STATE is outside the clone model's domain — see GitSubcmd). Every form still
 * reduces to the member cat-ing the coordinator's result, so the verdict seam (approval-gate) is form-agnostic.
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

/** Phase-1b path-read forms (content of a regular file: cat/head/tail/wc; `ls` a DIRECTORY's entries; `stat` metadata). */
export type PathReadKind = "cat" | "head" | "tail" | "wc" | "ls" | "stat";
/** Phase-2 committed-history git subcommands (NON-content; the coordinator runs these HARDENED in a THROWAWAY `--mirror` clone and
 *  injects the output — sanitized-read-git.ts). ONLY committed-history CONTENT/metadata reads. `branch`/`remote`/`status` are
 *  DEFERRED by the coordinator's family ruling (2026-10-11): a "member-repo LIVE-STATE" form (current branch, upstream, worktree
 *  occupancy, symref aliases, remotes, working tree) is OUTSIDE the clone model's domain — a clone faithfully reproduces committed
 *  history but NOT live repo state — so the sanitize Phase does not handle them; they escalate to the user. */
export type GitSubcmd = "log" | "show" | "diff";
/** A parsed sanitizable read: a path form (`<form> <oneArg>`) OR a git committed-history read (subcmd + closed flags + rev operands).
 *  The IO side keys its producer off `readKind` (path ⇒ sanitized-read-io; git ⇒ sanitized-read-git). */
export type SanitizeSpec =
  | { readKind: PathReadKind; targetArg: string }
  | { readKind: "git"; subcmd: GitSubcmd; flags: string[]; operands: string[] };

/** Phase-1b sanitizable PATH-read forms. `file` is deferred (see the module header). ls targets a dir; the rest a regular file. */
const SANITIZE_FORMS = new Set<string>(["cat", "head", "tail", "wc", "ls", "stat"]);

/** Phase-2 git closed FLAG table (REUSED verbatim from the frozen git-recall brief — the brief's named audit input). Each set is
 *  the EXACT value-less flags allowed per subcommand; anything outside ⇒ escalate. NO `-p`/`--patch`/`-U` (content) anywhere. */
const GIT_FLAGS: Record<GitSubcmd, Set<string>> = {
  log: new Set(["--oneline", "--stat", "--graph", "--decorate", "--no-color", "--numstat", "--shortstat", "--name-only", "--name-status", "--all"]),
  show: new Set(["--stat", "--numstat", "--name-only", "--name-status"]),
  diff: new Set(["--stat", "--name-only", "--name-status", "--numstat", "--shortstat", "--summary"]),
};
/** show/diff default to CONTENT (a patch); a bare `git show`/`git diff` ⇒ escalate — require ≥1 non-content stat/name flag. */
const GIT_REQUIRE_FLAG = new Set<GitSubcmd>(["show", "diff"]);
/** A rev-ish operand pre-filter (the SOUND disambiguation is the clone-side `rev-parse --verify ^{commit}` in sanitized-read-git).
 *  First char alnum/_/@/^ (no leading `-`/`.`/`/`/`~` ⇒ no flag/path/home); body adds `.`/`/`/`~`/`-` (branch/tag/`HEAD~3`); an
 *  optional `..`/`...` range. Bans `:` (the `rev:path` CONTENT form), `*?[]{}` (glob/brace), and all shell metacharacters. */
const GIT_REV_RE = /^[A-Za-z0-9_@^][A-Za-z0-9_.@^~/-]*(\.\.\.?[A-Za-z0-9_@^][A-Za-z0-9_.@^~/-]*)?$/;
function isGitSubcmd(s: string): s is GitSubcmd { return s === "log" || s === "show" || s === "diff"; } // branch/remote/status deferred (family ruling)

/**
 * PURE: parse a Bash command into a SanitizeSpec, or null (⇒ not sanitizable ⇒ the caller escalates to the user). Applies the
 * SAME structural guards as approval-delegation's `planDelegation` — DELIBERATELY DUPLICATED, NOT shared, so the v1-signed
 * `planDelegation` stays byte-unchanged (the guards are the proven set; a future refactor may extract them). Then requires
 * EXACTLY `<form> <oneArg>` (no options, no second arg). A credential-PATH target ⇒ null (the ④ conservative red-line: a
 * credential path escalates to the user, never sanitized — REUSES the existing `SECRET_RE`, no new regex). Pure.
 */
export function planSanitize(command: string): SanitizeSpec | null {
  return /^[ \t]*git[ \t]/.test(command) ? planSanitizeGit(command) : planSanitizePath(command);
}

/** PURE path-read planner (Phase 1b): EXACTLY `<form> <oneArg>`, the structural guards, and the credential red-line. */
function planSanitizePath(command: string): SanitizeSpec | null {
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
  if (tokens.length !== 2) return null;     // EXACTLY <form> <oneArg> — no options, no second path
  const [cmd, arg] = tokens;
  if (!SANITIZE_FORMS.has(cmd)) return null; // case-SENSITIVE; only the exact lowercase form
  if (arg.startsWith("-")) return null;      // an option, not a path — path forms forbid options
  if (SECRET_RE.test(arg.toLowerCase())) return null; // ④ credential-path red-line (SR-P1-2: case-INSENSITIVE, matches approval's isBlacklisted — `.ENV`/`ID_RSA` must also escalate, never sanitize)
  return { readKind: cmd as PathReadKind, targetArg: arg };
}

/**
 * PURE git committed-history planner (Phase 2): `git <subcmd> [closed-flags…] [rev-operands…]`, NON-content only. Shares the shell
 * safety guards (reject command-substitution / var-expansion / quotes / redirect-chain / glob) but ALLOWS the rev chars `^~/` in
 * OPERANDS (not flags) so `HEAD~3` / `refs/heads/x` survive. Each flag must be in the closed per-subcommand table; each operand must
 * pass GIT_REV_RE (the clone-side `rev-parse --verify ^{commit}` in sanitized-read-git is the SOUND rev-vs-pathspec check). Returns
 * null ⇒ escalate. The hardened invocation (env scrub, `--mirror` clone, `-c` family, `--no-pager`) is the IO side.
 */
function planSanitizeGit(command: string): SanitizeSpec | null {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return null;            // control chars
  if (/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) return null; // non-ASCII/NBSP/Unicode ws
  const c = command.trim();
  if (/`|\$\(/.test(c)) return null;        // command substitution
  if (/\$/.test(c)) return null;            // variable expansion
  if (/['"\\]/.test(c)) return null;        // quote / backslash
  if (/[;&|<>(){}\n]/.test(c)) return null; // redirect / chain / multi-command / brace group (bans `{}` ⇒ `@{N}` revs excluded — rare, acceptable)
  if (/[*?[\]]/.test(c)) return null;       // glob / pathspec magic (NOT `~`/`^`/`/` — those are rev syntax, checked per-operand)
  const tokens = c.split(/[ \t]+/).filter(t => t.length > 0);
  if (tokens.length < 2 || tokens[0] !== "git") return null;
  const subcmd = tokens[1];
  if (!isGitSubcmd(subcmd)) return null;    // only log/show/diff (branch/remote/status escalate — family ruling)
  const flags: string[] = [];
  const operands: string[] = [];
  for (const tok of tokens.slice(2)) {
    if (tok === "--") return null;          // pathspec separator ⇒ escalate (NO pathspec in v2)
    if (tok.startsWith("-")) {
      if (GIT_FLAGS[subcmd].has(tok)) { flags.push(tok); continue; }
      if (subcmd === "log" && /^-\d+$/.test(tok)) { flags.push(tok); continue; } // `git log -<N>`
      return null;                          // an out-of-table flag ⇒ escalate
    }
    if (tok.includes(":") || !GIT_REV_RE.test(tok)) return null; // `rev:path` content form / a non-rev-ish operand ⇒ escalate
    operands.push(tok);
  }
  if (GIT_REQUIRE_FLAG.has(subcmd) && flags.length === 0) return null; // bare show/diff = content ⇒ escalate
  if (operands.length > (subcmd === "diff" ? 2 : 1)) return null;      // diff ≤2 revs (or 1 range); log/show ≤1
  return { readKind: "git", subcmd, flags, operands };
}
