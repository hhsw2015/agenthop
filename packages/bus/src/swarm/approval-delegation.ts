/**
 * approval-delegation — the PURE classifier for a member's permission request (board `approval-delegation`; contract
 * docs/swarm/approval-delegation-brief.md + allowlist docs/swarm/approval-allowlist-v0.md).
 *
 * Flow (dormant until SWARM_APPROVAL_DELEGATE is on): a SYNC Claude `PermissionRequest` hook writes an `ApprovalRequest`
 * (S11) to the coordinator's dedicated durable approval key; the coordinator runs `classifyApproval` and either DELEGATES an
 * auto-allow (safe → recorded in the control-log → the hook polls it back by its per-invocation requestId and auto-allows, no
 * user dialog) or ESCALATES to the user (the hook times out to the user dialog). North star: external-activation count ↓.
 *
 * HARD CONSTRAINTS (board): ① privilege-escalation NEVER delegated (→ user); ② a delegated decision MUST be recorded
 * (control-log); ③ reuse writeInbox/S11/sweep + control-log (no new persistent surface); ④ Claude members only.
 *
 * SCOPE — v1 is SCOPE-FREE-ONLY (coordinator architecture ruling A(a)+B(a), after happycapy's adversarial review):
 *   The ONLY auto-allowable commands are ones that touch NO filesystem path at execution — `pwd` / `echo` (literals) / `which`
 *   / `basename` / `dirname` — AND whose execution is PINNED via a `builtin command <abspath>` rewrite (AD-V1-P1-1: a command NAME
 *   does not bind its implementation; a member shell alias/function/PATH entry could shadow `pwd`/`echo`, so the verdict rewrites
 *   the command to e.g. `builtin command /bin/pwd` via the hook's `updatedInput`, and the member hook lstat-verifies the binary
 *   before emitting). Everything else escalates. Deliberate and bounded (PINNED lists the accepted non-differential residuals):
 *     - PATH reads (cat/ls/…) are OUT: a hook decision cannot bind the EXECUTION target — the gap between the hook's final
 *       resolve and the actual read is an irreducible TOCTOU (a symlink repoint, even to a safe→safe swap), and re-query /
 *       rewrite-to-realpath cannot close it (happycapy ADIO-P1-2, proven).
 *     - GIT reads are OUT: a git read run as the member typed it honours repo/global config AND env (external diff, pager,
 *       fsmonitor, textconv, `.gitattributes` clean/process filters) — un-enumerable exec vectors `-c` cannot close — and
 *       `git show` can dump committed content (happycapy GR-P1-1/P1-2, proven).
 *   v1's value is the END-TO-END pipeline (prompt → S11 → three-gate → control-log → flowback) running soundly; the delegable
 *   WIDTH (path/git reads = the popup bulk) is covered by a SEPARATE design-first ticket: the coordinator runs a SANITIZED read
 *   in a controlled environment and injects the output, instead of auto-allowing the member's command (closes TOCTOU/env/filter).
 *
 * Pure core below (selftested). IO (the sync hook CLI, the coordinator wiring, the control-log `permissionDecision` record,
 * the InboxMsg `approval?` field) is the dormant seam.
 */

// ============================================================================================================
// Pure core (selftested in approval-delegation.selftest.mts)
// ============================================================================================================

/** The S11 payload a PermissionRequest hook writes to the coordinator. `requestId` is a FRESH per-hook-invocation nonce (ADIO-
 *  P1-1) — the flowback key AND the one-shot identity: NOT the user prompt_id (shared across a turn's tool calls, which would let
 *  one call's allow authorize another) and NOT a content hash (which would collapse two identical calls into one decision —
 *  ADIO-R2-P2-1). Each PermissionRequest ⇒ a unique requestId ⇒ its own decision + audit entry. `toolInputDigest` binds the FULL
 *  tool input (not just command), so a decision authorizes exactly this call. */
export interface ApprovalRequest {
  requestId: string;       // fresh per-invocation nonce (the control-log entity is permissionDecision:<requestId>)
  member: string;          // requesting member's session id (Claude) — binding field
  tool: string;            // tool_name — binding field
  command: string;         // tool_input.command for Bash; "" for a structured tool — binding field
  toolInputDigest: string; // digest of the canonical full tool_input — binding field (covers inputs beyond `command`)
  cwd: string;             // the member's cwd — a verified ABSOLUTE path
  promptId: string;        // Claude's prompt_id — AUDIT/context only (never the key)
  nowSec: number;
}

/** The coordinator's verdict. `delegate` is auto-APPLIED (allow only, v1) and recorded; `escalate` goes to the user and is
 *  NEVER auto-granted (`privilege` = the hard blacklist; `needs-user` = not-safe-enough, fail-closed). */
export type ApprovalVerdict =
  | { kind: "delegate"; behavior: "allow"; rewrite: string }  // rewrite = the pinned-absolute-path command (execution binding)
  | { kind: "escalate"; reason: "privilege" | "needs-user" };

/** A recorded (② 留痕) delegated decision — the control-log `permissionDecision` payload AND the hook's flowback. Keyed by the
 *  per-invocation `requestId`; BINDS member/tool/command/toolInputDigest so the hook applies it only to the exact call it
 *  authorized. */
export interface PermissionDecision {
  requestId: string;
  member: string;
  tool: string;
  command: string;
  toolInputDigest: string;
  behavior: "allow" | "deny";
  rewrite: string;   // AD-V1-P1-1: the pinned-absolute-path command, recorded for audit (② 留痕). The member hook RECOMPUTES its
                     // own rewrite at emit and NEVER executes this logged string — the log authorizes WHETHER to allow, the
                     // member binds WHAT runs (defence against a stale/tampered control-log).
  by: string;        // the deciding coordinator sid
  reason: string;
  atSec: number;
  promptId: string;  // AUDIT/context only
}

/** The member blocks on the sync hook at most this long before the request falls through to the user dialog. A timeout is the
 *  SAFE direction (the member was blocked at the dialog anyway) and NEVER an auto-grant. */
export const APPROVAL_POLL_SEC = 15;

/** AD-V1-P1-1 — the v1 scope-free allowlist AS trusted ABSOLUTE PATHS. These commands read NO filesystem path at execution (no
 *  execution-target TOCTOU); their args are literals (echo), command names (which), or lexical string ops (basename/dirname);
 *  pwd prints cwd. But a command NAME does not bind its execution: `pwd`/`echo`/… can be shadowed by a member shell alias /
 *  function / PATH entry (incl. a slash-named BASH_ENV function), so auto-allowing the NAME would run an attacker's
 *  implementation. The verdict rewrites the command to `builtin command <abspath>` (planDelegation): `command` skips
 *  function/alias lookup, `builtin` forces the real `command` builtin — the member shell's name resolution no longer
 *  participates. Standard POSIX locations (macOS + Linux); the member hook lstat-verifies the path is a real regular file in ITS
 *  env before emitting (dangling link / directory / symlink-replacement ⇒ escalate). ACCEPTED RESIDUALS (bounded contract,
 *  coordinator-ruled NON-DIFFERENTIAL — each defeats a USER's own approval of the SAME command equally, so auto-allow need only
 *  be no-worse-than-user-approval): a member function shadowing `builtin`/`command` themselves; a BASH_ENV/ENV startup file that
 *  executes arbitrary code at shell init; /bin itself tampered. All are shell-/system-compromise level, outside the
 *  differential-auto-allow threat model (a sanitized read could not defend them either). */
const PINNED = new Map<string, string>([
  ["pwd", "/bin/pwd"], ["echo", "/bin/echo"], ["which", "/usr/bin/which"], ["basename", "/usr/bin/basename"], ["dirname", "/usr/bin/dirname"],
]); // a Map, NOT a plain object (AD-V1-R2-P2-1 / AD-R2-P1-1 lineage): `PINNED.get("constructor"|"toString"|"__proto__"|…)` is
   // undefined, so a prototype-inherited name is never classified scope-free (a plain-object `PINNED[name]` would return the
   // inherited function and wrongly delegate — and record a bogus permissionDecision).

/** The credential/secret path signature — the privilege backstop inspects the raw command for it (black-before-white). */
const SECRET_RE = /(\.env|id_rsa|id_ed25519|id_dsa|id_ecdsa|\.pem|\.key|credentials|\.aws|\.ssh|\.npmrc|\.git-credentials|\.netrc|secret|token|password|passwd|\.agenthop\/identity)/;

/**
 * The BLACKLIST — a privilege BACKSTOP so a dangerous command is labelled `privilege` (not merely `needs-user`). v1 delegates
 * only scope-free commands, so this is not the primary gate; it sharpens the reason. Only Bash is inspected. Conservative. Pure.
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
    /[>]/.test(c) ||                                                                                   // any redirect-write
    /\|\s*(sh|bash|zsh|python[0-9.]*|node|ruby|perl|eval)\b/.test(c) ||                                // pipe-to-interpreter
    /(^|[\s;&|(])git\s+(push|commit|reset|clean|checkout|switch|restore|rebase|merge|stash|rm|mv|apply|am|cherry-pick|tag\s|branch\s+-[dDmM]|config)\b/.test(c) || // git mutation
    SECRET_RE.test(c) // cred/secret paths in the raw command
  );
}

/** The structural plan for a Bash command — PURE. v1: a scope-free form delegates; everything else escalates (privilege for the
 *  blacklist backstop / command substitution, else needs-user). No filesystem facts are ever needed (scope-free touches none). */
export type DelegationPlan =
  | { gate: "escalate"; reason: "privilege" | "needs-user" }
  | { gate: "scope-free"; rewrite: string; pinnedPath: string };   // rewrite = `builtin command <abspath> <args>`; pinnedPath = the abspath the member hook lstat-verifies

const esc = (reason: "privilege" | "needs-user"): DelegationPlan => ({ gate: "escalate", reason });

export function planDelegation(command: string): DelegationPlan {
  // Reject control chars (CR/VT/FF/…; tab \x09 and newline \x0a excepted) and non-ASCII / NBSP / Unicode whitespace BEFORE any
  // JS whitespace handling — JS trim()/\s split on these but Bash's IFS does not, so a byte would be dropped or mis-split.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return esc("needs-user");
  if (/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) return esc("needs-user");
  const c = command.trim();
  if (c === "") return esc("needs-user");
  if (/`|\$\(/.test(c)) return esc("privilege");   // command substitution
  if (/\$/.test(c)) return esc("needs-user");       // variable expansion — unanalyzable
  if (/['"\\]/.test(c)) return esc("needs-user");   // quote/backslash anomaly
  if (isBlacklisted("Bash", c)) return esc("privilege");
  if (/[;&|<>(){}\n]/.test(c)) return esc("needs-user"); // redirect / chain / multi-command / brace group
  if (/[*?[\]{}~]/.test(c)) return esc("needs-user");    // glob / brace / tilde expansion

  const tokens = c.split(/[ \t]+/).filter(t => t.length > 0); // Bash IFS word-split is space/tab only
  const cmd = tokens[0];        // case-SENSITIVE (AD-V1-P1-1): only the EXACT lowercase name delegates — `ECHO`/`Pwd` are NOT
  const rest = tokens.slice(1); // scope-free (they would otherwise pass the table then EXECUTE the raw spelling, which the
                                // member's PATH resolves to a different/attacker binary — the uppercase-ECHO hole)

  const pin = PINNED.get(cmd);  // Map.get ⇒ undefined for a prototype-inherited name (AD-V1-R2-P2-1): no delegate, no record
  if (pin === undefined) return esc("needs-user");                // path reads, git, uppercase/prototype names, unknown ⇒ user
  if (cmd === "pwd" && rest.length > 0) return esc("needs-user"); // pwd takes no args
  // AD-V1-P1-1 execution binding: invoke the trusted ABSOLUTE PATH via `builtin command` so the member shell's name resolution
  // never participates — `command` skips function/alias lookup (closing a BASH_ENV function that shadows the `/bin/pwd` literal),
  // `builtin` forces the real `command` builtin (not a member function named `command`). Args kept VERBATIM (`c` is trimmed so it
  // starts with tokens[0]; slice keeps the inter-arg spacing). pinnedPath is the bare abspath the member hook lstat-verifies.
  return { gate: "scope-free", rewrite: `builtin command ${pin}${c.slice(tokens[0].length)}`, pinnedPath: pin };
}

/**
 * The verdict (board ①). Bash-only (structured tools ⇒ needs-user). v1: a scope-free form delegates (no facts needed — it reads
 * no path); everything else escalates. v1 delegates ALLOW only; a deny is never delegated (→ user). Pure. */
export function classifyApproval(req: ApprovalRequest): ApprovalVerdict {
  if (req.tool !== "Bash") return { kind: "escalate", reason: "needs-user" };
  const plan = planDelegation(req.command);
  switch (plan.gate) {
    case "escalate":   return { kind: "escalate", reason: plan.reason };
    case "scope-free": return { kind: "delegate", behavior: "allow", rewrite: plan.rewrite };
  }
}

/** Validate an untrusted ApprovalRequest (the S11 payload the coordinator reads) — fail-closed: a malformed request is not an
 *  ApprovalRequest (the caller then escalates, never delegates). cwd MUST be a non-empty ABSOLUTE path. Pure. */
export function validApprovalRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !r.requestId) return null;
  if (typeof r.member !== "string" || !r.member) return null;
  if (typeof r.tool !== "string" || !r.tool) return null;
  if (typeof r.command !== "string") return null;                  // "" is valid (structured tool)
  if (typeof r.toolInputDigest !== "string" || !r.toolInputDigest) return null;
  if (typeof r.cwd !== "string" || !r.cwd.startsWith("/")) return null; // absolute anchor required
  if (typeof r.promptId !== "string" || !r.promptId) return null;
  if (typeof r.nowSec !== "number" || !Number.isFinite(r.nowSec)) return null;
  return { requestId: r.requestId, member: r.member, tool: r.tool, command: r.command, toolInputDigest: r.toolInputDigest, cwd: r.cwd, promptId: r.promptId, nowSec: r.nowSec };
}

// ============================================================================================================
// IO shell — dormant (SWARM_APPROVAL_DELEGATE off; the sync hook + coordinator wiring land in the IO round)
// ============================================================================================================

/** Dormant wiring flip, default OFF (opt-in; the sync PermissionRequest hook + coordinator delegation only run when on —
 *  until then the hook stays `report-status blocked` and every prompt reaches the user as today). */
export function approvalDelegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_APPROVAL_DELEGATE ?? "");
}
