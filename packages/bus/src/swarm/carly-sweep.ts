/**
 * Carly sweep wiring (dialog-officer M2-a follow-up — the sweep-tick that drives the projection + switchboard + outbox + beat).
 * This is the IO ORCHESTRATION that the dispatcher's sweep calls each tick (a thin closure in scripts/swarm-dispatch.ts registers
 * `runCarlySweep` in the tail array, flag-gated + throttled). It REUSES the already-reviewed primitives — `writeManagedFile`
 * (dual-write isolation + holder-lock + exclusive temp), `readCarlyStatus`, `generateRegistry`, `publishUniqueAtomic` — and adds
 * no new write surface of its own beyond the two beat/outbox mechanics.
 *
 * Four things per tick (each isolated — one fault never stops the others; the whole sweep step is fail-soft at the caller):
 *   1. generateRegistry  — refresh ~/.agenthop/projects.json (Carly's switchboard view).
 *   2. projection write   — HEARTBEAT/MEMORY managed region into Carly's WORKSPACE files (her actual auto-read, per her r1 review:
 *      ~/Library/Application Support/Tern/carly/), PLUS a swarm-side AUDIT copy under ~/.agenthop/carly/ (the pack marks it on-demand).
 *   3. outbox drain       — deliver swarm-carly-send's durable fallback outbox (~/.agenthop/carly/outbox/) to the resolved role box.
 *   4. coordinator.beat   — write the bare-epoch-seconds liveness beat Carly reads (the mutual-watch contract, §5 of the pack).
 *
 * Flag: SWARM_CARLY_PROJECTION, DEFAULT OFF (dormant merge discipline; flip is the user's / coordinator's).
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { writeInbox } from "../inbox.js";
import { isValidSessionId } from "../send-fallback.js";
import { resolveSession, listSessions } from "./task-liveness.js";
import { installInboxWake } from "./inbox-wake.js";
import { generateRegistry } from "./projects-registry-store.js";
import { readCarlyStatus, writeManagedFile, type CarlyStatus } from "./carly-projection-store.js";
import { buildHeartbeatBody, buildMemoryBody } from "./carly-projection.js";
import { CARLY_USAGE_NOTE } from "./carly-projection-store.js";

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

// --- beat contract (mutual watchdog, pack §5): one line of bare epoch seconds; >20min ⇒ stale. Literal paths PINNED here. ---
export const BEAT_STALE_SEC = 1200; // 20 minutes
export function coordinatorBeatPath(home: string): string { return path.join(home, ".agenthop", "swarm", "coordinator.beat"); }
export function carlyPatrolBeatPath(home: string): string { return path.join(home, ".agenthop", "carly", "carly-patrol.beat"); }

/** Write a bare-epoch-seconds beat atomically (temp+rename). The single-line integer format is the cross-program contract (shell
 *  `date +%s` writes it, a luau `tonumber(line)` reads it). */
export function writeBeat(file: string, nowSec: number): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.wtmp-${randomBytes(6).toString("hex")}`;
  try { writeFileSync(tmp, `${Math.floor(nowSec)}\n`, { flag: "wx", mode: 0o600 }); renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* own temp */ } throw e; }
}
/** Read a bare-epoch beat as an integer second, or null (absent/unreadable/non-numeric). Pure-ish (one read). */
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

/** Deliver swarm-carly-send's durable fallback outbox. Each `<ts>-<hex>.json` holds `{to:<role>, msg:<InboxMsg>}`; resolve the role
 *  to a sid and writeInbox (+ wake). On success the file is unlinked; an UNRESOLVABLE role or a write fault LEAVES the file (retry
 *  next tick) — never dropped, never double-delivered (unlink only after a confirmed write). Corrupt JSON is left for inspection.
 *  Returns the count delivered. */
export function drainOutbox(home: string, env: NodeJS.ProcessEnv = process.env): number {
  const dir = outboxDir(home);
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return 0; } // absent/unreadable ⇒ nothing to drain
  installInboxWake(undefined, env); // ms pane wake on publish (floor is the receiver's own poll)
  let delivered = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let rec: { to?: unknown; msg?: unknown };
    try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { continue; } // corrupt ⇒ leave for inspection
    if (typeof rec.to !== "string" || !rec.msg || typeof rec.msg !== "object") continue;
    const sid = resolveRoleSid(rec.to, home, env);
    if (!sid || !isValidSessionId(sid)) continue; // role not reachable now ⇒ leave, retry next tick
    try { writeInbox(home, sid, rec.msg as Parameters<typeof writeInbox>[2]); unlinkSync(file); delivered++; }
    catch { /* write/unlink fault ⇒ leave, retry (a second delivery is prevented by unlink only after a confirmed write) */ }
  }
  return delivered;
}

export type CarlySweepResult = {
  ran: boolean; registry: boolean; wroteProjection: boolean; drained: number; beat: boolean; reason?: string;
};

/**
 * One Carly sweep tick (flag-gated). Each of the four steps is isolated — a fault in one never stops the others. Returns a summary
 * (the caller logs it). Projection writes to BOTH the workspace (primary, her auto-read) and the audit copy, and ONLY when the
 * source status is certain (readCarlyStatus; an uncertain decision store ⇒ keep her last-good files, never clear the queue).
 */
export function runCarlySweep(home: string, env: NodeJS.ProcessEnv = process.env, nowSec: number = Math.floor(Date.now() / 1000)): CarlySweepResult {
  if (!carlyProjectionEnabled(env)) return { ran: false, registry: false, wroteProjection: false, drained: 0, beat: false, reason: "disabled" };
  const r: CarlySweepResult = { ran: true, registry: false, wroteProjection: false, drained: 0, beat: false };

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

  try { writeBeat(coordinatorBeatPath(home), nowSec); r.beat = true; } catch { /* isolated */ }

  return r;
}
