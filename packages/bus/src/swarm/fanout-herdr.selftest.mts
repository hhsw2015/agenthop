// Selftest for the pure fanout VISIBLE-backend (herdr chain) layer. The IO state machine is thin glue over these.
//   npx tsx packages/bus/src/swarm/fanout-herdr.selftest.mts
import {
  buildPaneRead, buildPaneRun, buildPaneSplitIn, buildPaneWaitOutput, buildWorkspaceClose, buildWorkspaceCreate,
  buildWorkspaceRename, doneMarker, paneIdFromSplit, unitCommand, workspaceFromCreate,
} from "./fanout-herdr.js";
import { shquote } from "../spawn.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

// --- argv builders ---
{
  t("workspace create", buildWorkspaceCreate().join(" ") === "workspace create");
  t("workspace rename", buildWorkspaceRename("w9", "fanout-r1").join(" ") === "workspace rename w9 fanout-r1");
  t("workspace close (single zone, not --group)", buildWorkspaceClose("w9").join(" ") === "workspace close w9");
  t("pane split targets a pane, right, no-focus", buildPaneSplitIn("w1:p1", "/w").join(" ") === "pane split w1:p1 --direction right --cwd /w --no-focus");
  t("pane run carries the command as one arg", (() => { const a = buildPaneRun("w1:p2", "echo hi; echo done"); return a.length === 4 && a[3] === "echo hi; echo done"; })());
  t("pane wait-output match + timeout", buildPaneWaitOutput("w1:p2", "FANOUT_DONE_x", 120000).join(" ") === "pane wait-output w1:p2 --match FANOUT_DONE_x --timeout 120000");
  t("pane read recent-unwrapped", buildPaneRead("w1:p2").join(" ") === "pane read w1:p2 --source recent-unwrapped --lines 120");
}

// --- receipt parsers ---
{
  const created = workspaceFromCreate({ result: { workspace: { id: "w9" }, root_pane: { pane_id: "w9:p1" }, tab: { id: "w9:t1" } } });
  t("workspaceFromCreate extracts ids", created?.workspaceId === "w9" && created?.rootPaneId === "w9:p1" && created?.tabId === "w9:t1");
  t("workspaceFromCreate null on missing root_pane", workspaceFromCreate({ result: { workspace: { id: "w9" } } }) === null);
  t("workspaceFromCreate null on garbage", workspaceFromCreate({}) === null);
  t("paneIdFromSplit extracts", paneIdFromSplit({ result: { pane: { pane_id: "w9:p2" } } }) === "w9:p2");
  t("paneIdFromSplit null on missing", paneIdFromSplit({ result: {} }) === null);
}

// --- unit command (tier-model explicit; F41 single atomic command) ---
{
  t("doneMarker format", doneMarker("k1") === "FANOUT_DONE_k1");
  const cmd = unitCommand({ bin: "claude", model: "claude-haiku-5-5", prompt: "scan the repo", outputFile: "/t/out.log", key: "k1", childDepth: 1 });
  t("command carries FANOUT_DEPTH to the child (FN6 visible depth)", cmd.startsWith("FANOUT_DEPTH=1 "));
  t("command sets the tier-model on the command line", cmd.includes(`--model ${shquote("claude-haiku-5-5")}`));
  t("command passes the prompt via -p, shell-quoted", cmd.includes(`-p ${shquote("scan the repo")}`));
  t("command redirects all output to the harvest file", cmd.includes(`> ${shquote("/t/out.log")} 2>&1`));
  t("command captures the real exit code to the rc sidecar (FN8 for visible)", cmd.includes(`echo $? > ${shquote("/t/out.log.rc")}`));
  t("command echoes the completion marker last", cmd.trim().endsWith(`echo ${shquote("FANOUT_DONE_k1")}`));
  t("default extra args skip permissions", cmd.includes("--dangerously-skip-permissions"));
  // F41 char-swallow defense: a prompt with quotes/semicolons stays ONE safe command (shquote escapes it),
  // run atomically by `pane run` — not typed character-by-character via send-text.
  const tricky = unitCommand({ bin: "claude", model: "m", prompt: `a'; rm -rf /; echo '`, outputFile: "/t/o", key: "k2", childDepth: 1 });
  t("a prompt with quotes/semicolons is shell-quoted, not injected", tricky.includes(`-p ${shquote(`a'; rm -rf /; echo '`)}`));
  t("the tricky command is a single line (no raw newline)", !tricky.includes("\n"));
  // override extra args (e.g. a different tool/flags)
  const custom = unitCommand({ bin: "codex", model: "m", prompt: "p", outputFile: "/o", key: "k", childDepth: 2, extraArgs: ["exec", "--yolo"] });
  t("extraArgs override is honored", custom.includes(`codex --model ${shquote("m")} exec --yolo -p`));
}

console.log("all fanout-herdr selftests passed");
