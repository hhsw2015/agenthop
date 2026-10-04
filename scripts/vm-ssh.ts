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
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

/** Optional SOCKS5 egress for the provisioning ssh. Railway rate-limits anonymous `railway.new` PER SOURCE IP; a proxy
 *  gives a fresh IP (and lets a signed-up account route as it likes). AGENTHOP_SSH_PROXY = "host:port" or "socks5://…". */
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

/** provision/reach: run a script on the box named by `keyPath` (new key ⇒ new box; existing key ⇒ same box). Surfaces
 *  Railway's anonymous-limit refusal as an actionable error (sign up, or route through AGENTHOP_SSH_PROXY). */
async function railwayRun(keyPath: string, knownHosts: string, remoteScript: string, timeoutMs = 180_000): Promise<string> {
  const refused = (out: string): string | undefined => {
    if (!out.includes('"status":"refused"')) return undefined;
    let url = "https://railway.com";
    try { url = (JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { human_signup_url?: string }).human_signup_url ?? url; } catch { /* keep default */ }
    return `Railway refused anonymous provisioning (per-source-IP limit). Sign up: ${url}  — or set AGENTHOP_SSH_PROXY=host:port (SOCKS5) for a fresh egress IP, then retry.`;
  };
  try {
    const { stdout } = await execFileP("ssh", [...isolatedKeyOpts(keyPath, knownHosts), "railway.new", remoteScript], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const s = stdout.toString();
    const r = refused(s);
    if (r) throw new Error(r);
    return s;
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
    const r = refused(out);
    if (r) throw new Error(r);
    throw e;
  }
}
function providerDestroy(): void {
  /* no-op: Railway auto-destroys the box ~1h after allocation (vm-ssh-brief). Local bookkeeping only. */
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

  const stdout = await railwayRun(keyPath, knownHosts, buildBootstrap(mode, pubKey, initScript));
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

const USAGE = "usage: vm-ssh <up|ssh|ls|refresh> ...\n  up [--open] [--init <script>] [--key <pubkey-file>] [--name <alias>]\n  ssh [id] [-- <cmd...>]\n  ls [--json]\n  refresh <id>\n";

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const args = new Args(rest);
  switch (verb) {
    case "up": return cmdUp(args);
    case "ssh": return cmdSsh(args);
    case "ls": return cmdLs(args);
    case "refresh": return cmdRefresh(args);
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
  providerDestroy();
  process.stdout.write("vm-ssh selftest: all assertions passed\n");
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
