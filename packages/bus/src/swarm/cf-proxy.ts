import { randomBytes } from "node:crypto";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * A SOCKS5 server that tunnels TCP connections through Cloudflare Worker WebSocket tunnels —
 * the same tunnel CPA's proxypool uses (ECH Workers), but without the ECH TLS extension (the Workers
 * accept plain TLS 1.3 + WebSocket upgrade + Sec-WebSocket-Protocol token auth — ECH is only SNI
 * encryption against middleboxes, not a Worker-side requirement). Pure Node.js, no native deps.
 *
 * Each Worker domain = one Cloudflare edge exit IP; connections round-robin across workers so each
 * SSH to Railway sees a different source IP with Cloudflare-grade reputation.
 *
 * Usage:
 *   startCfProxy({ port: 1090, workers: [{domain:"ech-workers.xxx.workers.dev:443", ip:"172.64.80.1", token:"..."}] })
 * Then: ssh -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1090 %h %p' railway.new 'echo hi'
 */

export type CfWorker = { domain: string; ip?: string; token: string };

export type CfProxyOptions = {
  port: number;
  workers: CfWorker[];
};

let workerIdx = 0;

/** Connect to a Worker via TLS + WebSocket upgrade, then CONNECT to the target. Returns a duplex stream. */
function dialWorker(w: CfWorker, target: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const [host, port] = parseHostPort(w.domain);
    const connectHost = w.ip || host;

    const raw = netConnect(Number(port), connectHost, () => {
      const sock = tlsConnect({ socket: raw, servername: host, minVersion: "TLSv1.3" }, () => {
        // WebSocket upgrade (hand-rolled — no ws lib needed)
        const key = randomBytes(16).toString("base64");
        const req = [
          `GET / HTTP/1.1`,
          `Host: ${host}`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Sec-WebSocket-Key: ${key}`,
          `Sec-WebSocket-Version: 13`,
          `Sec-WebSocket-Protocol: ${w.token}`,
          "", "",
        ].join("\r\n");
        sock.write(req);

        let headerBuf = "";
        const onData = (chunk: Buffer) => {
          headerBuf += chunk.toString();
          const endIdx = headerBuf.indexOf("\r\n\r\n");
          if (endIdx < 0) return; // wait for full headers
          sock.removeListener("data", onData);
          const statusLine = headerBuf.split("\r\n")[0]!;
          if (!statusLine.includes("101")) {
            sock.destroy();
            reject(new Error(`WS upgrade failed: ${statusLine}`));
            return;
          }
          // WebSocket is up — send CONNECT as a text frame
          const connectMsg = Buffer.from(`CONNECT:${target}|`);
          sock.write(wsTextFrame(connectMsg));
          // Read the CONNECTED response (a text frame)
          let frameBuf = Buffer.alloc(0);
          // Also handle any leftover data after the HTTP headers
          const leftover = Buffer.from(headerBuf.slice(endIdx + 4));
          if (leftover.length) frameBuf = leftover;

          const onFrame = (d: Buffer) => {
            frameBuf = Buffer.concat([frameBuf, d]);
            const parsed = parseWsFrame(frameBuf);
            if (!parsed) return; // need more data
            sock.removeListener("data", onFrame);
            const resp = parsed.payload.toString();
            if (resp !== "CONNECTED") {
              sock.destroy();
              reject(new Error(`CONNECT rejected: ${resp}`));
              return;
            }
            // From here on, the socket carries raw TCP data wrapped in WS binary frames.
            // We'll bridge at the WS frame level.
            const remaining = frameBuf.subarray(parsed.totalLen);
            resolve(wrapWsStream(sock, remaining));
          };
          sock.on("data", onFrame);
        };
        sock.on("data", onData);
      });
      sock.on("error", reject);
    });
    raw.on("error", reject);
    setTimeout(() => reject(new Error("dial timeout")), 20_000);
  });
}

import { Duplex } from "node:stream";

/** Wrap a TLS socket (carrying WS frames) into a plain duplex that reads/writes raw TCP bytes. */
function wrapWsStream(sock: Socket, initial: Buffer): Duplex {
  let readBuf = initial;

  const duplex = new Duplex({
    read() {
      // data is pushed from the sock 'data' handler below
    },
    write(chunk: Buffer, _enc, cb) {
      sock.write(wsBinaryFrame(chunk), cb);
    },
    destroy(_err, cb) {
      sock.destroy();
      cb(null);
    },
  });

  const pump = () => {
    while (readBuf.length > 0) {
      const f = parseWsFrame(readBuf);
      if (!f) break;
      duplex.push(f.payload);
      readBuf = readBuf.subarray(f.totalLen);
    }
  };
  pump();
  sock.on("data", (d) => {
    readBuf = Buffer.concat([readBuf, d]);
    pump();
  });
  sock.on("close", () => duplex.push(null));
  sock.on("error", (e) => duplex.destroy(e));

  return duplex;
}

// --- WebSocket frame helpers (minimal, unmasked server→client / masked client→server) ---

function wsTextFrame(payload: Buffer): Buffer {
  return wsFrame(0x81, payload, true); // text, masked (client→server must be masked)
}

function wsBinaryFrame(payload: Buffer): Buffer {
  return wsFrame(0x82, payload, true); // binary, masked
}

function wsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = opcode;
    header[1] = (mask ? 0x80 : 0) | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = opcode;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (mask) {
    const maskKey = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ maskKey[i % 4]!;
    return Buffer.concat([header, maskKey, masked]);
  }
  return Buffer.concat([header, payload]);
}

function parseWsFrame(buf: Buffer): { payload: Buffer; totalLen: number } | undefined {
  if (buf.length < 2) return undefined;
  const masked = !!(buf[1]! & 0x80);
  let payloadLen = buf[1]! & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return undefined;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return undefined;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return undefined;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i]! ^ maskKey[i % 4]!;
    return { payload, totalLen: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return undefined;
  return { payload: buf.subarray(offset, offset + payloadLen), totalLen: offset + payloadLen };
}

function parseHostPort(addr: string): [string, string] {
  const idx = addr.lastIndexOf(":");
  return [addr.slice(0, idx), addr.slice(idx + 1)];
}

// --- SOCKS5 server ---

function handleSocks5(client: Socket, workers: CfWorker[]) {
  let state: "greeting" | "request" | "connected" = "greeting";
  let buf = Buffer.alloc(0);

  client.on("data", async (d) => {
    buf = Buffer.concat([buf, d]);

    if (state === "greeting") {
      if (buf.length < 2) return;
      client.write(Buffer.from([0x05, 0x00])); // no auth
      buf = Buffer.alloc(0);
      state = "request";
      return;
    }

    if (state === "request") {
      if (buf.length < 7) return;
      if (buf[0] !== 0x05 || buf[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      let host: string;
      let port: number;
      let consumed: number;
      if (buf[3] === 0x01) { // IPv4
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        port = buf.readUInt16BE(8);
        consumed = 10;
      } else if (buf[3] === 0x03) { // Domain
        const dlen = buf[4]!;
        if (buf.length < 5 + dlen + 2) return;
        host = buf.subarray(5, 5 + dlen).toString();
        port = buf.readUInt16BE(5 + dlen);
        consumed = 7 + dlen;
      } else {
        client.destroy();
        return;
      }
      const target = `${host}:${port}`;
      buf = buf.subarray(consumed);
      state = "connected";
      client.pause();

      // Round-robin worker
      const w = workers[workerIdx++ % workers.length]!;
      try {
        const remote = await dialWorker(w, target);
        // SOCKS5 success
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        // dialWorker already returns a Duplex (WS-unwrapped), just pipe both directions
        client.pipe(remote);
        remote.pipe(client);
        if (buf.length) remote.write(buf);
        client.resume();
        console.log(`CONNECT ${target} via ${w.domain}`);
      } catch (err) {
        console.error(`FAIL ${target} via ${w.domain}: ${err instanceof Error ? err.message : err}`);
        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
      }
    }
  });
  client.on("error", () => {});
}

/** Start a local SOCKS5 proxy that tunnels through Cloudflare Worker WebSocket tunnels. */
export function startCfProxy(options: CfProxyOptions): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((client) => handleSocks5(client, options.workers));
    srv.listen(options.port, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      console.log(`cf-proxy SOCKS5 on :${addr.port} with ${options.workers.length} workers`);
      resolve({ port: addr.port, close: () => srv.close() });
    });
  });
}

// CLI entry
if (process.argv[1] && (process.argv[1].endsWith("cf-proxy.ts") || process.argv[1].endsWith("cf-proxy.js"))) {
  const port = Number(process.env.CF_PROXY_PORT || "1090");
  const token = process.env.CF_PROXY_TOKEN || "";
  const ip = process.env.CF_PROXY_IP || "";
  const domains = (process.env.CF_PROXY_WORKERS || "").split(",").filter(Boolean);
  if (!domains.length || !token) {
    console.error("CF_PROXY_WORKERS=domain1:443,domain2:443 CF_PROXY_TOKEN=... [CF_PROXY_IP=...] [CF_PROXY_PORT=1090]");
    process.exit(1);
  }
  startCfProxy({ port, workers: domains.map((d) => ({ domain: d, ip, token })) });
}
