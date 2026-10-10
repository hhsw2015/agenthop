/**
 * approval-delegation — the PURE closed-form classifier for a member's permission request (board `approval-delegation`;
 * frozen contract docs/swarm/approval-delegation-brief.md + allowlist docs/swarm/approval-allowlist-v0.md).
 *
 * Flow (dormant until SWARM_APPROVAL_DELEGATE is on): a SYNC Claude `PermissionRequest` hook writes an `ApprovalRequest`
 * (S11) to the coordinator's durable inbox (inbox-wake pings it); the coordinator runs `classifyApproval` and either
 * DELEGATES an auto-allow (safe → recorded in the control-log → the hook polls it back and auto-allows, no user dialog) or
 * ESCALATES to the user (packaged plain-language via buildApprovalDoc; the hook times out to the user dialog). North star:
 * external-activation count ↓.
 *
 * HARD CONSTRAINTS (board): ① privilege-escalation NEVER delegated (→ user); ② a delegated decision MUST be recorded
 * (control-log — the IO round); ③ reuse writeInbox/S11/sweep + control-log (no new persistent surface); ④ Claude members
 * only (Codex has no equivalent decision hook). v1: delegate ALLOW only (deny → user).
 *
 * DESIGN (coordinator r2/r3 rulings, hardened through happycapy's review rounds — every rule below was an adversarial finding
 * first):
 *   The v0 allowlist is a CLOSED-FORM list, NOT a command-name list. A command name alone means nothing — a poisoned option
 *   (`find … -delete`), a quote-concatenated path (`cat .e''nv`→`.env`), a glob (`cat .e*`), a symlink (`cat alias`→`.env`),
 *   or an inherited object key (`constructor`) all defeat name-matching. So:
 *     1. Only an ENUMERATED closed form is recognised — a known command (looked up in a Map, so inherited keys like
 *        `constructor`/`toString` can NEVER match: AD-R2-P1-1) with NO options or ONLY its exact value-less flag whitelist.
 *        Any un-enumerated option / redirect / pipe / chain / glob / brace / tilde / `$`-expansion / quote / backslash /
 *        command-substitution → escalate (coordinator r3 ②: ban every metacharacter arg — narrower and more stable than
 *        expanding it). No generic flag parser to fool (AD-P1-1, AD-P1-2).
 *     2. A path operand is delegated ONLY against IO-VERIFIED facts that its realpath (symlinks followed) stays inside cwd AND
 *        is NOT a credential/secret target (AD-R2-P1-2 — within-cwd ≠ credential-safe: a symlink to `./.env` resolves within
 *        cwd). The secret-name blacklist is applied BOTH to the raw command (black-before-white) AND, via the hook's resolver,
 *        to the realpath target (coordinator r3 ④: extend the sensitive-name gate to the argument/target level).
 *     3. git RECALLED for NON-CONTENT read forms via a config-immune rewrite (git-recall-brief.md, FROZEN). A git read run as
 *        typed can EXECUTE via config/env (diff.external, pager.<sub>, core.fsmonitor, textconv) and `git show`/`git diff` DUMP
 *        committed content — so a git form delegates ONLY when (Hole 1) the decision rewrites it config-immune (`git --no-pager
 *        -c diff.external= -c core.fsmonitor= … --no-ext-diff`), (Hole 2) the IO fact `gitEnvClean` says the member env has no
 *        `GIT_`-prefixed var nor an explicit non-GIT_ vector, (Hole 3) the form is non-content (status/log-sans-p/diff|show with
 *        name/stat flags/branch/remote), AND `cwdIsGitRoot`. Miss one ⇒ escalate. grep/rg/find remain DEFERRED → needs-user.
 *   The pure core holds NO filesystem; the facts (ApprovalScope) are the hook's job in the IO round. Until then path/git forms
 *   fail closed. Narrow is the point (coordinator: fewer popups; ls/cat/status/log fixed forms cover the bulk).
 *
 * Pure core below (selftested). IO (the sync hook CLI, the coordinator wiring, the control-log `permissionDecision` record,
 * the InboxMsg `approval?` field, the realpath+credential resolver that fills ApprovalScope) is the dormant seam.
 */

// ============================================================================================================
// Pure core (selftested in approval-delegation.selftest.mts)
// ============================================================================================================

/** IO-VERIFIED filesystem-scope facts the hook attaches to a request. The hook realpaths each path operand (following
 *  symlinks to the end), tests containment in realpath(cwd), and classifies the resolved target as a credential. Absent until
 *  the IO round / when unresolvable — and the classifier FAILS CLOSED without them (never infers safety from the raw spelling;
 *  AD-P1-3 / AD-R2-P1-2). */
export interface ApprovalScope {
  cwdVerified: boolean;  // the hook confirmed cwd is a trustworthy absolute, existing directory (the containment anchor)
  resolvedPaths: Array<{
    raw: string;                 // the raw operand as parsed from the command (must match planDelegation's pathArgs)
    resolved?: string | null;    // the realpath target at resolution time (null = unresolvable, absent treated as null) — the TOCTOU
                                 // snapshot (ADIO-P1-2): the hook re-resolves at emit and DISCARDS if this changed (a swap, even safe→safe)
    resolvedWithinCwd: boolean;  // realpath(raw) resolved AND stayed within realpath(cwd), symlinks followed
    resolvedSensitive: boolean;  // the resolved target is a credential/secret file (AD-R2-P1-2) ⇒ never delegate
  }>;
  // git-recall facts (git-recall-brief.md); additive/optional (FC-7). Absent ⇒ a git form fails closed (never delegated).
  cwdIsGitRoot?: boolean;  // cwd == `git rev-parse --show-toplevel` (realpath-compared): a repo-wide read is confined to cwd
  gitEnvClean?: boolean;   // the member env has NO GIT_-prefixed var and none of the explicit non-GIT_ vectors (Hole 2)
}

/** The S11 payload a PermissionRequest hook writes to the coordinator. Built from the Claude hook stdin:
 *  tool_name→tool, tool_input.command→command (""` for a structured tool), session_id→member, cwd, prompt_id→promptId.
 *  `scope` carries the hook's IO-verified facts (absent until the IO round ⇒ path forms fail closed). */
export interface ApprovalRequest {
  requestId: string; // a FRESH per-hook-invocation id (ADIO-P1-1) — the flowback key. NOT the user prompt_id: a prompt_id is
                     // shared across every tool call in one user turn, so keying on it would let one call's allow authorize a
                     // later call. The hook mints a unique requestId per PermissionRequest; a decision binds to THIS call.
  member: string;   // requesting member's session id (Claude) — also a binding field of the decision
  tool: string;     // tool_name (Bash | Read | Write | mcp__… | …) — binding field
  command: string;  // tool_input.command for Bash; "" for a structured tool — binding field
  cwd: string;      // the member's cwd — a verified ABSOLUTE path (the within-cwd anchor)
  promptId: string; // Claude's prompt_id — AUDIT/context only (shared across a turn's tool calls; never the flowback key)
  nowSec: number;
  scope?: ApprovalScope;
}

/** The coordinator's verdict. `delegate` is auto-APPLIED (allow only, v1) and recorded; `escalate` goes to the user and is
 *  NEVER auto-granted (`privilege` = the hard blacklist / never-delegable; `needs-user` = not-safe-enough, fail-closed). */
export type ApprovalVerdict =
  | { kind: "delegate"; behavior: "allow"; rewrite?: string } // `rewrite` (git-recall): the config-immune command the hook emits via updatedInput
  | { kind: "escalate"; reason: "privilege" | "needs-user" };

/** A recorded (② 留痕) delegated decision — the control-log `permissionDecision` payload (IO round) AND the hook's flowback
 *  key: the hook polls the control-log for its `promptId` and applies `behavior`. */
export interface PermissionDecision {
  requestId: string; // the flowback key (ADIO-P1-1) = ApprovalRequest.requestId, unique per hook invocation; the control-log
                     // entity is permissionDecision:<requestId>. An old decision can never match a new call's fresh requestId.
  member: string;    // binding: the member this decision authorizes (the hook re-checks it matches its own request)
  tool: string;      // binding: the tool this decision authorizes
  command: string;   // binding: the exact command this decision authorizes
  behavior: "allow" | "deny";
  by: string;        // the deciding coordinator sid
  reason: string;
  atSec: number;
  promptId: string;  // AUDIT/context only (never the key)
  rewrite?: string;  // git-recall: the config-immune rewritten command the hook applies via decision.updatedInput (additive/optional)
}

/** The member blocks on the sync hook at most this long before the request falls through to the user dialog (coordinator
 *  freeze ③). inbox-wake wakes the coordinator in ~1s, leaving room to classify; a timeout is the SAFE direction (the member
 *  was blocked at the dialog anyway) and NEVER an auto-grant. */
export const APPROVAL_POLL_SEC = 15;

// ── The CLOSED-FORM table (coordinator r2: a form = a command + an EXACT value-less flag whitelist). A Map — NOT a plain
//    object — so an inherited key (`constructor`, `toString`, `hasOwnProperty`) can never resolve to a form (AD-R2-P1-1). ──

/** A non-git read command: its exact allowed value-less flag tokens, and whether it takes path operands (scope-checked). */
interface ReadForm { flags: Set<string>; takesPaths: boolean }
const READ_FORMS = new Map<string, ReadForm>([
  ["cat",  { flags: new Set(["-n", "-b"]), takesPaths: true }],
  ["head", { flags: new Set([]), takesPaths: true }],
  ["tail", { flags: new Set([]), takesPaths: true }],
  ["wc",   { flags: new Set(["-l", "-w", "-c", "-m", "-lw", "-wl"]), takesPaths: true }],
  ["ls",   { flags: new Set(["-l", "-a", "-la", "-al", "-lh", "-alh", "-lah", "-h", "-1", "-R", "-lR", "-t", "-lt", "-rt", "-lrt", "-ltr", "-r"]), takesPaths: true }],
  ["file", { flags: new Set([]), takesPaths: true }],
  ["stat", { flags: new Set([]), takesPaths: true }],
]);
/** Scope-free commands: no filesystem read by a cwd-relative path (their args are literals / command names / cwd itself). */
const SCOPE_FREE = new Set(["pwd", "echo", "which", "basename", "dirname"]);

// ── git-recall (git-recall-brief.md, FROZEN): the NON-CONTENT git read forms, recalled via a config-immune rewrite. A Map (not
//    a plain object) so inherited keys can't resolve (AD-R2-P1-1). `requireFlag` ⇒ the bare form emits file CONTENT (bare `git
//    diff`/`git show`) so a no-content flag is mandatory. `allowCount` ⇒ a bare `-<N>` is allowed (git log -5). NO positional
//    operand (a ref/pathspec widens scope/content ⇒ escalate). Every git form ALSO requires cwdIsGitRoot && gitEnvClean. ──
interface GitForm { flags: Set<string>; requireFlag: boolean; allowCount?: boolean }
const GIT_FORMS = new Map<string, GitForm>([
  ["status", { flags: new Set(["-s", "--short", "--porcelain", "-b", "--branch", "-sb", "--long"]), requireFlag: false }],
  ["log",    { flags: new Set(["--oneline", "--stat", "--graph", "--decorate", "--no-color", "--numstat", "--shortstat", "--name-only", "--name-status", "--all"]), requireFlag: false, allowCount: true }],
  ["diff",   { flags: new Set(["--stat", "--name-only", "--name-status", "--numstat", "--shortstat", "--summary"]), requireFlag: true }],
  ["show",   { flags: new Set(["--stat", "--numstat", "--name-only", "--name-status"]), requireFlag: true }],
  ["branch", { flags: new Set(["-a", "--all", "-v", "-vv", "-r", "--list", "-l"]), requireFlag: false }],
  ["remote", { flags: new Set(["-v", "--verbose"]), requireFlag: false }],
]);
/** The diff-family subcommands that accept `--no-ext-diff` (others reject it as an unknown option). */
const GIT_DIFF_FAMILY = new Set(["diff", "log", "show"]);
/** The config-immune rewrite of a git read command (git-recall Hole 1, FROZEN). Pure string transform over the ALREADY-VALIDATED
 *  subcommand + closed-form flags: `--no-pager` (kills every pager path incl. pager.<sub>) + `-c diff.external=` + `-c
 *  core.fsmonitor=` as git GLOBAL options, then the subcommand, then `--no-ext-diff` for the diff family only, then the flags. */
function gitImmuneRewrite(sub: string, flags: string[]): string {
  const extDiff = GIT_DIFF_FAMILY.has(sub) ? " --no-ext-diff" : "";
  const tail = flags.length ? " " + flags.join(" ") : "";
  return `git --no-pager -c diff.external= -c core.fsmonitor= ${sub}${extDiff}${tail}`;
}
/** Plan a git read command (git-recall). Returns scope-git with the config-immune rewrite for a recognised NON-CONTENT closed
 *  form, else escalate (unknown subcommand/flag, a bare content form, or a positional operand). Pure. */
function planGit(rest: string[]): DelegationPlan {
  if (rest.length === 0) return esc("needs-user");
  const sub = rest[0].toLowerCase();
  const form = GIT_FORMS.get(sub);                   // Map.get ⇒ inherited keys return undefined (AD-R2-P1-1)
  if (!form) return esc("needs-user");
  const flags: string[] = [];
  let sawFlag = false;
  for (const tok of rest.slice(1)) {
    if (form.allowCount && /^-\d+$/.test(tok)) { flags.push(tok); sawFlag = true; continue; } // git log -5
    if (form.flags.has(tok)) { flags.push(tok); sawFlag = true; continue; }
    return esc("needs-user");                         // unknown flag OR a positional ref/pathspec (widens scope / content)
  }
  if (form.requireFlag && !sawFlag) return esc("needs-user"); // bare `git diff`/`git show` emit file content (Hole 3)
  return { gate: "scope-git", rewrite: gitImmuneRewrite(sub, flags) };
}

/** The explicit non-`GIT_`-prefixed env vectors (git-recall Hole 2): config-injection / exec that do not start with `GIT_`. */
const GIT_ENV_NON_PREFIX = ["PAGER", "EDITOR", "SSH_ASKPASS", "XDG_CONFIG_HOME"];
/** gitEnvClean (git-recall Hole 2, FROZEN GIT_ PREFIX RULE): true iff NO env var name starts with `GIT_` (any value) AND none
 *  of the explicit non-`GIT_` vectors is set. The prefix rule is complete by construction — a future `GIT_*` exec/config/scope
 *  vector is caught without a code edit. `HOME` is a known accepted residual (always present; mitigated by the `-c` rewrite +
 *  the non-content restriction). The IO resolver calls this with the member's process.env to fill `ApprovalScope.gitEnvClean`;
 *  the pure classifier then trusts that boolean. Pure. */
export function isGitEnvClean(env: NodeJS.ProcessEnv): boolean {
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") && env[k] !== undefined) return false;
  for (const k of GIT_ENV_NON_PREFIX) if (env[k] !== undefined) return false;
  return true;
}

/** The credential/secret path signature — shared by the blacklist (raw command) and isSensitivePath (resolved target). Covers
 *  the coordinator r3 ④ list: `.env*`, `.git/credentials`, `*.pem`, `*.key`, `id_rsa*`, ssh/aws material, tokens/passwords. */
// NO word boundaries — every family is a PREFIX/substring match so the whole `.env*`/`.pem*`/`.key*`/… families are covered
// (`.envrc`, `.env_local`, `foo.pembak`, …); a `\b` wrongly passed `.envrc`/`.env_local` (AD-R2-P1-2). Over-matching is the
// intent (coordinator r4 ②: 宁误杀不漏 — a false positive only escalates to the user, never wrongly delegates).
const SECRET_RE = /(\.env|id_rsa|id_ed25519|id_dsa|id_ecdsa|\.pem|\.key|credentials|\.aws|\.ssh|\.npmrc|\.git-credentials|\.netrc|secret|token|password|passwd|\.agenthop\/identity)/;

/** True iff a (realpath-resolved) target is a credential/secret file. The IO resolver calls this on each realpath to fill
 *  `resolvedSensitive`, so the hook and the contract agree; the pure classifier then trusts that boolean. Pure. */
export function isSensitivePath(resolvedPath: string): boolean {
  return SECRET_RE.test(resolvedPath.toLowerCase());
}

/** A clearly cwd-escaping path spelling — an absolute path or a `..` component. A fast structural reject (→ needs-user); a
 *  non-escaping relative spelling is NOT trusted either, it still requires the realpath scope fact. (A `~` is rejected earlier
 *  as an expansion metacharacter, so it never reaches here.) */
function isEscapingPath(tok: string): boolean {
  return tok.startsWith("/") || tok.split("/").includes("..");
}

/**
 * The BLACKLIST — a privilege BACKSTOP so a dangerous command is labelled `privilege` (not merely `needs-user`). The closed-
 * form table already fails closed on everything not enumerated, so this is not the primary gate; it only sharpens the reason.
 * Only Bash command strings are inspected. Conservative (over-matching only changes a reason, never grants). Pure.
 */
export function isBlacklisted(tool: string, command: string): boolean {
  if (tool !== "Bash") return false;
  const c = command.toLowerCase();
  return (
    /(^|[\s;&|(])(sudo|doas)\b/.test(c) ||
    /(^|[\s;&|(])(rm|rmdir|mv|cp|dd|mkfs|chmod|chown|chgrp|ln|truncate|shred)\b/.test(c) ||          // destructive / perms
    /(^|[\s;&|(])(kill|killall|pkill|reboot|shutdown|halt|launchctl|systemctl|service)\b/.test(c) ||  // process / host control
    /(^|[\s;&|(])(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp)\b/.test(c) ||               // network
    /(^|[\s;&|(])(npm|pnpm|yarn|npx|pip|pip3|cargo|gem|bundle|apt|apt-get|yum|dnf|brew|go|docker|kubectl)\b/.test(c) || // pkg/fetch/deploy
    /(^|[\s;&|(])(env|printenv|export|set)\b/.test(c) ||                                              // env dump/leak
    /[>]/.test(c) ||                                                                                   // any redirect-write (non-read-only)
    /\|\s*(sh|bash|zsh|python[0-9.]*|node|ruby|perl|eval)\b/.test(c) ||                                // pipe-to-interpreter
    /(^|[\s;&|(])git\s+(push|commit|reset|clean|checkout|switch|restore|rebase|merge|stash|rm|mv|apply|am|cherry-pick|tag\s|branch\s+-[dDmM]|config)\b/.test(c) || // git mutation
    SECRET_RE.test(c) // cred/secret paths in the raw command (black-before-white, extended to the argument level — r3 ④)
  );
}

/** The structural plan for a Bash command — PURE, no filesystem facts. The single source of truth for both the classifier
 *  (which then applies scope facts) and the IO hook (which reads `pathArgs` to know what to realpath-resolve). Everything not
 *  an enumerated closed form resolves to `escalate`. Pure. */
export type DelegationPlan =
  | { gate: "escalate"; reason: "privilege" | "needs-user" }
  | { gate: "scope-free" }                           // delegate with no facts (pwd/echo/which/basename/dirname)
  | { gate: "scope-paths"; pathArgs: string[] }      // delegate iff facts prove every operand within cwd AND not sensitive
  | { gate: "scope-git"; rewrite: string };          // git-recall: delegate iff cwdIsGitRoot && gitEnvClean; emit `rewrite`

const esc = (reason: "privilege" | "needs-user"): DelegationPlan => ({ gate: "escalate", reason });

export function planDelegation(command: string): DelegationPlan {
  // Reject control chars (CR/VT/FF/…; tab \x09 and newline \x0a excepted) and non-ASCII / NBSP / Unicode whitespace BEFORE any
  // JS whitespace handling — JS trim() and \s treat CR/NBSP/Unicode-space as whitespace but Bash's IFS word-splitting does not,
  // so such a byte would be dropped by trim() or wrongly split, planning a different operand set than Bash actually reads
  // (AD-P1-2). Unsupported whitespace/control ⇒ escalate; literal space and tab are preserved as real IFS separators.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return esc("needs-user");
  if (/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) return esc("needs-user"); // NBSP / Unicode whitespace Bash does not IFS-split
  const c = command.trim();
  if (c === "") return esc("needs-user");
  if (/`|\$\(/.test(c)) return esc("privilege");   // command substitution (dangerous intent)
  if (/\$/.test(c)) return esc("needs-user");       // variable expansion — unanalyzable
  if (/['"\\]/.test(c)) return esc("needs-user");   // quote/backslash anomaly (AD-P1-2 concatenation)
  if (isBlacklisted("Bash", c)) return esc("privilege");
  if (/[;&|<>(){}\n]/.test(c)) return esc("needs-user"); // redirect / chain / multi-command / brace group
  if (/[*?[\]{}~]/.test(c)) return esc("needs-user");    // glob / brace / tilde — expansion widens the operand set (r3 ②)

  const tokens = c.split(/[ \t]+/).filter(t => t.length > 0); // Bash IFS word-split is space/tab only (CR/NBSP rejected above; newline by the meta gate)
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "pwd") return rest.length === 0 ? { gate: "scope-free" } : esc("needs-user");
  if (SCOPE_FREE.has(cmd)) return { gate: "scope-free" }; // echo/which/basename/dirname: args are literals, not file reads
  if (cmd === "git") return planGit(rest);           // git-recall: non-content forms via a config-immune rewrite (git-recall-brief)

  const form = READ_FORMS.get(cmd);                  // Map.get ⇒ inherited keys (constructor/…) return undefined (AD-R2-P1-1)
  if (!form) return esc("needs-user");               // unknown command
  const pathArgs: string[] = [];
  for (const tok of rest) {
    if (tok.startsWith("-")) {
      if (!form.flags.has(tok)) return esc("needs-user"); // un-enumerated option
      continue;
    }
    if (!form.takesPaths) return esc("needs-user");
    if (isEscapingPath(tok)) return esc("needs-user");    // fast escape reject
    pathArgs.push(tok);
  }
  return { gate: "scope-paths", pathArgs };
}

/** Scope gate for a path form: delegate ONLY when cwd is verified AND every parsed operand has an IO fact that its realpath
 *  resolved inside cwd (symlinks followed) AND the resolved target is NOT a credential. Any missing fact / escape / sensitive
 *  target / un-covered operand ⇒ false. */
function pathsScopeOk(pathArgs: string[], scope?: ApprovalScope): boolean {
  if (!scope || !scope.cwdVerified) return false;
  for (const p of pathArgs) {
    const entries = scope.resolvedPaths.filter(r => r.raw === p);
    if (entries.length === 0) return false;                                           // no fact for this operand
    if (entries.some(r => !r.resolvedWithinCwd || r.resolvedSensitive)) return false; // ANY escape/credential fact wins, order-
    // independent — validApprovalScope KEEPS duplicate raws and this deny-sticky merge resolves them (AD-R3-P2-1; AD-R4-N1)
  }
  return true; // pathArgs empty (e.g. `ls` listing cwd) ⇒ vacuously within cwd once cwdVerified
}

/** Scope gate for a git read form (git-recall): delegate ONLY when cwd is verified, IS the git repo root (scope confined), AND
 *  the member env is clean of every exec/config/scope vector (Hole 2). Any missing/false fact ⇒ false ⇒ escalate. */
function gitScopeOk(scope?: ApprovalScope): boolean {
  return !!scope && scope.cwdVerified && scope.cwdIsGitRoot === true && scope.gitEnvClean === true;
}

/**
 * The verdict (board ①). Bash-only (structured tools ⇒ needs-user, v0). The structural `planDelegation` decides the FORM;
 * a delegate form additionally requires the IO-verified scope facts (fail-closed without them). v1 delegates ALLOW only; a
 * deny is never delegated (→ user). Pure. */
export function classifyApproval(req: ApprovalRequest): ApprovalVerdict {
  if (req.tool !== "Bash") return { kind: "escalate", reason: "needs-user" }; // v0 inspects Bash only
  const plan = planDelegation(req.command);
  switch (plan.gate) {
    case "escalate":    return { kind: "escalate", reason: plan.reason };
    case "scope-free":  return { kind: "delegate", behavior: "allow" };
    case "scope-paths": return pathsScopeOk(plan.pathArgs, req.scope) ? { kind: "delegate", behavior: "allow" } : { kind: "escalate", reason: "needs-user" };
    case "scope-git":   return gitScopeOk(req.scope) ? { kind: "delegate", behavior: "allow", rewrite: plan.rewrite } : { kind: "escalate", reason: "needs-user" };
  }
}

/** Validate IO-verified scope facts (fail-closed: a malformed scope is treated as no scope by the caller). Pure. */
export function validApprovalScope(raw: unknown): ApprovalScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cwdVerified !== "boolean") return null;
  if (!Array.isArray(r.resolvedPaths)) return null;
  const resolved: ApprovalScope["resolvedPaths"] = [];
  for (const e of r.resolvedPaths) {
    if (typeof e !== "object" || e === null) return null;
    const p = e as Record<string, unknown>;
    if (typeof p.raw !== "string" || typeof p.resolvedWithinCwd !== "boolean" || typeof p.resolvedSensitive !== "boolean") return null;
    const rp = p.resolved === undefined ? null : p.resolved; // the TOCTOU realpath snapshot (string | null); tolerate absent ⇒ null (FC-7)
    if (rp !== null && typeof rp !== "string") return null;
    resolved.push({ raw: p.raw, resolved: rp, resolvedWithinCwd: p.resolvedWithinCwd, resolvedSensitive: p.resolvedSensitive });
  }
  // Duplicate raws are KEPT, not rejected — pathsScopeOk merges them DENY-STICKY (any negative entry wins, order-independent;
  // coordinator r4 ③ "归并单调向严,不许后项覆盖前项" — the FC-6 monotonic family), so a contradictory pair always escalates.
  if (r.cwdIsGitRoot !== undefined && typeof r.cwdIsGitRoot !== "boolean") return null; // git-recall facts: optional booleans
  if (r.gitEnvClean !== undefined && typeof r.gitEnvClean !== "boolean") return null;
  return {
    cwdVerified: r.cwdVerified, resolvedPaths: resolved,
    ...(typeof r.cwdIsGitRoot === "boolean" ? { cwdIsGitRoot: r.cwdIsGitRoot } : {}),
    ...(typeof r.gitEnvClean === "boolean" ? { gitEnvClean: r.gitEnvClean } : {}),
  };
}

/** Validate an untrusted ApprovalRequest (the S11 payload the coordinator reads) — fail-closed: a malformed request is not an
 *  ApprovalRequest (the caller then escalates, never delegates). cwd MUST be a non-empty ABSOLUTE path (AD-P1-3: an empty or
 *  relative cwd is not a trustworthy containment anchor). Pure. */
export function validApprovalRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !r.requestId) return null; // the per-invocation flowback key (ADIO-P1-1)
  if (typeof r.member !== "string" || !r.member) return null;
  if (typeof r.tool !== "string" || !r.tool) return null;
  if (typeof r.command !== "string") return null;          // "" is valid (structured tool)
  if (typeof r.cwd !== "string" || !r.cwd.startsWith("/")) return null; // absolute anchor required
  if (typeof r.promptId !== "string" || !r.promptId) return null;
  if (typeof r.nowSec !== "number" || !Number.isFinite(r.nowSec)) return null;
  let scope: ApprovalScope | undefined;
  if (r.scope !== undefined) { const s = validApprovalScope(r.scope); if (s === null) return null; scope = s; }
  return { requestId: r.requestId, member: r.member, tool: r.tool, command: r.command, cwd: r.cwd, promptId: r.promptId, nowSec: r.nowSec, ...(scope ? { scope } : {}) };
}

// ============================================================================================================
// IO shell — dormant (SWARM_APPROVAL_DELEGATE off; the sync hook + coordinator wiring + realpath/credential resolver land in
// the IO round)
// ============================================================================================================

/** Dormant wiring flip, default OFF (opt-in; the sync PermissionRequest hook + coordinator delegation only run when on —
 *  until then the hook stays `report-status blocked` and every prompt reaches the user as today). */
export function approvalDelegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_APPROVAL_DELEGATE ?? "");
}
