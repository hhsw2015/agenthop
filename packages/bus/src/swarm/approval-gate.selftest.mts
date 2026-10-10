// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-gate.selftest.mts
// Pins the IO-round logic layer: planCoordinatorAction, the Claude PermissionRequest hook parse/build, the allow-decision stdout
// JSON, and runPermissionGate (dependency-injected member-side flow) — delegate-allow emits, everything else emits nothing.
import {
  planCoordinatorAction, parsePermissionHook, buildApprovalRequest, allowDecisionOutput, runPermissionGate, approvalInboxKey,
  type PermissionGateDeps,
} from "./approval-gate.js";
import { type ApprovalRequest, type ApprovalScope, type PermissionDecision } from "./approval-delegation.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const okScope = (paths: string[] = []): ApprovalScope => ({ cwdVerified: true, resolvedPaths: paths.map(raw => ({ raw, resolvedWithinCwd: true, resolvedSensitive: false })) });
const req = (command: string, scope?: ApprovalScope): ApprovalRequest => ({ member: "mem1", tool: "Bash", command, cwd: "/w", promptId: "pr1", nowSec: 1000, ...(scope ? { scope } : {}) });

// ── planCoordinatorAction ─────────────────────────────────────────────────────────────────────────────────────
{
  const a = planCoordinatorAction(req("cat a.txt", okScope(["a.txt"])), "coord-sid", 1234);
  t("delegate: act=delegate, behavior allow, promptId/member/by/atSec carried", a.act === "delegate" && a.decision.behavior === "allow" && a.decision.promptId === "pr1" && a.decision.member === "mem1" && a.decision.by === "coord-sid" && a.decision.atSec === 1234);
}
t("privilege -> escalate:privilege", (() => { const a = planCoordinatorAction(req("rm -rf /", okScope([])), "c", 1); return a.act === "escalate" && a.reason === "privilege"; })());
t("unknown -> escalate:needs-user", (() => { const a = planCoordinatorAction(req("make", okScope([])), "c", 1); return a.act === "escalate" && a.reason === "needs-user"; })());
t("path form w/o facts -> escalate", planCoordinatorAction(req("cat a.txt"), "c", 1).act === "escalate");
t("git form w/o git facts -> escalate", planCoordinatorAction(req("git status", okScope([])), "c", 1).act === "escalate");
// git-recall: a git delegate carries a config-immune rewrite in the decision
(() => {
  const gitScope: ApprovalScope = { cwdVerified: true, resolvedPaths: [], cwdIsGitRoot: true, gitEnvClean: true };
  const a = planCoordinatorAction(req("git status -s", gitScope), "c", 7);
  t("git delegate: decision.rewrite is the config-immune command", a.act === "delegate" && a.decision.rewrite === "git --no-pager -c diff.external= -c core.fsmonitor= status -s");
})();
t("allow-only: no delegate carries deny", [req("cat a.txt", okScope(["a.txt"])), req("rm x"), req("git status", okScope([]))].every(s => { const a = planCoordinatorAction(s, "c", 1); return a.act === "escalate" || a.decision.behavior === "allow"; }));

// ── parsePermissionHook (takes the parsed object) ─────────────────────────────────────────────────────────────
t("parse full Bash hook", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Bash", tool_input: { command: "cat x" }, cwd: "/w", prompt_id: "p" }); return p !== null && p.member === "s" && p.tool === "Bash" && p.command === "cat x" && p.cwd === "/w" && p.promptId === "p"; })());
t("parse structured tool: command ''", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Read", tool_input: { file_path: "/w/x" }, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === "" && p.tool === "Read"; })());
t("parse non-object -> null", parsePermissionHook(42) === null);
t("parse null -> null", parsePermissionHook(null) === null);
t("parse missing session_id -> null", parsePermissionHook({ tool_name: "Bash", cwd: "/w", prompt_id: "p" }) === null);
t("parse missing tool_name -> null", parsePermissionHook({ session_id: "s", cwd: "/w", prompt_id: "p" }) === null);
t("parse missing cwd -> null", parsePermissionHook({ session_id: "s", tool_name: "Bash", prompt_id: "p" }) === null);
t("parse missing prompt_id -> null", parsePermissionHook({ session_id: "s", tool_name: "Bash", cwd: "/w" }) === null);
t("parse tool_input without command -> ''", (() => { const p = parsePermissionHook({ session_id: "s", tool_name: "Bash", tool_input: {}, cwd: "/w", prompt_id: "p" }); return p !== null && p.command === ""; })());

// ── buildApprovalRequest ──────────────────────────────────────────────────────────────────────────────────────
{
  const parsed = { member: "s", tool: "Bash", command: "cat x", cwd: "/w", promptId: "p" };
  const scope = okScope(["x"]);
  t("build: carries fields + scope + nowSec", (() => { const r = buildApprovalRequest(parsed, scope, 999); return r.member === "s" && r.command === "cat x" && r.nowSec === 999 && r.scope === scope; })());
  t("build: omits scope when undefined", buildApprovalRequest(parsed, undefined, 999).scope === undefined);
}

// ── approvalInboxKey: the dedicated per-coordinator key (approvals:<coordSid>) ─────────────────────────────────
t("approvalInboxKey(coordSid)", approvalInboxKey("fe0376cd-sid") === "approvals:fe0376cd-sid");

// ── allowDecisionOutput: exact hook stdout JSON ───────────────────────────────────────────────────────────────
t("allow output shape", allowDecisionOutput() === JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
t("allow output w/ rewrite (git recall seam)", JSON.parse(allowDecisionOutput({ command: "git -c x diff" })).hookSpecificOutput.decision.updatedInput.command === "git -c x diff");

// ── runPermissionGate: the injected member-side flow ──────────────────────────────────────────────────────────
const hookPayload = { session_id: "mem1", tool_name: "Bash", tool_input: { command: "cat a.txt" }, cwd: "/w", prompt_id: "pr1" };
function mkDeps(over: Partial<PermissionGateDeps> & { decisions?: Record<string, PermissionDecision> } = {}): { deps: PermissionGateDeps; out: string[]; blocked: string[]; written: ApprovalRequest[] } {
  const out: string[] = [], blocked: string[] = [], written: ApprovalRequest[] = [];
  const decisions = over.decisions ?? {};
  let now = 0;
  const deps: PermissionGateDeps = {
    enabled: over.enabled ?? true,
    readStdin: over.readStdin ?? (async () => hookPayload),
    reportBlocked: (m) => blocked.push(m),
    resolveScope: over.resolveScope ?? ((_c, _cwd) => okScope(["a.txt"])),
    writeApprovalRequest: over.writeApprovalRequest ?? ((r) => { written.push(r); return true; }),
    readDecision: over.readDecision ?? ((pid) => decisions[pid] ?? null),
    emit: (j) => out.push(j),
    nowMs: () => (now += 100),   // advances 100ms per call so the poll window elapses deterministically
    sleep: async () => { /* no real wait */ },
    pollSec: over.pollSec ?? 1,
    intervalMs: over.intervalMs ?? 100,
  };
  return { deps, out, blocked, written };
}

// delegated allow present immediately -> emits allow, reports blocked, wrote the S11
await (async () => {
  const { deps, out, blocked, written } = mkDeps({ decisions: { pr1: { promptId: "pr1", member: "mem1", behavior: "allow", by: "coord", reason: "x", atSec: 1 } } });
  await runPermissionGate(deps);
  t("gate: emits the allow decision", out.length === 1 && out[0] === allowDecisionOutput());
  t("gate: reported blocked", blocked.length === 1 && blocked[0] === "mem1");
  t("gate: wrote the S11 approval request", written.length === 1 && written[0].promptId === "pr1" && written[0].scope !== undefined);
})();

// no decision ever -> emits nothing (timeout -> user dialog), but still reported blocked + wrote S11
await (async () => {
  const { deps, out, written } = mkDeps({});
  await runPermissionGate(deps);
  t("gate: no decision -> emits nothing", out.length === 0);
  t("gate: still wrote S11 before polling", written.length === 1);
})();

// disabled (dormant) -> reports blocked, emits nothing, writes nothing
await (async () => {
  const { deps, out, blocked, written } = mkDeps({ enabled: false });
  await runPermissionGate(deps);
  t("gate: disabled emits nothing", out.length === 0);
  t("gate: disabled still reports blocked", blocked.length === 1);
  t("gate: disabled writes no S11", written.length === 0);
})();

// unparseable payload -> emits nothing, no blocked, no write
await (async () => {
  const { deps, out, blocked, written } = mkDeps({ readStdin: async () => undefined });
  await runPermissionGate(deps);
  t("gate: no payload emits nothing / no write / no blocked", out.length === 0 && written.length === 0 && blocked.length === 0);
})();

// undeliverable S11 (no coordinator) -> emits nothing, never polls
await (async () => {
  const { deps, out } = mkDeps({ writeApprovalRequest: () => false, decisions: { pr1: { promptId: "pr1", member: "mem1", behavior: "allow", by: "c", reason: "x", atSec: 1 } } });
  await runPermissionGate(deps);
  t("gate: undeliverable -> emits nothing even if a decision exists", out.length === 0);
})();

// a deny decision is NOT auto-applied by the hook (deny stays a user decision) -> emits nothing
await (async () => {
  const { deps, out } = mkDeps({ decisions: { pr1: { promptId: "pr1", member: "mem1", behavior: "deny", by: "c", reason: "x", atSec: 1 } } });
  await runPermissionGate(deps);
  t("gate: delegated deny is never emitted (emits nothing)", out.length === 0);
})();

// git-recall: a delegated allow WITH a rewrite -> emit allow carrying decision.updatedInput.command (the config-immune form)
await (async () => {
  const rewrite = "git --no-pager -c diff.external= -c core.fsmonitor= status -s";
  const { deps, out } = mkDeps({ decisions: { pr1: { promptId: "pr1", member: "mem1", behavior: "allow", by: "c", reason: "x", atSec: 1, rewrite } } });
  await runPermissionGate(deps);
  t("gate: git delegate emits allow WITH updatedInput rewrite", out.length === 1 && JSON.parse(out[0]).hookSpecificOutput.decision.updatedInput.command === rewrite);
})();

console.log("all approval-gate selftests passed");
