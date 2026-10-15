// `agenthop hook subagent` — production version of the #1042 spike (docs/research/tui-subagent-visibility-conclusion.md).
// A bare Claude Code TUI seat reports its sub-agents to its PARENT seat's durable inbox:
//   SubagentStart / SubagentStop → one fyi per event (agent_type, agent_id, this seat's session)
//   PermissionRequest            → one fyi, plus OSC 777 to the TUI's own pty (a pane alert for a person looking at Tern)
// The parent comes ONLY from SWARM_PARENT_SID (injected when the seat starts); the hook never guesses a recipient. Delivery goes
// through writeSessionInbox, which refuses a non-UUID or a session with no presence on this machine (no orphan inbox).
// The hook ALWAYS exits 0 and logs every outcome: a dead or missing inbox must never block the seat.
//
// Dedup keys (re-fired hook ⇒ no duplicate):
//   tui-sub-<start|stop>-<seat8>-<agent_id>
//   tui-perm-<seat8>-<tool_use_id>  — Claude Code 2.1.293 sends no tool_use_id for PermissionRequest, so the fallback is the
//                                     event time in SECONDS: at most ONE permission message per seat per second (documented
//                                     ceiling; two requests in the same second collapse into one message).

import { homedir } from "node:os";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeSessionInbox, composeInboxMsg, SessionInboxError, type WriteResult } from "./inbox.js";

export type HookOutcome =
  | { kind: "posted"; result: WriteResult; key: string; parent: string }
  | { kind: "skipped"; why: string }
  | { kind: "refused"; why: string }   // bad / unknown parent (writeSessionInbox refused; nothing created)
  | { kind: "failed"; why: string }
  | { kind: "ignored"; event: string }; // an event this hook does not handle

export interface HookDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  nowSec: () => number;
  /** Write an OSC 777 notification to the TUI's pty; returns where it went, or null when no pty was reachable. */
  osc777: (title: string, body: string) => string | null;
  log: (line: string) => void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Build the dedup key and message for one hook payload (pure). null ⇒ an event this hook ignores. */
export function planHookMessage(payload: Record<string, unknown>, nowSec: number): { event: string; key: string; title: string; text: string } | null {
  const event = str(payload.hook_event_name);
  const seat = str(payload.session_id);
  const seat8 = seat.slice(0, 8) || "noseat";
  if (event === "SubagentStart" || event === "SubagentStop") {
    const phase = event === "SubagentStart" ? "start" : "stop";
    const agentType = str(payload.agent_type) || "?";
    const agentId = str(payload.agent_id) || "noid";
    return {
      event,
      key: `tui-sub-${phase}-${seat8}-${agentId}`,
      title: `sub-agent ${phase}: ${agentType}`,
      text: `[tui sub-agent ${phase}] agent_type=${agentType} agent_id=${agentId} seat_session=${seat}`,
    };
  }
  if (event === "PermissionRequest") {
    const tool = str(payload.tool_name) || "?";
    const tuid = str(payload.tool_use_id) || String(Math.floor(nowSec)); // documented ceiling: one per seat per second
    return {
      event,
      key: `tui-perm-${seat8}-${tuid}`,
      title: `permission request: ${tool}`,
      text: `[tui permission request] tool=${tool} seat_session=${seat} (the seat is waiting for a human answer)`,
    };
  }
  return null;
}

/** Handle one hook payload. Never throws. */
export function runSubagentHook(payload: Record<string, unknown> | undefined, d: HookDeps): HookOutcome {
  const p = payload ?? {};
  const plan = planHookMessage(p, d.nowSec());
  const event = str(p.hook_event_name) || "(no event)";
  const seat8 = str(p.session_id).slice(0, 8);
  const note = (s: string) => { try { d.log(`${new Date(d.nowSec() * 1000).toISOString()}\t${event}\tseat=${seat8}\t${s}`); } catch { /* logging never breaks the hook */ } };
  if (!plan) { note("ignored"); return { kind: "ignored", event }; }
  if (event === "PermissionRequest") {
    let where: string | null = null;
    try { where = d.osc777("Claude needs permission", str(p.tool_name) || "a tool"); } catch { where = null; }
    note(where ? `osc777: ok via ${where}` : "osc777: no pty reachable");
  }
  const parent = (d.env.SWARM_PARENT_SID ?? "").trim();
  if (!parent) { note("inbox: SKIPPED (SWARM_PARENT_SID unset)"); return { kind: "skipped", why: "SWARM_PARENT_SID unset" }; }
  const seat = str(p.session_id);
  const msg = composeInboxMsg({ from: seat || "tui-subagent-hook", fromLabel: `tui-seat:${seat8 || "?"}`, text: plan.text, title: plan.title, intent: "fyi" });
  try {
    const result = writeSessionInbox(d.home, parent, msg, plan.key);
    note(`inbox: ${result} -> ${parent.slice(0, 8)} key=${plan.key}`);
    return { kind: "posted", result, key: plan.key, parent };
  } catch (e) {
    if (e instanceof SessionInboxError) { note(`inbox: REFUSED (${e.message})`); return { kind: "refused", why: e.message }; }
    note(`inbox: FAILED (${(e as Error).message})`);
    return { kind: "failed", why: (e as Error).message };
  }
}

/** The default hook log (one line per event). */
export function defaultHookLogPath(home: string = homedir()): string {
  return path.join(home, ".agenthop", "logs", "subagent-hook.log");
}

export function appendHookLog(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

/** Production OSC writer: only inside a Tern pane (TERN_PANE set), write the OSC 777 to the TUI's pty found via the parent processes.
 *  Returns the pty path written, or null. Never throws. */
export function writeOsc777(env: NodeJS.ProcessEnv, title: string, body: string): string | null {
  if (!env.TERN_PANE) return null;
  const tty = ancestorTty();
  if (!tty) return null;
  try { writeFileSync(tty, osc777Sequence(title, body), { flag: "a" }); return tty; } catch { return null; }
}

/** The TUI's own pty, found by walking up the parent processes to the first one with a terminal. A hook has NO controlling
 *  terminal (#1037: every write to /dev/tty failed), but its ancestors include the Claude TUI, whose pty reaches Tern. Bounded
 *  depth; uses `ps` (read-only). null when none is found. */
export function ancestorTty(startPid: number = process.pid, maxDepth = 8): string | null {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    let ppid: number;
    try { ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim()); } catch { return null; }
    if (!Number.isSafeInteger(ppid) || ppid <= 1) return null;
    let tty = "";
    try { tty = execFileSync("ps", ["-o", "tty=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000 }).trim(); } catch { return null; }
    if (tty && tty !== "??" && tty !== "-") return `/dev/${tty}`;
    pid = ppid;
  }
  return null;
}

/** OSC 777 desktop-notification escape (`ESC ] 777 ; notify ; <title> ; <body> BEL`) with control characters stripped from both
 *  fields, so a tool name can't inject further escape sequences into the TUI. Pure. */
export function osc777Sequence(title: string, body: string): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f;]/g, " ").slice(0, 200);
  return `\u001b]777;notify;${clean(title)};${clean(body)}\u0007`;
}
