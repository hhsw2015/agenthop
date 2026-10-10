/**
 * approval-gate — the IO-round LOGIC layer around the pure classifier (approval-delegation.ts). Kept separate so the frozen,
 * adversarially-cleared pure core stays byte-identical. Pure/testable pieces + one dependency-injected orchestrator the dormant
 * IO wiring drives:
 *   - planCoordinatorAction: the coordinator's decision for one request — DELEGATE (commit a PermissionDecision: ② 留痕 + the
 *     hook's flowback) or ESCALATE (package for the user, write no decision ⇒ the hook times out).
 *   - parsePermissionHook / buildApprovalRequest: turn a Claude `PermissionRequest` hook payload into an ApprovalRequest.
 *   - allow/deny decision output: the exact `hookSpecificOutput` JSON a SYNC hook prints to stdout.
 *   - runPermissionGate: the member-side hook flow (resolve scope → write S11 → report blocked → poll the control-log by
 *     promptId → emit allow/empty), with every IO edge injected so it is testable without a filesystem or a coordinator.
 * The filesystem resolver (ApprovalScope) is approval-scope.ts; the CLI subcommand + dispatcher glue are the thin shell.
 */
import { classifyApproval, APPROVAL_POLL_SEC, type ApprovalRequest, type ApprovalScope, type PermissionDecision } from "./approval-delegation.js";

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
      decision: { promptId: req.promptId, member: req.member, behavior: verdict.behavior, by, reason: `auto-allow:${req.tool}:read-only-within-cwd`, atSec: nowSec },
    };
  }
  return { act: "escalate", reason: verdict.reason };
}

/** The subset of a Claude `PermissionRequest` hook's stdin JSON this feature needs. */
export interface ParsedPermissionHook {
  member: string;   // session_id
  tool: string;     // tool_name
  command: string;  // tool_input.command ("" for a structured tool)
  cwd: string;
  promptId: string; // prompt_id
}

/** Parse an already-JSON-parsed Claude PermissionRequest hook payload (the CLI's readStdinJson does the JSON.parse). Fail-closed:
 *  a non-object or one missing session_id / tool_name / prompt_id / cwd returns null ⇒ the hook emits nothing ⇒ user dialog.
 *  `tool_input.command` is optional (a structured tool has none ⇒ ""). Pure. */
export function parsePermissionHook(obj: unknown): ParsedPermissionHook | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const member = o.session_id, tool = o.tool_name, cwd = o.cwd, promptId = o.prompt_id;
  if (typeof member !== "string" || !member) return null;
  if (typeof tool !== "string" || !tool) return null;
  if (typeof cwd !== "string" || !cwd) return null;
  if (typeof promptId !== "string" || !promptId) return null;
  let command = "";
  if (typeof o.tool_input === "object" && o.tool_input !== null) {
    const cmd = (o.tool_input as Record<string, unknown>).command;
    if (typeof cmd === "string") command = cmd;
  }
  return { member, tool, command, cwd, promptId };
}

/** Build the ApprovalRequest the hook writes (S11) — parsed hook fields + the IO-resolved scope facts + the clock. Pure. */
export function buildApprovalRequest(parsed: ParsedPermissionHook, scope: ApprovalScope | undefined, nowSec: number): ApprovalRequest {
  return { member: parsed.member, tool: parsed.tool, command: parsed.command, cwd: parsed.cwd, promptId: parsed.promptId, nowSec, ...(scope ? { scope } : {}) };
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
  resolveScope: (command: string, cwd: string) => ApprovalScope | null; // resolveApprovalScope
  writeApprovalRequest: (req: ApprovalRequest) => boolean;            // writeInbox S11 to coordinator; false ⇒ undeliverable
  readDecision: (promptId: string) => PermissionDecision | null;      // loadControlLog ⇒ permissionDecision:<promptId>
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
  const scope = deps.resolveScope(parsed.command, parsed.cwd) ?? undefined;
  const req = buildApprovalRequest(parsed, scope, Math.floor(deps.nowMs() / 1000));
  if (!deps.writeApprovalRequest(req)) return;           // couldn't reach the coordinator ⇒ user dialog (never auto-grant)
  const deadline = deps.nowMs() + (deps.pollSec ?? APPROVAL_POLL_SEC) * 1000;
  const interval = deps.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  while (deps.nowMs() < deadline) {
    const dec = deps.readDecision(parsed.promptId);
    if (dec && dec.promptId === parsed.promptId && dec.behavior === "allow") { deps.emit(allowDecisionOutput()); return; }
    // v1 never records a delegated deny; if one ever appears, we still do NOT emit it here (deny stays a user decision) — fall through.
    await deps.sleep(interval);
  }
  // window elapsed, no delegated decision ⇒ emit nothing ⇒ user dialog / auto-deny
}
