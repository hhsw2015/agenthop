import net from "node:net";
import { rmSync, writeFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { startBusCore, type BusCore, type BusCoreOptions } from "./core.js";
import { PRESENCE_HEARTBEAT_SEC, openLivenessSocket } from "./swarm/task-liveness.js";
import { successionEnabled, runSuccessionAtStartup } from "./swarm/shell-succession.js";
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
export function runPresence(opts: BusCoreOptions = {}): { core: BusCore; stop: () => Promise<void> } {
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
  const home = opts.home ?? homedir();
  let sockServer: net.Server | null = null;
  let closing = false;
  // The per-session LIVENESS SOCKET's sid. F45-R1/R7: a live instance LISTENS at `presence/<hash(sid)>.<nonce>.sock` (a BOUNDED
  // hash of the sid — no traversal/truncation-collision — plus a per-instance nonce so close() unlinks only our own path); the
  // kernel drops the listener the instant we die, so a receiver's connect-probe is a WINDOW-FREE "current instance alive?" check.
  // When a pid file is set the sid is FIXED from its name (stable from byte one). Otherwise it follows the core's identity — and
  // for Codex the stable id is adopted LATE (cwd-match), so the listener MUST re-bind to hash(stableId) when that id is learned
  // (B7-1): a socket left at hash(run-id) answers for the wrong sid, so a sender probing the stable id finds nothing and wrongly
  // keeps relay — the same-machine durable guarantee to the stable id's inbox silently breaks.
  const fixedSid = pidFile ? path.basename(pidFile).replace(/\.pid$/, "") : null;
  let sockSid = fixedSid ?? "";
  // Every bind attempt carries a GENERATION. Only the LATEST generation's socket is ever kept; any earlier/duplicate result is
  // closed on arrival (B7-1-R1: comparing the SID alone let two concurrent binds for the SAME sid — e.g. an A→B→A switch while a
  // bind is still in flight — both pass and both assign sockServer, orphaning the first listener). `binding` elides a redundant
  // concurrent attempt for the current sid; a sid change bumps the generation (superseding the in-flight bind) and clears it.
  let bindGen = 0;
  let binding = false;
  const openSock = (): void => {
    if (sockServer || closing || !sockSid || binding) return;
    const gen = ++bindGen;
    const bindFor = sockSid;
    binding = true;
    void openLivenessSocket(home, bindFor).then(
      (res) => {
        if (gen === bindGen) binding = false;           // SU3: only the CURRENT attempt releases the shared in-flight marker — a
        if (!res) return;                               // superseded bind must NOT clear `binding` out from under its superseder
        // Keep ONLY if this is still the latest attempt and we are not shutting down; otherwise it is stale/duplicate — close it
        // (unlinks its own path) so no superseded or orphaned listener survives (B7-1-R1).
        if (closing || gen !== bindGen) { try { res.server.close(); } catch { /* best effort */ } return; }
        sockServer = res.server;
      },
      () => { if (gen === bindGen) binding = false; },  // same: a stale reject never clears the current attempt's marker
    );
  };
  // B7-1: the stable identity was (re)assigned after startup (no pre-set SID + no pid file). Re-bind with NO poll window — close
  // the old-sid listener (close() unlinks only OUR OWN path, never another instance's) and open a fresh one at hash(new sid), so
  // a sender probing hash(stableId) proves THIS instance alive and routes its send to the stable id's durable inbox. Bumping the
  // generation here supersedes any in-flight old-sid bind (it will close itself on arrival), so the old identity keeps no listener.
  const syncSidFor = (want: string): void => {
    if (fixedSid || want === sockSid || !want) return; // a pid-file sid is fixed; no-op if unchanged
    sockSid = want;
    bindGen++;                                          // supersede an in-flight bind for the superseded sid
    binding = false;                                    // allow openSock to start a fresh bind for the new sid
    if (sockServer) { try { sockServer.close(); } catch { /* best effort */ } sockServer = null; }
    openSock();
  };
  // SU3: bind the liveness socket to `want` and RETURN whether the listener is actually ready for THIS identity. Used on a proven
  // succession adoption (overrides a seeded fixedSid — the one place that happens). Unlike syncSidFor there is NO same-sid early
  // return: core.adoptStableId fires onIdentityChange→syncSidFor which may already have started an in-flight bind for `want`, so
  // this bumps the generation to SUPERSEDE it and binds freshly, then awaits — so "done" means the socket for `want` is up, not
  // merely "sockSid already equals want". Returns false on a failed bind / supersession / shutdown (NOT ready) so the caller can
  // treat the adoption as incomplete and roll back its pid claim.
  const ensureSockBoundTo = async (want: string): Promise<boolean> => {
    if (!want || closing) return false;
    const prev = sockSid;                             // the identity to fall back to if this bind does not complete (SU3)
    sockSid = want;
    const gen = ++bindGen;                            // supersede any in-flight bind (incl. syncSidFor's from onIdentityChange)
    binding = true;                                   // SU3: HOLD the in-flight marker across our own await, so a keepAlive openSock
                                                      // cannot bind `want` behind us and publish the un-adopted target as if it were
                                                      // established. WE are the sole binder for this generation until it resolves.
    if (sockServer) { try { sockServer.close(); } catch { /* best effort */ } sockServer = null; }
    const res = await openLivenessSocket(home, want);
    if (gen === bindGen) binding = false;             // our bind resolved and we are still current — release the marker
    if (res && !closing && gen === bindGen) { sockServer = res.server; return true; } // bound + current ⇒ ready
    if (res) { try { res.server.close(); } catch { /* best effort */ } }              // superseded / shutting down ⇒ discard
    // SU3: the bind did NOT complete for `want`. Because `binding` was held across the await, no benign heartbeat could have bumped
    // the generation, so `gen === bindGen` here is a GENUINE failure (not a real adopt) and the revert MUST run: restore sockSid to
    // the previous identity and re-open ITS socket, so a failed adoption never leaves the un-adopted target as the published
    // identity and the keepAlive heartbeat serves our own sid. A newer generation can only be ANOTHER ensureSockBoundTo (a real
    // adopt) — leave it alone.
    if (gen === bindGen && sockSid === want) { sockSid = prev; bindGen++; openSock(); }
    return false;                                     // NOT ready
  };
  const core = startBusCore({ ...opts, onIdentityChange: (self) => syncSidFor(self.stableId ?? self.id) });
  if (!fixedSid) sockSid = core.self.stableId ?? core.self.id; // initial sid from the core (the per-run id until a late adopt)
  dbg(`presence up: ${core.self.title} (tool=${core.self.tool} stable=${core.self.stableId ?? "-"})`);

  // F45 ① (SWARM_SUCCESSION): a restarted shell proving it continues a stable identity may re-take that identity's presence
  // slot + durable-inbox scan instead of coming up a stranger. LIVE BY DEFAULT (kill with SWARM_SUCCESSION=0 ⇒ skipped entirely). On "adopt"
  // the pid slot is taken over inside runSuccessionAtStartup; core.adoptStableId then drains that sid's inbox ("扫箱") and
  // rebinds the liveness socket (via onIdentityChange) so resolveSession(stableSid) finds this instance. Fail-soft.
  if (successionEnabled()) {
    // SOLE completion point (coordinator SU3 pivot): adoption completes ONLY here — the presence daemon is the single instance
    // that owns a liveness socket, so one completion point avoids the double-write surface F45 closed. The credential (resume
    // target) is the AGENT's own argv, read via ps / /proc on the host pid the hook recorded (AGENTHOP_HOST_PID = the codex/
    // claude process), never this daemon's `node presence.mjs`. Async because the incumbent check probes the live socket (SU1).
    void (async () => {
      try {
        // The publish runs UNDER SU2's single-winner adopt lock: adopt the identity (drain its inbox) then bind its liveness
        // socket (SU3), RETURNING whether the listener is actually ready — runSuccessionAtStartup rolls back the pid claim if not.
        // The lock is released only after this resolves, covering the pre-publish interval.
        await runSuccessionAtStartup(
          home, core.self.tool, core.self.stableId ?? core.self.id, Number(process.env.AGENTHOP_HOST_PID) || undefined,
          // SU3: bind the target's liveness socket FIRST; only adopt the core identity (+ drain inbox) once the socket is confirmed
          // ready. On a bind failure core identity is left untouched and sockSid is reverted — nothing to roll back in core, and the
          // heartbeat keeps serving our own sid. (syncSidFor from adoptStableId is a same-sid no-op: the socket is already bound.)
          async (sid) => { if (closing) return false; const bound = await ensureSockBoundTo(sid); if (!bound) return false; core.adoptStableId(sid); return true; },
          dbg,
        );
      } catch (e) { dbg(`succession startup failed (ignored): ${e instanceof Error ? e.message : e}`); }
    })();
  }

  // Keep the process alive (a ref'd timer holds the detached loop open — a non-compiled bun/node script stays up on that alone).
  // Heartbeat the pid file's mtime (sentinel aux only — NOT ownership, which is the liveness socket), re-sync the sid defensively
  // (belt-and-suspenders should an identity change ever land without the callback), and (re)open the socket when we don't hold it.
  const keepAlive = setInterval(() => {
    if (pidFile) { try { const t = new Date(); utimesSync(pidFile, t, t); } catch { /* best effort — the pid file may be gone on shutdown */ } }
    if (!fixedSid) syncSidFor(core.self.stableId ?? core.self.id);
    openSock();
  }, PRESENCE_HEARTBEAT_SEC * 1000);
  openSock(); // open immediately at startup; the keepAlive tick is only the retry path

  const timers: Array<ReturnType<typeof setInterval>> = [keepAlive];
  // Cleanup WITHOUT exiting the process, so an embedder (or a test) can stop one instance cleanly; shutdown() wraps it with
  // process.exit for the signal/orphan-guard paths.
  const stop = (): Promise<void> => {
    if (closing) return Promise.resolve();
    closing = true;
    for (const tmr of timers) clearInterval(tmr);
    // Close the liveness socket we OWN. server.close() unlinks our own socket file — we only ever hold a path we bound (a
    // live incumbent is deferred, never replaced; a re-bind already closed the superseded one), so this cannot delete another
    // instance's endpoint (F45-R7-P2-1). No unconditional rmSync: a crashed daemon's leftover file is reclaimed by the next
    // start's probe-then-skip.
    if (sockServer) { try { sockServer.close(); } catch { /* best effort */ } sockServer = null; }
    // Remove our own pid file (the entry wrote it, the SessionEnd hook also removes it — harmless to do both).
    const pidFile = process.env.AGENTHOP_PID_FILE;
    if (pidFile) { try { rmSync(pidFile, { force: true }); } catch { /* best effort */ } }
    return core.close();
  };
  const shutdown = (code = 0): void => { void stop().finally(() => process.exit(code)); };
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

  return { core, stop };
}
