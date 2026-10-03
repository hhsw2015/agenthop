import net from "node:net";
import { startBusCore, type BusCoreOptions } from "./core.js";
import { dbg } from "./debug.js";

/**
 * The startup PRESENCE daemon: a session's always-on bus node, launched by a SessionStart hook so the session is
 * findable + reachable on the bus FROM STARTUP — not only after it first calls an agenthop tool (the host spawns the
 * `agenthop mcp` server lazily, so an idle session that never touches agenthop is otherwise invisible). It is just
 * `startBusCore()` kept alive: it connects to the broker, registers this session, and its handleInbound pushes an
 * inbound message to the host's live channel (Claude cc-socks / Codex `codex queue` via cwd-match) or persists it to
 * the durable inbox — exactly what the MCP node does, minus the MCP tool surface.
 *
 * Launch model: the SessionStart hook backgrounds this (a plain `&`, NOT setsid). A bun --compile binary with no
 * controlling terminal (setsid/new session) drains its event loop and exits, so it must stay in the hook's session;
 * a non-interactive shell does not SIGHUP its background children on exit, so it survives the hook. SessionEnd stops it
 * by pid, and the orphan guard self-exits if the host's live channel is gone for a while.
 *
 * Coexistence with the lazily-spawned MCP node is safe: they share one session identity, core.unified() collapses the
 * two local nodes into one roster entry (so resolve isn't "ambiguous"), and the atomic durable-inbox claim + unicast
 * DM routing mean a message is delivered exactly once even while both run.
 */
export function runPresence(opts: BusCoreOptions = {}): void {
  const core = startBusCore(opts);
  dbg(`presence up: ${core.self.title} (tool=${core.self.tool} stable=${core.self.stableId ?? "-"})`);
  // Keep the process alive. A bun --compile binary with no controlling terminal (backgrounded/detached by the hook)
  // drains its event loop and exits even with a ref'd timer + open sockets — UNLESS it is actively reading an open
  // stdin (the same reason the `mcp` server survives: Claude holds its stdin pipe). So resume stdin: the SessionStart
  // hook feeds it a never-EOF stdin (`tail -f /dev/null |`), and this active read holds the loop open with no tty.
  try { process.stdin.resume(); } catch { /* no stdin — the timer is the fallback */ }
  const keepAlive = setInterval(() => {}, 60000);

  let closing = false;
  let guard: ReturnType<typeof setInterval> | undefined;
  const shutdown = (code = 0): void => {
    if (closing) return;
    closing = true;
    clearInterval(keepAlive);
    if (guard) clearInterval(guard);
    void core.close().finally(() => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  // Orphan guard: if the host's live channel is gone for several consecutive checks, the session ended without the
  // SessionEnd hook stopping us (crash / closed terminal) — self-exit so we don't linger as a ghost presence. Only for
  // Claude's cc-socks (a connect probe); Codex has no equivalent per-session socket, so its presence relies on the
  // SessionEnd hook (the broker drops it the moment it exits).
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (sock) {
    let misses = 0;
    guard = setInterval(() => {
      const probe = net.connect(sock);
      probe.once("connect", () => { misses = 0; probe.destroy(); });
      probe.once("error", () => { probe.destroy(); if (++misses >= 3) { dbg("presence orphan guard: host channel gone, exiting"); shutdown(0); } });
    }, 30000);
    guard.unref?.();
  }
}
