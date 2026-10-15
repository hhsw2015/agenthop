// `agenthop hook subagent` (#1057): a bare Claude Code TUI seat's SubagentStart / SubagentStop / PermissionRequest hook ⇒ one fyi
// to the PARENT seat's durable inbox (parent = SWARM_PARENT_SID only; a bad/unknown parent is refused, never a new orphan box) +
// OSC 777 on PermissionRequest. Loaded by bin.ts before the rest of the CLI. ALWAYS exits 0: a hook must never block the seat.
import { homedir } from "node:os";
import { readStdinJson } from "./stdin-json.js";
import { runSubagentHook, writeOsc777, appendHookLog, defaultHookLogPath } from "./subagent-hook.js";

try {
  const home = process.env.AH_HOME || homedir();
  const logFile = process.env.AGENTHOP_SUBAGENT_HOOK_LOG || defaultHookLogPath(home);
  runSubagentHook(await readStdinJson(), {
    home, env: process.env, nowSec: () => Math.floor(Date.now() / 1000),
    osc777: (t, b) => writeOsc777(process.env, t, b),
    log: (line) => appendHookLog(logFile, line),
  });
} catch { /* never break the agent */ }
process.exitCode = 0;
