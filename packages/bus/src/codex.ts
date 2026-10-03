import net from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dbg } from "./debug.js";

/**
 * A persistent connection to Codex's app-server daemon, so we always know the active thread to
 * deliver into — without the agent ever touching the bus (full auto). Codex has no cc-socks-style
 * per-session inbox; its only inbound is this daemon, reachable as a WebSocket over a unix socket.
 *
 * We hold ONE connection open (bun's WebSocket can't do unix sockets and the ws package's ws+unix://
 * is rejected under bun, so we speak a minimal WebSocket over node:net), do the app-server handshake,
 * keep a live view of loaded threads via thread/loaded/list plus notification threadIds, answer pings,
 * and reconnect if it drops. Churny one-shot connections get closed by the daemon; a kept-open one is
 * what antiphon uses and what stays reliable. The protocol is experimental and may change between
 * Codex versions; every failure degrades to the recv queue.
 */

export type CodexDaemon = {
  /** The thread to deliver into. Given the caller's own cwd, the loaded thread whose session cwd matches
   *  it (unambiguously) — so an IDLE session that never touched the bus is still reachable. Falls back to
   *  the sole loaded thread when there is only one, else undefined. */
  activeThread(cwd?: string): string | undefined;
  /** The daemon's CODEX_HOME (from the initialize handshake). `codex queue` needs it to find the thread's
   *  rollout; the MCP subprocess's own env does not carry it. Undefined until the handshake completes. */
  codexHome(): string | undefined;
  close(): void;
};

/**
 * Find the daemon's control socket. The MCP subprocess Codex spawns gets a clean env (no CODEX_HOME),
 * so we can't rely on it: first try CODEX_HOME/~/.codex, then scan the daemon's tmp dir
 * (/tmp/codex-daemon-<uid>/<hash>), which is where the app-server-control symlink actually points.
 */
function controlSocket(): string | undefined {
  if (process.env.AGENTHOP_NO_CODEX) return undefined; // test/opt-out escape hatch
  for (const home of [process.env.CODEX_HOME, path.join(homedir(), ".codex")]) {
    if (!home) continue;
    const s = path.join(home, "app-server-control", "app-server-control.sock");
    if (existsSync(s)) return s;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  for (const base of [`/tmp/codex-daemon-${uid}`, `/private/tmp/codex-daemon-${uid}`]) {
    try {
      const socks = readdirSync(base)
        .filter((e) => !e.endsWith(".lock"))
        .map((e) => path.join(base, e))
        .filter((p) => {
          try {
            return statSync(p).isSocket();
          } catch {
            return false;
          }
        });
      if (socks.length > 0) return socks.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    } catch {
      // dir not present on this platform/layout
    }
  }
  return undefined;
}

/** Whether a Codex app-server daemon socket is reachable — a reliable "this is Codex" signal. */
export function codexDaemonPresent(): boolean {
  return controlSocket() !== undefined;
}

export function startCodexDaemon(): CodexDaemon | undefined {
  const sock = controlSocket();
  dbg(`startCodexDaemon CODEX_HOME=${process.env.CODEX_HOME} sock=${sock}`);
  if (!sock) return undefined;

  let closed = false;
  let loaded: string[] = [];
  // threadId -> its session's cwd (immutable per thread), read once from the daemon. Lets a node pin ITS
  // OWN thread by matching self.cwd, so delivery works even to a session that never called the bus.
  const cwdByThread = new Map<string, string>();
  // The daemon's CODEX_HOME, learned from the initialize result. Passed to `codex queue` so it can find
  // the thread's rollout — the MCP subprocess Codex spawns does not get CODEX_HOME in its own env.
  let codexHome: string | undefined;
  let lastActive: string | undefined;
  let current: net.Socket | undefined;
  let ready = false;
  const pending = new Map<number, string>();
  let nextId = 1;

  const request = (method: string, params: unknown): void => {
    if (!current || !ready) return;
    const id = nextId++;
    pending.set(id, method);
    sendText(current, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  };

  const connect = (): void => {
    if (closed) return;
    ready = false;
    let handshaken = false;
    let buf: Buffer = Buffer.alloc(0);
    // Reassembly state for fragmented WebSocket messages (persists across TCP reads until FIN).
    let fragOpcode = 0; // 0 = no data message in progress; else the opcode of the first fragment
    let fragParts: Buffer[] = [];
    const s = net.connect(sock);
    current = s;
    s.on("connect", () => {
      dbg("daemon socket connected");
      s.write(upgradeRequest());
    });
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const statusLine = buf.subarray(0, end).toString().split("\r\n")[0];
        if (!buf.subarray(0, end).toString().startsWith("HTTP/1.1 101")) {
          dbg(`daemon handshake refused: ${statusLine}`);
          s.destroy();
          return;
        }
        dbg(`daemon handshake ok: ${statusLine}`);
        handshaken = true;
        buf = buf.subarray(end + 4);
        const id = nextId++;
        pending.set(id, "initialize");
        sendText(s, JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: { name: "agenthop-bus", version: "0.6.0" }, capabilities: { experimentalApi: true } } }));
      }
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = f.rest;
        if (f.opcode === 0x9) {
          sendRaw(s, 0xa, f.payloadBuf); // ping -> pong
          continue;
        }
        if (f.opcode === 0x8) {
          s.destroy();
          return;
        }
        // Reassemble fragmented messages: a data frame (text 0x1 / binary 0x2) can arrive split into a
        // first frame with FIN=0 followed by continuation frames (0x0) until FIN=1, with control frames
        // possibly interleaved. Only a COMPLETE text message is valid JSON-RPC. Ignoring this dropped
        // fragmented initialize / thread-list responses.
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          fragOpcode = f.opcode;
          fragParts = [f.payloadBuf];
        } else if (f.opcode === 0x0) {
          if (fragOpcode === 0) continue; // stray continuation with no start frame
          fragParts.push(f.payloadBuf);
        } else {
          continue; // pong or unknown control frame: nothing to assemble
        }
        if (!f.fin) continue; // more fragments still coming
        const messageOpcode = fragOpcode;
        const complete = Buffer.concat(fragParts);
        fragOpcode = 0;
        fragParts = [];
        if (messageOpcode !== 0x1) continue; // only text frames carry JSON-RPC
        let m: { id?: number; method?: string; result?: unknown; params?: { threadId?: string; thread_id?: string } };
        try {
          m = JSON.parse(complete.toString("utf8"));
        } catch {
          continue;
        }
        const tid = m.params?.threadId ?? m.params?.thread_id;
        if (typeof m.method === "string" && typeof tid === "string") lastActive = tid; // foreground activity
        if (m.id != null && pending.has(m.id)) {
          const method = pending.get(m.id)!;
          pending.delete(m.id);
          if (method === "initialize") {
            codexHome = (m.result as { codexHome?: string } | undefined)?.codexHome ?? codexHome;
            dbg(`daemon codexHome=${codexHome}`);
            sendText(s, JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
            ready = true;
            dbg("daemon initialized; requesting thread/loaded/list");
            request("thread/loaded/list", {});
          } else if (method === "thread/loaded/list") {
            loaded = pickThreads(m.result);
            dbg(`daemon loaded=${JSON.stringify(loaded)}`);
            // Learn each loaded thread's cwd once (immutable), and drop entries that have unloaded.
            for (const id of [...cwdByThread.keys()]) if (!loaded.includes(id)) cwdByThread.delete(id);
            for (const id of loaded) if (!cwdByThread.has(id)) request("thread/read", { threadId: id });
          } else if (method === "thread/read") {
            const t = (m.result as { thread?: { id?: string; environments?: { environmentId?: string; cwd?: string }[] } } | undefined)?.thread;
            const cwd = t?.environments?.find((e) => e.environmentId === "local")?.cwd ?? t?.environments?.[0]?.cwd;
            if (t?.id && typeof cwd === "string") { cwdByThread.set(t.id, cwd); dbg(`daemon thread ${t.id} cwd=${cwd}`); }
          }
        }
      }
    });
    s.on("error", (e) => dbg(`daemon socket error: ${e.message}`));
    s.on("close", () => {
      dbg("daemon socket closed");
      ready = false;
      if (current === s) current = undefined;
      if (!closed) setTimeout(connect, 1500);
    });
  };

  connect();
  // Periodic refresh doubles as keepalive traffic so the daemon does not drop us.
  const refresh = setInterval(() => request("thread/loaded/list", {}), 5000);
  refresh.unref?.();

  return {
    // Deliver only to a thread we can pin unambiguously. The daemon is shared across every Codex session
    // for this user, so a global "most recently active" guess can push a message into the wrong session
    // (cross-talk). Two unambiguous pins, in order: (1) the loaded thread whose session cwd equals the
    // caller's own cwd — a correct binding even for an IDLE session that never called the bus, as long as
    // exactly one loaded thread sits in that cwd; (2) the sole loaded thread when there is only one. Any
    // ambiguity (no cwd match, or several threads share the cwd) returns undefined, so the message stays
    // durably queued for agenthop_recv rather than risk the wrong session. The authoritative binding is
    // still ownCodexThread (the thread that actually called this bus), handled in core before this.
    activeThread: (cwd) => pickThreadForCwd(loaded, cwdByThread, cwd),
    codexHome: () => codexHome,
    close: () => {
      closed = true;
      clearInterval(refresh);
      try {
        current?.destroy();
      } catch {
        // already gone
      }
    },
  };
}

function upgradeRequest(): string {
  const key = randomBytes(16).toString("base64");
  return `GET /rpc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
}

function sendText(s: net.Socket, text: string): void {
  sendRaw(s, 0x1, Buffer.from(text, "utf8"));
}

/** Encode one masked client frame (WebSocket clients must mask). */
function sendRaw(s: net.Socket, opcode: number, payload: Buffer): void {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
  try {
    s.write(Buffer.concat([header, mask, masked]));
  } catch {
    // reconnect handles a dead socket
  }
}

/** Decode one WebSocket frame (with its FIN bit); undefined if incomplete. Server frames are unmasked. */
function readFrame(buf: Buffer): { fin: boolean; opcode: number; payloadBuf: Buffer; rest: Buffer } | undefined {
  if (buf.length < 2) return undefined;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buf[1]! & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return undefined;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i & 3]!;
    payload = out;
  }
  return { fin, opcode, payloadBuf: Buffer.from(payload), rest: buf.subarray(offset + maskLen + len) };
}

/**
 * Choose the Codex thread to deliver into, avoiding cross-talk between sessions that share one daemon:
 *  1. the loaded thread whose session cwd UNIQUELY equals the caller's own cwd (reaches an idle session
 *     that never touched the bus — as long as exactly one loaded thread sits in that cwd);
 *  2. otherwise the sole loaded thread, when there is only one;
 *  3. otherwise undefined — ambiguous, so the message stays durably queued rather than risk misdelivery.
 */
export function pickThreadForCwd(loaded: string[], cwdByThread: Map<string, string>, cwd?: string): string | undefined {
  if (cwd) {
    const matches = loaded.filter((id) => cwdByThread.get(id) === cwd);
    if (matches.length === 1) return matches[0];
  }
  return loaded.length === 1 ? loaded[0] : undefined;
}

/** thread/loaded/list data is id strings on Codex 0.158; be lenient about object shapes too. */
function pickThreads(result: unknown): string[] {
  const list = (result as { data?: unknown } | undefined)?.data ?? result;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t === "string") out.push(t);
    else if (t && typeof t === "object") {
      const o = t as { id?: string; threadId?: string; thread_id?: string };
      const id = o.id ?? o.threadId ?? o.thread_id;
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}
