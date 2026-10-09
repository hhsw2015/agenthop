import net from "node:net";
import { rmSync, writeFileSync, utimesSync } from "node:fs";
import { startBusCore, type BusCoreOptions } from "./core.js";
import { PRESENCE_HEARTBEAT_SEC } from "./swarm/task-liveness.js";
import { dbg } from "./debug.js";

/**
 * The startup PRESENCE daemon: a session's always-on bus node, launched by a SessionStart hook so the session is
 * findable + reachable on the bus FROM STARTUP — not only after it first calls an agenthop tool (the host spawns the
 * `agenthop mcp` server lazily, so an idle session that never touches agenthop is otherwise invisible). It is just
 * `startBusCore()` kept alive: it connects to the broker, registers this session, and its handleInbound pushes an
 * inbound message to the host's live channel (Claude cc-socks / Codex `codex queue` via cwd-match) or persists it to
 * the durable inbox — exactly what the MCP node does, minus the MCP tool surface.
 *
 * Launch model: the SessionStart hook runs the NON-compiled bundle (~/.agenthop/presence.mjs) via bun/node, and the
 * ENTRY (presence-entry.ts) immediately re-spawns itself DETACHED (new session via setsid) and exits — because a plain
 * `&` child stays in the hook's process group, which the host tears down when the hook returns (Codex 0.160 waits for
 * the group, hanging a sync hook, or kills it; Claude is similar). The detached grandchild escapes that group and lives
 * independently. A non-compiled bun/node script with a ref'd keep-alive survives with no controlling terminal (unlike a
 * bun --compile binary, which drains its loop and exits).
 *
 * Not leaking: the daemon is detached, so it does NOT die with the terminal — three independent stops cover that.
 * (1) SessionEnd hook kills it by the pid the entry recorded. (2) Host-pid guard: it polls the host process (the hook's
 * $PPID, passed as AGENTHOP_HOST_PID) and self-exits once that process is gone — covers a crash / SessionEnd not firing.
 * (3) Claude also keeps a cc-socks probe as a second signal. So a clean exit, a crash, and a closed terminal each stop
 * it; the broker drops the roster entry the moment it exits.
 *
 * Coexistence with the lazily-spawned MCP node is safe: they share one session identity, core.unified() collapses the
 * two local nodes into one roster entry (so resolve isn't "ambiguous"), and the atomic durable-inbox claim + unicast
 * DM routing mean a message is delivered exactly once even while both run.
 */
export function runPresence(opts: BusCoreOptions = {}): void {
  // Record our pid as EARLY as possible. This doubles as the bootstrap's handshake: the detached-spawn parent polls for
  // this file to confirm the daemon is up in its own session before it exits (see presence-entry.ts). SessionEnd reads
  // it to stop us; we remove it on shutdown. We are already post-setsid here (the child runs after detached spawn).
  const pidFile = process.env.AGENTHOP_PID_FILE;
  if (pidFile) {
    try {
      writeFileSync(pidFile, String(process.pid));
    } catch {
      // best effort — the host-pid guard + SessionEnd are the other stops
    }
  }
  const core = startBusCore(opts);
  dbg(`presence up: ${core.self.title} (tool=${core.self.tool} stable=${core.self.stableId ?? "-"})`);
  // Keep the process alive. The daemon is detached (its own session, no controlling terminal, stdio ignored), so a
  // ref'd timer is what holds the event loop open — a non-compiled bun/node script stays up on that alone. This timer
  // ALSO HEARTBEATS the pid file's mtime (F45-P1-2): a live same-machine peer proves THIS instance is current by the file
  // being fresh; a stale mtime means the daemon is gone and the pid may be recycled, so the send path keeps relay rather
  // than a false local durable redirect. Keyed on the file's freshness (an active association), not on process start time
  // (whose 1s granularity let a same-second recycle masquerade as the original writer).
  const keepAlive = setInterval(() => {
    if (pidFile) { try { const t = new Date(); utimesSync(pidFile, t, t); } catch { /* best effort — the pid file may be gone on shutdown */ } }
  }, PRESENCE_HEARTBEAT_SEC * 1000);

  // F45-R1 (coordinator ruling B): a per-session LIVENESS SOCKET at presence/<sid>.sock. A live instance LISTENS; when it
  // dies the kernel drops the listener, so a receiver's connect-probe is a WINDOW-FREE "is the current instance alive?" check
  // (ownership — the mtime heartbeat above is only a sentinel-classification aid). The sock filename IS the sid (natural
  // binding). A stale sock file from a dead daemon connects to nothing ⇒ ECONNREFUSED ⇒ naturally rejected; we only unlink a
  // leftover file BEFORE binding (standard unix). Accept-and-close: the mere existence of a listener is the signal.
  const sockPath = pidFile ? pidFile.replace(/\.pid$/, ".sock") : null;
  let sockServer: net.Server | null = null;
  if (sockPath) {
    try { rmSync(sockPath, { force: true }); } catch { /* no stale sock */ }
    try {
      sockServer = net.createServer((c) => c.destroy());
      sockServer.on("error", () => { /* never crash the daemon on a socket error */ });
      sockServer.listen(sockPath);
      sockServer.unref?.(); // don't keep the loop alive on the socket alone (keepAlive does that)
    } catch { sockServer = null; }
  }

  let closing = false;
  const timers: Array<ReturnType<typeof setInterval>> = [keepAlive];
  const shutdown = (code = 0): void => {
    if (closing) return;
    closing = true;
    for (const tmr of timers) clearInterval(tmr);
    // Close the liveness socket + remove its file (a clean exit; a crash leaves the file, but connect then gets ECONNREFUSED).
    if (sockServer) { try { sockServer.close(); } catch { /* best effort */ } }
    if (sockPath) { try { rmSync(sockPath, { force: true }); } catch { /* best effort */ } }
    // Remove our own pid file (the entry wrote it, the SessionEnd hook also removes it — harmless to do both).
    const pidFile = process.env.AGENTHOP_PID_FILE;
    if (pidFile) {
      try {
        rmSync(pidFile, { force: true });
      } catch {
        // best effort
      }
    }
    void core.close().finally(() => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  // Orphan guard #1 (universal): poll the host process. The SessionStart hook passes its own $PPID — the host process
  // that owns this session (codex / claude) — as AGENTHOP_HOST_PID. When that process is gone, the session ended (incl.
  // a crash or a SessionEnd that never fired), so self-exit. ponytail: a reused pid could mask death until the next
  // check; SessionEnd + cc-socks are the other two signals, and same-pid reuse within a session's life is unlikely.
  const hostPid = Number(process.env.AGENTHOP_HOST_PID);
  if (Number.isInteger(hostPid) && hostPid > 1) {
    const hostGuard = setInterval(() => {
      try {
        process.kill(hostPid, 0); // signal 0 = liveness check, sends nothing
      } catch {
        dbg(`presence orphan guard: host pid ${hostPid} gone, exiting`);
        shutdown(0);
      }
    }, 30000);
    hostGuard.unref?.();
    timers.push(hostGuard);
  }

  // Orphan guard #2 (Claude only): if the host's cc-socks channel is unreachable for several consecutive checks, the
  // session ended. Codex has no equivalent per-session socket, so it relies on guard #1 + the SessionEnd hook.
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (sock) {
    let misses = 0;
    const guard = setInterval(() => {
      const probe = net.connect(sock);
      probe.once("connect", () => { misses = 0; probe.destroy(); });
      probe.once("error", () => { probe.destroy(); if (++misses >= 3) { dbg("presence orphan guard: host channel gone, exiting"); shutdown(0); } });
    }, 30000);
    guard.unref?.();
    timers.push(guard);
  }
}
