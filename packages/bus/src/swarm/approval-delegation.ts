/**
 * approval-delegation — the PURE three-gate classifier for a member's permission request (board `approval-delegation`;
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
 * only (Codex has no equivalent decision hook). v1 freeze: delegate ALLOW only (deny → user); the BLACKLIST precedes the
 * allowlist; the allowlist = read-only within cwd.
 *
 * Pure core below (selftested). IO (the sync hook CLI, the coordinator wiring, the control-log `permissionDecision` record,
 * the InboxMsg `approval?` field) is the dormant seam — this round ships the classifier + types + flag + selftest first.
 */

// ============================================================================================================
// Pure core (selftested in approval-delegation.selftest.mts)
// ============================================================================================================

/** The S11 payload a PermissionRequest hook writes to the coordinator. Built from the Claude hook stdin:
 *  tool_name→tool, tool_input.command→command (""` for a structured tool), session_id→member, cwd, prompt_id→promptId. */
export interface ApprovalRequest {
  member: string;   // requesting member's session id (Claude)
  tool: string;     // tool_name (Bash | Read | Write | mcp__… | …)
  command: string;  // tool_input.command for Bash; "" for a structured tool
  cwd: string;      // the member's cwd (for the within-cwd check)
  promptId: string; // Claude's prompt_id — the delegated decision is matched back by this
  nowSec: number;
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

// v1 allowlist (coordinator freeze ①): the ONLY auto-allowable Bash entrypoints — read-only / idempotent, no write, no net.
const READ_ONLY_CMDS = new Set(["cat", "ls", "head", "tail", "wc", "grep", "rg", "egrep", "fgrep", "find", "file", "stat", "tree", "pwd", "echo", "which", "basename", "dirname"]);
const GIT_READ_SUBCMDS = new Set(["status", "diff", "log", "show", "branch", "remote", "rev-parse", "describe"]);
// Shell metacharacters that allow chaining / substitution / redirection — their presence means we CANNOT treat the string as
// a single read-only command, so it is never auto-delegated (a safe pipe like `cat x | grep y` degrades to needs-user, v0).
const SHELL_META = /[;&|<>`$(){}\n\\]/;

/** First whitespace-delimited token of a command (the entrypoint), lowercased. */
function argv0(command: string): string {
  const m = command.trim().match(/^(\S+)/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * The BLACKLIST — matched FIRST (coordinator: 黑名单优先于白名单). Any match ⇒ NEVER delegated (escalate:"privilege").
 * Conservative by construction (over-matching only loses a delegation opportunity, never wrongly auto-allows). Only Bash
 * command strings are inspected; a non-Bash tool is not "privilege" here (it falls through to the allowlist-miss ⇒ needs-user).
 * Pure.
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
    /\$\(|`/.test(c) ||                                                                                // command substitution
    /(^|[\s;&|(])git\s+(push|commit|reset|clean|checkout|switch|restore|rebase|merge|stash|rm|mv|apply|am|cherry-pick|tag\s|branch\s+-[dDmM]|config\s+(?!--get))/.test(c) || // git mutation
    /(\.env\b|id_rsa|id_ed25519|id_dsa|id_ecdsa|\.pem\b|\.key\b|credentials|\.aws\b|\.ssh\b|\.npmrc|\.git-credentials|\.netrc|secret|token|password|passwd|\.agenthop\/identity)/.test(c) // cred/secret paths
  );
}

/** The ALLOWLIST (coordinator freeze ①: read-only AND within cwd). True only for a SINGLE Bash command (no shell
 *  metacharacters) whose entrypoint is a read-only tool (git only with a read subcommand) and whose arguments stay inside the
 *  cwd — no absolute path, no `..` escape, no `~` home expansion. Blacklist is assumed already checked (it precedes). Pure. */
export function isReadOnlyWithinCwd(tool: string, command: string): boolean {
  if (tool !== "Bash") return false;                 // v0 inspects Bash only; structured tools ⇒ needs-user
  const c = command.trim();
  if (c === "" || SHELL_META.test(c)) return false;  // empty or chainable/substituting/redirecting ⇒ not a simple read
  const first = argv0(c);
  if (first === "git") {
    const sub = c.split(/\s+/)[1]?.toLowerCase() ?? "";
    if (!GIT_READ_SUBCMDS.has(sub)) return false;
  } else if (!READ_ONLY_CMDS.has(first)) {
    return false;
  }
  // every argument must stay within cwd: reject an absolute path, a parent-escape, or a home expansion
  const args = c.split(/\s+/).slice(1);
  for (const a of args) {
    const bare = a.replace(/^['"]|['"]$/g, "");       // strip simple surrounding quotes
    if (bare.startsWith("/") || bare.startsWith("~") || bare.split("/").includes("..")) return false;
  }
  return true;
}

/**
 * The three-gate verdict (board ①/②/③). Order is fixed: BLACKLIST first (never-delegable ⇒ escalate:"privilege"), then the
 * read-only-within-cwd ALLOWLIST (⇒ delegate allow), else FAIL-CLOSED to the user (escalate:"needs-user" — an unknown/unsafe
 * request is NEVER auto-granted, the "不确定不授权" family). v1 delegates ALLOW only; a deny is never delegated (→ user). Pure. */
export function classifyApproval(req: ApprovalRequest): ApprovalVerdict {
  if (isBlacklisted(req.tool, req.command)) return { kind: "escalate", reason: "privilege" };
  if (isReadOnlyWithinCwd(req.tool, req.command)) return { kind: "delegate", behavior: "allow" };
  return { kind: "escalate", reason: "needs-user" };
}

/** Validate an untrusted ApprovalRequest (the S11 payload the coordinator reads) — fail-closed: a malformed request is not an
 *  ApprovalRequest (the caller then escalates, never delegates). Pure. */
export function validApprovalRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.member !== "string" || !r.member) return null;
  if (typeof r.tool !== "string" || !r.tool) return null;
  if (typeof r.command !== "string") return null;          // "" is valid (structured tool)
  if (typeof r.cwd !== "string") return null;
  if (typeof r.promptId !== "string" || !r.promptId) return null;
  if (typeof r.nowSec !== "number" || !Number.isFinite(r.nowSec)) return null;
  return { member: r.member, tool: r.tool, command: r.command, cwd: r.cwd, promptId: r.promptId, nowSec: r.nowSec };
}

// ============================================================================================================
// IO shell — dormant (SWARM_APPROVAL_DELEGATE off; the sync hook + coordinator wiring land in the IO round)
// ============================================================================================================

/** Dormant wiring flip, default OFF (opt-in; the sync PermissionRequest hook + coordinator delegation only run when on —
 *  until then the hook stays `report-status blocked` and every prompt reaches the user as today). */
export function approvalDelegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_APPROVAL_DELEGATE ?? "");
}
