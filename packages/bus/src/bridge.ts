import net from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 * One bridge per machine. Election is serialized by an owner lock file next to the socket, whose owner
 * is identified by pid: a live owner's lock is NEVER stolen (so two live bridges cannot both hold it),
 * and a dead owner's lock is reclaimed by an atomic rename so only one reclaimer wins. The lock is held
 * for the bridge's whole life and released on close (or reclaimed after a crash). The socket bind is
 * the ultimate mutex — a launcher that loses the race fails to bind and exits.
 *
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

// Backstop against pid reuse: a live owner is normally identified by its pid, but if that pid was
// recycled by an unrelated process, a lock older than this (no legitimate owner holds it that long
// without the socket also being live) may still be reclaimed.
const LOCK_BACKSTOP_MS = 60_000;

export function startBridge(options: BridgeOptions = {}): Promise<Bridge | undefined> {
  const team = loadTeam(options.home);
  if (!team) return Promise.resolve(undefined);
  // Every relay this gateway runs uses THIS frozen team, so the team a handshake is checked against is
  // always the team its session is published to, even if the config file changes afterwards.
  const relayOptions: RelayOptions = { ...options, team };
  const sock = bridgeSocketPath(options.home);
  const lockPath = `${sock}.lock`;
  const owner = String(process.pid);
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
    const cleanups = new Set<Promise<unknown>>(); // relay.close() promises from normal disconnects

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (closed || sessions > 0 || !options.onIdle) return;
      idleTimer = setTimeout(() => {
        if (!closed && sessions === 0) options.onIdle?.();
      }, idleMs);
      idleTimer.unref();
    };

    // --- Owner lock -------------------------------------------------------------------------------
    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours == still alive
      }
    };
    const lockIsStale = (): boolean => {
      try {
        const pid = Number(readFileSync(lockPath, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
          // A live owner: only the pid-reuse backstop may reclaim it, never a brief-hold timeout.
          return Date.now() - statSync(lockPath).mtimeMs > LOCK_BACKSTOP_MS;
        }
        return true; // dead pid, or an unparseable/foreign lock -> reclaimable
      } catch {
        return true; // vanished/unreadable
      }
    };
    /** "acquired" (we own it), "held" (a live owner holds it), or "error" (a permanent fs error). */
    const takeLock = (): "acquired" | "held" | "error" => {
      try {
        writeFileSync(lockPath, owner, { flag: "wx" }); // atomic create == the ownership mutex
        return "acquired";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "error"; // EACCES etc: do not spin
      }
      if (!lockIsStale()) return "held";
      // Reclaim a stale lock by atomically renaming IT away; only one reclaimer wins the rename, and a
      // fresh create by anyone else still loses to the create-wx below. Never unlinks a lock in place.
      const claim = `${lockPath}.dead-${owner}-${Date.now()}`;
      try {
        renameSync(lockPath, claim);
      } catch {
        return "held"; // someone else reclaimed/holds it; back off
      }
      try {
        unlinkSync(claim);
      } catch {
        // best effort
      }
      try {
        writeFileSync(lockPath, owner, { flag: "wx" });
        return "acquired";
      } catch {
        return "held"; // another launcher created it in the gap
      }
    };
    const ownLock = (): boolean => {
      try {
        return readFileSync(lockPath, "utf8").trim() === owner;
      } catch {
        return false;
      }
    };
    const dropLock = (): void => {
      try {
        if (ownLock()) unlinkSync(lockPath); // only ever remove a lock that is still ours
      } catch {
        // best effort
      }
    };

    // --- Connections ------------------------------------------------------------------------------
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
          // Track the in-flight close so a concurrent Bridge.close() waits for it to settle.
          const p = had.close();
          cleanups.add(p);
          void p.finally(() => cleanups.delete(p));
        }
      };
      socket.on("close", teardown);
      socket.on("error", teardown);
    });

    const doClose = async (): Promise<void> => {
      closed = true; // makes teardown a no-op for relay shutdown; close() owns it from here
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      for (const s of conns) s.destroy(); // also stops server.close() waiting on open connections
      conns.clear();
      await new Promise<void>((r) => server.close(() => r()));
      // Wait for BOTH relays still registered at close and any close already in flight from a normal
      // disconnect, so nothing is left shutting down after we return.
      await Promise.allSettled([...relays].map((r) => r.close()));
      await Promise.allSettled([...cleanups]);
      relays.clear();
      dropLock(); // we held it for our whole life; release it (only if still ours)
    };
    // Shared promise: a second (even concurrent) close awaits the same shutdown instead of returning early.
    const close = (): Promise<void> => (closePromise ??= doClose());

    // --- Election ---------------------------------------------------------------------------------
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
        const lock = takeLock();
        if (lock === "error") {
          done(undefined); // a permanent lock error (e.g. EACCES): give up rather than spin forever
          return;
        }
        if (lock === "held") {
          setTimeout(elect, 40 + Math.floor(Math.random() * 80)); // a live owner holds it; retry
          return;
        }
        // We hold the lock (for our whole life). Re-probe: a prior owner may have a live socket.
        const reprobe = net.connect(sock);
        reprobe.once("connect", () => {
          reprobe.destroy();
          dropLock();
          done(undefined);
        });
        reprobe.once("error", () => {
          reprobe.destroy();
          if (closed || !ownLock()) {
            dropLock();
            done(undefined); // lost the lock or closed -> never unlink/bind
            return;
          }
          try {
            if (existsSync(sock)) unlinkSync(sock); // clear the confirmed-dead socket; we hold the lock
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
            armIdle();
            done({ socketPath: sock, close }); // keep the lock held for the bridge's lifetime
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
