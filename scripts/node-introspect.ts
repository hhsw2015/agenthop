import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Node introspection over tailcat — the out-of-band channel that answers "what is this box doing right now".
 *
 * WHY THIS EXISTS: everything else I render is either presence (who is alive) or metadata written by the
 * node about itself (control records, task records, the message journal). None of it shows the inside of a
 * running worker. tailcat gives a second access path to a VM without the Railway key, so a box can be asked
 * directly: what is on your tmux screen, what did your supervisor last log, how far along is the work.
 *
 * THE ADDRESS IS A CREDENTIAL, NOT A HANDLE. It embeds a pre-shared key, so it is read from a 0600 file,
 * never logged, never returned in full by any helper here, and never placed on a command line where `ps`
 * would show it. `redactAddress` is the only thing that should ever reach a log or a page.
 *
 * WHAT THIS IS NOT: a control channel. tailcat rides public DERP with no SLA and the tool is experimental,
 * so absence of an answer means "unknown", never "healthy" and never "failed". Correctness lives in the
 * git-channel and the dispatcher; this is observability and convenience only. Every call is bounded and a
 * timeout is reported as unreachable, not as an error to retry.
 *
 * READ-ONLY BY CONSTRUCTION. Only the read commands below are defined. Nothing in this module sends keys to
 * a tmux pane: keystroke injection is best-effort blind input, not an RPC, and would be a different feature
 * with a different risk profile.
 */

/** Where the box side publishes its address: one line, the bare `tc...` address. */
export function tailcatDir(home: string): string {
  return path.join(home, ".agenthop", "swarm", "tailcat");
}
export function addressFile(home: string, launchId: string): string {
  // launchIds become filenames, so refuse anything that could escape the directory.
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(launchId) || launchId === "." || launchId === "..") {
    throw new Error(`unsafe launchId: ${JSON.stringify(launchId)}`);
  }
  return path.join(tailcatDir(home), `${launchId}.addr`);
}

/**
 * The bare address from a file's contents. Tolerates surrounding whitespace and a trailing newline; rejects
 * anything that is not a tailcat address, so a truncated or half-written file reads as "no address" rather
 * than as a bogus one that would be tried as a credential.
 */
export function parseAddress(raw: string): string | undefined {
  const line = raw.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return undefined;
  // Observed length is ~154 chars of base64url-ish text after a "tc" prefix. Bound it loosely but do not
  // accept arbitrary text: a wrong string here is a credential sent to the wrong place.
  return /^tc[A-Za-z0-9_-]{40,400}$/.test(line) ? line : undefined;
}

/** Read a node's address, or undefined when the box side has not published one (yet). */
export function readAddress(home: string, launchId: string): string | undefined {
  try {
    const raw = readFileSync(addressFile(home, launchId), "utf8");
    return parseAddress(raw);
  } catch {
    return undefined; // not published, or unreadable — both mean "no channel"
  }
}

/**
 * The only representation of an address that may be logged or rendered. Keeps a short head so two boxes can
 * be told apart, and never the body, because the body is the secret.
 */
export function redactAddress(addr: string | undefined): string {
  if (!addr) return "(none)";
  return `${addr.slice(0, 6)}…(${addr.length})`;
}

// ---------------------------------------------------------------------------------------------
// Read probes
// ---------------------------------------------------------------------------------------------

/** A named, read-only inspection of a node. Each maps to one remote command. */
export type ProbeId = "screen" | "sup-log" | "progress" | "processes" | "resources";

export type Probe = {
  id: ProbeId;
  label: string;
  /** The remote command. Passed as ARGV, never through a shell on our side. */
  argv: string[];
  /** Cap on output we keep, bytes. A tmux pane can be large. */
  maxBytes: number;
};

/**
 * The probe set. Deliberately all reads. `screen` is the highest-value one — the worker's own TUI is the
 * most direct answer to "what is it doing" that exists, and unlike git state it is live.
 */
export const PROBES: readonly Probe[] = [
  { id: "screen", label: "worker screen", argv: ["tmux", "capture-pane", "-t", "swarm", "-p"], maxBytes: 16 * 1024 },
  { id: "progress", label: "progress file", argv: ["cat", "/root/work/out/progress.txt"], maxBytes: 8 * 1024 },
  { id: "sup-log", label: "supervisor log", argv: ["tail", "-n", "50", "/root/.swarm/sup.log"], maxBytes: 16 * 1024 },
  { id: "processes", label: "processes", argv: ["ps", "-eo", "pid,etime,pcpu,rss,comm"], maxBytes: 16 * 1024 },
  { id: "resources", label: "resources", argv: ["sh", "-c", "free -m 2>/dev/null || vm_stat; uptime"], maxBytes: 8 * 1024 },
];

export function probeById(id: ProbeId): Probe | undefined {
  return PROBES.find((p) => p.id === id);
}

/** How a probe ended. `unreachable` is the expected outcome for a box that has expired. */
export type ProbeStatus = "ok" | "empty" | "unreachable" | "failed";

export type ProbeResult = {
  id: ProbeId;
  status: ProbeStatus;
  /** Trimmed output when status is ok/empty. Never includes the address. */
  text: string;
  /** Wall time, ms. */
  ms: number;
  /** A short diagnostic for a failure. Never includes the address. */
  detail?: string;
};

/**
 * Classify an outcome. Pure, so the interesting cases (timeout, empty screen, auth refusal) are testable
 * without a box. This is where "absent means unknown" is enforced: a timeout is NOT failure and NOT health.
 */
export function classify(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean): ProbeStatus {
  if (timedOut) return "unreachable";
  if (exitCode !== 0) {
    const s = stderr.toLowerCase();
    // TRANSPORT failures mean "no answer", which is `unreachable`, not `failed`. This matters: an expired
    // VM is the common case and must render as stale, so misclassifying it as a failure sends a reader
    // looking for a broken command instead of a dead box.
    //
    // Measured against a killed server, tailcat reports:
    //   tlsdial: error: server cert for "tcNNN.ipn.dev" failed both system roots ...
    //   tailcat Ping: context deadline exceeded
    // The earlier matcher looked for "timed out" and therefore missed this completely.
    const transport = [
      "tailcat ping",        // tailcat's own reachability probe
      "context deadline exceeded",
      "timed out",
      "tlsdial",
      "derp",
      "no such host",
      "connection refused",
      "network is unreachable",
      "i/o timeout",
    ];
    if (transport.some((k) => s.includes(k))) return "unreachable";
    // Auth refusal is also "no answer from an authorised peer", not a command failure.
    if (s.includes("permission denied")) return "unreachable";
    // A malformed address is OUR bug, not the node's state — surface it as a failure so it is not read as
    // a dead box. ("invalid tailcat address ... CBOR unmarshal")
    if (s.includes("invalid tailcat address")) return "failed";
    return "failed";
  }
  return stdout.trim() ? "ok" : "empty";
}

/** The tailcat binary. TAILCAT_BIN lets a test point at a stub. */
export function tailcatBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.TAILCAT_BIN || "tailcat";
}

/**
 * Run one probe against a node. Bounded by `timeoutMs` (default 10s: a DERP round trip can be slow, and the
 * page must not hang on a dead box). Never throws — a probe failure is data, reported as a status.
 *
 * NOTE on the invocation: `tailcat ssh <addr> <cmd...>` passes everything after the destination to the
 * system ssh as the remote command. A literal `--` must NOT be inserted: tailcat already places its own
 * `--` before the destination, so an extra one becomes part of the remote command and the remote shell
 * tries to execute `--` (verified: `zsh: no such option`). The remote command must also arrive as separate
 * argv tokens, not one pre-quoted string.
 */
export function runProbe(
  addr: string,
  probe: Probe,
  opts: { timeoutMs?: number; bin?: string } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    execFile(
      opts.bin ?? tailcatBin(),
      ["ssh", addr, ...probe.argv],
      { timeout: timeoutMs, maxBuffer: probe.maxBytes * 2, encoding: "utf8" },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        const out = typeof stdout === "string" ? stdout : "";
        const err = typeof stderr === "string" ? stderr : "";
        const timedOut = !!error && /ETIMEDOUT|timed out|killed/i.test(String(error.message ?? ""));
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        const status = classify(code, out, err, timedOut);
        resolve({
          id: probe.id,
          status,
          text: clipBytes(out.trim(), probe.maxBytes),
          ms,
          // Keep the diagnostic short and address-free; stderr from tailcat can echo the address, so strip it.
          detail: status === "ok" || status === "empty" ? undefined : stripAddress(err || String(error?.message ?? ""), addr),
        });
      },
    );
  });
}

/** Remove an address from free text before it can reach a log or a page. */
export function stripAddress(text: string, addr: string): string {
  const t = addr ? text.split(addr).join("<redacted-address>") : text;
  return t.trim().slice(0, 300);
}

function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return Buffer.from(s, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "") + "\n… (truncated)";
}

/**
 * Highest-value probe bundle for a node, in the order a watcher wants it: what is on screen, then progress,
 * then the last supervisor lines. Sequential on purpose — these share one public relay, and hammering it in
 * parallel for one node is both rude and slower.
 */
export async function surveyNode(
  addr: string,
  opts: { ids?: ProbeId[]; timeoutMs?: number; bin?: string } = {},
): Promise<ProbeResult[]> {
  const ids = opts.ids ?? (["screen", "progress", "sup-log"] as ProbeId[]);
  const out: ProbeResult[] = [];
  for (const id of ids) {
    const probe = probeById(id);
    if (!probe) continue;
    out.push(await runProbe(addr, probe, { timeoutMs: opts.timeoutMs, bin: opts.bin }));
  }
  return out;
}
