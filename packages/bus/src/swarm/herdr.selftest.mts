// Selftest for the pure herdr backend core. Kept OUT of herdr.ts (msglog P1 lesson); IO wrappers are exercised
// by live runs, not here.  npx tsx packages/bus/src/swarm/herdr.selftest.mts
import {
  WHITELIST_V1, buildAgentPrompt, buildAgentRead, buildAgentStart, buildAgentWait, buildApprovalDoc, buildPaneSplit,
  buildSendKeys, herdrAgentName, herdrSpawnable, sentinelDecision, splitCommand, stripTui,
} from "./herdr.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

// --- detection gate: spawn/resume backend needs HERDR_ENV=1 AND a pane id ---
{
  t("spawnable needs HERDR_ENV=1 + HERDR_PANE_ID", herdrSpawnable({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as any) === true);
  t("no HERDR_ENV -> not spawnable", herdrSpawnable({ HERDR_PANE_ID: "w1:p1" } as any) === false);
  t("HERDR_ENV but no pane id -> not spawnable", herdrSpawnable({ HERDR_ENV: "1" } as any) === false);
  t("empty env -> not spawnable", herdrSpawnable({} as any) === false);
}

// --- agent name sanitation: [a-z][a-z0-9_-]{0,31}, unique ---
{
  t("uppercase + spaces -> slug", herdrAgentName("Work-20cab0a5 Viz") === "work-20cab0a5-viz");
  t("leading non-alpha stripped", herdrAgentName("90b58f9c") === "b58f9c" || /^[a-z]/.test(herdrAgentName("90b58f9c")));
  t("empty -> agent", herdrAgentName("") === "agent");
  t("<=32 chars", herdrAgentName("x".repeat(99).replace(/x/g, "a")).length <= 32);
  t("uniqueness suffix", herdrAgentName("rev", new Set(["rev"])) === "rev-1");
  t("uniqueness skips taken", herdrAgentName("rev", new Set(["rev", "rev-1"])) === "rev-2");
}

// --- splitCommand: full command -> {kind, args} for `agent start -- <args>` ---
{
  const a = splitCommand("claude --dangerously-skip-permissions --model 'opus' --resume SID");
  t("claude kind", a.kind === "claude");
  t("claude args after kind", a.args.join(" ") === "--dangerously-skip-permissions --model 'opus' --resume SID");
  const c = splitCommand("codex resume SID");
  t("codex kind + resume subcommand as args", c.kind === "codex" && c.args.join(" ") === "resume SID");
  t("empty -> empty kind", splitCommand("").kind === "");
  // the canon resume cmd quotes the model for the shell; herdr (execFile, no shell) must get it UNquoted
  const q = splitCommand("claude --dangerously-skip-permissions --model 'claude-opus-5-5[1m]' --effort xhigh --resume SID");
  t("surrounding shell quotes stripped for execFile", q.args.includes("claude-opus-5-5[1m]") && !q.args.some((a) => a.includes("'")));
}

// --- argv builders ---
{
  t("pane split preserves cwd + no-focus", buildPaneSplit("/w/x").join(" ") === "pane split --current --direction right --cwd /w/x --no-focus");
  t("agent start with args after --", buildAgentStart("rev", "claude", "w1:p2", ["--resume", "S"]).join(" ") === "agent start rev --kind claude --pane w1:p2 -- --resume S");
  t("agent start no args -> no trailing --", buildAgentStart("rev", "codex", "w1:p2").join(" ") === "agent start rev --kind codex --pane w1:p2");
  t("agent start timeout", buildAgentStart("r", "claude", "p", [], 30000).includes("--timeout"));
  t("prompt --wait --until (multi) --timeout", buildAgentPrompt("rev", "hi", { wait: true, until: ["blocked", "idle"], timeoutMs: 60000 }).join(" ") === "agent prompt rev hi --wait --until blocked --until idle --timeout 60000");
  t("prompt bare", buildAgentPrompt("rev", "hi").join(" ") === "agent prompt rev hi");
  t("wait builder", buildAgentWait("rev", ["blocked"], 5000).join(" ") === "agent wait rev --until blocked --timeout 5000");
  t("read builder default recent-unwrapped", buildAgentRead("rev").join(" ") === "agent read rev --source recent-unwrapped");
  t("send-keys builder", buildSendKeys("rev", ["Enter"]).join(" ") === "agent send-keys rev Enter");
}

// --- stripTui: drop the chrome, keep content (verified-live noise shapes) ---
{
  const raw = ["The answer is 42.", "", "  Worked for 5s • 2:02 PM", "› Ask Codex to do anything", "  GPT-6-Astra xhigh · Context 99% left · 828K window", "  ← for agents · ? for shortcuts", "  ⚠ 2 warnings · f2 to view"].join("\n");
  const clean = stripTui(raw);
  t("keeps real content", clean.includes("The answer is 42."));
  t("drops 'Worked for'", !/Worked for/.test(clean));
  t("drops input box", !/Ask Codex/.test(clean));
  t("drops status line", !/Context 99% left/.test(clean));
  t("drops shortcuts + warnings", !/for shortcuts/.test(clean) && !/warning/.test(clean));
}

// --- sentinel classifier: whitelist auto-clear vs escalate (the HARD boundary) ---
{
  const dir = sentinelDecision("Do you trust the files in this folder?\n> Yes  No");
  t("dir-trust -> auto-clear with Enter", dir.action === "auto-clear" && dir.ruleId === "dir-trust" && dir.keys?.join("") === "Enter");
  const hook = sentinelDecision("Allow this hook to run? trust hooks");
  t("hook-trust -> auto-clear", hook.action === "auto-clear" && hook.ruleId === "hook-trust");
  const danger = sentinelDecision("Run `rm -rf /` ? This will delete everything. [y/N]");
  t("non-whitelist (dangerous) -> escalate, never auto-answer", danger.action === "escalate" && !danger.keys);
  const generic = sentinelDecision("The model wants to push to main. Approve? [y/n]");
  t("generic approval -> escalate", generic.action === "escalate");
  t("whitelist v1 is narrow (2 rules)", WHITELIST_V1.length === 2);
}

// --- buildApprovalDoc: reuse S19 7-field format, taskRef=approval, options+consequences ---
{
  const { file, body } = buildApprovalDoc({
    from: "90b58f9c-5bac", fromLabel: "90b58f9c", coordinatorId: "fe0376cd", nowSec: 1000,
    member: "Work-1", screenSummary: "push to main?", options: [{ label: "approve", consequence: "merges" }, { label: "deny", consequence: "stays open" }], recommend: "deny",
  });
  t("approval taskRef", body.taskRef === "approval");
  t("7 fields present", ["from", "fromLabel", "via", "ts", "taskRef", "title", "text"].every((k) => k in body));
  t("options + consequences in text", String(body.text).includes("approve → merges") && String(body.text).includes("deny → stays open"));
  t("recommendation present but labeled advisory", String(body.text).includes("建议") && String(body.text).includes("裁决出自你"));
  t("filename shape", file === "1000-approval-Work-1-from-90b58f9c.json");
}

console.log("all herdr selftests passed");
