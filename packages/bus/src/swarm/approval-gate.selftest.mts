// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-gate.selftest.mts
// Pins the IO-round logic layer after happycapy's r1: planCoordinatorAction, the Claude hook parse/build, approvalInstanceId
// (ADIO-P1-1 deterministic per-call identity), decisionBindsTo, factsStable (ADIO-P1-2 TOCTOU snapshot), the allow-decision JSON,
// and runPermissionGate (dependency-injected member flow) — delegate-allow emits ONLY when the decision binds this call AND the
// re-resolved facts are stable; everything else emits nothing.
import {
  planCoordinatorAction, parsePermissionHook, buildApprovalRequest, allowDecisionOutput, runPermissionGate,
  approvalInboxKey, approvalInstanceId, decisionBindsTo, factsStable, type PermissionGateDeps,
} from "./approval-gate.js";
import { type ApprovalRequest, type ApprovalScope, type PermissionDecision } from "./approval-delegation.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const okScope = (paths: Array<{ raw: string; resolved?: string | null; within?: boolean; sensitive?: boolean }> = []): ApprovalScope =>
  ({ cwdVerified: true, resolvedPaths: paths.map(p => ({ raw: p.raw, resolved: p.resolved ?? ("/w/" + p.raw), resolvedWithinCwd: p.within ?? true, resolvedSensitive: p.sensitive ?? false })) });
const gitScope = (): ApprovalScope => ({ cwdVerified: true, resolvedPaths: [], cwdIsGitRoot: true, gitEnvClean: true });
const reqOf = (command: string, scope?: ApprovalScope): ApprovalRequest =>
  ({ requestId: "rid", member: "mem1", tool: "Bash", command, cwd: "/w", promptId: "pr1", nowSec: 1000, ...(scope ? { scope } : {}) });

// ── planCoordinatorAction ─────────────────────────────────────────────────────────────────────────────────────
{
  const a = planCoordinatorAction(reqOf("cat a.txt", okScope([{ raw: "a.txt" }])), "coord", 1234);
  t("delegate: binds requestId/member/tool/command + behavior/by/atSec", a.act === "delegate" && a.decision.requestId === "rid" && a.decision.member === "mem1" && a.decision.tool === "Bash" && a.decision.command === "cat a.txt" && a.decision.behavior === "allow" && a.decision.by === "coord" && a.decision.atSec === 1234);
}
t("privilege -> escalate", (() => { const a = planCoordinatorAction(reqOf("rm -rf /", okScope()), "c", 1); return a.act === "escalate" && a.reason === "privilege"; })());
t("unknown -> escalate", planCoordinatorAction(reqOf("make", okScope()), "c", 1).act === "escalate");
t("git delegate: decision carries config-immune rewrite", (() => { const a = planCoordinatorAction(reqOf("git status -s", gitScope()), "c", 1); return a.act === "delegate" && a.decision.rewrite === "git --no-pager -c diff.external= -c core.fsmonitor= status -s"; })());
t("allow-only: no delegate carries deny", [reqOf("cat a.txt", okScope([{ raw: "a.txt" }])), reqOf("rm x"), reqOf("git status", gitScope())].every(s => { const a = planCoordinatorAction(s, "c", 1); return a.act === "escalate" || a.decision.behavior === "allow"; }));

// ── parsePermissionHook (captures toolInput for the instance hash) ─────────────────────────────────────────────
t("parse Bash: command + toolInput kept", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Bash", tool_input: { command: "cat x", timeout: 5 }, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === "cat x" && JSON.stringify(p.toolInput) === JSON.stringify({ command: "cat x", timeout: 5 }); })());
t("parse structured: command '' + toolInput kept", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Write", tool_input: { file_path: "/w/x" }, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === "" && JSON.stringify(p.toolInput) === JSON.stringify({ file_path: "/w/x" }); })());
t("parse no tool_input -> toolInput {}", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Bash", cwd: "/w", prompt_id: "p" }); return p !== null && JSON.stringify(p.toolInput) === "{}"; })());
for (const bad of [42, null, { tool_name: "Bash", cwd: "/w", prompt_id: "p" }, { session_id: "s", cwd: "/w", prompt_id: "p" }, { session_id: "s", tool_name: "Bash", prompt_id: "p" }, { session_id: "s", tool_name: "Bash", cwd: "/w" }]) {
  t(`parse invalid -> null: ${JSON.stringify(bad)}`, parsePermissionHook(bad) === null);
}

// ── approvalInstanceId (ADIO-P1-1): deterministic; different call ⇒ different id ───────────────────────────────
t("instanceId deterministic (same call ⇒ same id)", approvalInstanceId("p", "Bash", { command: "pwd" }) === approvalInstanceId("p", "Bash", { command: "pwd" }));
t("instanceId: pwd vs rm differ (the ADIO-P1-1 attack)", approvalInstanceId("p", "Bash", { command: "pwd" }) !== approvalInstanceId("p", "Bash", { command: "rm x" }));
t("instanceId: different promptId differ", approvalInstanceId("p1", "Bash", { command: "pwd" }) !== approvalInstanceId("p2", "Bash", { command: "pwd" }));
t("instanceId: structured tools with command '' still differ by input", approvalInstanceId("p", "Write", { file_path: "/w/a" }) !== approvalInstanceId("p", "Write", { file_path: "/w/b" }));
t("instanceId: key order does not matter (canonical)", approvalInstanceId("p", "Bash", { command: "x", timeout: 1 }) === approvalInstanceId("p", "Bash", { timeout: 1, command: "x" }));

// ── decisionBindsTo ───────────────────────────────────────────────────────────────────────────────────────────
const parsed = { member: "mem1", tool: "Bash", command: "cat a.txt", toolInput: { command: "cat a.txt" }, cwd: "/w", promptId: "pr1" };
const dec = (over: Partial<PermissionDecision> = {}): PermissionDecision => ({ requestId: "RID", member: "mem1", tool: "Bash", command: "cat a.txt", behavior: "allow", by: "c", reason: "x", atSec: 1, promptId: "pr1", ...over });
t("bindsTo: full match", decisionBindsTo(dec(), "RID", parsed) === true);
t("bindsTo: requestId mismatch -> false", decisionBindsTo(dec(), "OTHER", parsed) === false);
t("bindsTo: member mismatch -> false", decisionBindsTo(dec({ member: "memX" }), "RID", parsed) === false);
t("bindsTo: tool mismatch -> false", decisionBindsTo(dec({ tool: "Read" }), "RID", parsed) === false);
t("bindsTo: command mismatch -> false", decisionBindsTo(dec({ command: "rm x" }), "RID", parsed) === false);

// ── factsStable (ADIO-P1-2): realpath snapshot comparison ─────────────────────────────────────────────────────
t("factsStable: same realpaths -> true", factsStable(okScope([{ raw: "a", resolved: "/w/a" }]), okScope([{ raw: "a", resolved: "/w/a" }])) === true);
t("factsStable: changed realpath (target swap) -> false", factsStable(okScope([{ raw: "a", resolved: "/w/a" }]), okScope([{ raw: "a", resolved: "/w/b" }])) === false);
t("factsStable: length mismatch -> false", factsStable(okScope([{ raw: "a" }]), okScope([])) === false);
t("factsStable: empty (git/scope-free) -> true", factsStable(gitScope(), gitScope()) === true);

// ── allowDecisionOutput ───────────────────────────────────────────────────────────────────────────────────────
t("allow output shape", allowDecisionOutput() === JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
t("allow output w/ rewrite", JSON.parse(allowDecisionOutput({ command: "git x" })).hookSpecificOutput.decision.updatedInput.command === "git x");

// ── approvalInboxKey ──────────────────────────────────────────────────────────────────────────────────────────
t("approvalInboxKey", approvalInboxKey("fe0376cd") === "approvals:fe0376cd");

// ── runPermissionGate ─────────────────────────────────────────────────────────────────────────────────────────
const bashPayload = { session_id: "mem1", tool_name: "Bash", tool_input: { command: "cat a.txt" }, cwd: "/w", prompt_id: "pr1" };
const RID = approvalInstanceId("pr1", "Bash", { command: "cat a.txt" }); // what the gate computes for bashPayload
const boundAllow = (over: Partial<PermissionDecision> = {}): PermissionDecision => ({ requestId: RID, member: "mem1", tool: "Bash", command: "cat a.txt", behavior: "allow", by: "c", reason: "x", atSec: 1, promptId: "pr1", ...over });
function mkDeps(over: Partial<PermissionGateDeps> & { decisions?: Record<string, PermissionDecision>; payload?: Record<string, unknown> } = {}): { deps: PermissionGateDeps; out: string[]; blocked: string[]; written: ApprovalRequest[] } {
  const out: string[] = [], blocked: string[] = [], written: ApprovalRequest[] = [];
  const decisions = over.decisions ?? {};
  let now = 0;
  const deps: PermissionGateDeps = {
    enabled: over.enabled ?? true,
    readStdin: over.readStdin ?? (async () => over.payload ?? bashPayload),
    reportBlocked: (m) => blocked.push(m),
    resolveScope: over.resolveScope ?? ((_c, _cwd) => okScope([{ raw: "a.txt" }])),
    writeApprovalRequest: over.writeApprovalRequest ?? ((r) => { written.push(r); return true; }),
    readDecision: over.readDecision ?? ((rid) => decisions[rid] ?? null),
    emit: (j) => out.push(j),
    nowMs: () => (now += 100),
    sleep: async () => {},
    pollSec: over.pollSec ?? 1,
    intervalMs: over.intervalMs ?? 100,
  };
  return { deps, out, blocked, written };
}

// bound allow + stable facts -> emits allow; reports blocked; wrote S11 with the computed requestId
await (async () => {
  const { deps, out, blocked, written } = mkDeps({ decisions: { [RID]: boundAllow() } });
  await runPermissionGate(deps);
  t("gate: emits allow when bound + facts stable", out.length === 1 && out[0] === allowDecisionOutput());
  t("gate: reported blocked", blocked.length === 1 && blocked[0] === "mem1");
  t("gate: wrote S11 with computed requestId", written.length === 1 && written[0].requestId === RID);
})();
// no decision -> nothing
await (async () => { const { deps, out } = mkDeps({}); await runPermissionGate(deps); t("gate: no decision -> nothing", out.length === 0); })();
// disabled -> nothing + blocked
await (async () => { const { deps, out, blocked, written } = mkDeps({ enabled: false }); await runPermissionGate(deps); t("gate: disabled -> nothing, blocked, no write", out.length === 0 && blocked.length === 1 && written.length === 0); })();
// no payload -> nothing
await (async () => { const { deps, out, written, blocked } = mkDeps({ readStdin: async () => undefined }); await runPermissionGate(deps); t("gate: no payload -> nothing/no write/no blocked", out.length === 0 && written.length === 0 && blocked.length === 0); })();
// undeliverable -> nothing even if a (bound) decision exists
await (async () => { const { deps, out } = mkDeps({ writeApprovalRequest: () => false, decisions: { [RID]: boundAllow() } }); await runPermissionGate(deps); t("gate: undeliverable -> nothing", out.length === 0); })();
// deny -> nothing
await (async () => { const { deps, out } = mkDeps({ decisions: { [RID]: boundAllow({ behavior: "deny" }) } }); await runPermissionGate(deps); t("gate: deny -> nothing", out.length === 0); })();
// ADIO-P1-1: a decision at the RIGHT key but WRONG binding (different member/command) -> NOT emitted
await (async () => { const { deps, out } = mkDeps({ decisions: { [RID]: boundAllow({ command: "rm x" }) } }); await runPermissionGate(deps); t("gate: mis-bound decision (command) -> nothing (ADIO-P1-1)", out.length === 0); })();
await (async () => { const { deps, out } = mkDeps({ decisions: { [RID]: boundAllow({ member: "memX" }) } }); await runPermissionGate(deps); t("gate: mis-bound decision (member) -> nothing (ADIO-P1-1)", out.length === 0); })();
// ADIO-P1-2 TOCTOU: facts drift during the wait (realpath swap) -> discard -> nothing
await (async () => {
  let n = 0;
  const { deps, out } = mkDeps({ decisions: { [RID]: boundAllow() }, resolveScope: () => { n += 1; return okScope([{ raw: "a.txt", resolved: n === 1 ? "/w/a.txt" : "/w/SWAPPED" }]); } });
  await runPermissionGate(deps);
  t("gate: realpath drift during wait -> nothing (ADIO-P1-2)", out.length === 0);
})();
// ADIO-P1-2: target now escapes cwd at emit -> re-classify fails -> nothing
await (async () => {
  let n = 0;
  const { deps, out } = mkDeps({ decisions: { [RID]: boundAllow() }, resolveScope: () => { n += 1; return okScope([{ raw: "a.txt", resolved: "/w/a.txt", within: n !== 1 ? false : true }]); } });
  await runPermissionGate(deps);
  t("gate: target now escapes at emit -> nothing (ADIO-P1-2)", out.length === 0);
})();
// git: a bound git allow + stable git facts -> emit allow WITH the fresh config-immune rewrite
await (async () => {
  const gitPayload = { session_id: "mem1", tool_name: "Bash", tool_input: { command: "git status -s" }, cwd: "/w", prompt_id: "pg" };
  const RIDG = approvalInstanceId("pg", "Bash", { command: "git status -s" });
  const decG: PermissionDecision = { requestId: RIDG, member: "mem1", tool: "Bash", command: "git status -s", behavior: "allow", by: "c", reason: "x", atSec: 1, promptId: "pg", rewrite: "git --no-pager -c diff.external= -c core.fsmonitor= status -s" };
  const { deps, out } = mkDeps({ payload: gitPayload, decisions: { [RIDG]: decG }, resolveScope: () => gitScope() });
  await runPermissionGate(deps);
  t("gate: git delegate emits allow WITH rewrite", out.length === 1 && JSON.parse(out[0]).hookSpecificOutput.decision.updatedInput.command === "git --no-pager -c diff.external= -c core.fsmonitor= status -s");
})();

console.log("all approval-gate selftests passed");
