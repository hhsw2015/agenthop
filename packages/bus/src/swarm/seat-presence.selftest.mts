/**
 * seat-presence selftest (#1053). Pure resolver over ps fixtures shaped like the live tree (2026-10-15):
 *   tern acp claude --resume <sid>  →  node …/Tern/agents/…  →  claude --output-format stream-json … --resume=<sid>
 *   tern acp codex --resume <sid>   →  node …/@agentclientprotocol/codex-acp/dist/…  →  codex app-server
 * plus the writer's keep / replace / refuse rules.  Run: node_modules/.bin/tsx packages/bus/src/swarm/seat-presence.selftest.mts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePs, resolveAgentPid, writePresence } from "./seat-presence.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const A = "90b58f9c-5bac-4318-a996-2373c179d674";
const B = "f32a0507-27bd-47d2-adea-9f30b87612ae";
const C = "01a13284-d361-74a0-a026-ad56f1fdf355";
const PS = [
  ` 2935 14473 /Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${A} --mode bypassPermissions`,
  ` 4122  2935 /Users/x/.nvm/versions/node/v20/bin/node /Users/x/Library/Application Support/Tern/agents/claude/index.js`,
  ` 4158  4122 /Users/x/.local/share/claude/versions/2.1.293 --output-format stream-json --verbose --input-format stream-json --resume=${A} --tools=default`,
  ` 4200  4158 /bin/zsh -c npm test`,
  ` 2936 14473 /Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${B}`,
  ` 4121  2936 node /x/Tern/agents/claude/index.js`,
  ` 4152  4121 claude --output-format stream-json --resume ${B}`,
  `21477 14473 /Applications/Tern.app/Contents/MacOS/tern acp codex --resume ${C}`,
  `21490 21477 /usr/local/bin/node /x/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
  `21495 21490 codex app-server`,
  `21496 21477 tail -f /tmp/codex.log`,
].join("\n");
const rows = parsePs(PS);

t("parsePs: pid/ppid/argv", rows.length === 11 && rows[2]!.pid === 4158 && rows[2]!.ppid === 4122)
t("claude: --resume=<sid> two levels down, argv[0] a versioned native path (basename is not 'claude')", resolveAgentPid(2935, A, "claude", rows) === 4158)
t("claude: --resume <sid> as two arguments", resolveAgentPid(2936, B, "claude", rows) === 4152)
t("claude: the sid must match (another seat's root never resolves to this sid)", resolveAgentPid(2936, A, "claude", rows) === null)
t("claude: a descendant without stream-json (a shell the agent ran) is never the agent", resolveAgentPid(4158, A, "claude", rows) === null)
t("codex: the direct node child naming the codex-acp adapter; a mere 'codex' mention (tail -f) is not proof", resolveAgentPid(21477, C, "codex", rows) === 21490)
{
  const dup = parsePs(PS + `\n 4999  4122 claude --output-format stream-json --resume=${A}`);
  t("claude: TWO candidates ⇒ null (never guess)", resolveAgentPid(2935, A, "claude", dup) === null)
  const noAdapter = rows.filter((r) => r.pid !== 21490);
  t("codex: no adapter child ⇒ null", resolveAgentPid(21477, C, "codex", noAdapter) === null)
  const decoy = parsePs(PS + `\n21497 21477 node /tmp/watch-codex.js --log /tmp/codex.log`);
  t("codex: a node child that merely mentions codex is not the adapter (still exactly the adapter)", resolveAgentPid(21477, C, "codex", decoy) === 21490)
}

// ---- writer ----
const home = mkdtempSync(path.join(os.tmpdir(), "sp-"));
const f = path.join(home, ".agenthop", "presence", `${A}.pid`);
const alive = (p: number) => p !== 666;
t("write: absent ⇒ wrote", writePresence(home, A, 4158, alive).state === "wrote" && readFileSync(f, "utf8") === "4158")
t("write: same live pid ⇒ kept", writePresence(home, A, 4158, alive).state === "kept")
{
  const r = writePresence(home, A, 4170, alive);
  t("write: a DIFFERENT pid already there ⇒ replaced, was reported", r.state === "wrote" && r.was === 4158 && readFileSync(f, "utf8") === "4170")
}
t("write: the resolved pid must be alive", writePresence(home, A, 666, alive).state === "refused" && readFileSync(f, "utf8") === "4170")
t("write: an invalid sid is refused before any path", writePresence(home, "../x", 4158, alive).state === "refused")
writeFileSync(f, "garbage");
t("write: an existing non-pid file ⇒ refused, NOT overwritten", writePresence(home, A, 4158, alive).state === "refused" && readFileSync(f, "utf8") === "garbage")
writeFileSync(f, "4170"); chmodSync(f, 0o000);
const ro = writePresence(home, A, 4158, alive);
chmodSync(f, 0o600);
t("write: an existing UNREADABLE file ⇒ refused (FC-2), not overwritten", ro.state === "refused" && readFileSync(f, "utf8") === "4170")
t("write: no temp files left behind", readdirSync(path.dirname(f)).every((n) => !n.includes(".tmp-")))
void mkdirSync;

console.log("all seat-presence selftests passed");
