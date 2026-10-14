/**
 * Carly sweep wiring (dialog-officer M2-a follow-up — the sweep-tick that drives the projection + switchboard + outbox drain).
 * A thin closure in scripts/swarm-dispatch.ts registers `runCarlySweep` in the sweep tail (flag-gated + throttled). It REUSES the
 * already-reviewed primitives — `writeManagedFile` (dual-write isolation + holder-lock + exclusive temp), `readCarlyStatus`,
 * `generateRegistry`, and `writeInbox`'s publishOnce exactly-once — and adds no new write surface of its own.
 *
 * Three isolated steps per tick (one fault never stops the others; the whole step is fail-soft at the caller):
 *   1. generateRegistry  — refresh ~/.agenthop/projects.json (Carly's switchboard view).
 *   2. projection write   — HEARTBEAT/MEMORY managed region into Carly's WORKSPACE files (her actual auto-read, per her r1 review:
 *      ~/Library/Application Support/Tern/carly/), PLUS a swarm-side AUDIT copy under ~/.agenthop/carly/ (the pack marks it on-demand).
 *   3. outbox drain       — deliver swarm-carly-send's durable fallback outbox (~/.agenthop/carly/outbox/) to the resolved role box,
 *      EXACTLY ONCE (each file's stable basename is the publishOnce idempotency key; clear the source only on a confirmed durable landing).
 *
 * The coordinator.beat is DELIBERATELY NOT written here (CS-BEAT-SOURCE): a live dispatcher is NOT proof the coordinator's scan loop
 * is alive, so the sweep must not forge that liveness. The coordinator writes its own beat each scan; this module only carries the
 * READ side of the beat contract (readBeatSec / beatStale) + the pinned literal paths.
 *
 * Flag: SWARM_CARLY_PROJECTION, DEFAULT OFF (dormant merge discipline; flip is the user's / coordinator's).
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { writeInbox } from "../inbox.js";
import { isValidSessionId } from "../send-fallback.js";
import { resolveSession, listSessions } from "./task-liveness.js";
import { installInboxWake } from "./inbox-wake.js";
import { generateRegistry } from "./projects-registry-store.js";
import { readCarlyStatus, writeManagedFile, CARLY_USAGE_NOTE, type CarlyStatus } from "./carly-projection-store.js";
import { buildHeartbeatBody, buildMemoryBody } from "./carly-projection.js";

/** SWARM_CARLY_PROJECTION — DEFAULT OFF (opt-in; mirrors placementEnabled). Read at the call site. Pure. */
export function carlyProjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_CARLY_PROJECTION ?? "");
}

/** Carly's WORKSPACE dir — the files she AUTO-READS every session (her r1 review: these, NOT ~/.agenthop/carly/). macOS default;
 *  `CARLY_WORKSPACE_DIR` overrides (tests + portability). This is the sweep's PRIMARY projection target. */
export function carlyWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARLY_WORKSPACE_DIR ?? path.join(homedir(), "Library", "Application Support", "Tern", "carly");
}
/** The swarm-side AUDIT copy dir (read on-demand per the pack). */
export function carlyAuditDir(home: string): string { return path.join(home, ".agenthop", "carly"); }
export function outboxDir(home: string): string { return path.join(home, ".agenthop", "carly", "outbox"); }

// --- beat contract (mutual watchdog, pack §5): one line of bare epoch seconds; >20min ⇒ stale. READ side only (the coordinator
//     writes coordinator.beat from its own scan loop; Carly writes carly-patrol.beat from her patrol). Literal paths PINNED here. ---
export const BEAT_STALE_SEC = 1200; // 20 minutes
export function coordinatorBeatPath(home: string): string { return path.join(home, ".agenthop", "swarm", "coordinator.beat"); }
export function carlyPatrolBeatPath(home: string): string { return path.join(home, ".agenthop", "carly", "carly-patrol.beat"); }

/** Read a bare-epoch beat as an integer second, or null (absent/unreadable/non-numeric). The single-line integer format is the
 *  cross-program contract (shell `date +%s` writes it, a luau `tonumber(line)` reads it, this reads it). */
export function readBeatSec(file: string): number | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const n = Number((text.split("\n")[0] ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** A beat is STALE iff absent/unreadable OR older than `thresholdSec`. Pure. */
export function beatStale(beatSec: number | null, nowSec: number, thresholdSec: number = BEAT_STALE_SEC): boolean {
  return beatSec === null || nowSec - beatSec > thresholdSec;
}

// --- role resolution for the outbox drain (tiny; a bus module must NOT import the script that defines the sender). ---
function roleEnvVar(role: string): string {
  return "SWARM_" + role.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function resolveRoleSid(role: string, home: string, env: NodeJS.ProcessEnv): string | null {
  const handle = env[roleEnvVar(role)];
  if (typeof handle !== "string" || handle.trim() === "") return null;
  return resolveSession(handle.trim(), listSessions(home));
}

/** Write Carly's two managed files into `dir`, reusing the reviewed writeManagedFile (dual-write isolation + lock + exclusive temp).
 *  Returns false if any managed write was skipped (lock busy) ⇒ caller treats as "retry next tick". */
function writeManagedPair(dir: string, status: CarlyStatus): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hb = writeManagedFile(path.join(dir, "HEARTBEAT.md"), buildHeartbeatBody(status.heartbeat));
  const mem = writeManagedFile(path.join(dir, "MEMORY.md"), buildMemoryBody(status) + "\n\n" + CARLY_USAGE_NOTE);
  return hb && mem;
}

/**
 * Deliver swarm-carly-send's durable fallback outbox. Each `<ts>-<hex>.json` holds `{to:<role>, msg:<InboxMsg>}`.
 *  - CS-OUTBOX-ONCE: deliver with the file's STABLE basename as the publishOnce idempotency key, so a re-drain after a failed unlink
 *    (or a restart) returns "already" — the message lands EXACTLY ONCE even though the credential persists after the receiver takes
 *    it. The source is cleared ONLY on a confirmed durable result ("published" | "already"); any other result keeps the obligation.
 *  - CS-OUTBOX-SHAPE: the ROOT shape is validated before any field access, and EACH file is handled in its own try/catch — one
 *    malformed file (null/array/scalar JSON, or a write fault) is isolated and LEFT; the rest of the drain continues.
 * Returns the count confirmed delivered. */
export function drainOutbox(home: string, env: NodeJS.ProcessEnv = process.env): number {
  const dir = outboxDir(home);
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return 0; } // absent/unreadable ⇒ nothing to drain
  installInboxWake(undefined, env); // ms pane wake on publish (floor is the receiver's own poll)
  let delivered = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      let rec: unknown;
      try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { continue; } // corrupt JSON ⇒ leave for inspection
      if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue; // CS-OUTBOX-SHAPE: bad root ⇒ isolate + leave
      const r = rec as { to?: unknown; msg?: unknown };
      if (typeof r.to !== "string" || !r.msg || typeof r.msg !== "object") continue; // bad fields ⇒ leave
      const sid = resolveRoleSid(r.to, home, env);
      if (!sid || !isValidSessionId(sid)) continue; // role not reachable now ⇒ leave, retry next tick
      const key = name.replace(/\.json$/, ""); // stable per-file idempotency key (`<ts>-<hex>`, publishOnce-safe)
      const res = writeInbox(home, sid, r.msg as Parameters<typeof writeInbox>[2], key);
      if (res === "published" || res === "already") { unlinkSync(file); delivered++; } // confirmed durable ⇒ clear source
      // deferred/pending/unknown ⇒ keep the file (retry next tick); "already" after a prior landing prevents a duplicate
    } catch { /* this one file faulted (parse/resolve/write/unlink) ⇒ isolate + leave; the rest of the drain continues */ }
  }
  return delivered;
}

export type CarlySweepResult = {
  ran: boolean; registry: boolean; wroteProjection: boolean; drained: number; reason?: string;
};

/**
 * One Carly sweep tick (flag-gated). Each of the three steps is isolated — a fault in one never stops the others. Returns a summary
 * (the caller logs it). Projection writes to BOTH the workspace (primary, her auto-read) and the audit copy, and ONLY when the
 * source status is certain (readCarlyStatus; an uncertain decision store ⇒ keep her last-good files, never clear the queue).
 */
export function runCarlySweep(home: string, env: NodeJS.ProcessEnv = process.env): CarlySweepResult {
  if (!carlyProjectionEnabled(env)) return { ran: false, registry: false, wroteProjection: false, drained: 0, reason: "disabled" };
  const r: CarlySweepResult = { ran: true, registry: false, wroteProjection: false, drained: 0 };

  try { r.registry = generateRegistry(home, env).written; } catch { /* isolated */ }

  try {
    const { status, certain } = readCarlyStatus(home);
    if (certain) {
      const w1 = writeManagedPair(carlyWorkspaceDir(env), status); // PRIMARY — her auto-read
      const w2 = writeManagedPair(carlyAuditDir(home), status);    // swarm-side audit copy
      r.wroteProjection = w1 && w2;
    } // uncertain ⇒ skip (keep her last-good files)
  } catch { /* isolated */ }

  try { r.drained = drainOutbox(home, env); } catch { /* isolated */ }

  return r;
}
