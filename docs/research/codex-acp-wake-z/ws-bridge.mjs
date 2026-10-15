// probe-only: newline JSON on stdio <-> WebSocket text frames on the shared app-server control socket
import net from "node:net"; import { randomBytes } from "node:crypto"; import readline from "node:readline";
const sock = process.env.HOME + "/.codex/app-server-control/app-server-control.sock";
const s = net.connect(sock); let hs = false; let buf = Buffer.alloc(0); const queue = []; let parts = [];
const frame = (op, p) => { const m = randomBytes(4); let h; if (p.length < 126) h = Buffer.from([0x80 | op, 0x80 | p.length]); else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0xfe; h.writeUInt16BE(p.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0xff; h.writeBigUInt64BE(BigInt(p.length), 2); } const x = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) x[i] = p[i] ^ m[i & 3]; return Buffer.concat([h, m, x]); };
const send = (line) => { if (!hs) { queue.push(line); return; } s.write(frame(1, Buffer.from(line))); };
s.on("connect", () => s.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`));
s.on("data", (c) => { buf = Buffer.concat([buf, c]);
  if (!hs) { const e = buf.indexOf("\r\n\r\n"); if (e < 0) return; if (!buf.subarray(0, 12).toString().includes("101")) process.exit(3); hs = true; buf = buf.subarray(e + 4); for (const q of queue.splice(0)) send(q); }
  for (;;) { if (buf.length < 2) break; const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 15; let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + len) break; const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
    if (op === 9) { s.write(frame(10, pl)); continue; } if (op === 8) process.exit(0); if (op === 1 || op === 2) parts = [pl]; else if (op === 0) parts.push(pl); else continue; if (!fin) continue; process.stdout.write(Buffer.concat(parts).toString("utf8") + "\n"); parts = []; } });
s.on("close", () => process.exit(0)); s.on("error", () => process.exit(4));
// the adapter closing our stdout (it exited) is a normal end, not a crash
process.stdout.on("error", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (l) => { if (l.trim()) send(l); }).on("close", () => setTimeout(() => process.exit(0), 200));
