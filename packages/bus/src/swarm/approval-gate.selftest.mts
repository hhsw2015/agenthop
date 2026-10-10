// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-gate.selftest.mts
// Pins the scope-free-only v1 IO logic: planCoordinatorAction (delegate binds requestId/member/tool/command/toolInputDigest),
// the hook parse + full-input digest, decisionBindsTo (ADIO-P1-1: a decision authorizes THIS call only), the bare allow JSON,
// and runPermissionGate (fresh per-invocation requestId; emits only a bound allow).
import {
  planCoordinatorAction, parsePermissionHook, buildApprovalRequest, toolInputDigest, allowDecisionOutput, runPermissionGate,
  decisionBindsTo, approvalInboxKey, type PermissionGateDeps,
} from "./approval-gate.js";
import { type ApprovalRequest, type PermissionDecision } from "./approval-delegation.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const reqOf = (command: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ requestId: "rid", member: "mem1", tool: "Bash", command, toolInputDigest: toolInputDigest({ command }), cwd: "/w", promptId: "pr1", nowSec: 1000, ...over });

// ── planCoordinatorAction ─────────────────────────────────────────────────────────────────────────────────────
{
  const a = planCoordinatorAction(reqOf("pwd"), "coord", 1234);
  t("scope-free delegate: binds requestId/member/tool/command/digest + behavior/by/atSec", a.act === "delegate" && a.decision.requestId === "rid" && a.decision.member === "mem1" && a.decision.tool === "Bash" && a.decision.command === "pwd" && a.decision.toolInputDigest === toolInputDigest({ command: "pwd" }) && a.decision.behavior === "allow" && a.decision.by === "coord" && a.decision.atSec === 1234);
}
t("path read -> escalate (v1 dropped)", planCoordinatorAction(reqOf("cat a.txt"), "c", 1).act === "escalate");
t("git -> escalate (v1 dropped)", planCoordinatorAction(reqOf("git status"), "c", 1).act === "escalate");
t("privilege -> escalate", (() => { const a = planCoordinatorAction(reqOf("rm -rf /"), "c", 1); return a.act === "escalate" && a.reason === "privilege"; })());
t("allow-only: no delegate carries deny", ["pwd", "cat x", "rm x"].every(c => { const a = planCoordinatorAction(reqOf(c), "c", 1); return a.act === "escalate" || a.decision.behavior === "allow"; }));

// ── parsePermissionHook + toolInputDigest ─────────────────────────────────────────────────────────────────────
t("parse Bash: command + toolInput kept", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Bash", tool_input: { command: "pwd", timeout: 5 }, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === "pwd" && JSON.stringify(p.toolInput) === JSON.stringify({ command: "pwd", timeout: 5 }); })());
t("parse structured: command ''", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Write", tool_input: { file_path: "/w/x" }, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === ""; })());
for (const bad of [42, null, { tool_name: "Bash", cwd: "/w", prompt_id: "p" }, { session_id: "s", cwd: "/w", prompt_id: "p" }, { session_id: "s", tool_name: "Bash", prompt_id: "p" }, { session_id: "s", tool_name: "Bash", cwd: "/w" }]) {
  t(`parse invalid -> null: ${JSON.stringify(bad)}`, parsePermissionHook(bad) === null);
}
t("toolInputDigest deterministic + key-order-independent", toolInputDigest({ command: "x", timeout: 1 }) === toolInputDigest({ timeout: 1, command: "x" }));
t("toolInputDigest distinguishes different input", toolInputDigest({ command: "pwd" }) !== toolInputDigest({ command: "echo" }));
t("toolInputDigest distinguishes structured inputs (command '')", toolInputDigest({ file_path: "/w/a" }) !== toolInputDigest({ file_path: "/w/b" }));

// ── buildApprovalRequest ──────────────────────────────────────────────────────────────────────────────────────
{
  const parsed = { member: "s", tool: "Bash", command: "pwd", toolInput: { command: "pwd" }, cwd: "/w", promptId: "p" };
  const r = buildApprovalRequest(parsed, "RID", 999);
  t("build: carries fields + requestId + digest + nowSec", r.requestId === "RID" && r.command === "pwd" && r.nowSec === 999 && r.toolInputDigest === toolInputDigest({ command: "pwd" }));
}

// ── decisionBindsTo ───────────────────────────────────────────────────────────────────────────────────────────
const parsed = { member: "mem1", tool: "Bash", command: "pwd", toolInput: { command: "pwd" }, cwd: "/w", promptId: "pr1" };
const dec = (over: Partial<PermissionDecision> = {}): PermissionDecision => ({ requestId: "RID", member: "mem1", tool: "Bash", command: "pwd", toolInputDigest: toolInputDigest({ command: "pwd" }), behavior: "allow", by: "c", reason: "x", atSec: 1, promptId: "pr1", ...over });
t("bindsTo: full match", decisionBindsTo(dec(), "RID", parsed) === true);
t("bindsTo: requestId mismatch -> false", decisionBindsTo(dec(), "OTHER", parsed) === false);
t("bindsTo: member mismatch -> false", decisionBindsTo(dec({ member: "memX" }), "RID", parsed) === false);
t("bindsTo: tool mismatch -> false", decisionBindsTo(dec({ tool: "Read" }), "RID", parsed) === false);
t("bindsTo: command mismatch -> false", decisionBindsTo(dec({ command: "rm x" }), "RID", parsed) === false);
t("bindsTo: digest mismatch -> false", decisionBindsTo(dec({ toolInputDigest: "nope" }), "RID", parsed) === false);

// ── allowDecisionOutput + approvalInboxKey ────────────────────────────────────────────────────────────────────
t("allow output is a bare allow (no updatedInput in v1)", allowDecisionOutput() === JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
t("approvalInboxKey", approvalInboxKey("fe0376cd") === "approvals:fe0376cd");

// ── runPermissionGate ─────────────────────────────────────────────────────────────────────────────────────────
const payload = { session_id: "mem1", tool_name: "Bash", tool_input: { command: "pwd" }, cwd: "/w", prompt_id: "pr1" };
const boundAllow = (rid: string, over: Partial<PermissionDecision> = {}): PermissionDecision => ({ requestId: rid, member: "mem1", tool: "Bash", command: "pwd", toolInputDigest: toolInputDigest({ command: "pwd" }), behavior: "allow", by: "c", reason: "x", atSec: 1, promptId: "pr1", ...over });
function mkDeps(over: Partial<PermissionGateDeps> & { decisions?: Record<string, PermissionDecision>; rid?: string } = {}): { deps: PermissionGateDeps; out: string[]; blocked: string[]; written: ApprovalRequest[]; rid: string } {
  const out: string[] = [], blocked: string[] = [], written: ApprovalRequest[] = [];
  const rid = over.rid ?? "nonce-1";
  const decisions = over.decisions ?? {};
  let now = 0;
  const deps: PermissionGateDeps = {
    enabled: over.enabled ?? true,
    newRequestId: over.newRequestId ?? (() => rid),
    readStdin: over.readStdin ?? (async () => payload),
    reportBlocked: (m) => blocked.push(m),
    writeApprovalRequest: over.writeApprovalRequest ?? ((r) => { written.push(r); return true; }),
    readDecision: over.readDecision ?? ((q) => decisions[q] ?? null),
    emit: (j) => out.push(j),
    nowMs: () => (now += 100),
    sleep: async () => {},
    pollSec: over.pollSec ?? 1,
    intervalMs: over.intervalMs ?? 100,
  };
  return { deps, out, blocked, written, rid };
}

await (async () => { const { deps, out, blocked, written } = mkDeps({ decisions: { "nonce-1": boundAllow("nonce-1") } }); await runPermissionGate(deps); t("gate: bound allow -> emits allow; blocked; wrote S11 with requestId", out.length === 1 && out[0] === allowDecisionOutput() && blocked[0] === "mem1" && written[0].requestId === "nonce-1"); })();
await (async () => { const { deps, out } = mkDeps({}); await runPermissionGate(deps); t("gate: no decision -> nothing", out.length === 0); })();
await (async () => { const { deps, out, blocked, written } = mkDeps({ enabled: false }); await runPermissionGate(deps); t("gate: disabled -> nothing, blocked, no write", out.length === 0 && blocked.length === 1 && written.length === 0); })();
await (async () => { const { deps, out, written, blocked } = mkDeps({ readStdin: async () => undefined }); await runPermissionGate(deps); t("gate: no payload -> nothing/no write/no blocked", out.length === 0 && written.length === 0 && blocked.length === 0); })();
await (async () => { const { deps, out } = mkDeps({ writeApprovalRequest: () => false, decisions: { "nonce-1": boundAllow("nonce-1") } }); await runPermissionGate(deps); t("gate: undeliverable -> nothing", out.length === 0); })();
await (async () => { const { deps, out } = mkDeps({ decisions: { "nonce-1": boundAllow("nonce-1", { behavior: "deny" }) } }); await runPermissionGate(deps); t("gate: deny -> nothing", out.length === 0); })();
// ADIO-P1-1: a decision at the right key but WRONG binding -> not emitted
await (async () => { const { deps, out } = mkDeps({ decisions: { "nonce-1": boundAllow("nonce-1", { command: "rm x" }) } }); await runPermissionGate(deps); t("gate: mis-bound (command) -> nothing", out.length === 0); })();
await (async () => { const { deps, out } = mkDeps({ decisions: { "nonce-1": boundAllow("nonce-1", { member: "memX" }) } }); await runPermissionGate(deps); t("gate: mis-bound (member) -> nothing", out.length === 0); })();
await (async () => { const { deps, out } = mkDeps({ decisions: { "nonce-1": boundAllow("nonce-1", { toolInputDigest: "nope" }) } }); await runPermissionGate(deps); t("gate: mis-bound (digest) -> nothing", out.length === 0); })();
// a decision for a DIFFERENT invocation's nonce is never seen (fresh nonce each call)
await (async () => { const { deps, out } = mkDeps({ rid: "nonce-2", decisions: { "nonce-1": boundAllow("nonce-1") } }); await runPermissionGate(deps); t("gate: other invocation's decision not applied (fresh nonce)", out.length === 0); })();

console.log("all approval-gate selftests passed");
