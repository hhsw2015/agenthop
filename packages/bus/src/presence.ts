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
 * Coexistence with the lazily-spawned MCP node is safe: they share one session identity, core.unified() collapses the
 * two local nodes into one roster entry (so resolve isn't "ambiguous"), and the atomic durable-inbox claim + unicast
 * DM routing mean a message is delivered exactly once even while both run.
 *
 * Lifecycle: SIGTERM/SIGINT (the SessionEnd hook) stops it. An orphan guard self-exits if the host's messaging socket
 * is gone for several checks — so a session that ended without its SessionEnd hook firing does not leave a ghost on
 * the bus.
 */
export function runPresence(opts: BusCoreOptions = {}): void {
  const core = startBusCore(opts);
  dbg(`presence up: ${core.self.title} (tool=${core.self.tool} stable=${core.self.stableId ?? "-"})`);
  // A ref'd timer so the process stays alive independent of socket state (reconnect windows, broker failover).
  const keepAlive = setInterval(() => {}, 1 << 30);

  let closing = false;
  const shutdown = (code = 0): void => {
    if (closing) return;
    closing = true;
    clearInterval(keepAlive);
    stopOrphanGuard();
    void core.close().finally(() => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  // Orphan guard: if the host's live channel is gone for several consecutive checks, the session ended without the
  // SessionEnd hook killing us (crash / closed terminal) — self-exit so we don't linger as a ghost presence. Only for
  // Claude's cc-socks (a connect probe); Codex has no equivalent per-session socket, so its presence relies on the
  // SessionEnd hook (its daemon is cheap + the broker drops it the moment it exits).
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  let guard: ReturnType<typeof setInterval> | undefined;
  const stopOrphanGuard = (): void => { if (guard) clearInterval(guard); };
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
