import net from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { bridgeSocketPath } from "./broker.js";
import { loadTeam } from "./team.js";
import { startRelay, type Relay, type RelayOptions } from "./relay.js";
import type { SelfInfo } from "./label.js";
import type { UnifiedPeer } from "./resolve.js";
import { dbg } from "./debug.js";

/**
 * The cross-machine gateway for tools that cannot carry the relay themselves. The relay half pulls in
 * express + the a2a sdk (~2 MB); bundling that into an OpenCode plugin (loaded on every start, one
 * process holding many sessions) is the wrong shape. So the relay stays in this already-compiled
 * binary: a per-machine daemon that a lean plugin talks to over a unix socket.
 *
 * For each session a plugin registers, the bridge runs one relay node (startRelay) with THAT session's
 * identity — announcing it on the team directory, hosting its mailbox — exactly as a self-joining
 * session would. Inbound DMs are pushed back down the socket to the session; the plugin injects them.
 * Self-joining tools (Claude, Codex) do not use the bridge; they run their own relay in-process.
 *
 * One bridge per machine. Election is serialized by an O_EXCL lock file next to the socket: only the
 * lock holder ever clears a stale socket and binds, so two racing launches cannot both end up live.
 * The bridge serves exactly the team it started with — a session whose team namespace differs is
 * refused (checked and published under the SAME frozen team, even if the on-disk config changes). With
 * no team configured there is nothing to gateway, so it does not start.
 *
 * Trust is the same as the broker's: any process of this OS user can reach the socket. It is not an
 * authentication boundary between users; OS/path permissions decide who can connect at all.
 *
 * Wire (plugin -> bridge / bridge -> plugin), newline-delimited JSON. One session per connection.
 */

type FromPlugin =
  | { t: "hello"; self: SelfInfo; team?: string }
  | { t: "send"; rid: number; pub: string; text: string };
type ToPlugin =
  | { t: "roster"; peers: UnifiedPeer[] }
  | { t: "inbound"; from: string; text: string }
  | { t: "sent"; rid: number; ok: boolean }
  | { t: "rejected"; reason: string };

export type Bridge = { socketPath: string; close: () => Promise<void> };
export type BridgeOptions = RelayOptions & {
  /** Push the remote roster this often (ms). */
  rosterMs?: number;
  /** Called once the last session has been gone for the idle grace. The daemon uses it to exit. */
  onIdle?: () => void;
  /** How long to wait with zero sessions before onIdle fires (ms). */
  idleMs?: number;
};

// A lock held only during the brief clear-stale-socket-and-bind step; a crash leaves it at most this
// stale before another launcher may steal it.
const LOCK_STALE_MS = 3_000;

export function startBridge(options: BridgeOptions = {}): Promise<Bridge | undefined> {
  const team = loadTeam(options.home);
  if (!team) return Promise.resolve(undefined);
  // Every relay this gateway runs uses THIS frozen team, so the team a handshake is checked against is
  // always the team its session is published to, even if the config file changes afterwards.
  const relayOptions: RelayOptions = { ...options, team };
  const sock = bridgeSocketPath(options.home);
  const lockPath = `${sock}.lock`;
  const rosterMs = options.rosterMs ?? 5_000;
  const idleMs = options.idleMs ?? 30_000;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Bridge | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let closed = false;
    let closePromise: Promise<void> | undefined;
    let sessions = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    const conns = new Set<net.Socket>();
    const relays = new Set<Relay>();

    // Election lock: held only during the brief clear-stale-socket-and-bind step (and, best effort,
    // while close releases the socket) so exactly one launcher ever unlinks + binds the path. A crash
    // leaves it stale for at most LOCK_STALE_MS before another launcher may steal it.
    const takeLock = (): boolean => {
      try {
        closeSync(openSync(lockPath, "wx"));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath); // the holder crashed mid-election; steal it
            closeSync(openSync(lockPath, "wx"));
            return true;
          }
        } catch {
          // lost the race to steal it; treat as not held by us
        }
        return false;
      }
    };
    const dropLock = (): void => {
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort
      }
    };

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (closed || sessions > 0 || !options.onIdle) return;
      idleTimer = setTimeout(() => {
        if (!closed && sessions === 0) options.onIdle?.();
      }, idleMs);
      idleTimer.unref();
    };

    const server = net.createServer((socket) => {
      if (closed) {
        socket.destroy();
        return;
      }
      conns.add(socket);
      let relay: Relay | undefined;
      let registered = false; // this connection's hello was accepted and counts toward `sessions`
      let roster: NodeJS.Timeout | undefined;
      const write = (msg: ToPlugin): void => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
      };
      readLines(socket, (msg) => {
        if (closed) return;
        if (msg.t === "hello") {
          if (registered) return; // one session per connection; ignore a duplicate hello
          // Serve only this machine's team — never publish a differently-configured session to the
          // wrong remote group. nsId is the public team hash, safe to compare over the socket.
          if (msg.team !== team.nsId) {
            write({ t: "rejected", reason: "team-mismatch" });
            socket.destroy();
            return;
          }
          const r = startRelay(msg.self, (from, text) => write({ t: "inbound", from, text }), relayOptions);
          if (!r) {
            write({ t: "rejected", reason: "no-team" });
            socket.destroy();
            return;
          }
          // Count ONLY once a relay actually exists, so a refused/failed hello can never leave the
          // session count stuck above zero and defeat idle-exit.
          relay = r;
          relays.add(r);
          registered = true;
          sessions++;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
          dbg(`bridge: session ${msg.self.title} joined (sessions=${sessions})`);
          const push = (): void => {
            if (relay && !socket.destroyed) write({ t: "roster", peers: relay.roster() });
          };
          push();
          roster = setInterval(push, rosterMs);
          roster.unref();
        } else if (msg.t === "send") {
          if (!relay) {
            write({ t: "sent", rid: msg.rid, ok: false });
            return;
          }
          void relay.send(msg.pub, msg.text).then((ok) => write({ t: "sent", rid: msg.rid, ok }));
        }
      });
      const teardown = (): void => {
        if (roster) {
          clearInterval(roster);
          roster = undefined;
        }
        conns.delete(socket);
        if (closed) return; // close() owns relay shutdown and the session count during shutdown
        const had = relay;
        relay = undefined;
        if (registered) {
          registered = false;
          sessions = Math.max(0, sessions - 1);
          armIdle();
        }
        if (had) {
          relays.delete(had);
          void had.close();
        }
      };
      socket.on("close", teardown);
      socket.on("error", teardown);
    });

    const doClose = async (): Promise<void> => {
      closed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      // Hold the election lock while we release the socket, so a launcher racing us cannot bind the same
      // path mid-teardown (server.close() unlinks the socket file itself). Best effort: if a launcher is
      // already electing we proceed anyway rather than block shutdown.
      const held = takeLock();
      for (const s of conns) s.destroy(); // also stops server.close() from waiting on open connections
      conns.clear();
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.allSettled([...relays].map((r) => r.close()));
      relays.clear();
      if (held) dropLock();
    };
    // Shared promise: a second (even concurrent) close awaits the same shutdown instead of returning early.
    const close = (): Promise<void> => (closePromise ??= doClose());

    // Election, serialized by the O_EXCL lock so exactly one launcher clears a stale socket and binds.
    const elect = (): void => {
      if (closed) {
        done(undefined);
        return;
      }
      // Is a live bridge already serving this machine? (A missing socket errors here too -> proceed.)
      const probe = net.connect(sock);
      probe.once("connect", () => {
        probe.destroy();
        done(undefined);
      });
      probe.once("error", () => {
        probe.destroy();
        if (closed) {
          done(undefined);
          return;
        }
        if (!takeLock()) {
          setTimeout(elect, 40 + Math.floor(Math.random() * 80)); // someone is electing; retry
          return;
        }
        // Under the lock, re-probe: a winner may have bound between our probe and acquiring the lock.
        const reprobe = net.connect(sock);
        reprobe.once("connect", () => {
          reprobe.destroy();
          dropLock();
          done(undefined);
        });
        reprobe.once("error", () => {
          reprobe.destroy();
          try {
            if (existsSync(sock)) unlinkSync(sock); // clear the confirmed-dead socket, we hold the lock
          } catch {
            // best effort
          }
          const onErr = (): void => {
            dropLock();
            done(undefined);
          };
          server.once("error", onErr);
          server.listen(sock, () => {
            server.removeListener("error", onErr);
            dropLock();
            armIdle();
            done({ socketPath: sock, close });
          });
        });
      });
    };

    try {
      mkdirSync(path.dirname(sock), { recursive: true });
    } catch {
      // dir may already exist
    }
    elect();
  });
}

/** Split a socket's byte stream into newline-delimited JSON messages. Bad lines are skipped. */
function readLines(socket: net.Socket, onMessage: (msg: FromPlugin) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as FromPlugin);
      } catch {
        // A partial or malformed line is not worth taking the process down for.
      }
    }
  });
}
