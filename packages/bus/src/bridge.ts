import net from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
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
 * One bridge per machine: it binds the socket, and a second launch that finds a live one just exits.
 * It serves exactly the team it started with — a session whose team namespace differs is refused, so a
 * differently-configured session is never silently published to the wrong group. With no team
 * configured there is nothing to gateway, so it does not start.
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

/**
 * Start the gateway. Resolves to a handle once the socket is bound, or to undefined if there is no
 * team (nothing to do) or a live bridge already holds the socket (this launch is redundant).
 */
export function startBridge(options: BridgeOptions = {}): Promise<Bridge | undefined> {
  const team = loadTeam(options.home);
  if (!team) return Promise.resolve(undefined);
  const sock = bridgeSocketPath(options.home);
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
    let sessions = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    const conns = new Set<net.Socket>();

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
          const r = startRelay(msg.self, (from, text) => write({ t: "inbound", from, text }), options);
          if (!r) {
            // Team vanished between our start and this hello: nothing to gateway for it.
            write({ t: "rejected", reason: "no-team" });
            socket.destroy();
            return;
          }
          // Count ONLY once a relay actually exists, so a refused/failed hello can never leave the
          // session count stuck above zero and defeat idle-exit.
          relay = r;
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
        const had = relay;
        relay = undefined;
        if (registered) {
          registered = false;
          sessions = Math.max(0, sessions - 1);
          armIdle();
        }
        void had?.close();
      };
      socket.on("close", teardown);
      socket.on("error", teardown);
    });

    const close = async (): Promise<void> => {
      if (closed) return; // idempotent: a second close must not unlink a successor's socket
      closed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      // Drop clients first: server.close() waits for open connections, and destroying them is also
      // what tears down their relays (via the socket 'close' handler).
      for (const s of conns) s.destroy();
      conns.clear();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        if (existsSync(sock)) unlinkSync(sock);
      } catch {
        // best effort
      }
    };

    // Bind, mirroring the broker's stale-socket handling: try to listen; on EADDRINUSE probe the path —
    // a live bridge means this launch is redundant (exit), a dead file is stale (remove it and retry).
    const tryListen = (): void => {
      if (closed) return;
      server.listen(sock, () => {
        armIdle();
        done({ socketPath: sock, close });
      });
    };
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (closed) {
        done(undefined);
        return;
      }
      if (err.code !== "EADDRINUSE") {
        done(undefined);
        return;
      }
      const probe = net.connect(sock);
      probe.once("connect", () => {
        probe.destroy();
        done(undefined); // a live bridge already serves this machine
      });
      probe.once("error", () => {
        probe.destroy();
        try {
          if (existsSync(sock)) unlinkSync(sock);
        } catch {
          // best effort
        }
        // Retry after a short jittered wait. If someone bound in the meantime, listen re-EADDRINUSEs
        // and the next probe finds them live, so we exit rather than fight over the path.
        setTimeout(tryListen, 40 + Math.floor(Math.random() * 80));
      });
    });

    try {
      mkdirSync(path.dirname(sock), { recursive: true });
    } catch {
      // dir may already exist
    }
    tryListen();
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
