import net from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SelfInfo } from "./label.js";

/**
 * The same-machine bus: how sessions on one machine find each other and pass messages, with no
 * relay and no configuration. This is the "like Claude Code native" core.
 *
 * One process holds a unix socket and routes; the rest connect to it. Whoever gets the socket
 * first is the broker — a bind race, which is fine for one machine (ponytail: single-writer via
 * the socket, no consensus needed). If the broker exits, its socket closes, every client notices,
 * and one of them takes the socket next. Presence is live: a dropped connection is an instant
 * departure, so there is no TTL to tune.
 *
 * Wire: newline-delimited JSON. client->broker {hello|dm}; broker->client {peers|dm}.
 */

export type Role = "broker" | "client" | "connecting";
export type Peer = SelfInfo & { via: "local" };
export type Inbound = { from: string; payload: string; via: "local" };

export type LocalBus = {
  role(): Role;
  peers(): Peer[];
  /** Address a peer by session id. false when that id is not currently on the roster. */
  send(to: string, payload: string): boolean;
  /** Take everything received since the last call. */
  drain(): Inbound[];
  /** Refresh our own advertised info (e.g. once a stable session id is learned) and re-announce it. */
  updateSelf(next: SelfInfo): void;
  close(): Promise<void>;
};

type Wire =
  | { t: "hello"; self: SelfInfo }
  | { t: "dm"; to: string; from: string; payload: string }
  | { t: "peers"; peers: SelfInfo[] };

const RETRY_MS = 300;

export function socketPath(home: string = path.join(homedir(), ".agenthop")): string {
  return process.env.AGENTHOP_BUS_SOCK ?? path.join(home, "bus.sock");
}

export function startLocalBus(self: SelfInfo, home?: string, onInbound?: (msg: Inbound) => void): LocalBus {
  const sock = socketPath(home);
  let role: Role = "connecting";
  let roster: SelfInfo[] = [self];
  const inbox: Inbound[] = [];
  let closed = false;
  let electing = false;

  // A message for us: hand it to the callback if one is set (it may push to the host UI), else keep
  // it for drain()/recv. Only one of the two, so a pushed message is never also left in the queue.
  const deliver = (msg: Inbound): void => {
    if (onInbound) onInbound(msg);
    else inbox.push(msg);
  };

  let server: net.Server | undefined;
  const clients = new Map<net.Socket, SelfInfo | undefined>();
  let client: net.Socket | undefined;
  // The socket we are mid-connect on (before it becomes `client`), tracked so close() can tear it
  // down instead of leaving a ghost that registers with the broker after we have shut down.
  let connecting: net.Socket | undefined;

  const rosterFromClients = (): SelfInfo[] => [self, ...[...clients.values()].filter((s): s is SelfInfo => !!s)];

  const broadcastPeers = (): void => {
    roster = rosterFromClients();
    const line = `${JSON.stringify({ t: "peers", peers: roster } satisfies Wire)}\n`;
    for (const socket of clients.keys()) if (!socket.destroyed) socket.write(line);
  };

  const routeDm = (to: string, from: string, payload: string): void => {
    if (to === self.id) {
      deliver({ from, payload, via: "local" });
      return;
    }
    for (const [socket, info] of clients) {
      if (info?.id === to && !socket.destroyed) {
        socket.write(`${JSON.stringify({ t: "dm", to, from, payload } satisfies Wire)}\n`);
        return;
      }
    }
    // Unknown target: dropped. send() already told its caller by checking the roster first.
  };

  const becomeBroker = (): void => {
    if (closed) return;
    const srv = net.createServer((socket) => {
      if (closed) {
        socket.destroy();
        return;
      }
      clients.set(socket, undefined);
      readLines(socket, (msg) => {
        if (msg.t === "hello") {
          clients.set(socket, msg.self);
          broadcastPeers();
        } else if (msg.t === "dm") {
          routeDm(msg.to, msg.from, msg.payload);
        }
      });
      const drop = (): void => {
        if (clients.delete(socket)) broadcastPeers();
      };
      socket.on("close", drop);
      socket.on("error", drop);
    });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      try {
        srv.close();
      } catch {
        // already down
      }
      if (closed) return;
      if (err.code === "EADDRINUSE") {
        // Someone holds the path. Probe it: a live broker means go be a client; a dead one means
        // the file is stale (a broker that crashed without cleanup) — remove it and try again.
        const probe = net.connect(sock);
        probe.once("connect", () => {
          probe.destroy();
          elect();
        });
        probe.once("error", () => {
          probe.destroy();
          try {
            if (existsSync(sock)) unlinkSync(sock);
          } catch {
            // best effort
          }
          setTimeout(becomeBroker, RETRY_MS);
        });
        return;
      }
      setTimeout(elect, RETRY_MS);
    });
    try {
      mkdirSync(path.dirname(sock), { recursive: true });
    } catch {
      // dir may already exist
    }
    // No blind unlink: a concurrent starter may have just bound this path. EADDRINUSE above tells a
    // live broker from a stale file, so we never delete a socket someone is using.
    srv.listen(sock, () => {
      if (closed) {
        // Closed while binding: don't publish a live broker; tear the socket back down.
        try {
          srv.close();
        } catch {
          // already down
        }
        return;
      }
      server = srv;
      role = "broker";
      roster = rosterFromClients();
    });
  };

  const elect = (): void => {
    if (closed || electing || role === "broker") return;
    electing = true;
    role = "connecting";
    const socket = net.connect(sock);
    connecting = socket;
    let connected = false;
    socket.on("connect", () => {
      connecting = undefined;
      if (closed) {
        socket.destroy(); // closed mid-connect: don't register a ghost with the broker
        return;
      }
      connected = true;
      electing = false;
      client = socket;
      role = "client";
      socket.write(`${JSON.stringify({ t: "hello", self } satisfies Wire)}\n`);
    });
    readLines(socket, (msg) => {
      if (msg.t === "peers") roster = msg.peers;
      else if (msg.t === "dm") deliver({ from: msg.from, payload: msg.payload, via: "local" });
    });
    socket.on("error", () => undefined); // handled by 'close'
    socket.once("close", () => {
      if (client === socket) client = undefined;
      if (connecting === socket) connecting = undefined;
      electing = false;
      if (closed) return;
      if (!connected) becomeBroker(); // no broker was there -> take the socket
      else setTimeout(elect, RETRY_MS); // broker went away -> connect to the next one (or become it)
    });
  };

  elect();

  return {
    role: () => role,
    peers: () => roster.map((info) => ({ ...info, via: "local" })),
    send: (to, payload) => {
      if (!roster.some((info) => info.id === to)) return false;
      if (role === "broker") {
        routeDm(to, self.id, payload);
        return true;
      }
      // Client path: during a broker failover the roster can still list peers while our connection
      // is gone and we are re-electing. Report that honestly instead of a silent drop that looks ok.
      if (client) {
        client.write(`${JSON.stringify({ t: "dm", to, from: self.id, payload } satisfies Wire)}\n`);
        return true;
      }
      return false;
    },
    drain: () => inbox.splice(0, inbox.length),
    updateSelf: (next) => {
      // Reassigning the `self` param updates every closure that reads it (rosterFromClients, routeDm,
      // send, hello). Then re-announce.
      self = next;
      if (role === "broker") {
        // We own the roster: rebuild from our clients (which includes the new self) and broadcast.
        roster = rosterFromClients();
        broadcastPeers();
      } else if (client && !client.destroyed) {
        // We are a client: our roster comes from the broker's broadcasts. Do NOT rebuild it here —
        // rosterFromClients() would collapse it to just [self] (our clients map is empty), dropping
        // every peer until the next broadcast. Re-send hello; the broker updates our entry and
        // broadcasts the full roster back.
        client.write(`${JSON.stringify({ t: "hello", self } satisfies Wire)}\n`);
      }
      // connecting (mid-failover): elect() sends hello with the current self on reconnect.
    },
    async close() {
      if (closed) return; // idempotent: a second close must not unlink a successor broker's socket
      closed = true;
      client?.destroy();
      client = undefined;
      connecting?.destroy(); // cancel an in-flight connection so it never registers post-close
      connecting = undefined;
      const srv = server;
      server = undefined;
      if (srv) {
        // Drop connected clients first: server.close() waits for open connections to end, and they
        // only end once they see us go — so closing them is also how clients learn to re-elect.
        for (const socket of clients.keys()) socket.destroy();
        clients.clear();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        try {
          if (existsSync(sock)) unlinkSync(sock);
        } catch {
          // best effort
        }
      }
    },
  };
}

/** Split a socket's byte stream into newline-delimited JSON messages. Bad lines are skipped. */
function readLines(socket: net.Socket, onMessage: (msg: Wire) => void): void {
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
        onMessage(JSON.parse(line) as Wire);
      } catch {
        // A partial or malformed line is not worth taking the process down for.
      }
    }
  });
}
