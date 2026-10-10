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
 * DESIGN (coordinator r2 ruling, after happycapy's first review caught 3 real pass-throughs AD-P1-1/2/3):
 *   The v0 allowlist is a CLOSED-FORM list, NOT a command-name list. A command name alone (`cat`, `git`) means nothing —
 *   a poisoned option (`find … -delete`, `rg --pre=sh`, `git diff --output=f`), a quote-concatenated path (`cat .e''nv` →
 *   `.env`), or a bare relative name that is actually a symlink (`cat alias` → ../outside) all defeat name-matching. So:
 *     1. planDelegation recognises ONLY an enumerated set of closed forms: a known command with NO options, or ONLY options
 *        from that command's exact whitelist (value-less flag tokens). Any un-enumerated option / redirect / `$`/quote/
 *        backslash anomaly / shell metacharacter / multi-command → needs-user. There is no generic flag parser to fool.
 *     2. A path operand is delegated ONLY against an IO-VERIFIED fact that its realpath (symlinks followed to the end) stays
 *        inside the member cwd; a missing fact or a failed/escaping resolution → needs-user. The pure core holds no FS; the
 *        hook supplies `ApprovalScope` in the IO round. This keeps the core pure AND sound: it never infers scope from spelling.
 *     3. A git read form reads repo-wide, so it is delegated ONLY when the IO fact says cwd IS the git repo root.
 *   Narrow is the point — the north star is fewer popups, and the handful of fixed forms (status/log/ls/cat …) already covers
 *   the bulk of them. grep/rg/find are DEFERRED (not closed forms; pending a sound model or a wider ruling) → needs-user.
 *
 * Pure core below (selftested). IO (the sync hook CLI, the coordinator wiring, the control-log `permissionDecision` record,
 * the InboxMsg `approval?` field, the realpath resolver that fills ApprovalScope) is the dormant seam — this round ships the
 * classifier + the closed-form table + the scope-fact contract + flag + selftest first.
 */

// ============================================================================================================
// Pure core (selftested in approval-delegation.selftest.mts)
// ============================================================================================================

/** IO-VERIFIED filesystem-scope facts the hook attaches to a request (realpath each path operand, following symlinks to the
 *  end, and test containment in realpath(cwd); detect the git repo root). Absent until the IO round / when the hook cannot
 *  resolve — and the classifier FAILS CLOSED without them (never infers scope from the raw spelling; AD-P1-3). */
export interface ApprovalScope {
  cwdVerified: boolean;  // the hook confirmed cwd is a trustworthy absolute, existing directory (the containment anchor)
  resolvedPaths: Array<{ raw: string; resolvedWithinCwd: boolean }>; // per path operand: realpath resolved AND stayed within cwd
  cwdIsGitRoot?: boolean; // for a git read form: cwd == git repo root (so repo-wide read is confined to cwd). absent ⇒ unknown
}

/** The S11 payload a PermissionRequest hook writes to the coordinator. Built from the Claude hook stdin:
 *  tool_name→tool, tool_input.command→command (""` for a structured tool), session_id→member, cwd, prompt_id→promptId.
 *  `scope` carries the hook's IO-verified facts (absent until the IO round ⇒ path/git forms fail closed). */
export interface ApprovalRequest {
  member: string;   // requesting member's session id (Claude)
  tool: string;     // tool_name (Bash | Read | Write | mcp__… | …)
  command: string;  // tool_input.command for Bash; "" for a structured tool
  cwd: string;      // the member's cwd — a verified ABSOLUTE path (the within-cwd anchor)
  promptId: string; // Claude's prompt_id — the delegated decision is matched back by this
  nowSec: number;
  scope?: ApprovalScope;
}

/** The coordinator's verdict. `delegate` is auto-APPLIED (allow only, v1) and recorded; `escalate` goes to the user and is
 *  NEVER auto-granted (`privilege` = the hard blacklist / never-delegable; `needs-user` = not-safe-enough, fail-closed). */
export type ApprovalVerdict =
  | { kind: "delegate"; behavior: "allow" }
  | { kind: "escalate"; reason: "privilege" | "needs-user" };

/** A recorded (② 留痕) delegated decision — the control-log `permissionDecision` payload (IO round) AND the hook's flowback
 *  key: the hook polls the control-log for its `promptId` and applies `behavior`. */
export interface PermissionDecision {
  promptId: string;
  member: string;
  behavior: "allow" | "deny";
  by: string;        // the deciding coordinator sid
  reason: string;
  atSec: number;
}

/** The member blocks on the sync hook at most this long before the request falls through to the user dialog (coordinator
 *  freeze ③). inbox-wake wakes the coordinator in ~1s, leaving room to classify; a timeout is the SAFE direction (the member
 *  was blocked at the dialog anyway) and NEVER an auto-grant. */
export const APPROVAL_POLL_SEC = 15;

// ── The CLOSED-FORM table (coordinator r2: a form = a command + an EXACT value-less flag whitelist). Any option not listed,
//    any value-taking flag, any positional where none is allowed ⇒ not a recognised form ⇒ needs-user. Narrow by design. ──

/** A non-git read command: its exact allowed value-less flag tokens, and whether it takes path operands (scope-checked). */
interface ReadForm { flags: Set<string>; takesPaths: boolean }
const READ_FORMS: Record<string, ReadForm> = {
  cat:   { flags: new Set(["-n", "-b"]), takesPaths: true },
  head:  { flags: new Set([]), takesPaths: true },
  tail:  { flags: new Set([]), takesPaths: true },
  wc:    { flags: new Set(["-l", "-w", "-c", "-m", "-lw", "-wl"]), takesPaths: true },
  ls:    { flags: new Set(["-l", "-a", "-la", "-al", "-lh", "-alh", "-lah", "-h", "-1", "-R", "-lR", "-t", "-lt", "-rt", "-lrt", "-ltr", "-r"]), takesPaths: true },
  file:  { flags: new Set([]), takesPaths: true },
  stat:  { flags: new Set([]), takesPaths: true },
};
/** Scope-free commands: no filesystem read by a cwd-relative path (their args are literals / command names / cwd itself). */
const SCOPE_FREE = new Set(["pwd", "echo", "which", "basename", "dirname"]);
/** git read subcommands and their exact allowed value-less flag tokens (NO positional operand — a ref/pathspec widens scope
 *  past cwd, so `git diff HEAD` / `git branch X` / `git remote add …` are all un-enumerated ⇒ needs-user). git log also
 *  allows a bare `-<digits>` count. A git read form reads repo-wide ⇒ it is delegated only when cwd IS the repo root. */
const GIT_FORMS: Record<string, Set<string>> = {
  status: new Set(["-s", "--short", "--porcelain", "-b", "--branch", "-sb", "--long"]),
  log:    new Set(["--oneline", "--stat", "--graph", "--decorate", "--no-color", "--numstat", "--shortstat", "--name-only", "--name-status", "--all"]),
  diff:   new Set(["--stat", "--cached", "--staged", "--name-only", "--name-status", "--numstat", "--shortstat", "--summary"]),
  show:   new Set(["--stat", "--numstat", "--name-only", "--name-status"]),
  branch: new Set(["-a", "--all", "-v", "-vv", "-r", "--list", "-l"]),
  remote: new Set(["-v", "--verbose"]),
};

/** A clearly cwd-escaping path spelling — an absolute path, a home expansion, or a `..` component. A fast structural reject
 *  (→ needs-user); a non-escaping relative spelling is NOT trusted either, it still requires the realpath scope fact. */
function isEscapingPath(tok: string): boolean {
  return tok.startsWith("/") || tok.startsWith("~") || tok.split("/").includes("..");
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
    /(\.env\b|id_rsa|id_ed25519|id_dsa|id_ecdsa|\.pem\b|\.key\b|credentials|\.aws\b|\.ssh\b|\.npmrc|\.git-credentials|\.netrc|secret|token|password|passwd|\.agenthop\/identity)/.test(c) // cred/secret paths
  );
}

/** The structural plan for a Bash command — PURE, no filesystem facts. The single source of truth for both the classifier
 *  (which then applies scope facts) and the IO hook (which reads `pathArgs` to know what to realpath-resolve). Everything not
 *  an enumerated closed form resolves to `escalate` (privilege for the blacklist backstop / command substitution, else
 *  needs-user). Pure. */
export type DelegationPlan =
  | { gate: "escalate"; reason: "privilege" | "needs-user" }
  | { gate: "scope-free" }                           // delegate with no facts (pwd/echo/which/basename/dirname)
  | { gate: "scope-paths"; pathArgs: string[] }      // delegate iff facts prove every operand's realpath within cwd
  | { gate: "scope-git" };                            // delegate iff cwd is the git repo root

export function planDelegation(command: string): DelegationPlan {
  const c = command.trim();
  if (c === "") return { gate: "escalate", reason: "needs-user" };
  if (/`|\$\(/.test(c)) return { gate: "escalate", reason: "privilege" };   // command substitution (dangerous intent)
  if (/\$/.test(c)) return { gate: "escalate", reason: "needs-user" };      // variable expansion — unanalyzable
  if (/['"\\]/.test(c)) return { gate: "escalate", reason: "needs-user" };  // quote/backslash anomaly (AD-P1-2 concatenation)
  if (isBlacklisted("Bash", c)) return { gate: "escalate", reason: "privilege" };
  if (/[;&|<>(){}\n]/.test(c)) return { gate: "escalate", reason: "needs-user" }; // redirect / chain / multi-command

  const tokens = c.split(/\s+/).filter(t => t.length > 0);
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "pwd") return rest.length === 0 ? { gate: "scope-free" } : { gate: "escalate", reason: "needs-user" };
  if (SCOPE_FREE.has(cmd)) return { gate: "scope-free" }; // echo/which/basename/dirname: args are literals, not file reads
  if (cmd === "git") return planGit(rest);

  const form = READ_FORMS[cmd];
  if (!form) return { gate: "escalate", reason: "needs-user" };
  const pathArgs: string[] = [];
  for (const tok of rest) {
    if (tok.startsWith("-")) {
      if (!form.flags.has(tok)) return { gate: "escalate", reason: "needs-user" }; // un-enumerated option
      continue;
    }
    if (!form.takesPaths) return { gate: "escalate", reason: "needs-user" };
    if (isEscapingPath(tok)) return { gate: "escalate", reason: "needs-user" };    // fast escape reject
    pathArgs.push(tok);
  }
  return { gate: "scope-paths", pathArgs };
}

function planGit(rest: string[]): DelegationPlan {
  if (rest.length === 0) return { gate: "escalate", reason: "needs-user" };
  const sub = rest[0].toLowerCase();
  const flags = GIT_FORMS[sub];
  if (!flags) return { gate: "escalate", reason: "needs-user" };
  for (const tok of rest.slice(1)) {
    if (sub === "log" && /^-\d+$/.test(tok)) continue; // git log -5
    if (flags.has(tok)) continue;
    return { gate: "escalate", reason: "needs-user" };  // unknown flag OR a positional ref/pathspec (widens scope)
  }
  return { gate: "scope-git" };
}

/** Scope gate for a path form: delegate ONLY when cwd is verified AND every parsed operand has an IO fact that its realpath
 *  resolved inside cwd (symlinks followed). A missing fact, a failed/escaping resolution, or an un-covered operand ⇒ false. */
function pathsScopeOk(pathArgs: string[], scope?: ApprovalScope): boolean {
  if (!scope || !scope.cwdVerified) return false;
  const verdict = new Map(scope.resolvedPaths.map(r => [r.raw, r.resolvedWithinCwd]));
  for (const p of pathArgs) if (verdict.get(p) !== true) return false; // includes the missing-fact case
  return true; // pathArgs empty (e.g. `ls` listing cwd) ⇒ vacuously within cwd once cwdVerified
}

/** Scope gate for a git read form: delegate ONLY when cwd is verified AND is the git repo root (AD-P1-3 parent-repo scope). */
function gitScopeOk(scope?: ApprovalScope): boolean {
  return !!scope && scope.cwdVerified && scope.cwdIsGitRoot === true;
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
    case "scope-git":   return gitScopeOk(req.scope) ? { kind: "delegate", behavior: "allow" } : { kind: "escalate", reason: "needs-user" };
    case "scope-paths": return pathsScopeOk(plan.pathArgs, req.scope) ? { kind: "delegate", behavior: "allow" } : { kind: "escalate", reason: "needs-user" };
  }
}

/** Validate IO-verified scope facts (fail-closed: a malformed scope is treated as no scope by the caller). Pure. */
export function validApprovalScope(raw: unknown): ApprovalScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cwdVerified !== "boolean") return null;
  if (!Array.isArray(r.resolvedPaths)) return null;
  const resolved: Array<{ raw: string; resolvedWithinCwd: boolean }> = [];
  for (const e of r.resolvedPaths) {
    if (typeof e !== "object" || e === null) return null;
    const p = e as Record<string, unknown>;
    if (typeof p.raw !== "string" || typeof p.resolvedWithinCwd !== "boolean") return null;
    resolved.push({ raw: p.raw, resolvedWithinCwd: p.resolvedWithinCwd });
  }
  if (r.cwdIsGitRoot !== undefined && typeof r.cwdIsGitRoot !== "boolean") return null;
  return { cwdVerified: r.cwdVerified, resolvedPaths: resolved, ...(typeof r.cwdIsGitRoot === "boolean" ? { cwdIsGitRoot: r.cwdIsGitRoot } : {}) };
}

/** Validate an untrusted ApprovalRequest (the S11 payload the coordinator reads) — fail-closed: a malformed request is not an
 *  ApprovalRequest (the caller then escalates, never delegates). cwd MUST be a non-empty ABSOLUTE path (AD-P1-3: an empty or
 *  relative cwd is not a trustworthy containment anchor). Pure. */
export function validApprovalRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.member !== "string" || !r.member) return null;
  if (typeof r.tool !== "string" || !r.tool) return null;
  if (typeof r.command !== "string") return null;          // "" is valid (structured tool)
  if (typeof r.cwd !== "string" || !r.cwd.startsWith("/")) return null; // absolute anchor required
  if (typeof r.promptId !== "string" || !r.promptId) return null;
  if (typeof r.nowSec !== "number" || !Number.isFinite(r.nowSec)) return null;
  let scope: ApprovalScope | undefined;
  if (r.scope !== undefined) { const s = validApprovalScope(r.scope); if (s === null) return null; scope = s; }
  return { member: r.member, tool: r.tool, command: r.command, cwd: r.cwd, promptId: r.promptId, nowSec: r.nowSec, ...(scope ? { scope } : {}) };
}

// ============================================================================================================
// IO shell — dormant (SWARM_APPROVAL_DELEGATE off; the sync hook + coordinator wiring + realpath resolver land in the IO round)
// ============================================================================================================

/** Dormant wiring flip, default OFF (opt-in; the sync PermissionRequest hook + coordinator delegation only run when on —
 *  until then the hook stays `report-status blocked` and every prompt reaches the user as today). */
export function approvalDelegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_APPROVAL_DELEGATE ?? "");
}
