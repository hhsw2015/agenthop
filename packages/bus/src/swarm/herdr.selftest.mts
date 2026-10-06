// Selftest for the pure herdr backend core (rev2, first-review fixes). IO wrappers exercised by live runs.
//   npx tsx packages/bus/src/swarm/herdr.selftest.mts
import {
  HARD_NOT_STARTED, WHITELIST_V1, buildAgentRead, buildAgentStart, buildAgentSubmit, buildAgentWait,
  buildApprovalDoc, buildPaneClose, buildPaneSplit, buildSendKeys, classifyStart, currentPromptRegion,
  hasExplicitBinary, herdrAgentName, herdrSpawnable, paneIdFromSplit, sentinelDecision, shellTokenize,
  splitCommand, startedName, stripTui,
} from "./herdr.js";
import { validInboxMsg } from "../inbox.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

// --- detection gates ---
{
  t("spawnable needs HERDR_ENV=1 + HERDR_PANE_ID", herdrSpawnable({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as any) === true);
  t("no pane id -> not spawnable", herdrSpawnable({ HERDR_ENV: "1" } as any) === false);
  // H-P2-3: explicit binary override -> herdr must step aside
  t("AGENTHOP_SPAWN_BIN_CODEX -> explicit binary", hasExplicitBinary("codex", { AGENTHOP_SPAWN_BIN_CODEX: "/x/codex" } as any) === true);
  t("ALLOW_CMD -> explicit binary", hasExplicitBinary("claude", { AGENTHOP_SPAWN_ALLOW_CMD: "1" } as any) === true);
  t("no override -> not explicit", hasExplicitBinary("claude", {} as any) === false);
}

// --- name sanitation ---
{
  t("slug + unique suffix", herdrAgentName("Work Viz", new Set(["work-viz"])) === "work-viz-1");
  t("empty -> agent", herdrAgentName("") === "agent");
}

// --- H-P2-4: quote-aware tokenizer preserves spaced args ---
{
  t("quoted spaced arg stays one token", shellTokenize(`codex --config "model_reasoning_effort = 'xhigh'" resume s`).length === 5);
  t("quoted value content preserved (spaces kept, quotes stripped)", shellTokenize(`a --c "x = 'y'"`)[2] === "x = 'y'");
  const canon = splitCommand("claude --dangerously-skip-permissions --model 'claude-opus-5-5[1m]' --resume SID");
  t("canon: model unquoted, balanced", canon.kind === "claude" && canon.args.includes("claude-opus-5-5[1m]") && canon.balanced);
  const spaced = splitCommand(`codex --config "model_reasoning_effort = 'xhigh'" resume sid`);
  t("spaced config stays ONE arg (H-P2-4)", spaced.args[0] === "--config" && spaced.args[1] === "model_reasoning_effort = 'xhigh'" && spaced.args[2] === "resume");
  t("unbalanced quotes flagged (caller refuses herdr)", splitCommand(`codex --config "oops`).balanced === false);
  t("balanced canon flagged balanced", splitCommand("codex resume sid").balanced === true);
}

// --- argv builders ---
{
  t("pane split", buildPaneSplit("/w").join(" ") === "pane split --current --direction right --cwd /w --no-focus");
  t("agent start args after --", buildAgentStart("r", "claude", "w1:p2", ["--resume", "S"]).join(" ") === "agent start r --kind claude --pane w1:p2 -- --resume S");
  t("agent submit (no --wait; submit/wait separated)", buildAgentSubmit("r", "hi").join(" ") === "agent prompt r hi");
  t("agent wait explicit timeout", buildAgentWait("r", ["idle", "done"], 120000).join(" ") === "agent wait r --until idle --until done --timeout 120000");
  t("agent read default source", buildAgentRead("r").join(" ") === "agent read r --source recent-unwrapped");
  t("send-keys", buildSendKeys("r", ["Enter"]).join(" ") === "agent send-keys r Enter");
  t("pane close", buildPaneClose("w1:p2").join(" ") === "pane close w1:p2");
}

// --- H-P2-6: receipt validation (no fabricated success) ---
{
  t("pane id from split", paneIdFromSplit({ result: { pane: { pane_id: "w1:p3" } } }) === "w1:p3");
  t("no pane id -> null", paneIdFromSplit({ result: {} }) === null);
  t("valid agent_started for name", startedName({ result: { type: "agent_started", agent: { name: "rev" } } }, "rev") === "rev");
  t("wrong name -> null", startedName({ result: { type: "agent_started", agent: { name: "other" } } }, "rev") === null);
  t("wrong type -> null", startedName({ result: { type: "agent_released" } }, "rev") === null);
  t("empty -> null", startedName(null, "rev") === null);
}

// --- H-P2-2: start classification (started / not-started / unconfirmed) ---
{
  t("valid receipt -> started", classifyStart({ result: { type: "agent_started", agent: { name: "r" } } }, "r", false).state === "started");
  t("name_in_use -> not-started (clean + fallback)", classifyStart({ error: { code: "name_in_use" } }, "r", true).state === "not-started");
  t("unknown_kind -> not-started", classifyStart({ error: { code: "unknown_kind" } }, "r", true).state === "not-started");
  t("agent_not_ready -> unconfirmed (keep, no re-launch)", classifyStart({ error: { code: "agent_not_ready" } }, "r", true).state === "unconfirmed");
  t("empty output -> unconfirmed", classifyStart(null, "r", false).state === "unconfirmed");
  t("wrong receipt type -> unconfirmed", classifyStart({ result: { type: "agent_released" } }, "r", false).state === "unconfirmed");
  t("unrecognized error code -> unconfirmed (never prove not-started)", classifyStart({ error: { code: "weird_new_code" } }, "r", true).state === "unconfirmed");
  t("HARD_NOT_STARTED is a narrow set", HARD_NOT_STARTED.has("name_in_use") && !HARD_NOT_STARTED.has("agent_not_ready"));
}

// --- H-P1-1: current-prompt region + full-form whitelist; the four counterexamples MUST escalate ---
{
  // positives: the real mechanical prompts auto-clear
  t("real dir-trust -> auto-clear", sentinelDecision("Do you trust the files in this folder?\n> 1. Yes, proceed\n  2. No").action === "auto-clear");
  t("real hook-trust -> auto-clear", sentinelDecision("Trust the hooks in this directory to run?\n> Yes / No").action === "auto-clear");
  // the four review counterexamples
  t("CE1 deployment-not-mechanical -> escalate", sentinelDecision("Do you trust this deployment to delete the production database? [y/N]").action === "escalate");
  t("CE2 webhook substring -> escalate", sentinelDecision("Allow this webhook to transfer $5000? [y/N]").action === "escalate");
  const stale = ["Do you trust the files in this folder?", "> Yes (answered)", ...Array(14).fill("build log line"), "Push to main and deploy to prod? [y/N]"].join("\n");
  t("CE3 stale trust in history, current=push -> escalate", sentinelDecision(stale).action === "escalate");
  const quoted = ["tool output: the agent said \"trust this directory\" earlier", "Delete all backups now? [y/N]"].join("\n");
  t("CE4 quoted trust in tool output, current=delete -> escalate", sentinelDecision(quoted).action === "escalate");
  // region is the tail only
  t("currentPromptRegion takes the tail", !currentPromptRegion(stale).includes("trust the files"));
}

// --- H-P2-1: approval envelope is a VALID InboxMsg (via local), roundtrips through the real validator ---
{
  const { file, body } = buildApprovalDoc({
    from: "90b58f9c-5bac", fromLabel: "90b58f9c", nowSec: 1000,
    member: "Work-1", screenSummary: "push to main?", options: [{ label: "approve", consequence: "merges" }, { label: "deny", consequence: "stays open" }], recommend: "deny",
  });
  t("via is local (not durable-inbox)", body.via === "local");
  t("passes the REAL validInboxMsg (H-P2-1 roundtrip)", validInboxMsg(body) !== null);
  t("validator preserves taskRef + title", (() => { const v = validInboxMsg(body)!; return v.taskRef === "approval" && !!v.title; })());
  t("options + consequences + advisory recommend in text", body.text.includes("approve → merges") && body.text.includes("deny → stays open") && body.text.includes("裁决出自你"));
  t("filename shape", file === "1000-approval-Work-1-from-90b58f9c.json");
}

// --- stripTui keeps content, drops chrome ---
{
  const clean = stripTui(["The answer is 42.", "  Worked for 5s • 2:02 PM", "› Ask Codex to do anything"].join("\n"));
  t("keeps content, drops chrome", clean.includes("42.") && !/Worked for|Ask Codex/.test(clean));
}

console.log("all herdr selftests passed");
