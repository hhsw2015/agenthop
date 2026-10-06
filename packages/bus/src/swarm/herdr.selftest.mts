// Selftest for the pure herdr backend core (rev3). IO wrappers are exercised by live runs.
//   npx tsx packages/bus/src/swarm/herdr.selftest.mts
import {
  HARD_NOT_STARTED, SUBMIT_REJECTED, WAIT_SETTLE_TYPES, WHITELIST_V1, agentPaneId, buildAgentGet,
  buildAgentPromptWait, buildAgentRead, buildAgentStart, buildAgentSubmit, buildAgentWait, buildApprovalDoc,
  buildPaneClose, buildPaneSplit, buildSendKeys, classifyStart, classifySubmit, hasExplicitBinary,
  herdrAgentName, herdrSpawnable, paneBound, paneIdFromSplit, scanCommand, sentinelDecision, settledFrom,
  shellTokenize, splitCommand, startedName, stripTui,
} from "./herdr.js";
import { validInboxMsg } from "../inbox.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

// --- detection gates ---
{
  t("spawnable needs HERDR_ENV=1 + HERDR_PANE_ID", herdrSpawnable({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as any) === true);
  t("no pane id -> not spawnable", herdrSpawnable({ HERDR_ENV: "1" } as any) === false);
  t("AGENTHOP_SPAWN_BIN_CODEX -> explicit binary", hasExplicitBinary("codex", { AGENTHOP_SPAWN_BIN_CODEX: "/x/codex" } as any) === true);
  t("ALLOW_CMD -> explicit binary", hasExplicitBinary("claude", { AGENTHOP_SPAWN_ALLOW_CMD: "1" } as any) === true);
  t("no override -> not explicit", hasExplicitBinary("claude", {} as any) === false);
}

// --- name sanitation ---
{
  t("slug + unique suffix", herdrAgentName("Work Viz", new Set(["work-viz"])) === "work-viz-1");
  t("empty -> agent", herdrAgentName("") === "agent");
}

// --- R2-P2-2: escape/quote-aware tokenizer (the indexOf version was gamed by escaped quotes) ---
{
  t("quoted spaced arg stays one token", shellTokenize(`codex --config "model_reasoning_effort = 'xhigh'" resume s`).length === 5);
  t("quoted value content preserved (spaces kept, quotes stripped)", shellTokenize(`a --c "x = 'y'"`)[2] === "x = 'y'");
  const canon = splitCommand("claude --dangerously-skip-permissions --model 'claude-opus-5-5[1m]' --resume SID");
  t("canon: model unquoted, balanced", canon.kind === "claude" && canon.args.includes("claude-opus-5-5[1m]") && canon.balanced);
  const spaced = splitCommand(`codex --config "model_reasoning_effort = 'xhigh'" resume sid`);
  t("spaced config stays ONE arg", spaced.args[0] === "--config" && spaced.args[1] === "model_reasoning_effort = 'xhigh'" && spaced.args[2] === "resume");
  t("unbalanced quotes flagged (caller refuses herdr)", splitCommand(`codex --config "oops`).balanced === false);
  t("balanced canon flagged balanced", splitCommand("codex resume sid").balanced === true);
  // escape handling (the real R2-P2-2 bug): an escaped double-quote inside a double-quoted run is LITERAL and must
  // NOT toggle the quote state — otherwise the space after it would wrongly split the arg.
  const esc = scanCommand(String.raw`a "x\"y z"`);
  t("escaped quote inside double stays literal, space kept", esc.tokens.length === 2 && esc.tokens[1] === `x"y z` && esc.balanced);
  t("single-quoted content is literal (backslash kept)", scanCommand(String.raw`a 'x\y'`).tokens[1] === String.raw`x\y`);
  t("backslash escapes a bare space into one token", (() => { const r = scanCommand(String.raw`a b\ c`); return r.tokens.length === 2 && r.tokens[1] === "b c"; })());
  t("dangling trailing escape -> not balanced (refuse herdr)", scanCommand("a b\\").balanced === false);
}

// --- argv builders ---
{
  t("pane split", buildPaneSplit("/w").join(" ") === "pane split --current --direction right --cwd /w --no-focus");
  t("agent start args after --", buildAgentStart("r", "claude", "w1:p2", ["--resume", "S"]).join(" ") === "agent start r --kind claude --pane w1:p2 -- --resume S");
  t("agent submit (no --wait)", buildAgentSubmit("r", "hi").join(" ") === "agent prompt r hi");
  t("agent prompt --wait (native activity gate, R2-P2-4)", buildAgentPromptWait("r", "hi", 120000).join(" ") === "agent prompt r hi --wait --timeout 120000");
  t("agent get (pane-bind lookup, R2-P2-5)", buildAgentGet("r").join(" ") === "agent get r");
  t("agent wait explicit timeout", buildAgentWait("r", ["idle", "done"], 120000).join(" ") === "agent wait r --until idle --until done --timeout 120000");
  t("agent read default source", buildAgentRead("r").join(" ") === "agent read r --source recent-unwrapped");
  t("send-keys", buildSendKeys("r", ["Enter"]).join(" ") === "agent send-keys r Enter");
  t("pane close", buildPaneClose("w1:p2").join(" ") === "pane close w1:p2");
}

// --- receipt validation + R2-P2-5 pane binding (no fabricated success) ---
{
  t("pane id from split", paneIdFromSplit({ result: { pane: { pane_id: "w1:p3" } } }) === "w1:p3");
  t("no pane id -> null", paneIdFromSplit({ result: {} }) === null);
  t("valid agent_started for name", startedName({ result: { type: "agent_started", agent: { name: "rev" } } }, "rev") === "rev");
  t("wrong name -> null", startedName({ result: { type: "agent_started", agent: { name: "other" } } }, "rev") === null);
  t("wrong type -> null", startedName({ result: { type: "agent_released" } }, "rev") === null);
  // agentPaneId tolerates the likely herdr shapes; paneBound is the ownership-at-launch proof
  t("agentPaneId from agent.pane_id", agentPaneId({ result: { agent: { pane_id: "w1:p2" } } }) === "w1:p2");
  t("agentPaneId from result.pane_id", agentPaneId({ result: { pane_id: "w1:p5" } }) === "w1:p5");
  t("agentPaneId absent -> null", agentPaneId({ result: {} }) === null);
  t("paneBound true when pane matches", paneBound({ result: { agent: { pane_id: "w1:p2" } } }, "w1:p2") === true);
  t("paneBound false on wrong pane (same-name reattach -> unconfirmed)", paneBound({ result: { agent: { pane_id: "w1:p9" } } }, "w1:p2") === false);
  t("paneBound false on empty expected pane", paneBound({ result: { agent: { pane_id: "w1:p2" } } }, "") === false);
}

// --- R2-P2-1: start classification uses the REAL installed-binary error codes ---
{
  t("valid receipt -> started", classifyStart({ result: { type: "agent_started", agent: { name: "r" } } }, "r", false).state === "started");
  t("agent_name_taken -> not-started (clean + fallback)", classifyStart({ error: { code: "agent_name_taken" } }, "r", true).state === "not-started");
  t("agent_pane_busy -> not-started", classifyStart({ error: { code: "agent_pane_busy" } }, "r", true).state === "not-started");
  t("agent_pane_not_found -> not-started (live-confirmed code)", classifyStart({ error: { code: "agent_pane_not_found" } }, "r", true).state === "not-started");
  t("agent_not_ready -> unconfirmed (keep, no re-launch)", classifyStart({ error: { code: "agent_not_ready" } }, "r", true).state === "unconfirmed");
  t("empty output -> unconfirmed", classifyStart(null, "r", false).state === "unconfirmed");
  t("wrong receipt type -> unconfirmed", classifyStart({ result: { type: "agent_released" } }, "r", false).state === "unconfirmed");
  t("the OLD guessed code name_in_use is NOT hard -> unconfirmed (regression guard)", classifyStart({ error: { code: "name_in_use" } }, "r", true).state === "unconfirmed");
  t("HARD_NOT_STARTED = real codes only", HARD_NOT_STARTED.has("agent_name_taken") && !HARD_NOT_STARTED.has("name_in_use") && !HARD_NOT_STARTED.has("agent_not_ready"));
}

// --- R2-P2-3/4 + R13-B: submit 3-state with a NARROW reject whitelist; settle needs a VERIFIED --wait type ---
{
  // R4-P2-2 POSITIVE target binding: yes ONLY when the receipt names the exact prompted target; everything short of
  // that (missing shape, wrong/null/absent/empty/non-string name) is insufficient proof -> unknown.
  t("valid agent_prompted bound to the exact target -> yes", classifySubmit({ result: { type: "agent_prompted", agent: { name: "r", pane_id: "w1:p2" } } }, "r", false).submitted === "yes");
  t("agent_prompted for a DIFFERENT agent -> unknown", classifySubmit({ result: { type: "agent_prompted", agent: { name: "other", pane_id: "w1:p2" } } }, "r", false).submitted === "unknown");
  t("agent_prompted NULL name -> unknown (not provably our target)", classifySubmit({ result: { type: "agent_prompted", agent: { name: null, pane_id: "w1:p2" } } }, "r", false).submitted === "unknown");
  t("agent_prompted OMITTED name -> unknown", classifySubmit({ result: { type: "agent_prompted", agent: { pane_id: "w1:p2" } } }, "r", false).submitted === "unknown");
  t("agent_prompted EMPTY-STRING name -> unknown", classifySubmit({ result: { type: "agent_prompted", agent: { name: "", pane_id: "w1:p2" } } }, "r", false).submitted === "unknown");
  t("agent_prompted NON-STRING name (9) -> unknown (can't bypass via typeof)", classifySubmit({ result: { type: "agent_prompted", agent: { name: 9, pane_id: "w1:p2" } } }, "r", false).submitted === "unknown");
  t("agent_prompted MISSING agent object -> unknown (invalid shape)", classifySubmit({ result: { type: "agent_prompted" } }, "r", false).submitted === "unknown");
  t("agent_prompted agent without pane_id -> unknown (invalid shape)", classifySubmit({ result: { type: "agent_prompted", agent: { name: "r" } } }, "r", false).submitted === "unknown");
  t("empty expectedName never yields yes (guard)", classifySubmit({ result: { type: "agent_prompted", agent: { name: "", pane_id: "w1:p2" } } }, "", false).submitted === "unknown");
  t("agent_not_found (whitelisted) -> submitted no", classifySubmit({ error: { code: "agent_not_found" } }, "r", true).submitted === "no");
  t("timeout -> submitted unknown (can post-date submission, R3/R13)", classifySubmit({ error: { code: "timeout" } }, "r", true).submitted === "unknown");
  t("agent_prompt_stalled -> submitted unknown (can post-date submission, R3/R13)", classifySubmit({ error: { code: "agent_prompt_stalled" } }, "r", true).submitted === "unknown");
  t("exec failed, no code -> submitted unknown (never replay)", classifySubmit(null, "r", true).submitted === "unknown");
  t("wrong type -> submitted unknown", classifySubmit({ result: { type: "agent_other" } }, "r", false).submitted === "unknown");
  t("SUBMIT_REJECTED is narrow (only provably-not-submitted codes)", SUBMIT_REJECTED.has("agent_not_found") && !SUBMIT_REJECTED.has("timeout") && !SUBMIT_REJECTED.has("agent_prompt_stalled"));
  // settle: a bare agent_status is NOT proof (agent get returns it too); it needs a VERIFIED --wait receipt type.
  t("prod WAIT_SETTLE_TYPES empty -> settle unknown until live-verified (R13-B)", WAIT_SETTLE_TYPES.size === 0);
  t("bare agent_status, no wait type -> NOT settled (agent get snapshot is not proof)", settledFrom({ result: { agent: { agent_status: "idle" } } }).settled === false);
  const TS = new Set(["agent_wait_settled"]); // a hypothetical verified type, to exercise the positive logic only
  t("verified type + idle -> settled", settledFrom({ result: { type: "agent_wait_settled", agent: { agent_status: "idle" } } }, TS).settled === true);
  t("verified type + working -> NOT settled (still running)", settledFrom({ result: { type: "agent_wait_settled", agent: { agent_status: "working" } } }, TS).settled === false);
  t("verified type MISSING -> NOT settled even with idle", settledFrom({ result: { agent: { agent_status: "idle" } } }, TS).settled === false);
  t("settle extracts status for the note only", settledFrom({ result: { agent: { agent_status: "working" } } }).status === "working");
  t("empty -> status unknown, not settled", (() => { const s = settledFrom({}); return s.settled === false && s.status === "unknown"; })());
}

// --- R2-P1-1: the sentinel ALWAYS escalates (auto-clear disabled; whitelist empty) ---
{
  t("WHITELIST_V1 is empty (R12)", WHITELIST_V1.length === 0);
  t("real dir-trust now escalates (no structured signal)", sentinelDecision("Do you trust the files in this folder?\n> 1. Yes").action === "escalate");
  t("real hook-trust now escalates", sentinelDecision("Trust the hooks in this directory to run?\n> Yes / No").action === "escalate");
  t("CE1 deployment -> escalate", sentinelDecision("Do you trust this deployment to delete the production database? [y/N]").action === "escalate");
  t("CE2 webhook -> escalate", sentinelDecision("Allow this webhook to transfer $5000? [y/N]").action === "escalate");
  t("CE3 stale trust in history, current=push -> escalate", sentinelDecision(["Do you trust the files in this folder?", "Push to main and deploy to prod? [y/N]"].join("\n")).action === "escalate");
  t("CE4 quoted trust in tool output -> escalate", sentinelDecision(['tool output: the agent said "trust this directory"', "Delete all backups now? [y/N]"].join("\n")).action === "escalate");
  t("empty screen -> escalate", sentinelDecision("").action === "escalate");
  t("escalate NEVER carries keys (never synthesizes an answer)", sentinelDecision("anything").keys === undefined);
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
