/**
 * approval-gate — the IO-round LOGIC layer around the pure classifier (approval-delegation.ts). v1 is scope-free-only (see the
 * classifier header): the only auto-allowable commands read no filesystem path, so there is NO scope resolution and NO
 * execution-target re-check — the decision is a plain allow. Pure/testable pieces + one dependency-injected orchestrator:
 *   - planCoordinatorAction: DELEGATE (commit a PermissionDecision keyed by the per-invocation requestId, binding member/tool/
 *     command/toolInputDigest) or ESCALATE (write nothing ⇒ the hook times out).
 *   - parsePermissionHook / buildApprovalRequest / toolInputDigest: turn a Claude PermissionRequest payload into an S11 request.
 *   - decisionBindsTo: a decision authorizes THIS call only (ADIO-P1-1).
 *   - runPermissionGate: the member-side hook flow (mint a fresh requestId → write S11 → report blocked → poll by requestId →
 *     emit allow/empty), every IO edge injected so it is testable without a filesystem or a coordinator.
 */
import { createHash } from "node:crypto";
import { classifyApproval, planDelegation, APPROVAL_POLL_SEC, type ApprovalRequest, type PermissionDecision } from "./approval-delegation.js";
import { planSanitize, sanitizedReadEnabled, type SanitizeSpec } from "./sanitized-read.js";

/** The dedicated durable-inbox key the member hook writes an approval request to and the dispatcher drains — `approvals:<coordSid>`
 *  (coordinator ruling): in the coordinator's authority domain but a RESERVED key, not the coordinator SESSION's own sid, so
 *  draining it never races that session's flushInbox. Same writeInbox/S11/sweep surface (no new store/format ⇒ FC-7 holds). */
export function approvalInboxKey(coordSid: string): string {
  return `approvals:${coordSid}`;
}

/** Deterministic key-order JSON so the input digest is stable regardless of object key order. Pure. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** A digest of the FULL tool input (canonicalised) — the decision binds it so an allow authorizes the exact call, including
 *  inputs beyond `command` (e.g. a structured tool with command ""). Pure. */
export function toolInputDigest(toolInput: unknown): string {
  return createHash("sha256").update(stableStringify(toolInput)).digest("hex");
}

/** The coordinator's action for a classified request. v1: delegate ALWAYS carries behavior "allow" (a deny escalates). An
 *  escalate writes NO control-log decision (the hook polls, finds none, times out to the user dialog). */
export type CoordinatorAction =
  | { act: "delegate"; decision: PermissionDecision }
  | { act: "sanitize"; spec: SanitizeSpec }   // sanitized-read: the dispatcher runs the hardened read (sanitized-read-io), writes the result, THEN commits a sanitize decision via buildSanitizeDecision
  | { act: "escalate"; reason: "privilege" | "needs-user" };

/** Pure: classify + shape the coordinator's action. `by` = the deciding coordinator sid (audit); `nowSec` = the decision time.
 *  The decision is keyed by req.requestId (per-invocation) and BINDS member/tool/command/toolInputDigest. */
export function planCoordinatorAction(req: ApprovalRequest, by: string, nowSec: number, env: NodeJS.ProcessEnv = process.env): CoordinatorAction {
  const verdict = classifyApproval(req);
  if (verdict.kind === "delegate") {
    return {
      act: "delegate",
      decision: { requestId: req.requestId, member: req.member, tool: req.tool, command: req.command, toolInputDigest: req.toolInputDigest, behavior: verdict.behavior, rewrite: verdict.rewrite, by, reason: `auto-allow:${req.tool}:scope-free`, atSec: nowSec, promptId: req.promptId },
    };
  }
  // sanitized-read (ruling B): a path read that v1 would escalate can instead be SANITIZED — the coordinator runs a hardened read
  // and injects the output. Gated on SWARM_SANITIZED_READ. planSanitize applies the same structural guards + the credential
  // red-line; the DECISION is built LATER (buildSanitizeDecision) by the dispatcher AFTER it runs the read (the result path is an
  // IO output). classifyApproval stays v1-pure — the sanitize fork lives here (the coordinator's action), avoiding an import cycle.
  if (req.tool === "Bash" && sanitizedReadEnabled(env)) {
    const spec = planSanitize(req.command);
    if (spec) return { act: "sanitize", spec };
  }
  return { act: "escalate", reason: verdict.reason };
}

/** Build the SANITIZE PermissionDecision AFTER the dispatcher has run the hardened read + written the result file. Binds the same
 *  member/tool/command/toolInputDigest as a delegate (so decisionBindsTo holds), sets `sanitized:true`, and the rewrite reads the
 *  coordinator-produced result via the v1 impl-pin (`builtin command /bin/cat <resultPath>`). Pure. */
export function buildSanitizeDecision(req: ApprovalRequest, resultPath: string, by: string, nowSec: number): PermissionDecision {
  return { requestId: req.requestId, member: req.member, tool: req.tool, command: req.command, toolInputDigest: req.toolInputDigest, behavior: "allow", rewrite: `builtin command /bin/cat ${resultPath}`, sanitized: true, by, reason: `sanitized-read:${req.tool}`, atSec: nowSec, promptId: req.promptId };
}

/** The subset of a Claude `PermissionRequest` hook's stdin JSON this feature needs. */
export interface ParsedPermissionHook {
  member: string;    // session_id
  tool: string;      // tool_name
  command: string;   // tool_input.command ("" for a structured tool)
  toolInput: unknown; // the RAW tool_input object (for the binding digest)
  cwd: string;
  promptId: string;  // prompt_id
}

/** Parse an already-JSON-parsed Claude PermissionRequest hook payload. Fail-closed: a non-object or one missing
 *  session_id / tool_name / prompt_id / cwd returns null ⇒ the hook emits nothing ⇒ user dialog. Pure. */
export function parsePermissionHook(obj: unknown): ParsedPermissionHook | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const member = o.session_id, tool = o.tool_name, cwd = o.cwd, promptId = o.prompt_id;
  if (typeof member !== "string" || !member) return null;
  if (typeof tool !== "string" || !tool) return null;
  if (typeof cwd !== "string" || !cwd) return null;
  if (typeof promptId !== "string" || !promptId) return null;
  const toolInput = (typeof o.tool_input === "object" && o.tool_input !== null) ? o.tool_input : {};
  const cmd = (toolInput as Record<string, unknown>).command;
  return { member, tool, command: typeof cmd === "string" ? cmd : "", toolInput, cwd, promptId };
}

/** Build the ApprovalRequest the hook writes (S11) — parsed fields + the per-invocation requestId + the full-input digest. Pure. */
export function buildApprovalRequest(parsed: ParsedPermissionHook, requestId: string, nowSec: number): ApprovalRequest {
  return { requestId, member: parsed.member, tool: parsed.tool, command: parsed.command, toolInputDigest: toolInputDigest(parsed.toolInput), cwd: parsed.cwd, promptId: parsed.promptId, nowSec };
}

/** A decision authorizes THIS invocation only when it matches the fresh requestId AND binds the same member/tool/command and the
 *  full-input digest (ADIO-P1-1). The requestId is unique per hook run, so an old/other decision can never match. Pure. */
export function decisionBindsTo(dec: PermissionDecision, requestId: string, p: ParsedPermissionHook): boolean {
  return dec.requestId === requestId && dec.member === p.member && dec.tool === p.tool && dec.command === p.command && dec.toolInputDigest === toolInputDigest(p.toolInput);
}

/** The exact stdout JSON a SYNC PermissionRequest hook prints to AUTO-ALLOW (verified against the hooks reference). With no
 *  argument it is a bare allow; with `updatedInput` it carries the AD-V1-P1-1 execution-pinned input — the hooks contract
 *  REPLACES the ENTIRE tool input, so the caller passes the FULL original input with only `command` swapped to the pinned path. Pure. */
export function allowDecisionOutput(updatedInput?: unknown): string {
  const decision: Record<string, unknown> = { behavior: "allow" };
  if (updatedInput !== undefined) decision.updatedInput = updatedInput;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

/** The poll cadence inside the hook's bounded window. */
export const APPROVAL_POLL_INTERVAL_MS = 400;

/** Every IO edge of the member-side hook, injected so runPermissionGate is testable without a real filesystem/coordinator. */
export interface PermissionGateDeps {
  enabled: boolean;                                                 // approvalDelegateEnabled()
  newRequestId: () => string;                                       // a FRESH unique id per invocation (crypto.randomUUID) — ADIO-P1-1
  readStdin: () => Promise<Record<string, unknown> | undefined>;    // the Claude hook payload
  reportBlocked: (member: string) => void;                          // writeStatusFile blocked (status visibility, kept)
  writeApprovalRequest: (req: ApprovalRequest) => boolean;          // writeInbox S11 to coordinator; false ⇒ undeliverable
  readDecision: (requestId: string) => PermissionDecision | null;   // loadControlLog ⇒ permissionDecision:<requestId>
  pinnedPathOk: (absPath: string) => boolean;                       // lstat in the MEMBER's env: pinned binary is a real regular file (AD-V1-P1-1)
  sanitizedResultDir?: string;                                      // sanitized-read: the coordinator-owned result dir; a sanitize rewrite's path MUST be under it (anti decision-tampering)
  emit: (json: string) => void;                                     // stdout (the decision)
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  pollSec?: number;
  intervalMs?: number;
}

/**
 * The member-side sync hook. Dormant unless `enabled`. Flow: read the payload; always keep the `blocked` status signal; when
 * enabled + parseable, mint a fresh requestId, write the S11 approval request, then poll the control-log for a delegated
 * decision bound to THIS invocation up to the window. A bound delegated ALLOW ⇒ emit the allow decision (no user dialog);
 * anything else (disabled, unparseable, undeliverable, or window elapsed with no bound decision) ⇒ emit NOTHING ⇒ user dialog
 * (interactive) / auto-deny (non-interactive). NEVER emits a decision the coordinator did not record for this exact call.
 */
export async function runPermissionGate(deps: PermissionGateDeps): Promise<void> {
  const payload = await deps.readStdin();
  const parsed = payload ? parsePermissionHook(payload) : null;
  if (parsed) deps.reportBlocked(parsed.member);         // preserve the blocked status signal (sync hook replaces the async one)
  if (!deps.enabled || !parsed) return;                  // dormant / malformed ⇒ emit nothing ⇒ user dialog
  const requestId = deps.newRequestId();                 // fresh per-invocation identity (ADIO-P1-1); the flowback key + one-shot
  const req = buildApprovalRequest(parsed, requestId, Math.floor(deps.nowMs() / 1000));
  if (!deps.writeApprovalRequest(req)) return;           // couldn't reach the coordinator ⇒ user dialog (never auto-grant)
  const deadline = deps.nowMs() + (deps.pollSec ?? APPROVAL_POLL_SEC) * 1000;
  const interval = deps.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  while (deps.nowMs() < deadline) {
    const dec = deps.readDecision(requestId);
    // The decision must bind to THIS invocation and be an allow (v1 never records a delegated deny; a deny stays a user decision).
    if (dec && decisionBindsTo(dec, requestId, parsed) && dec.behavior === "allow") {
      if (dec.sanitized === true) {
        // SANITIZE (ruling B): the result is a COORDINATOR-produced file — the member CANNOT recompute it, so it TRUSTS the
        // decision's rewrite but VALIDATES it before emitting (the ONE trust-model difference from a delegate): (a) the rewrite is
        // EXACTLY `builtin command /bin/cat <path>` (no spaces in <path>); (b) <path> is under the coordinator's sanitized-read
        // result dir; (c) /bin/cat AND <path> are real regular files (PIN ①, lstat — anti result-swap-to-dir/symlink). Any fail ⇒ user.
        const m = /^builtin command \/bin\/cat (\/[^\s]+)$/.exec(dec.rewrite);
        if (!m) return;
        const resultPath = m[1]!;
        const dir = deps.sanitizedResultDir;
        if (!dir || !(resultPath === dir || resultPath.startsWith(dir.endsWith("/") ? dir : dir + "/"))) return; // not under the result dir ⇒ user
        if (!deps.pinnedPathOk("/bin/cat") || !deps.pinnedPathOk(resultPath)) return; // both must be real regular files in THIS env
        const updatedInput = { ...(parsed.toolInput as Record<string, unknown>), command: dec.rewrite };
        deps.emit(allowDecisionOutput(updatedInput));
        return;
      }
      // AD-V1-P1-1 (DELEGATE): the hook RECOMPUTES the execution-pinned rewrite from the (bound) original command — it NEVER executes the
      // rewrite string carried in the control-log decision (the log authorizes WHETHER to allow; the member binds WHAT runs).
      const plan = planDelegation(parsed.command);
      if (plan.gate !== "scope-free") return;                 // a bound decision for a non-scope-free command ⇒ user dialog (defensive)
      if (!deps.pinnedPathOk(plan.pinnedPath)) return;        // the pinned binary missing / symlink / dir in THIS env ⇒ escalate to the user
      const updatedInput = { ...(parsed.toolInput as Record<string, unknown>), command: plan.rewrite };
      deps.emit(allowDecisionOutput(updatedInput));           // full original input, command swapped to `builtin command <abspath>`
      return;
    }
    await deps.sleep(interval);
  }
  // window elapsed, no bound decision ⇒ emit nothing ⇒ user dialog / auto-deny
}
