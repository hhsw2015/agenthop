/**
 * approval-gate — the IO-round LOGIC layer around the pure classifier (approval-delegation.ts). Kept separate so the frozen,
 * adversarially-cleared pure core stays byte-identical. Pure/testable pieces + one dependency-injected orchestrator the dormant
 * IO wiring drives:
 *   - planCoordinatorAction: the coordinator's decision for one request — DELEGATE (commit a PermissionDecision: ② 留痕 + the
 *     hook's flowback) or ESCALATE (package for the user, write no decision ⇒ the hook times out).
 *   - parsePermissionHook / buildApprovalRequest: turn a Claude `PermissionRequest` hook payload into an ApprovalRequest.
 *   - allow/deny decision output: the exact `hookSpecificOutput` JSON a SYNC hook prints to stdout.
 *   - runPermissionGate: the member-side hook flow (mint a per-invocation requestId → resolve scope → write S11 → report blocked
 *     → poll the control-log by requestId → re-resolve+re-classify at emit → emit allow/empty), every IO edge injected so it is
 *     testable without a filesystem or a coordinator.
 * The filesystem resolver (ApprovalScope) is approval-scope.ts; the CLI subcommand + dispatcher glue are the thin shell.
 */
import { createHash } from "node:crypto";
import { classifyApproval, APPROVAL_POLL_SEC, type ApprovalRequest, type ApprovalScope, type PermissionDecision } from "./approval-delegation.js";

/** Deterministic key-order JSON so the approval-instance hash is stable regardless of object key order. Pure. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** The approval-instance identity (ADIO-P1-1): a deterministic hash of (promptId, toolName, canonical toolInput). It BINDS the
 *  decision to the exact call — a different tool/input (e.g. `rm` vs `pwd`) hashes differently, so one call's allow can never
 *  authorize another; and a structured tool (command "") is still distinguished by its full toolInput. The hook recomputes this
 *  at write AND at read; the control-log entity is permissionDecision:<this>. Deterministic (same call ⇒ same id). Pure. */
export function approvalInstanceId(promptId: string, tool: string, toolInput: unknown): string {
  return createHash("sha256").update(stableStringify([promptId, tool, toolInput])).digest("hex");
}

/** The dedicated durable-inbox key the member hook writes an approval request to and the dispatcher (coordinator-replacement
 *  sweep) drains — `approvals:<coordSid>` (coordinator r4 ruling): in the coordinator's authority domain, but a RESERVED key,
 *  not the coordinator SESSION's own sid, so draining it never races that session's flushInbox (the contention the wiring
 *  flagged). Still the same writeInbox/S11/sweep surface (no new store/format ⇒ FC-7 holds). The dispatcher's 5s sweep polls it
 *  (never worse than the APPROVAL_POLL_SEC=15s window); inbox-wake fires best-effort on write (its pane ping is a no-op for a
 *  non-session key, harmless). */
export function approvalInboxKey(coordSid: string): string {
  return `approvals:${coordSid}`;
}

/** The coordinator's action for a classified request. v1: delegate ALWAYS carries behavior "allow" (a deny is never delegated —
 *  it escalates). An escalate writes NO control-log decision (the hook polls, finds none, times out to the user dialog). */
export type CoordinatorAction =
  | { act: "delegate"; decision: PermissionDecision }
  | { act: "escalate"; reason: "privilege" | "needs-user" };

/** Pure: run the three-gate classifier and shape the coordinator's action. `by` = the deciding coordinator sid (stamped into the
 *  audit record); `nowSec` = the decision time. The reason string is audit-only (the authority is classifyApproval returning
 *  `delegate`, never this text). */
export function planCoordinatorAction(req: ApprovalRequest, by: string, nowSec: number): CoordinatorAction {
  const verdict = classifyApproval(req);
  if (verdict.kind === "delegate") {
    return {
      act: "delegate",
      // The decision is keyed by req.requestId (per-invocation; ADIO-P1-1) and BINDS member/tool/command so the hook can verify it
      // authorizes exactly THIS call. git-recall: a git delegate carries a config-immune `rewrite`; a plain read form has none.
      decision: { requestId: req.requestId, member: req.member, tool: req.tool, command: req.command, behavior: verdict.behavior, by, reason: `auto-allow:${req.tool}:read-only-within-cwd`, atSec: nowSec, promptId: req.promptId, ...(verdict.rewrite ? { rewrite: verdict.rewrite } : {}) },
    };
  }
  return { act: "escalate", reason: verdict.reason };
}

/** The subset of a Claude `PermissionRequest` hook's stdin JSON this feature needs. */
export interface ParsedPermissionHook {
  member: string;    // session_id
  tool: string;      // tool_name
  command: string;   // tool_input.command ("" for a structured tool)
  toolInput: unknown; // the RAW tool_input object (for the approval-instance hash — binds the full input, not just command)
  cwd: string;
  promptId: string;  // prompt_id
}

/** Parse an already-JSON-parsed Claude PermissionRequest hook payload (the CLI's readStdinJson does the JSON.parse). Fail-closed:
 *  a non-object or one missing session_id / tool_name / prompt_id / cwd returns null ⇒ the hook emits nothing ⇒ user dialog.
 *  `tool_input.command` is optional (a structured tool has none ⇒ ""); the raw tool_input is kept for the instance hash. Pure. */
export function parsePermissionHook(obj: unknown): ParsedPermissionHook | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const member = o.session_id, tool = o.tool_name, cwd = o.cwd, promptId = o.prompt_id;
  if (typeof member !== "string" || !member) return null;
  if (typeof tool !== "string" || !tool) return null;
  if (typeof cwd !== "string" || !cwd) return null;
  if (typeof promptId !== "string" || !promptId) return null;
  const toolInput = (typeof o.tool_input === "object" && o.tool_input !== null) ? o.tool_input : {};
  let command = "";
  const cmd = (toolInput as Record<string, unknown>).command;
  if (typeof cmd === "string") command = cmd;
  return { member, tool, command, toolInput, cwd, promptId };
}

/** Build the ApprovalRequest the hook writes (S11) — parsed hook fields + the per-invocation requestId + the IO-resolved scope
 *  facts + the clock. Pure. */
export function buildApprovalRequest(parsed: ParsedPermissionHook, requestId: string, scope: ApprovalScope | undefined, nowSec: number): ApprovalRequest {
  return { requestId, member: parsed.member, tool: parsed.tool, command: parsed.command, cwd: parsed.cwd, promptId: parsed.promptId, nowSec, ...(scope ? { scope } : {}) };
}

/** A decision authorizes THIS invocation only when it matches the instance id AND binds the same member/tool/command (ADIO-P1-1).
 *  The id is hash(promptId,tool,toolInput) so a different call hashes differently; the member/tool/command re-check is
 *  defense-in-depth (incl. the astronomically-unlikely cross-member promptId collision). Pure. */
export function decisionBindsTo(dec: PermissionDecision, requestId: string, p: ParsedPermissionHook): boolean {
  return dec.requestId === requestId && dec.member === p.member && dec.tool === p.tool && dec.command === p.command;
}

/** ADIO-P1-2 (TOCTOU): the authorized path-fact snapshot must still hold at emit. Every operand's realpath (`resolved`) must be
 *  UNCHANGED between the authorized scope (resolved when the S11 was written + what the coordinator approved) and a fresh
 *  re-resolve — a target swap (even safe→safe) is drift. (git has no path operands; its env/root drift is caught by the fresh
 *  re-classify.) Pure. */
export function factsStable(authorized: ApprovalScope | undefined, fresh: ApprovalScope | undefined): boolean {
  const a = authorized?.resolvedPaths ?? [];
  const f = fresh?.resolvedPaths ?? [];
  if (a.length !== f.length) return false;
  const byRaw = new Map(a.map((e) => [e.raw, e.resolved ?? null]));
  for (const fe of f) {
    if (!byRaw.has(fe.raw)) return false;
    if (byRaw.get(fe.raw) !== (fe.resolved ?? null)) return false; // realpath drift ⇒ unstable ⇒ discard (absent normalised to null)
  }
  return true;
}

/** The exact stdout JSON a SYNC PermissionRequest hook prints to AUTO-ALLOW (verified against the hooks reference). `rewrite`
 *  (allow-only `decision.updatedInput`) replaces the whole Bash input object — reserved for the git-recall path (a config-immune
 *  `-c` rewrite); omitted for a plain read form. Pure. */
export function allowDecisionOutput(rewrite?: { command: string }): string {
  const decision: Record<string, unknown> = { behavior: "allow", ...(rewrite ? { updatedInput: { command: rewrite.command } } : {}) };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

/** The poll cadence inside the hook's bounded window. A short interval keeps the member's block brief once the coordinator has
 *  decided (inbox-wake wakes it in ~1s); the window total is APPROVAL_POLL_SEC. */
export const APPROVAL_POLL_INTERVAL_MS = 400;

/** Every IO edge of the member-side hook, injected so runPermissionGate is testable without a real filesystem/coordinator. */
export interface PermissionGateDeps {
  enabled: boolean;                                                    // approvalDelegateEnabled()
  readStdin: () => Promise<Record<string, unknown> | undefined>;      // the Claude hook payload
  reportBlocked: (member: string) => void;                            // writeStatusFile blocked (status visibility, kept)
  resolveScope: (command: string, cwd: string) => ApprovalScope | null; // resolveApprovalScope (called at request-time AND re-called at emit — ADIO-P1-2)
  writeApprovalRequest: (req: ApprovalRequest) => boolean;            // writeInbox S11 to coordinator; false ⇒ undeliverable
  readDecision: (requestId: string) => PermissionDecision | null;     // loadControlLog ⇒ permissionDecision:<requestId>
  emit: (json: string) => void;                                       // stdout (the decision)
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  pollSec?: number;                                                   // default APPROVAL_POLL_SEC
  intervalMs?: number;                                               // default APPROVAL_POLL_INTERVAL_MS
}

/**
 * The member-side sync hook. Dormant unless `enabled`. Flow: read the hook payload; always keep the `blocked` status signal;
 * when enabled + parseable, resolve scope, write the S11 approval request to the coordinator, then poll the control-log for a
 * delegated decision keyed by promptId up to the bounded window. A delegated ALLOW ⇒ emit the allow decision (no user dialog);
 * anything else (disabled, unparseable, undeliverable, or window elapsed with no decision) ⇒ emit NOTHING ⇒ the call falls to
 * the user dialog (interactive) / auto-deny (non-interactive). NEVER emits a decision the coordinator did not record — a timeout
 * is the SAFE direction, never an auto-grant.
 */
export async function runPermissionGate(deps: PermissionGateDeps): Promise<void> {
  const payload = await deps.readStdin();
  const parsed = payload ? parsePermissionHook(payload) : null;
  if (parsed) deps.reportBlocked(parsed.member);         // preserve the blocked status signal (sync hook replaces the async one)
  if (!deps.enabled || !parsed) return;                  // dormant / malformed ⇒ emit nothing ⇒ user dialog
  const requestId = approvalInstanceId(parsed.promptId, parsed.tool, parsed.toolInput); // deterministic instance identity (ADIO-P1-1)
  const scope = deps.resolveScope(parsed.command, parsed.cwd) ?? undefined; // the authorized fact snapshot
  const req = buildApprovalRequest(parsed, requestId, scope, Math.floor(deps.nowMs() / 1000));
  if (!deps.writeApprovalRequest(req)) return;           // couldn't reach the coordinator ⇒ user dialog (never auto-grant)
  const deadline = deps.nowMs() + (deps.pollSec ?? APPROVAL_POLL_SEC) * 1000;
  const interval = deps.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  while (deps.nowMs() < deadline) {
    const dec = deps.readDecision(requestId);
    // The decision must bind to THIS invocation (instance id + member/tool/command) and be an allow (v1 never records a delegated
    // deny; a deny stays a user decision ⇒ never emitted here).
    if (dec && decisionBindsTo(dec, requestId, parsed) && dec.behavior === "allow") {
      // ADIO-P1-2 (TOCTOU): the facts were resolved when the S11 was written; a symlink/env change during the poll must NOT
      // auto-grant. RE-RESOLVE now and emit ONLY if (a) the fresh verdict is still a delegate AND (b) every path operand's
      // realpath is UNCHANGED from the authorized snapshot (factsStable — a target swap, even safe→safe, is drift). Else emit
      // nothing ⇒ user dialog. Use the FRESH rewrite (git) — execution-time truth.
      const freshScope = deps.resolveScope(parsed.command, parsed.cwd) ?? undefined;
      const freshVerdict = classifyApproval(buildApprovalRequest(parsed, requestId, freshScope, Math.floor(deps.nowMs() / 1000)));
      if (freshVerdict.kind === "delegate" && factsStable(scope, freshScope)) deps.emit(allowDecisionOutput(freshVerdict.rewrite ? { command: freshVerdict.rewrite } : undefined));
      return; // decided (emitted iff still-safe + stable, else nothing ⇒ user): the coordinator authorized this id, we do not re-wait
    }
    await deps.sleep(interval);
  }
  // window elapsed, no delegated decision ⇒ emit nothing ⇒ user dialog / auto-deny
}
