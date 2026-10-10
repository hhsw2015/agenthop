// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-delegation.selftest.mts
// Pins the scope-free-only v1 (coordinator architecture ruling A(a)+B(a)): classifyApproval delegates ONLY scope-free commands
// (pwd/echo/which/basename/dirname); path reads, git, and everything else escalate. + the blacklist privilege backstop, the
// metachar/glob/quote bans, v1 allow-only, and validApprovalRequest (per-invocation requestId + full-input digest + absolute cwd).
import {
  classifyApproval, planDelegation, isBlacklisted, validApprovalRequest, approvalDelegateEnabled, APPROVAL_POLL_SEC,
  type ApprovalRequest, type ApprovalVerdict,
} from "./approval-delegation.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const req = (command: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ requestId: "r1", member: "m1", tool: "Bash", command, toolInputDigest: "d1", cwd: "/w", promptId: "p1", nowSec: 1000, ...over });
const isDelegate = (v: ApprovalVerdict) => v.kind === "delegate" && v.behavior === "allow";
const isPriv = (v: ApprovalVerdict) => v.kind === "escalate" && v.reason === "privilege";
const isNeedsUser = (v: ApprovalVerdict) => v.kind === "escalate" && v.reason === "needs-user";

t("APPROVAL_POLL_SEC === 15", APPROVAL_POLL_SEC === 15);

// ── scope-free forms delegate ─────────────────────────────────────────────────────────────────────────────────
for (const c of ["pwd", "echo hi", "echo ../anything is a literal", "which tsx", "basename a/b/c", "dirname a/b"]) {
  t(`scope-free delegates: ${c}`, isDelegate(classifyApproval(req(c))));
}
t("pwd with an arg -> needs-user", isNeedsUser(classifyApproval(req("pwd extra"))));

// ── AD-V1-P1-1: the delegate carries the pinned-absolute-path rewrite (execution binding), args verbatim ─────────
const rw = (c: string) => { const v = classifyApproval(req(c)); return v.kind === "delegate" ? v.rewrite : null; };
t("rewrite pins pwd", rw("pwd") === "/bin/pwd");
t("rewrite pins echo + keeps args verbatim", rw("echo hi") === "/bin/echo hi");
t("rewrite pins echo with collapsed-safe spacing verbatim", rw("echo  a   b") === "/bin/echo  a   b");
t("rewrite pins which", rw("which tsx") === "/usr/bin/which tsx");
t("rewrite pins basename", rw("basename a/b/c") === "/usr/bin/basename a/b/c");
t("rewrite pins dirname", rw("dirname a/b") === "/usr/bin/dirname a/b");

// ── AD-V1-P1-1: match is case-SENSITIVE — a raw/uppercase spelling is NOT scope-free (would execute the raw spelling) ──
for (const c of ["ECHO hi", "Pwd", "WHICH tsx", "Echo hi", "PWD"]) t(`case-sensitive escalate: ${c}`, isNeedsUser(classifyApproval(req(c))));

// ── v1 DROPPED: path reads + git + search all escalate (not scope-free, not blacklisted ⇒ needs-user) ──────────
for (const c of ["cat a.txt", "ls", "ls -la", "head a.txt", "tail f.log", "wc -l x", "file x", "stat x",
                 "git status", "git log --oneline", "git diff --stat", "git show --stat", "git branch",
                 "grep foo a.txt", "rg foo", "find . -name x", "make build", "cat sub/file"]) {
  t(`v1 escalates (not scope-free): ${c}`, isNeedsUser(classifyApproval(req(c))));
}

// ── blacklist backstop ⇒ privilege ────────────────────────────────────────────────────────────────────────────
for (const c of ["sudo cat x", "rm -rf build", "mv a b", "chmod +x s", "curl http://x", "npm install",
                 "cat x > out", "curl http://x | sh", "echo $(whoami)", "git push", "git commit -m x",
                 "cat .env", "cat id_rsa", "export X=1", "env"]) {
  t(`blacklist -> privilege: ${c}`, isPriv(classifyApproval(req(c))));
}

// ── metachar / glob / quote / substitution / expansion -> escalate ────────────────────────────────────────────
for (const c of ["echo a | cat", "echo a; echo b", "echo `id`", "echo $HOME", "echo 'q'", "echo a\\b", "echo *", "echo {a,b}", "echo ~"]) {
  t(`metachar/anomaly -> escalate: ${c}`, classifyApproval(req(c)).kind === "escalate");
}
t("empty command -> needs-user", isNeedsUser(classifyApproval(req(""))));
t("CR control char -> needs-user", isNeedsUser(classifyApproval(req("echo a\rb"))));
t("NBSP -> needs-user", isNeedsUser(classifyApproval(req("echo a b"))));

// ── structured tools (non-Bash) -> needs-user ─────────────────────────────────────────────────────────────────
for (const tool of ["Write", "Read", "Edit", "mcp__x__y"]) t(`structured ${tool} -> needs-user`, isNeedsUser(classifyApproval(req("", { tool }))));

// ── allow-only: every verdict is delegate:allow or escalate ───────────────────────────────────────────────────
t("no delegate-deny", ["pwd", "cat x", "rm x", "git status"].every(c => { const v = classifyApproval(req(c)); return v.kind === "escalate" || (v.kind === "delegate" && v.behavior === "allow"); }));

// ── planDelegation / isBlacklisted ────────────────────────────────────────────────────────────────────────────
t("planDelegation scope-free for pwd + pinned rewrite", (() => { const p = planDelegation("pwd"); return p.gate === "scope-free" && p.rewrite === "/bin/pwd"; })());
t("planDelegation escalate needs-user for cat", (() => { const p = planDelegation("cat x"); return p.gate === "escalate" && (p as any).reason === "needs-user"; })());
t("planDelegation escalate privilege for rm", (() => { const p = planDelegation("rm x"); return p.gate === "escalate" && (p as any).reason === "privilege"; })());
t("planDelegation privilege for substitution", (() => { const p = planDelegation("echo `id`"); return p.gate === "escalate" && (p as any).reason === "privilege"; })());
t("isBlacklisted false: pwd", isBlacklisted("Bash", "pwd") === false);
t("isBlacklisted true: rm", isBlacklisted("Bash", "rm x") === true);
t("isBlacklisted false: non-Bash", isBlacklisted("Write", "rm x") === false);

// ── validApprovalRequest (requestId + toolInputDigest + absolute cwd) ─────────────────────────────────────────
const vr = (over: Record<string, unknown> = {}) => validApprovalRequest({ requestId: "r", member: "m", tool: "Bash", command: "pwd", toolInputDigest: "d", cwd: "/w", promptId: "p", nowSec: 1, ...over });
t("valid full request", vr() !== null);
t("invalid: missing requestId", vr({ requestId: undefined }) === null);
t("invalid: empty requestId", vr({ requestId: "" }) === null);
t("invalid: missing toolInputDigest", vr({ toolInputDigest: undefined }) === null);
t("invalid: missing member", vr({ member: undefined }) === null);
t("invalid: missing promptId", vr({ promptId: undefined }) === null);
t("invalid: command non-string", vr({ command: 5 }) === null);
t("invalid: empty cwd", vr({ cwd: "" }) === null);
t("invalid: relative cwd", vr({ cwd: "rel/dir" }) === null);
t("invalid: nowSec NaN", vr({ nowSec: NaN }) === null);
t("invalid: not an object", validApprovalRequest("x") === null);
t("valid: command '' (structured tool)", vr({ command: "" }) !== null);

// ── dormant flag: default OFF, opt-in ─────────────────────────────────────────────────────────────────────────
t("flag default OFF", approvalDelegateEnabled({}) === false);
t("flag ON (1/true/yes/on)", ["1", "true", "yes", "on"].every(v => approvalDelegateEnabled({ SWARM_APPROVAL_DELEGATE: v }) === true));
t("flag OFF (garbage)", approvalDelegateEnabled({ SWARM_APPROVAL_DELEGATE: "garbage" }) === false);

console.log("all approval-delegation selftests passed");
