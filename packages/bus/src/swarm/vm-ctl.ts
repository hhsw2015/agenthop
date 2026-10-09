/**
 * vm-ctl — backend-agnostic native machine-management primitives (S14).
 *
 * CONSTITUTION (user ruling): Railway's commands bind to its account/cloud; vm-ctl's commands bind only to SSH
 * reachability. A machine is a valid `Machine` with just `{addr + key}`, whatever its origin — Railway Free, GHA, any
 * VPS, an old home computer, a client's data center. Their logic, our sovereignty.
 *
 * Three decoupling hard-conditions:
 *  ① The `Backend` interface's ONLY vendor-specific methods are `up` and `reclaim`. Every other verb (ready/creds/boot/
 *     snapshot/restore/forward/ssh) is a PURE SSH primitive with ZERO vendor-API calls — `verbNeedsBackend` is the
 *     machine-checkable invariant.
 *  ② `adopt <addr>` turns ANY ssh-reachable machine into a `Machine` (no up, lifetimeSec=null, capacity probe still
 *     runs) — the literal landing of "any VM".
 *  ③ An account is needed only at `up`; the adopt path is account-free end to end.
 *
 * Pure core below (selftested); IO shell (ssh/git/herdr exec) is dormant (`SWARM_VM_CTL` off) and exercised by live
 * runs. Credential discipline (§creds) is a hard gate: a credential travels on stdin into a 0600 file, NEVER argv.
 */

import { CAPACITY_PROBE_CMD } from "./remote-capacity.js"; // D4-1: single-source the capacity probe command (its parsers live here)

// ============================================================================================================
// Pure core (selftested in vm-ctl.selftest.mts)
// ============================================================================================================

/** Backend only decides provisioning/reclaim; "adopted" is the accountless path for a pre-existing machine. */
export type Backend = "railway" | "gha" | "adopted" | (string & {});

/** The unified machine shape — identical across every backend. `lifetimeSec=null` ⇒ does not self-destruct. */
export interface Machine {
  id: string;
  addr: string;
  backend: Backend;
  lifetimeSec: number | null;
  capacity: number | null;
  createdSec: number;
  remainingSec: number | null;
}

export type Verb = "up" | "down" | "adopt" | "ls" | "ssh" | "ready" | "creds" | "boot" | "snapshot" | "restore" | "forward";

/** The ONLY two verbs permitted to touch a vendor API (hard-condition ①). Everything else is pure SSH. */
export const BACKEND_ONLY_VERBS: ReadonlySet<Verb> = new Set<Verb>(["up", "down"]);
export function verbNeedsBackend(v: Verb): boolean {
  return BACKEND_ONLY_VERBS.has(v);
}

/**
 * Adopt any ssh-reachable machine as a `Machine` — NO vendor API, NO account (hard-condition ②/③). `lifetimeSec` is
 * null (unknown/none; not self-destructing by assumption); `capacity` is filled later by the probe (null until then).
 * Pure: constructs the shape; the actual reachability/capacity probe is the IO caller's job. */
export function adoptMachine(addr: string, opts: { id?: string; capacity?: number | null; nowSec?: number } = {}): Machine {
  if (!addr || !addr.trim()) throw new Error("adoptMachine: addr required");
  return {
    id: opts.id ?? addr.trim(),
    addr: addr.trim(),
    backend: "adopted",
    lifetimeSec: null,
    capacity: opts.capacity ?? null,
    createdSec: Math.floor(opts.nowSec ?? Date.now() / 1000),
    remainingSec: null,
  };
}

export type ReadyVerdict = "ready" | "down" | "unknown";

/**
 * Ready-probe verdict from an ssh/probe invocation = (raw output, exit-failed). A non-zero exit is a LOCAL/transport
 * failure (not the remote asserting down) ⇒ `unknown` (retry, never "down"); explicit reachable text ⇒ `ready`;
 * explicit connection-refused/down ⇒ `down`; anything else ⇒ `unknown`. Fail-closed: never "ready" on doubt. Pure. */
/**
 * Verdict from a value that PARSED as JSON — judged structurally and ONLY structurally (the caller must NOT text-scan
 * a valid-JSON input). Scans known boolean flags (`ready|reachable|running|online`) across the top level and array
 * elements: all-true → ready, all-false → down, a mix → unknown (conflict). A known key with a NON-boolean value
 * (null/"pending"/0) ⇒ unknown (unrecognized shape); no known flag key ⇒ unknown. Pure (VMC-P1-1). */
function jsonReadyVerdict(v: unknown): ReadyVerdict {
  const objs = Array.isArray(v) ? v : [v];
  let sawTrue = false;
  let sawFalse = false;
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    for (const k of ["ready", "reachable", "running", "online"] as const) {
      if (!(k in (o as Record<string, unknown>))) continue;
      const f = (o as Record<string, unknown>)[k];
      if (f === true) sawTrue = true;
      else if (f === false) sawFalse = true;
      else return "unknown"; // known key, non-boolean value ⇒ cannot confirm
    }
  }
  if (sawTrue && sawFalse) return "unknown"; // conflict
  if (sawTrue) return "ready";
  if (sawFalse) return "down";
  return "unknown"; // no recognized flag ⇒ unknown shape (never fall through to text)
}

/**
 * Ready verdict (VMC-P1-1, hardened). Order: exit-fail → unknown; a VALID-JSON input is decided structurally and STOPS
 * (unknown shape / conflict → unknown, never text-scanned); plain text → explicit failure → down; progress/question or
 * any negation/falsity → unknown; `ready` ONLY on a COMPLETE success format (not a bare keyword inside progress text
 * like "waiting for server to become ready"). Pure. */
export function readyVerdict(raw: string, exitFailed: boolean): ReadyVerdict {
  if (exitFailed) return "unknown"; // transport/local failure — retry, don't conclude
  const s = (raw ?? "").trim();
  if (!s) return "unknown";
  try {
    return jsonReadyVerdict(JSON.parse(s)); // parsed as JSON ⇒ structural only, no text fall-through
  } catch {
    /* not JSON — fall to text */
  }
  const low = s.toLowerCase().trim();
  if (/\bunreachable\b|not reachable|unable to reach|cannot reach|not running|not ready|connection refused|\btimed out\b|no route to host|host is down|\boffline\b|\bfailed\b/.test(low)) return "down";
  // `ready` ONLY on an EXACT, fully-anchored complete-success format — no arbitrary surrounding text, no question/
  // conditional/speculation (VMC-P1-1). A substring/`[^.]*` match let "server is ready?", "if the server is ready,
  // continue", "herdr may be running" through; whole-string anchoring rejects them. Bare "reachable" stays a positive.
  return READY_FORMATS.some((re) => re.test(low)) ? "ready" : "unknown";
}

/** The ENUMERATED, fully-anchored set of complete success formats a probe may emit. Extend from a live run (the exact
 *  herdr wording is an acceptance rider), never loosen to a substring match. */
const READY_FORMATS: readonly RegExp[] = [
  /^reachable$/,
  /^ready$/,
  /^online$/,
  /^connected$/,
  /^up$/,
  /^ok$/,
  /^running$/,
  /^server is ready$/,
  /^status:\s*running$/,
  /^connection established$/,
  /^herdr( server)?( is)? running$/,
];

/** Bounded exponential-ish backoff for the ready gate (borrowed from Railway's BACKOFF_SECS). Last value repeats. Pure. */
export const READY_BACKOFF_SEC: readonly number[] = [1, 2, 4, 8, 15];
export function nextBackoffSec(attempt: number, schedule: readonly number[] = READY_BACKOFF_SEC): number {
  // Reject an illegal table → safe default; a delay must be finite & ≥0 (VMC-P2-2). `Array.from` materializes sparse
  // HOLES as `undefined` so `every` can't skip them (a plain `.every` skips holes and lets `new Array(n)` through).
  const dense = Array.isArray(schedule) ? Array.from(schedule as ArrayLike<number>) : [];
  const safe = dense.length > 0 && dense.every((n) => Number.isFinite(n) && n >= 0) ? dense : READY_BACKOFF_SEC;
  const a = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  return safe[Math.min(a - 1, safe.length - 1)];
}

export type CredFamily = "codex" | "claude";

export interface CredSeed {
  family: CredFamily;
  /** ALWAYS true — a credential is delivered on stdin, never as an argv (which would leak to ps). */
  viaStdin: true;
  /** The remote command that READS stdin into a 0600 file (codex), or starts the setup-token flow (claude). */
  remoteCmd: string;
  note: string;
}

/**
 * Build the credential seed for a family. Codex: the cred arrives on stdin into `~/.codex/auth.json` at mode 0600,
 * never an argv (Railway `CODEX_SEED`). Claude: mint a one-time setup token rather than copying raw credentials.
 * Pure (builds the command + the stdin discipline; the IO caller pipes the secret to stdin). */
export function buildCredSeed(family: CredFamily): CredSeed {
  // 0600 BEFORE the first sensitive byte (VMC-P1-2): `rm -f` drops any stale/0644/0400 file, then under `umask 077`
  // the redirect creates a FRESH 0600 file — the credential's first byte lands already-protected (no chmod-after window).
  // `&&`-chained: a failed mkdir/rm/write exits non-zero, so exit 0 means complete delivery (no chmod masquerade).
  if (family === "codex") {
    return {
      family,
      viaStdin: true,
      remoteCmd: "mkdir -p ~/.codex && umask 077 && rm -f ~/.codex/auth.json && cat > ~/.codex/auth.json",
      note: "cred on stdin → fresh 0600 file (born protected), never argv; && so a failed write is non-zero",
    };
  }
  if (family === "claude") {
    return {
      family,
      viaStdin: true,
      remoteCmd: "mkdir -p ~/.claude && umask 077 && rm -f ~/.claude/.credentials.json && cat > ~/.claude/.credentials.json",
      note: "prefer a minted one-time setup token over raw creds; still stdin → fresh 0600 file, && for write-failure",
    };
  }
  throw new Error(`buildCredSeed: unknown family ${family}`);
}

/** The credential hard-gate: a delivery is legal ONLY when it rides stdin and NOT argv. Fail-closed. Pure. */
export function credDeliveryOk(d: { viaStdin: boolean; inArgv: boolean }): boolean {
  return d.viaStdin === true && d.inArgv === false;
}

/** `ssh -L <localPort>:localhost:<remotePort>` args for port-forward (borrowed from Railway PortForward). Pure. */
export function buildForwardArgs(addr: string, remotePort: number, localPort: number = remotePort): string[] {
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) throw new Error("forward: bad remotePort");
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) throw new Error("forward: bad localPort");
  return ["-N", "-L", `${localPort}:localhost:${remotePort}`, addr];
}

/**
 * Snapshot genealogy (borrowed from sandbox template/checkpoint/fork, re-grounded on pure SSH + external storage, ZERO
 * account — a snapshot is a git branch / tar, never a vendor image):
 *  - `checkpoint`: a NAMED external archive of a machine's workspace (poor-man's-sleep).
 *  - `template`: a reusable "golden" archive — a new machine RESTORES its filesystem and SKIPS bootstrap (instant set-up).
 *  - `fork`: restore ONE snapshot onto N new machines (fan-out), amortizing a single install across N.
 */
export type SnapshotKind = "checkpoint" | "template" | "fork";

export interface SnapshotRef {
  machineId: string;
  kind: SnapshotKind;
  name: string;
  branch: string;
  breakpointFile: string;
  createdSec: number;
}

/** Build a snapshot reference — a git branch + a breakpoint file (fanout resume-point). `kind` defaults to a plain
 *  checkpoint; `name` defaults to the timestamp. Pure (names the refs; the IO caller does the git push / breakpoint write). */
export function snapshotRef(machineId: string, opts: { kind?: SnapshotKind; name?: string; nowSec?: number } = {}): SnapshotRef {
  const now = Math.floor(opts.nowSec ?? Date.now() / 1000);
  const kind = opts.kind ?? "checkpoint";
  const name = opts.name ?? String(now);
  return {
    machineId,
    kind,
    name,
    branch: `vmctl-snap/${name}`,
    breakpointFile: `vmctl-breakpoint-${machineId}.json`,
    createdSec: now,
  };
}

/** Restore a snapshot onto a fresh machine. A `template` restores the prebuilt filesystem and SKIPS boot; a
 *  checkpoint/fork runs boot then restores the workspace; both end with the succession hand-off. Pure (ordered steps). */
export function restorePlan(snap: SnapshotRef, newMachineId: string): string[] {
  const steps: string[] = [];
  if (snap.kind === "template") {
    steps.push(`restore prebuilt FS from ${snap.branch} (skip bootstrap — instant set-up)`);
  } else {
    steps.push(`boot ${newMachineId}`, `git fetch + checkout ${snap.branch}`);
  }
  steps.push(`read breakpoint ${snap.breakpointFile}`, `succession hand-off → ${newMachineId} resumes from breakpoint`);
  return steps;
}

/** Fan-out: restore ONE snapshot onto N new machines (sandbox `fork`), one install amortized across N. Pure. */
export function forkPlan(snap: SnapshotRef, newMachineIds: readonly string[]): string[] {
  if (newMachineIds.length === 0) throw new Error("forkPlan: need at least one target machine");
  return [
    `fork ${snap.branch} → ${newMachineIds.length} machines (one install amortized across N)`,
    ...newMachineIds.map((id) => `restore ${snap.name} → ${id}`),
  ];
}

/**
 * `code` facade (sandbox/`railway code` one-shot): string up/adopt → ready → creds → boot → herdr machine-add into a
 * single `vm-ctl code --<family>` invocation. The final machine-add is what makes a boot-completed REMOTE member
 * identical to a LOCAL one on the herdr panel / bus / dispatch path (position transparency). Pure (the ordered plan). */
export function buildCodePlan(family: CredFamily, source: { verb: "up" | "adopt"; backend?: Backend; addr?: string }): string[] {
  const first = source.verb === "up" ? `up --backend ${source.backend ?? "railway"}` : `adopt ${source.addr ?? "<addr>"}`;
  return [
    first,
    "ready <gate: bounded timeout + backoff>",
    `creds --family ${family} (stdin → 0600, never argv)`,
    "boot (idempotent)",
    "herdr machine add + ephemeral-linkage (position-transparent mount: remote member == local member)",
  ];
}

/** POSIX single-quote a string so the shell treats it as ONE literal argument (no `$(...)`, `&`, globbing). Pure. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The canonical herdr install URL (one source; remote-herdr-view's bootstrap re-exports this). */
export const HERDR_INSTALL_URL = "https://herdr.dev/install.sh";

/**
 * D4-1: the ONE construction point for the herdr-install step of a boot template — both vm-ctl's boot plan and
 * remote-herdr-view's bootstrap script compose from this (the batch-4 DRIFT was two divergent copies). Download THEN run
 * as SEPARATE commands with an explicit `|| exit 1` (RH6): never `curl | sh` (hides curl's exit), never `&&` (under
 * `set -e` a failed and-list LHS is exempt, so a failed download would be swallowed). The URL is shQuote'd (VMC-P2-1) so
 * a query `&`/`$(...)`/metachar can't rewrite the command or run before the download. Returns the ordered lines. Pure. */
export function buildHerdrInstallStep(url: string = HERDR_INSTALL_URL): string[] {
  return [
    `herdr_installer="$(mktemp)"`,
    `curl -fsSL ${shQuote(url)} -o "$herdr_installer" || exit 1`,
    `sh "$herdr_installer"`,
  ];
}

/** Idempotent boot plan (hard-condition: re-runnable from any point). Composes the shared herdr-install step + the shared
 *  capacity probe (D4-1 single source), so it can never drift from remote-herdr-view's bootstrap script again. Pure. */
export function buildBootPlan(opts: { herdrInstallUrl?: string } = {}): string[] {
  return [
    ...buildHerdrInstallStep(opts.herdrInstallUrl ?? HERDR_INSTALL_URL), // install herdr (the single construction point)
    CAPACITY_PROBE_CMD, // capacity probe → stdout (shared with remote-capacity's parsers)
    "# ensure every agent launcher uses `exec -a claude <real-binary>` (herdr argv0 identify)",
    "# reconcile hooks/config idempotently (safe to re-run)",
  ];
}

// ============================================================================================================
// IO shell — exec wrappers (dormant: SWARM_VM_CTL off; exercised by live runs, NOT the selftest)
// ============================================================================================================

/** vm-ctl wiring flip, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT / SWARM_SEAT_CAPS). */
export function vmCtlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_VM_CTL ?? "");
}
