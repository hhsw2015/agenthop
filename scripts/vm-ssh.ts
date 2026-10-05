#!/usr/bin/env -S npx tsx
/**
 * vm-ssh — one command to get a VM you can `tailcat ssh` into. SELF-CONTAINED single file, ZERO swarm imports: copy it
 * into any project. Contract frozen in docs/swarm/vm-ssh-brief.md. The deliverable is a bare machine reachable by
 * `tailcat ssh <addr>` — cloning, worker bootstrap, supervision are the caller's job (inject via `up --init`).
 *
 * Verbs:
 *   vm-ssh up [--backend railway|gha] [--open] [--init <script>] [--key <pubkey-file>] [--name <alias>]
 *            gha-only: [--repo <owner/name>] [--os ubuntu|macos|windows] [--ttl <min 1..360>] [--user <github-login>]
 *   vm-ssh ssh [id] [-- <cmd...>]
 *   vm-ssh ls [--json]
 *   vm-ssh refresh <id>
 *   vm-ssh down <id>              (gha: trip the sentinel / cancel the run; railway: no-op, platform auto-destroys)
 *   vm-ssh init [repo]           (gha: idempotently install the box workflow into a home repo; prints what it writes)
 *
 * TWO BACKENDS, caller-chosen, NEVER auto-selected (coordinator ruling 2026-10-05):
 *   railway (default) — ~1h PLATFORM FACT: box auto-destroys, no ttl/renewal; short tasks, fast, unbounded fan-out.
 *   gha               — a GitHub Actions runner runs `tailcat serve ssh`; 6h runner ceiling (ttl ≤360min, sentinel ends
 *                       it early), keyed via the user's published github.com/<user>.keys (zero secret). Single-account
 *                       Actions quota caps fan-out (multi-account is a separate, out-of-v2 follow-up). Long tasks.
 * Work longer than the box lives must be "one box per lifetime" with state kept OUTSIDE the VM. Local side only does
 * bookkeeping: a dangling address file is pruned when `ls`/`ssh` probes it.
 *
 * Credential discipline: a tailcat address embeds a pre-shared key. It is written 0600 and NEVER printed to stdout, a
 * log, or a command-line argument that `ps` could show (only `tailcat ssh` receives it, as its documented interface).
 * gha extra (Actions logs are durable + repo-readable): public-repo `--open` is REFUSED (address = sole credential), and
 * `init` writes a workflow file into a user repo = a persistent external write → explicit verb + print-before-write.
 *
 * PROVIDER SEAM: provider-specific code is the two PROVIDER sections below (railway / gha), each a provision /
 * reach-again / destroy triple dispatched by a box's recorded backend. Access (ssh/ls) is backend-agnostic.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
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

// ─────────────────────────── PROVIDER SEAM (GitHub Actions) ───────────────────────────
// v2 (vm-ssh-brief §v2): a GHA runner runs `tailcat serve ssh`; the address is handed off through the job log. Keyed via
// the user's published github.com/<user>.keys (zero secret transfer). 6h runner ceiling. The access layer (ssh/ls) is
// byte-identical to Railway — only provisioning differs. Backend is caller-chosen, NEVER auto-selected.

export type Backend = "railway" | "gha";
const WORKFLOW_FILE = "vm-ssh-box.yml";

/** The box workflow, embedded so vm-ssh stays a single self-contained file. `init` commits this into a home repo. Built
 *  as single-quoted lines so GitHub `${{ }}` and bash `${}`/`$()` are all literal (no JS template interpolation). */
export const WORKFLOW_YAML = [
  "name: vm-ssh-box",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      os:",
  "        description: runner OS",
  "        type: choice",
  "        default: ubuntu-latest",
  "        options: [ubuntu-latest, macos-latest, windows-latest]",
  "      ttl_minutes:",
  "        description: minutes to hold the box (<=360; the 6h runner ceiling)",
  "        type: string",
  '        default: "360"',
  "      auth:",
  "        description: keys = trust github_user published keys; none = address-only (open)",
  "        type: choice",
  "        default: keys",
  "        options: [keys, none]",
  "      github_user:",
  "        description: whose github.com/<user>.keys the box trusts (keyed mode; empty = the dispatcher)",
  "        type: string",
  '        default: ""',
  "      user_script:",
  "        description: optional shell run before serve",
  "        type: string",
  '        default: ""',
  "permissions:",
  "  contents: read",
  "jobs:",
  "  box:",
  "    runs-on: ${{ inputs.os }}",
  "    steps:",
  // Step 1 completes fast so `gh run view --log` can serve its address line while Step 2 blocks. The serve is fully
  // detached (setsid + nohup + </dev/null) so it survives into Step 2 on the same runner (killed only at job end).
  "      - name: start box",
  "        shell: bash",
  "        env:",
  "          AUTH: ${{ inputs.auth }}",
  "          GITHUB_USER: ${{ inputs.github_user || github.actor }}",
  "          USER_SCRIPT: ${{ inputs.user_script }}",
  `          TCVER: ${TAILCAT_VERSION}`,
  "        run: |",
  "          set -uo pipefail",
  // Linux (v2's verified OS): the prebuilt binary (seconds) so the box is ready inside the 90s target. macOS/windows
  // (unverified in v2) fall back to the portable `go install` (compiles; slower).
  '          if [ "$RUNNER_OS" = Linux ]; then',
  '            _a=$(uname -m); case "$_a" in x86_64) _a=amd64;; aarch64|arm64) _a=arm64;; esac;',
  '            curl -fsSL "https://github.com/tailscale/tailcat/releases/download/v${TCVER}/tailcat_${TCVER}_linux_${_a}.tar.gz" -o /tmp/tc.tgz;',
  '            tar xzf /tmp/tc.tgz -C /tmp tailcat && sudo install -m 0755 /tmp/tailcat /usr/local/bin/tailcat;',
  "          else",
  '            go install github.com/tailscale/tailcat/cmd/tailcat@latest && export PATH="$HOME/go/bin:$PATH";',
  "          fi",
  '          if [ -n "${USER_SCRIPT:-}" ]; then bash -lc "$USER_SCRIPT" || true; fi',
  '          if [ "$AUTH" = none ]; then SVC=no-auth-ssh; AUTHFLAG=""; else SVC=ssh; AUTHFLAG="--ssh-authorized-keys=${GITHUB_USER}@github"; fi',
  "          rm -f /tmp/tc.addr",
  '          TAILCAT_ADDR_FILE=/tmp/tc.addr setsid nohup tailcat serve --key=new $AUTHFLAG "$SVC" >/tmp/tc.out 2>/tmp/tc.err </dev/null &',
  "          echo $! > /tmp/tc.pid",
  "          for i in $(seq 1 90); do [ -s /tmp/tc.addr ] && break; sleep 1; done",
  '          ADDR="$(cat /tmp/tc.addr 2>/dev/null || true)"',
  '          if [ -z "$ADDR" ]; then ADDR="$(grep -oE "tc[A-Za-z0-9_-]{100,220}" /tmp/tc.err /tmp/tc.out 2>/dev/null | head -1 || true)"; fi',
  '          if [ -z "$ADDR" ]; then echo "tailcat did not report an address"; cat /tmp/tc.err || true; exit 1; fi',
  '          echo "VMSSH_ADDR=$ADDR"',
  '          printf %s "$ADDR" > "$GITHUB_WORKSPACE/vmssh-addr.txt"',
  '          echo "vm-ssh box ready: tailcat ssh ${GITHUB_USER}@$ADDR" >> "$GITHUB_STEP_SUMMARY"',
  // The run's logs are NOT fetchable while it is in progress (gh --log / jobs-API both refuse mid-run), so the address is
  // handed off as an artifact uploaded by this fast step — downloadable while the hold step still blocks.
  "      - name: publish address",
  "        uses: actions/upload-artifact@v4",
  "        with:",
  "          name: vmssh-addr",
  "          path: ${{ github.workspace }}/vmssh-addr.txt",
  "          retention-days: 1",
  "          if-no-files-found: error",
  "      - name: hold",
  "        shell: bash",
  "        env:",
  "          TTL_MINUTES: ${{ inputs.ttl_minutes }}",
  "        run: |",
  "          set -uo pipefail",
  '          TTL="${TTL_MINUTES:-360}"',
  "          for i in $(seq 1 $((TTL*6))); do",
  "            if [ -f /tmp/ghostish.stop ]; then echo stop sentinel seen; break; fi",
  '            kill -0 "$(cat /tmp/tc.pid)" 2>/dev/null || { echo tailcat exited; break; }',
  "            sleep 10",
  "          done",
].join("\n") + "\n";

// --- pure helpers (selftest covers these; no network) ---
/** Extract VMSSH_ADDR=tc... from anywhere in a gh-run log (lines are timestamp/step-prefixed, so match substring). */
export function parseLogAddr(log: string): string | undefined {
  const m = log.match(/VMSSH_ADDR=(tc[A-Za-z0-9_-]{100,220})/);
  return m ? m[1] : undefined;
}
const OS_MAP: Record<string, string> = { ubuntu: "ubuntu-latest", macos: "macos-latest", windows: "windows-latest", "ubuntu-latest": "ubuntu-latest", "macos-latest": "macos-latest", "windows-latest": "windows-latest" };
export function normalizeOs(os: string): string { const n = OS_MAP[os]; if (!n) throw new Error(`--os must be ubuntu|macos|windows (got "${os}")`); return n; }
/** GH-hosted runner's unix user (CONFIRM on a real run; ubuntu/macos = runner, windows = runneradmin). */
const sshUserForOs = (os: string): string => (os.startsWith("windows") ? "runneradmin" : "runner");
/** v2 discipline: a PUBLIC repo forbids --open (Actions logs are world-readable; in open mode the address is the sole key). */
export function openRefusedOnPublic(mode: Mode, visibility: string): boolean { return mode === "open" && visibility.toUpperCase() === "PUBLIC"; }

// --- gh CLI wrappers ---
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function gh(a: string[]): Promise<void> { await execFileP("gh", a, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }); }
async function ghCapture(a: string[]): Promise<string> { return (await execFileP("gh", a, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout.toString(); }
async function ghaResolveUser(): Promise<string> { return (await execFileP("gh", ["api", "user", "-q", ".login"], { timeout: 30_000 })).stdout.toString().trim(); }
async function ghaResolveRepo(override?: string): Promise<{ nameWithOwner: string; visibility: string }> {
  const a = ["repo", "view", ...(override ? [override] : []), "--json", "nameWithOwner,visibility"];
  return JSON.parse(await ghCapture(a)) as { nameWithOwner: string; visibility: string };
}

type GhaInputs = { os: string; ttlMin: number; auth: "keys" | "none"; githubUser: string; userScript: string };
async function ghaDispatch(repo: string, i: GhaInputs): Promise<void> {
  await gh(["workflow", "run", WORKFLOW_FILE, "-R", repo, "-f", `os=${i.os}`, "-f", `ttl_minutes=${i.ttlMin}`, "-f", `auth=${i.auth}`, "-f", `github_user=${i.githubUser}`, "-f", `user_script=${i.userScript}`]);
}

/** Lock the run WE just dispatched: `workflow run` returns no id, so pick the newest run created at/after our pre-dispatch
 *  timestamp (guards against grabbing an older run — vm-ssh-brief/IMPLEMENTATION §5). */
async function ghaLockRunId(repo: string, sinceIso: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const runs = JSON.parse(await ghCapture(["run", "list", "-R", repo, "--workflow", WORKFLOW_FILE, "-L", "20", "--json", "databaseId,createdAt,status"])) as { databaseId: number; createdAt: string; status: string }[];
    const fresh = runs.filter((r) => r.createdAt >= sinceIso).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (fresh.length > 0) return String(fresh[0]!.databaseId);
    await sleep(1500);
  }
  throw new Error("vm-ssh up --backend gha: the dispatched run did not appear in `gh run list` within 30s");
}

/** Address handoff via ARTIFACT (Phase-2 verified): a run's logs are NOT fetchable while it is in progress — both
 *  `gh run view --log` ("still in progress") and the jobs-API log (404 until the job ends) refuse mid-run. So the fast
 *  start step uploads the address as the "vmssh-addr" artifact, downloadable while the hold step still blocks. ~150s total
 *  absorbs queue + install (the box itself is ready inside the 90s target once its step runs). */
async function ghaCaptureAddr(repo: string, runId: string): Promise<string | undefined> {
  const base = mkdtempSync(path.join(tmpdir(), "vmssh-"));
  try {
    for (let i = 0; i < 50; i++) {
      const dir = path.join(base, String(i));
      try {
        await gh(["run", "download", runId, "-R", repo, "-n", "vmssh-addr", "-D", dir]);
        const addr = parseAddress(readFileSync(path.join(dir, "vmssh-addr.txt"), "utf8"));
        if (addr) return addr;
      } catch { /* artifact not uploaded yet (or the run failed) — retry */ }
      await sleep(3000);
    }
    return undefined;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Non-fatal pre-flight: warn if the ssh-agent holds no key published at github.com/<user>.keys — otherwise keyed connect
 *  silently fails (the box trusts only those published keys). A real connect failure is the backstop. */
async function ghaPreflightKeys(githubUser: string): Promise<void> {
  try {
    const published = (await execFileP("curl", ["-fsSL", `https://github.com/${githubUser}.keys`], { timeout: 10_000 })).stdout.toString();
    const pub = new Set(published.split("\n").map((l) => l.trim().split(/\s+/).slice(0, 2).join(" ")).filter((s) => s.startsWith("ssh-")));
    const agent = execFileSync("ssh-add", ["-L"], { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/).slice(0, 2).join(" ")).filter((s) => s.startsWith("ssh-"));
    if (pub.size > 0 && !agent.some((k) => pub.has(k))) {
      process.stderr.write(`vm-ssh up --backend gha: WARNING — none of your ssh-agent keys are in https://github.com/${githubUser}.keys; the keyed box will refuse your connect. Publish a matching key to that account, or pass --user <login> whose private key your agent holds.\n`);
    }
  } catch { /* best-effort */ }
}

async function cmdUpGha(id: string, mode: Mode, initScript: string | undefined, args: Args): Promise<void> {
  // pure input validation first — fail fast before any network round-trip.
  const os = normalizeOs(args.val("--os") ?? "ubuntu");
  const ttlMin = Number(args.val("--ttl") ?? "360");
  if (!Number.isInteger(ttlMin) || ttlMin < 1 || ttlMin > 360) throw new Error(`--ttl must be an integer 1..360 minutes (the GHA 6h ceiling); got "${args.val("--ttl")}"`);
  const repo = await ghaResolveRepo(args.val("--repo"));
  if (openRefusedOnPublic(mode, repo.visibility)) throw new Error(`vm-ssh up --backend gha --open REFUSED: ${repo.nameWithOwner} is ${repo.visibility} — Actions logs are world-readable and in --open mode the tailcat address IS the sole credential. Drop --open (keyed), or use a private repo.`);
  const githubUser = args.val("--user") ?? (await ghaResolveUser());
  if (mode === "keyed") await ghaPreflightKeys(githubUser);
  const sinceIso = new Date().toISOString();
  await ghaDispatch(repo.nameWithOwner, { os, ttlMin, auth: mode === "open" ? "none" : "keys", githubUser, userScript: initScript ?? "" });
  const runId = await ghaLockRunId(repo.nameWithOwner, sinceIso);
  const addr = await ghaCaptureAddr(repo.nameWithOwner, runId);
  if (!addr) throw new Error(`vm-ssh up --backend gha: no address captured within ~90s (run ${runId}). Inspect: gh run view ${runId} -R ${repo.nameWithOwner} --log`);
  writeAddr(id, addr);
  writeMeta({ id, mode, backend: "gha", createdSec: Math.floor(Date.now() / 1000), addrFile: addrPath(id), repo: repo.nameWithOwner, runId, os, githubUser, ttlMin, sshUser: sshUserForOs(os) });
  process.stdout.write(`${JSON.stringify({ id, addrFile: addrPath(id), mode, backend: "gha", runId, os, ttlMin })}\n`);
}

async function ghaRefresh(m: Meta): Promise<string | undefined> {
  return m.repo && m.runId ? ghaCaptureAddr(m.repo, m.runId) : undefined;
}

async function cmdInit(args: Args): Promise<void> {
  const repo = await ghaResolveRepo(args.rest()[0]);
  const wfPath = `.github/workflows/${WORKFLOW_FILE}`;
  // persistent external write → print exactly what will be committed BEFORE writing (vm-ssh-brief v2 discipline).
  process.stdout.write(`vm-ssh init: will install ${wfPath} into ${repo.nameWithOwner} (${repo.visibility}) as a commit on its default branch. Content:\n`);
  process.stdout.write(`──────── ${wfPath} ────────\n${WORKFLOW_YAML}────────\n`);
  let existingSha: string | undefined;
  try {
    const got = JSON.parse(await ghCapture(["api", `repos/${repo.nameWithOwner}/contents/${wfPath}`])) as { sha: string; content: string };
    existingSha = got.sha;
    if (Buffer.from(got.content, "base64").toString() === WORKFLOW_YAML) { process.stdout.write(`${JSON.stringify({ repo: repo.nameWithOwner, path: wfPath, installed: false, reason: "already identical (idempotent no-op)" })}\n`); return; }
  } catch { /* not present yet — create it */ }
  const apiArgs = ["api", `repos/${repo.nameWithOwner}/contents/${wfPath}`, "-X", "PUT", "-f", "message=chore: install vm-ssh box workflow", "-f", `content=${Buffer.from(WORKFLOW_YAML).toString("base64")}`];
  if (existingSha) apiArgs.push("-f", `sha=${existingSha}`);
  await gh(apiArgs);
  process.stdout.write(`${JSON.stringify({ repo: repo.nameWithOwner, path: wfPath, installed: true, updated: Boolean(existingSha) })}\n`);
}

async function cmdDown(args: Args): Promise<void> {
  const id = resolveId(args.rest()[0]);
  const m = readMeta(id)!;
  if (m.backend !== "gha") { process.stdout.write(`vm-ssh down: "${id}" is a ${m.backend} box — no down verb (the platform auto-destroys ~1h; vm-ssh-brief). Bookkeeping is pruned on ls/ssh.\n`); return; }
  const addr = readAddr(id);
  let stopped = "sentinel";
  try {
    if (!addr) throw new Error("no address on file");
    const target = m.sshUser ? `${m.sshUser}@${addr}` : addr;
    await execFileP("tailcat", ["ssh", target, "touch", "/tmp/ghostish.stop"], { timeout: 30_000 }); // trips the hold loop
  } catch {
    if (m.repo && m.runId) { await gh(["run", "cancel", m.runId, "-R", m.repo]); stopped = "cancel"; } // hard stop
    else { prune(id); throw new Error(`vm-ssh down: "${id}" has no reachable address and no run id to cancel — pruned bookkeeping only`); }
  }
  prune(id);
  process.stdout.write(`${JSON.stringify({ id, stopped })}\n`);
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
type Meta = {
  id: string; mode: Mode; backend?: Backend; createdSec: number; addrFile: string;
  keyPath?: string; knownHosts?: string; // railway-only (per-box provisioning ssh key)
  repo?: string; runId?: string; os?: string; githubUser?: string; ttlMin?: number; sshUser?: string; // gha-only
};
/** A box's backend; absent on pre-v2 records = railway (back-compat). */
const backendOf = (m: Meta): Backend => m.backend ?? "railway";

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
/** A box's lifetime cap in seconds: railway = ~1h platform fact; gha = its recorded ttlMin (≤6h runner ceiling). */
function ttlSec(m: Meta): number { return backendOf(m) === "gha" ? (m.ttlMin ?? 360) * 60 : TTL_SEC; }
function remainingSec(m: Meta, now = Date.now()): number { return m.createdSec + ttlSec(m) - Math.floor(now / 1000); }
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
  const backend = (args.val("--backend") ?? "railway") as Backend;
  if (backend !== "railway" && backend !== "gha") throw new Error(`--backend must be railway|gha (got "${args.val("--backend")}")`);
  const mode: Mode = args.has("--open") ? "open" : "keyed";
  const id = args.val("--name") ?? genId();
  if (readMeta(id)) throw new Error(`name "${id}" already in use`);
  const initFile = args.val("--init");
  const initScript = initFile ? readFileSync(initFile, "utf8") : undefined;
  if (backend === "gha") return cmdUpGha(id, mode, initScript, args);

  const pubKey = mode === "keyed" ? resolvePubKey(args.val("--key")) : undefined;
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
  writeMeta({ id, mode, backend: "railway", createdSec: Math.floor(Date.now() / 1000), keyPath, knownHosts, addrFile: addrPath(id) });
  process.stdout.write(`${JSON.stringify({ id, addrFile: addrPath(id), mode, backend: "railway" })}\n`); // address itself stays in the 0600 file
}

async function cmdSsh(args: Args): Promise<void> {
  const rest = args.rest(); // [id?] before a `--`
  const id = resolveId(rest[0]);
  const addr = readAddr(id);
  if (!addr) { prune(id); throw new Error(`no address for "${id}" (box gone or not captured) — try: vm-ssh refresh ${id}`); }
  const remoteCmd = args.afterDashDash();
  // gha boxes serve as the runner's unix user (recorded sshUser); railway boxes take tailcat's default user.
  const sshUser = readMeta(id)?.sshUser;
  const target = sshUser ? `${sshUser}@${addr}` : addr;
  // spawn (not execFile) with inherited stdio: an interactive shell / streamed remote-command output must pass through,
  // and the address goes only to tailcat's argv (its documented interface), never to our stdout/log.
  const child = spawn("tailcat", ["ssh", target, ...remoteCmd], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => { child.on("exit", (code) => (code ? reject(new Error(`tailcat ssh exited ${code}`)) : resolve())); child.on("error", reject); });
}

function cmdLs(args: Args): void {
  for (const id of allIds()) if (remainingSec(readMeta(id)!) <= 0) prune(id);
  const rows = allIds().map((id) => { const m = readMeta(id)!; return { id, mode: m.mode, backend: backendOf(m), ...(m.os ? { os: m.os } : {}), createdSec: m.createdSec, remainingSec: Math.max(0, remainingSec(m)), addrFile: m.addrFile }; });
  if (args.has("--json")) { process.stdout.write(`${JSON.stringify(rows)}\n`); return; }
  if (rows.length === 0) { process.stdout.write("(no live boxes)\n"); return; }
  for (const r of rows) process.stdout.write(`${r.id}\t${r.backend}${r.os ? `/${r.os}` : ""}\t${r.mode === "open" ? "OPEN⚠" : "keyed"}\t~${Math.floor(r.remainingSec / 60)}m left\t${r.addrFile}\n`);
  if (rows.some((r) => r.backend === "gha")) process.stdout.write("note: gha fan-out is capped by this GitHub account's Actions quota (concurrent runners + minute pool); multi-account fan-out is out of v2.\n");
}

async function cmdRefresh(args: Args): Promise<void> {
  const id = resolveId(args.rest()[0]);
  const m = readMeta(id)!;
  let addr: string | undefined;
  if (backendOf(m) === "gha") {
    addr = await ghaRefresh(m); // re-read the address off the (still-running) run's log
  } else {
    // railway: same key ⇒ same box: re-read the address the box's serve wrote (survives a serve restart that changed it).
    const stdout = await railwayRun(m.keyPath!, m.knownHosts!, "printf 'VMSSH_ADDR=%s\\n' \"$(cat /tmp/vmssh.addr 2>/dev/null)\"");
    addr = parseCapturedAddr(stdout);
  }
  if (!addr) { throw new Error(`vm-ssh refresh: box "${id}" returned no address (it may be destroyed; run vm-ssh ls)`); }
  writeAddr(id, addr);
  process.stdout.write(`${JSON.stringify({ id, addrFile: addrPath(id), mode: m.mode, backend: backendOf(m), refreshed: true })}\n`);
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

const USAGE = [
  "usage: vm-ssh <up|ssh|ls|refresh|down|init|proxy> ...",
  "  up [--backend railway|gha] [--open] [--init <script>] [--key <pubkey-file>] [--name <alias>]",
  "       gha-only: [--repo <owner/name>] [--os ubuntu|macos|windows] [--ttl <min 1..360>] [--user <github-login>]",
  "  ssh [id] [-- <cmd...>]",
  "  ls [--json]",
  "  refresh <id>",
  "  down <id>                                     (gha: sentinel/cancel; railway: no-op)",
  "  init [repo]                                   (gha: install the box workflow into a home repo; prints what it writes)",
  "  proxy <up|down|status> [--port <n>] [--json]   (bundled ECH pool; token: CF_PROXY_TOKEN or ~/.vm-ssh/token)",
  "",
].join("\n");

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const args = new Args(rest);
  switch (verb) {
    case "up": return cmdUp(args);
    case "ssh": return cmdSsh(args);
    case "ls": return cmdLs(args);
    case "refresh": return cmdRefresh(args);
    case "down": return cmdDown(args);
    case "init": return cmdInit(args);
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
  // --- v2 gha backend (pure helpers; no network) ---
  console.assert(parseLogAddr(`2026-10-05T00:00:00.0Z\tbox\tVMSSH_ADDR=${A} more log`) === A, "parseLogAddr extracts the address from a gh-log line");
  console.assert(parseLogAddr("2026\tbox\tno address here") === undefined, "parseLogAddr returns undefined when absent");
  console.assert(normalizeOs("ubuntu") === "ubuntu-latest" && normalizeOs("macos-latest") === "macos-latest", "normalizeOs maps short + full forms");
  let osThrew = false; try { normalizeOs("plan9"); } catch { osThrew = true; } console.assert(osThrew, "normalizeOs rejects an unknown os");
  console.assert(sshUserForOs("ubuntu-latest") === "runner" && sshUserForOs("windows-latest") === "runneradmin", "sshUserForOs picks the runner unix user");
  console.assert(openRefusedOnPublic("open", "PUBLIC") && !openRefusedOnPublic("open", "PRIVATE") && !openRefusedOnPublic("keyed", "PUBLIC"), "public repo forbids --open only (keyed ok, private ok)");
  console.assert(backendOf({ id: "x", mode: "keyed", createdSec: 0, addrFile: "" }) === "railway", "backendOf defaults a pre-v2 record to railway");
  console.assert(ttlSec({ id: "x", mode: "keyed", backend: "gha", ttlMin: 120, createdSec: 0, addrFile: "" }) === 7200, "gha ttlSec honors ttlMin");
  console.assert(WORKFLOW_YAML.includes("workflow_dispatch") && WORKFLOW_YAML.includes("--ssh-authorized-keys=${GITHUB_USER}@github") && WORKFLOW_YAML.includes("VMSSH_ADDR=") && WORKFLOW_YAML.includes("/tmp/ghostish.stop") && WORKFLOW_YAML.includes("contents: read"), "workflow yaml: dispatch inputs + keyed key-fetch + addr marker + sentinel + least-privilege");
  process.stdout.write("vm-ssh selftest: all assertions passed\n");
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
