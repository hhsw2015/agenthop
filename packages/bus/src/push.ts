import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dbg } from "./debug.js";

/**
 * Resolve the `codex` executable to an absolute path. Codex may spawn our MCP with a minimal launchd
 * PATH (when the app is opened from the Dock rather than a terminal), so `spawn("codex")` ENOENTs and
 * the message silently drops to the recv queue. Prefer the binary sitting next to our own (codex and
 * agenthop are installed together), then well-known install dirs, and only fall back to bare "codex".
 */
let cachedCodexBin: string | undefined;
function codexBin(): string {
  if (cachedCodexBin) return cachedCodexBin;
  const candidates = [
    process.env.AGENTHOP_CODEX_BIN,
    path.join(path.dirname(process.execPath), "codex"),
    path.join(homedir(), ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return (cachedCodexBin = c);
    } catch {
      // keep trying
    }
  }
  return (cachedCodexBin = "codex"); // last resort: hope PATH has it
}

/**
 * Deliver an incoming bus message into the host agent's OWN live UI using that agent's native
 * cross-session channel — so it surfaces with no hook and no polling loop, even while the session
 * is idle. This is what makes the bus feel like Claude Code's built-in cross-session messaging.
 *
 * Claude Code: write to this session's messaging socket (the same transport SendMessage uses); the
 * socket path and token are in every MCP subprocess's env, so a session can push to itself.
 * Codex: `codex queue --thread <id>` wakes/queues the thread; the id is the caller's own thread id,
 * learned from the x-codex-turn-metadata that Codex attaches to each MCP call (see mcp.ts).
 *
 * Returns true if handed to a native channel; false means keep it in the pull queue for agenthop_recv.
 */
export async function pushToHost(
  from: string,
  text: string,
  opts: { codexThread?: string; codexHome?: string; fromMode?: string; to?: string } = {},
): Promise<boolean> {
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (sock) return pushClaude(sock, process.env.CLAUDE_CODE_MESSAGING_TOKEN, from, text, { fromMode: opts.fromMode, to: opts.to });
  // Codex: the caller passes the active thread id (from x-codex-turn-metadata or the daemon client).
  if (opts.codexThread) return pushCodex(opts.codexThread, from, text, opts.codexHome, opts.to);
  dbg(`pushToHost: no channel (no cc-socks, no codexThread) from=${from}`);
  return false;
}

/** Email-style From→To header prepended to a delivered bus message so the agent (and the user) can see which address
 *  sent it AND which of their sessions received it. `from`/`to` are stable handles (the agent's "email address"). */
function busHeader(from: string, to?: string): string {
  return to ? `[bus] ${from} → ${to}\n` : `[bus] ${from}\n`;
}

/** codex queue delivers as if the user typed it (no sender field), so we prefix an email-style From→To header. */
function pushCodex(thread: string, from: string, text: string, codexHome?: string, to?: string): Promise<boolean> {
  return new Promise((resolve) => {
    // CODEX_HOME must be passed explicitly: `codex queue` reads the thread's rollout from it, but the MCP
    // subprocess Codex spawns does not inherit CODEX_HOME — without it the queue fails "no rollout found".
    const env = codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env;
    const child = spawn(codexBin(), ["queue", "--thread", thread, "--message", `${busHeader(from, to)}${text}`], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      dbg(`pushCodex spawn error thread=${thread}: ${e.message}`);
      resolve(false);
    });
    child.on("exit", (code) => {
      dbg(`pushCodex thread=${thread} exit=${code} out=${out.trim().slice(0, 200)} err=${err.trim().slice(0, 200)}`);
      resolve(code === 0);
    });
  });
}

function pushClaude(
  sockPath: string,
  token: string | undefined,
  from: string,
  text: string,
  opts: { fromMode?: string; to?: string } = {},
): Promise<boolean> {
  // from-mode carries the SENDER's REAL permission mode (Claude vocab, learned by the sender's presence hook; absent =>
  // "default" = the safe gated side). Hardcoding "default" made a bypass receiver gate every peer message for approval
  // regardless of the sender's trust level (Codex from-mode review). The To address rides the BODY (email-style): the
  // frame's attribute set/order is load-bearing (the receiver round-trips from, from-session, hop-chain, from-name,
  // from-mode and rejects a different order), so a "to" attribute would be rejected — put the recipient in the text.
  // Guard to a non-empty STRING: fromMode can originate from a peer's JSON presence (untyped), so a number/object must
  // never reach attr()/xml()'s .replace and throw (that rejection would lose the message — Codex P1-05). Unknown => default.
  const fromMode = typeof opts.fromMode === "string" && opts.fromMode ? opts.fromMode : "default";
  const content =
    `<cross-session-message from="${attr(from)}" from-session="agenthop-bus" hop-chain="" ` +
    `from-name="${attr(from)}" from-mode="${attr(fromMode)}">${xml(`${busHeader(from, opts.to)}${text}`)}</cross-session-message>`;
  const frames = [
    JSON.stringify({ type: "auth", token: token ?? "" }),
    JSON.stringify({ type: "user", message: { role: "user", content }, priority: "now", file_attachments: [] }),
  ];
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(4000, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => {
      for (const f of frames) socket.write(`${f}\n`);
      // Resolve success only once the bytes are flushed and FIN is sent. done() destroys the socket,
      // and destroying right after write() truncates an unflushed buffer — dropping the message while
      // still reporting true, so core would not fall back to the recv queue.
      socket.end(() => done(true));
    });
  });
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(text: string): string {
  return xml(text).replace(/"/g, "&quot;");
}
