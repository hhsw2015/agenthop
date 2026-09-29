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
 * With no team configured there is nothing to gateway, so it does not start.
 *
 * Wire (plugin -> bridge / bridge -> plugin), newline-delimited JSON. One session per connection.
 */

type FromPlugin =
  | { t: "hello"; self: SelfInfo }
  | { t: "send"; rid: number; pub: string; text: string };
type ToPlugin =
  | { t: "roster"; peers: UnifiedPeer[] }
  | { t: "inbound"; from: string; text: string }
  | { t: "sent"; rid: number; ok: boolean };

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
  if (!loadTeam(options.home)) return Promise.resolve(undefined);
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

    let sessions = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (sessions > 0 || !options.onIdle) return;
      idleTimer = setTimeout(() => {
        if (sessions === 0) options.onIdle?.();
      }, idleMs);
      idleTimer.unref();
    };

    const server = net.createServer((socket) => {
      let relay: Relay | undefined;
      let roster: NodeJS.Timeout | undefined;
      const write = (msg: ToPlugin): void => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
      };
      readLines(socket, (msg) => {
        if (msg.t === "hello") {
          if (relay) return; // one session per connection; ignore a duplicate hello
          sessions++;
          if (idleTimer) clearTimeout(idleTimer);
          relay = startRelay(msg.self, (from, text) => write({ t: "inbound", from, text }), options);
          dbg(`bridge: session ${msg.self.title} joined (relay=${relay ? "on" : "off"})`);
          const push = (): void => {
            if (relay) write({ t: "roster", peers: relay.roster() });
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
        if (roster) clearInterval(roster);
        const had = relay;
        relay = undefined;
        if (had) {
          sessions = Math.max(0, sessions - 1);
          void had.close();
          armIdle();
        }
      };
      socket.on("close", teardown);
      socket.on("error", teardown);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        done(undefined);
        return;
      }
      // Someone holds the socket. A live bridge means this launch is redundant; a dead file is stale.
      const probe = net.connect(sock);
      probe.once("connect", () => {
        probe.destroy();
        done(undefined); // a live bridge is already serving this machine
      });
      probe.once("error", () => {
        probe.destroy();
        try {
          if (existsSync(sock)) unlinkSync(sock);
        } catch {
          // best effort
        }
        try {
          server.listen(sock);
        } catch {
          done(undefined);
        }
      });
    });

    try {
      mkdirSync(path.dirname(sock), { recursive: true });
    } catch {
      // dir may already exist
    }
    server.listen(sock, () => {
      armIdle();
      done({
        socketPath: sock,
        async close() {
          if (idleTimer) clearTimeout(idleTimer);
          await new Promise<void>((r) => server.close(() => r()));
          try {
            if (existsSync(sock)) unlinkSync(sock);
          } catch {
            // best effort
          }
        },
      });
    });
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
