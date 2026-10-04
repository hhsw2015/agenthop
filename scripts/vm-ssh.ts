#!/usr/bin/env -S npx tsx
/**
 * vm-ssh — one command to get a VM you can `tailcat ssh` into. SELF-CONTAINED single file, ZERO swarm imports: copy it
 * into any project. Contract frozen in docs/swarm/vm-ssh-brief.md. The deliverable is a bare machine reachable by
 * `tailcat ssh <addr>` — cloning, worker bootstrap, supervision are the caller's job (inject via `up --init`).
 *
 * Verbs:
 *   vm-ssh up [--open] [--init <script>] [--key <pubkey-file>] [--name <alias>]
 *   vm-ssh ssh [id] [-- <cmd...>]
 *   vm-ssh ls [--json]
 *   vm-ssh refresh <id>
 *
 * Lifetime is a PLATFORM FACT: every box auto-destroys ~1h after allocation — no down verb, no ttl, no renewal. Work
 * longer than 1h must be "one box per hour" with state kept OUTSIDE the VM. Local side only does bookkeeping: a dangling
 * address file is pruned when `ls`/`ssh` probes it.
 *
 * Credential discipline: a tailcat address embeds a pre-shared key. It is written 0600 and NEVER printed to stdout, a
 * log, or a command-line argument that `ps` could show (only `tailcat ssh` receives it, as its documented interface).
 *
 * PROVIDER SEAM (Railway hardwired): the only provider-specific code is the three functions in the PROVIDER section
 * below (provision / reach-again / destroy). Swap them to port to another provider; nothing else changes.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const TTL_SEC = 3600; // platform auto-destroy ~1h (vm-ssh-brief: not our knob)

// ─────────────────────────── PROVIDER SEAM (Railway) ───────────────────────────
// Railway hands out a ~60-min box over `ssh railway.new <script>`. The per-box throwaway key IS the box handle: the
// SAME key reaches the SAME live box (reuse), a NEW key gets a fresh box. Destroy is the platform's job (no verb).

/** Pinned tailcat version the box installs. Seam: bump this one line when tailcat releases (vm-ssh-brief). */
const TAILCAT_VERSION = "0.7.0";
/** How the box installs tailcat: the goreleaser linux tarball (binary at its root) → /usr/local/bin, else ~/.local/bin. */
const TAILCAT_INSTALL = [
  "if ! command -v tailcat >/dev/null 2>&1; then",
  '  _a=$(uname -m); case "$_a" in x86_64) _a=amd64;; aarch64|arm64) _a=arm64;; armv7l) _a=armv7;; esac;',
  `  _u="https://github.com/tailscale/tailcat/releases/download/v${TAILCAT_VERSION}/tailcat_${TAILCAT_VERSION}_linux_\${_a}.tar.gz";`,
  '  curl -fsSL "$_u" -o /tmp/tc.tgz && tar xzf /tmp/tc.tgz -C /tmp tailcat && (install -m 0755 /tmp/tailcat /usr/local/bin/tailcat 2>/dev/null || { mkdir -p "$HOME/.local/bin" && install -m 0755 /tmp/tailcat "$HOME/.local/bin/tailcat"; });',
  "fi",
  'command -v tailcat >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$PATH"',
].join("\n");

/** Optional SOCKS5 egress for the provisioning ssh. Railway rate-limits anonymous `railway.new` PER SOURCE IP, so a
 *  proxy that rotates egress IPs raises the allocation success rate. The swarm points this at its ECH proxy POOL
 *  (packages/bus/src/swarm/cf-proxy.ts: a SOCKS5 server round-robining many Cloudflare-Worker edge IPs — abundant IPs
 *  ⇒ each retry a fresh one); any SOCKS5 works (a personal local proxy too, though a single IP won't benefit from
 *  retries). AGENTHOP_SSH_PROXY = "host:port" or "socks5://host:port". */
function proxyOpts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENTHOP_SSH_PROXY?.trim();
  if (!raw) return [];
  return ["-o", `ProxyCommand=nc -X 5 -x ${raw.replace(/^socks5?:\/\//i, "")} %h %p`];
}

const isolatedKeyOpts = (keyPath: string, knownHosts: string): string[] => [
  "-i", keyPath,
  "-o", "IdentitiesOnly=yes",
  "-o", "IdentityAgent=none",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", `UserKnownHostsFile=${knownHosts}`,
  ...proxyOpts(),
];

/** Railway's PRE-PROVISION IP-gate refusal ("Anonymous visitors are limited") — the box was NOT created, so retrying
 *  via a fresh egress IP is safe (no orphan box). Carries the signup URL for the no-proxy case. */
class RailwayRefused extends Error {
  constructor(public readonly signupUrl: string) {
    super(`Railway refused anonymous provisioning (per-source-IP limit). Sign up: ${signupUrl}  — or route an IP-rotating SOCKS proxy via AGENTHOP_SSH_PROXY (the swarm's ECH proxy pool), then retry.`);
    this.name = "RailwayRefused";
  }
}

/** provision/reach: run a script on the box named by `keyPath` (new key ⇒ new box; existing key ⇒ same box). A
 *  pre-provision IP-gate refusal becomes a retryable RailwayRefused (see provisionWithRetry). */
async function railwayRun(keyPath: string, knownHosts: string, remoteScript: string, timeoutMs = 180_000): Promise<string> {
  const refusal = (out: string): RailwayRefused | undefined => {
    if (!out.includes('"status":"refused"')) return undefined;
    let url = "https://railway.com";
    try { url = (JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { human_signup_url?: string }).human_signup_url ?? url; } catch { /* keep default */ }
    return new RailwayRefused(url);
  };
  try {
    const { stdout } = await execFileP("ssh", [...isolatedKeyOpts(keyPath, knownHosts), "railway.new", remoteScript], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const r = refusal(stdout.toString());
    if (r) throw r;
    return stdout.toString();
  } catch (e) {
    if (e instanceof RailwayRefused) throw e;
    const r = refusal(`${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`);
    if (r) throw r;
    throw e;
  }
}

/** Allocate, retrying the IP-gate refusal ONLY when an egress proxy is set: the ECH proxy pool round-robins a fresh
 *  Cloudflare edge IP per connection, so each retry sees a new source IP and the abundant pool makes success likely.
 *  With no proxy every retry reuses the one blocked IP — pointless — so fail fast with the signup hint. */
async function provisionWithRetry(keyPath: string, knownHosts: string, bootstrap: string): Promise<string> {
  const maxTries = process.env.AGENTHOP_SSH_PROXY?.trim() ? 8 : 1;
  for (let i = 1; ; i++) {
    try { return await railwayRun(keyPath, knownHosts, bootstrap); }
    catch (e) {
      if (!(e instanceof RailwayRefused) || i >= maxTries) throw e;
      process.stderr.write(`vm-ssh up: egress IP gated (attempt ${i}/${maxTries}); retrying through the proxy pool for a fresh IP…\n`);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}
function providerDestroy(): void {
  /* no-op: Railway auto-destroys the box ~1h after allocation (vm-ssh-brief). Local bookkeeping only. */
}
// ───────────────────────────────────────────────────────────────────────────────

// ─────────────────────── BUNDLED ECH PROXY POOL (inlined) ───────────────────────
// A SOCKS5 server tunneling TCP through Cloudflare-Worker WebSocket tunnels — the swarm's ECH proxy pool. Each worker
// domain = one Cloudflare edge exit IP; round-robin spreads each `ssh railway.new` across fresh IPs to beat Railway's
// per-source-IP gate (abundant IPs ⇒ a clean one is a retry away). Pool domains + edge IP are inlined so vm-ssh needs
// NO external config file; the shared worker TOKEN is a secret and is NEVER committed — it comes from CF_PROXY_TOKEN or
// ~/.vm-ssh/token (0600). Tunnel ported from packages/bus/src/swarm/cf-proxy.ts.
const ECH_POOL_IP = "172.64.80.1";
const ECH_POOL_DOMAINS = [
  "ech-workers.pikapk-f47.workers.dev:443",
  "ech.alias1.workers.dev:443", "ech.alias2.workers.dev:443", "ech.alias3.workers.dev:443", "ech.alias4.workers.dev:443",
  "ech.alias5.workers.dev:443", "ech.alias6.workers.dev:443", "ech.alias7.workers.dev:443", "ech.alias8-9c7.workers.dev:443",
  "ech.alias9.workers.dev:443", "ech.alias10.workers.dev:443", "ech.alias11.workers.dev:443", "ech.alias12.workers.dev:443",
  "ech.alias13.workers.dev:443", "ech.alias14.workers.dev:443", "ech.alias15.workers.dev:443", "ech.alias16.workers.dev:443",
  "ech.alias17.workers.dev:443", "ech.alias18.workers.dev:443", "ech.alias19.workers.dev:443", "ech.alias20.workers.dev:443",
];
const DEFAULT_PROXY_PORT = 10900;
type EchWorker = { domain: string; ip: string; token: string };

/** The shared ECH-worker token — the one secret, NEVER inlined/committed. CF_PROXY_TOKEN env, else ~/.vm-ssh/token (0600). */
function echToken(): string | undefined {
  const env = process.env.CF_PROXY_TOKEN?.trim();
  if (env) return env;
  try { const t = readFileSync(path.join(homedir(), ".vm-ssh", "token"), "utf8").trim(); if (t) return t; } catch { /* no file */ }
  return undefined;
}

let workerIdx = 0;
const parseHostPort = (addr: string): [string, string] => { const i = addr.lastIndexOf(":"); return [addr.slice(0, i), addr.slice(i + 1)]; };

function wsFrame(opcode: number, payload: Buffer): Buffer { // masked (client→server)
  const len = payload.length;
  let header: Buffer;
  if (len < 126) { header = Buffer.alloc(2); header[0] = opcode; header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ maskKey[i % 4]!;
  return Buffer.concat([header, maskKey, masked]);
}
function parseWsFrame(buf: Buffer): { payload: Buffer; totalLen: number } | undefined {
  if (buf.length < 2) return undefined;
  const masked = !!(buf[1]! & 0x80);
  let payloadLen = buf[1]! & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { if (buf.length < 4) return undefined; payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { if (buf.length < 10) return undefined; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return undefined;
    const maskKey = buf.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i]! ^ maskKey[i % 4]!;
    return { payload, totalLen: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return undefined;
  return { payload: buf.subarray(offset, offset + payloadLen), totalLen: offset + payloadLen };
}
function wrapWsStream(sock: Socket, initial: Buffer): Duplex {
  let readBuf = initial;
  const duplex = new Duplex({
    read() { /* pushed from sock 'data' */ },
    write(chunk: Buffer, _enc, cb) { sock.write(wsFrame(0x82, chunk), cb); },
    destroy(_err, cb) { sock.destroy(); cb(null); },
  });
  const pump = () => { while (readBuf.length > 0) { const f = parseWsFrame(readBuf); if (!f) break; duplex.push(f.payload); readBuf = readBuf.subarray(f.totalLen); } };
  pump();
  sock.on("data", (d) => { readBuf = Buffer.concat([readBuf, d]); pump(); });
  sock.on("close", () => duplex.push(null));
  sock.on("error", (e) => duplex.destroy(e));
  return duplex;
}
function dialWorker(w: EchWorker, target: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const [host, port] = parseHostPort(w.domain);
    const raw = netConnect(Number(port), w.ip || host, () => {
      const sock = tlsConnect({ socket: raw, servername: host, minVersion: "TLSv1.3" }, () => {
        const key = randomBytes(16).toString("base64");
        sock.write([`GET / HTTP/1.1`, `Host: ${host}`, `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Protocol: ${w.token}`, "", ""].join("\r\n"));
        let headerBuf = "";
        const onData = (chunk: Buffer) => {
          headerBuf += chunk.toString();
          const endIdx = headerBuf.indexOf("\r\n\r\n");
          if (endIdx < 0) return;
          sock.removeListener("data", onData);
          if (!headerBuf.split("\r\n")[0]!.includes("101")) { sock.destroy(); reject(new Error(`WS upgrade failed: ${headerBuf.split("\r\n")[0]}`)); return; }
          sock.write(wsFrame(0x81, Buffer.from(`CONNECT:${target}|`)));
          let frameBuf = Buffer.from(headerBuf.slice(endIdx + 4));
          const onFrame = (d: Buffer) => {
            frameBuf = Buffer.concat([frameBuf, d]);
            const parsed = parseWsFrame(frameBuf);
            if (!parsed) return;
            sock.removeListener("data", onFrame);
            if (parsed.payload.toString() !== "CONNECTED") { sock.destroy(); reject(new Error(`CONNECT rejected: ${parsed.payload.toString()}`)); return; }
            resolve(wrapWsStream(sock, frameBuf.subarray(parsed.totalLen)));
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
function handleSocks5(client: Socket, workers: EchWorker[]): void {
  let state: "greeting" | "request" | "connected" = "greeting";
  let buf = Buffer.alloc(0);
  client.on("data", async (d) => {
    buf = Buffer.concat([buf, d]);
    if (state === "greeting") { if (buf.length < 2) return; client.write(Buffer.from([0x05, 0x00])); buf = Buffer.alloc(0); state = "request"; return; }
    if (state === "request") {
      if (buf.length < 7) return;
      if (buf[0] !== 0x05 || buf[1] !== 0x01) { client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); client.destroy(); return; }
      let host: string; let port: number; let consumed: number;
      if (buf[3] === 0x01) { if (buf.length < 10) return; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; port = buf.readUInt16BE(8); consumed = 10; }
      else if (buf[3] === 0x03) { const dlen = buf[4]!; if (buf.length < 5 + dlen + 2) return; host = buf.subarray(5, 5 + dlen).toString(); port = buf.readUInt16BE(5 + dlen); consumed = 7 + dlen; }
      else { client.destroy(); return; }
      const target = `${host}:${port}`;
      buf = buf.subarray(consumed); state = "connected"; client.pause();
      const w = workers[workerIdx++ % workers.length]!;
      try {
        const remote = await dialWorker(w, target);
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(remote); remote.pipe(client);
        if (buf.length) remote.write(buf);
        client.resume();
      } catch { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); client.destroy(); }
    }
  });
  client.on("error", () => {});
}
function startSocksProxy(port: number, workers: EchWorker[]): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const srv = createServer((client) => handleSocks5(client, workers));
    srv.listen(port, "127.0.0.1", () => resolve({ port: (srv.address() as { port: number }).port }));
  });
}

// --- proxy lifecycle: a detached background SOCKS server + a pidfile so down/status/auto-reuse work ---
const proxyStatePath = (): string => path.join(homedir(), ".vm-ssh", "proxy.json");
type ProxyState = { pid: number; port: number; startedSec: number };
function readProxyState(): ProxyState | undefined { try { return JSON.parse(readFileSync(proxyStatePath(), "utf8")) as ProxyState; } catch { return undefined; } }
function proxyAlive(s: ProxyState): boolean { try { process.kill(s.pid, 0); return true; } catch { return false; } }
const portOpen = (port: number): Promise<boolean> => new Promise((res) => { const s = netConnect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 1500); });

/** Ensure a usable egress proxy for `up`. Returns the SOCKS endpoint, or undefined to go direct. A caller-set
 *  AGENTHOP_SSH_PROXY wins (we leave it). Else reuse a running bundled proxy, else auto-start one if a token exists. */
async function ensureProxyForUp(): Promise<string | undefined> {
  if (process.env.AGENTHOP_SSH_PROXY?.trim()) return undefined; // caller's proxy; proxyOpts already uses it
  const st = readProxyState();
  if (st && proxyAlive(st) && (await portOpen(st.port))) { process.env.AGENTHOP_SSH_PROXY = `127.0.0.1:${st.port}`; return `127.0.0.1:${st.port}`; }
  if (!echToken()) return undefined; // no token -> can't start the ECH pool; go direct (railway may gate -> clear error)
  process.stderr.write("vm-ssh up: no proxy running; auto-starting the bundled ECH proxy pool…\n");
  const port = await startDetachedProxy(DEFAULT_PROXY_PORT);
  process.env.AGENTHOP_SSH_PROXY = `127.0.0.1:${port}`;
  return `127.0.0.1:${port}`;
}

/** Spawn this script's `__proxy-serve` as a DETACHED background process and record its pidfile. */
async function startDetachedProxy(port: number): Promise<number> {
  const self = fileURLToPath(import.meta.url);
  const child = spawn("npx", ["tsx", self, "__proxy-serve", "--port", String(port)], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await portOpen(port)) { writeProxyStateFile({ pid: child.pid ?? -1, port, startedSec: Math.floor(Date.now() / 1000) }); return port; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`vm-ssh: bundled proxy did not come up on :${port} within 30s`);
}
function writeProxyStateFile(s: ProxyState): void { mkdirSync(path.join(homedir(), ".vm-ssh"), { recursive: true }); writeFileSync(proxyStatePath(), `${JSON.stringify(s)}\n`, { mode: 0o600 }); }

async function cmdProxyUp(args: Args): Promise<void> {
  if (!echToken()) throw new Error("vm-ssh proxy up: no ECH token — set CF_PROXY_TOKEN or write ~/.vm-ssh/token (0600)");
  const st = readProxyState();
  if (st && proxyAlive(st) && (await portOpen(st.port))) { process.stdout.write(`${JSON.stringify({ port: st.port, pid: st.pid, reused: true })}\n`); return; }
  const port = Number(args.val("--port") ?? DEFAULT_PROXY_PORT);
  const actual = await startDetachedProxy(port);
  process.stdout.write(`${JSON.stringify({ port: actual, addr: `127.0.0.1:${actual}`, workers: ECH_POOL_DOMAINS.length })}\n`);
}
function cmdProxyDown(): void {
  const st = readProxyState();
  if (!st) { process.stdout.write("(no bundled proxy recorded)\n"); return; }
  try { process.kill(st.pid); } catch { /* already gone */ }
  try { rmSync(proxyStatePath()); } catch { /* ok */ }
  process.stdout.write(`${JSON.stringify({ stopped: st.pid, port: st.port })}\n`);
}
async function cmdProxyStatus(args: Args): Promise<void> {
  const st = readProxyState();
  const up = st ? proxyAlive(st) && (await portOpen(st.port)) : false;
  const info = { running: up, ...(st ?? {}), workers: ECH_POOL_DOMAINS.length, tokenConfigured: Boolean(echToken()) };
  if (args.has("--json")) { process.stdout.write(`${JSON.stringify(info)}\n`); return; }
  process.stdout.write(up ? `ECH proxy up on 127.0.0.1:${st!.port} (pid ${st!.pid}, ${ECH_POOL_DOMAINS.length} workers)\n` : `ECH proxy down (token ${echToken() ? "configured" : "MISSING: set CF_PROXY_TOKEN or ~/.vm-ssh/token"})\n`);
}
/** Internal: run the bundled SOCKS server in the foreground (spawned detached by proxy up / auto-start). */
async function serveProxy(args: Args): Promise<void> {
  const token = echToken();
  if (!token) { process.stderr.write("__proxy-serve: no ECH token (CF_PROXY_TOKEN or ~/.vm-ssh/token)\n"); process.exit(1); }
  const port = Number(args.val("--port") ?? DEFAULT_PROXY_PORT);
  await startSocksProxy(port, ECH_POOL_DOMAINS.map((domain) => ({ domain, ip: ECH_POOL_IP, token })));
  await new Promise(() => { /* serve forever */ });
}
// ───────────────────────────────────────────────────────────────────────────────

type Mode = "keyed" | "open";
type Meta = { id: string; mode: Mode; createdSec: number; keyPath: string; knownHosts: string; addrFile: string };

const addrDir = (): string => process.env.VM_SSH_DIR?.trim() || path.join(homedir(), ".vm-ssh");
const addrPath = (id: string): string => path.join(addrDir(), `${id}.addr`);
const metaPath = (id: string): string => path.join(addrDir(), `${id}.meta.json`);
const keyBoxDir = (id: string): string => path.join(homedir(), ".vm-ssh", "boxes", id);

function genId(): string { return `vm-${randomUUID().slice(0, 8)}`; }

/** A tailcat address: "tc" + ~154 base64url-ish chars. Tolerates surrounding whitespace; rejects anything else so a
 *  truncated/half-written capture reads as "no address" rather than a bad connect. (matches node-introspect parseAddress) */
export function parseAddress(raw: string): string | undefined {
  const m = raw.trim().match(/^tc[A-Za-z0-9_-]{100,220}$/);
  return m ? m[0] : undefined;
}
/** The only form of an address that may be logged/printed: a short head + length, never the body. */
export function redactAddress(addr: string | undefined): string {
  return addr ? `${addr.slice(0, 6)}…(${addr.length})` : "(none)";
}

function writeAddr(id: string, addr: string): void {
  mkdirSync(addrDir(), { recursive: true });
  writeFileSync(addrPath(id), `${addr}\n`, { mode: 0o600 });
  chmodSync(addrPath(id), 0o600);
}
function readAddr(id: string): string | undefined {
  try { return parseAddress(readFileSync(addrPath(id), "utf8")); } catch { return undefined; }
}
function writeMeta(m: Meta): void {
  mkdirSync(addrDir(), { recursive: true });
  writeFileSync(metaPath(m.id), `${JSON.stringify(m)}\n`, { mode: 0o600 });
}
function readMeta(id: string): Meta | undefined {
  try { return JSON.parse(readFileSync(metaPath(id), "utf8")) as Meta; } catch { return undefined; }
}
function allIds(): string[] {
  try { return readdirSync(addrDir()).filter((f) => f.endsWith(".meta.json")).map((f) => f.slice(0, -".meta.json".length)); } catch { return []; }
}
function remainingSec(m: Meta, now = Date.now()): number { return m.createdSec + TTL_SEC - Math.floor(now / 1000); }
function prune(id: string): void { for (const p of [addrPath(id), metaPath(id)]) try { rmSync(p); } catch { /* ok */ } try { rmSync(keyBoxDir(id), { recursive: true, force: true }); } catch { /* ok */ } }

/** Resolve a (possibly partial) id to exactly one live box; never silently pick one. Prunes expired boxes first. */
function resolveId(partial: string | undefined): string {
  for (const id of allIds()) if (remainingSec(readMeta(id)!) <= 0) prune(id); // dangling by platform TTL
  const live = allIds();
  if (live.length === 0) throw new Error("no live vm-ssh boxes");
  if (partial === undefined) {
    if (live.length === 1) return live[0]!;
    throw new Error(`id required — ${live.length} boxes: ${live.join(", ")}`);
  }
  const hits = live.filter((id) => id === partial || id.startsWith(partial));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new Error(`no box matches "${partial}" (have: ${live.join(", ")})`);
  throw new Error(`ambiguous "${partial}" matches: ${hits.join(", ")}`);
}

/** keyed-mode public key. `tailcat ssh` authenticates via the ssh-AGENT (it rejects -i), so the key authorized on the
 *  box must be one the agent will offer. Order: --key file → the agent's own key (zero-op, guaranteed usable) → the
 *  first ~/.ssh/id_*.pub (best-effort ssh-add) → auto-generate ~/.vm-ssh/key + ssh-add. */
function resolvePubKey(keyFile: string | undefined): string {
  if (keyFile) return readFileSync(keyFile, "utf8").trim();
  try {
    const agent = execFileSync("ssh-add", ["-L"], { encoding: "utf8" });
    const first = agent.split("\n").find((l) => l.startsWith("ssh-"));
    if (first) return first.trim(); // the agent already holds a usable key — keyed is truly zero-op
  } catch { /* no agent / empty — fall through */ }
  const sshDir = path.join(homedir(), ".ssh");
  try {
    const pub = readdirSync(sshDir).filter((f) => /^id_.*\.pub$/.test(f)).sort()[0];
    if (pub) {
      try { execFileSync("ssh-add", [path.join(sshDir, pub.replace(/\.pub$/, ""))], { stdio: "ignore" }); } catch { /* may need a passphrase; connect fails until added */ }
      return readFileSync(path.join(sshDir, pub), "utf8").trim();
    }
  } catch { /* fall through to autogen */ }
  const vmDir = path.join(homedir(), ".vm-ssh");
  const kp = path.join(vmDir, "key");
  if (!existsSync(`${kp}.pub`)) {
    mkdirSync(vmDir, { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", kp, "-N", "", "-q"]);
  }
  try { execFileSync("ssh-add", [kp], { stdio: "ignore" }); } catch { /* agent may be absent; connect fails until added */ }
  return readFileSync(`${kp}.pub`, "utf8").trim();
}

/** POSIX single-quote for safe embedding in the remote shell script. */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The remote bootstrap: install tailcat → optional --init → start serve (background) writing its address to a file →
 *  echo the address back over ssh stdout as VMSSH_ADDR=. open mode = no-auth-ssh; keyed mode = authorized-keys + ssh. */
export function buildBootstrap(mode: Mode, pubKey: string | undefined, initScript: string | undefined): string {
  const serveArgs = mode === "open" ? "no-auth-ssh" : `--ssh-authorized-keys=${shq(pubKey ?? "")} ssh`;
  return [
    "set -u",
    TAILCAT_INSTALL,
    initScript ?? "",
    "_A=/tmp/vmssh.addr; rm -f \"$_A\"",
    `TAILCAT_ADDR_FILE="$_A" nohup tailcat serve ${serveArgs} >/tmp/vmssh.serve.log 2>&1 &`,
    'for _i in $(seq 1 60); do [ -s "$_A" ] && break; sleep 0.5; done',
    "printf 'VMSSH_ADDR=%s\\n' \"$(cat \"$_A\" 2>/dev/null)\"",
  ].filter(Boolean).join("\n");
}

/** Pull the captured address out of the box's bootstrap stdout. */
export function parseCapturedAddr(stdout: string): string | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith("VMSSH_ADDR="));
  return line ? parseAddress(line.slice("VMSSH_ADDR=".length)) : undefined;
}

async function cmdUp(args: Args): Promise<void> {
  const mode: Mode = args.has("--open") ? "open" : "keyed";
  const id = args.val("--name") ?? genId();
  if (readMeta(id)) throw new Error(`name "${id}" already in use`);
  const pubKey = mode === "keyed" ? resolvePubKey(args.val("--key")) : undefined;
  const initFile = args.val("--init");
  const initScript = initFile ? readFileSync(initFile, "utf8") : undefined;

  const dir = keyBoxDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, "id");
  const knownHosts = path.join(dir, "known_hosts");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);

  await ensureProxyForUp(); // caller's AGENTHOP_SSH_PROXY wins; else reuse/auto-start the bundled ECH proxy pool
  const stdout = await provisionWithRetry(keyPath, knownHosts, buildBootstrap(mode, pubKey, initScript));
  const addr = parseCapturedAddr(stdout);
  if (!addr) throw new Error("vm-ssh up: no tailcat address captured from the box (serve may have failed; see /tmp/vmssh.serve.log on the box)");

  writeAddr(id, addr);
  writeMeta({ id, mode, createdSec: Math.floor(Date.now() / 1000), keyPath, knownHosts, addrFile: addrPath(id) });
  process.stdout.write(`${JSON.stringify({ id, addrFile: addrPath(id), mode })}\n`); // address itself stays in the 0600 file
}

async function cmdSsh(args: Args): Promise<void> {
  const rest = args.rest(); // [id?] before a `--`
  const id = resolveId(rest[0]);
  const addr = readAddr(id);
  if (!addr) { prune(id); throw new Error(`no address for "${id}" (box gone or not captured) — try: vm-ssh refresh ${id}`); }
  const remoteCmd = args.afterDashDash();
  // spawn (not execFile) with inherited stdio: an interactive shell / streamed remote-command output must pass through,
  // and the address goes only to tailcat's argv (its documented interface), never to our stdout/log.
  const child = spawn("tailcat", ["ssh", addr, ...remoteCmd], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => { child.on("exit", (code) => (code ? reject(new Error(`tailcat ssh exited ${code}`)) : resolve())); child.on("error", reject); });
}

function cmdLs(args: Args): void {
  for (const id of allIds()) if (remainingSec(readMeta(id)!) <= 0) prune(id);
  const rows = allIds().map((id) => { const m = readMeta(id)!; return { id, mode: m.mode, createdSec: m.createdSec, remainingSec: Math.max(0, remainingSec(m)), addrFile: m.addrFile }; });
  if (args.has("--json")) { process.stdout.write(`${JSON.stringify(rows)}\n`); return; }
  if (rows.length === 0) { process.stdout.write("(no live boxes)\n"); return; }
  for (const r of rows) process.stdout.write(`${r.id}\t${r.mode === "open" ? "OPEN⚠" : "keyed"}\t~${Math.floor(r.remainingSec / 60)}m left\t${r.addrFile}\n`);
}

async function cmdRefresh(args: Args): Promise<void> {
  const id = resolveId(args.rest()[0]);
  const m = readMeta(id)!;
  // same key ⇒ same box: re-read the address the box's serve wrote (survives a serve restart that changed the address).
  const stdout = await railwayRun(m.keyPath, m.knownHosts, "printf 'VMSSH_ADDR=%s\\n' \"$(cat /tmp/vmssh.addr 2>/dev/null)\"");
  const addr = parseCapturedAddr(stdout);
  if (!addr) { throw new Error(`vm-ssh refresh: box "${id}" returned no address (it may be destroyed; run vm-ssh ls)`); }
  writeAddr(id, addr);
  process.stdout.write(`${JSON.stringify({ id, addrFile: addrPath(id), mode: m.mode, refreshed: true })}\n`);
}

// ─────────────────────────── tiny arg helper + CLI ───────────────────────────
class Args {
  constructor(private argv: string[]) {}
  has(flag: string): boolean { return this.argv.includes(flag); }
  val(flag: string): string | undefined { const i = this.argv.indexOf(flag); return i >= 0 ? this.argv[i + 1] : undefined; }
  /** positionals before a `--`, excluding flag names and their values. */
  rest(): string[] {
    const end = this.argv.indexOf("--");
    const head = end >= 0 ? this.argv.slice(0, end) : this.argv;
    const out: string[] = [];
    for (let i = 0; i < head.length; i++) { const a = head[i]!; if (a.startsWith("--")) { if (!["--open", "--json"].includes(a)) i++; continue; } out.push(a); }
    return out;
  }
  afterDashDash(): string[] { const i = this.argv.indexOf("--"); return i >= 0 ? this.argv.slice(i + 1) : []; }
}

const USAGE = "usage: vm-ssh <up|ssh|ls|refresh|proxy> ...\n  up [--open] [--init <script>] [--key <pubkey-file>] [--name <alias>]\n  ssh [id] [-- <cmd...>]\n  ls [--json]\n  refresh <id>\n  proxy <up|down|status> [--port <n>] [--json]   (bundled ECH pool; token: CF_PROXY_TOKEN or ~/.vm-ssh/token)\n";

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const args = new Args(rest);
  switch (verb) {
    case "up": return cmdUp(args);
    case "ssh": return cmdSsh(args);
    case "ls": return cmdLs(args);
    case "refresh": return cmdRefresh(args);
    case "proxy": {
      const sub = rest[0];
      const subArgs = new Args(rest.slice(1));
      if (sub === "up") return cmdProxyUp(subArgs);
      if (sub === "status") return cmdProxyStatus(subArgs);
      if (sub === "down") { cmdProxyDown(); return; }
      process.stderr.write("usage: vm-ssh proxy <up|down|status> [--port <n>] [--json]\n"); process.exit(1); return;
    }
    case "__proxy-serve": return serveProxy(args); // internal: the detached SOCKS server
    case "--selftest": return selftest();
    default: process.stderr.write(USAGE); process.exit(verb ? 1 : 0);
  }
}

/** Pure-layer self-check (no network): the parsing/resolution/credential helpers the integration rides on. */
function selftest(): void {
  const A = `tc${"A1b2C3d4_-".repeat(15)}`; // ~152 chars, valid shape
  console.assert(parseAddress(`  ${A}\n`) === A, "parseAddress accepts a well-formed address");
  console.assert(parseAddress("tcSHORT") === undefined, "parseAddress rejects too-short");
  console.assert(parseAddress("nope") === undefined, "parseAddress rejects non-tc");
  console.assert(parseCapturedAddr(`log line\nVMSSH_ADDR=${A}\nmore`) === A, "parseCapturedAddr extracts the address");
  console.assert(parseCapturedAddr("VMSSH_ADDR=garbage") === undefined, "parseCapturedAddr validates");
  console.assert(redactAddress(A) === `${A.slice(0, 6)}…(${A.length})` && !redactAddress(A).includes(A), "redactAddress never shows the body");
  console.assert(buildBootstrap("open", undefined, undefined).includes("no-auth-ssh"), "open mode uses no-auth-ssh");
  const kb = buildBootstrap("keyed", "ssh-ed25519 AAAA'B", "echo init");
  console.assert(kb.includes("--ssh-authorized-keys=") && kb.includes("ssh-ed25519") && kb.includes("echo init"), "keyed mode carries the quoted key + init");
  console.assert(kb.includes("'ssh-ed25519 AAAA'\\''B'"), "pubkey is shell-quoted (single-quote escaped)");
  console.assert(new Args(["x", "--", "uptime", "-a"]).afterDashDash().join(" ") === "uptime -a", "afterDashDash splits remote cmd");
  console.assert(new Args(["myid", "--", "uptime"]).rest().join(",") === "myid", "rest() takes positional id before --");
  console.assert(new Args(["--name", "n1", "--open"]).rest().length === 0, "rest() skips flags + flag values");
  console.assert(ECH_POOL_DOMAINS.length === 21, "ECH pool has its inlined workers");
  const fr = parseWsFrame(wsFrame(0x82, Buffer.from("hello ws tunnel"))); // the bundled tunnel's framing round-trips
  console.assert(fr?.payload.toString() === "hello ws tunnel", "ws frame masks + round-trips");
  providerDestroy();
  process.stdout.write("vm-ssh selftest: all assertions passed\n");
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
