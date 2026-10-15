// Tern transport for inbox-wake (the herdr transport's sibling) + the seat-shell registration the unique-claimant gate reads.
// Why (PROGRESS #1025): after the herdr→Tern migration a seat's sid can be live in BOTH shells. Wake pings only went to herdr, so the
// Tern seat was never woken while the stale herdr instance of the SAME sid was — and it started claiming the item. This module lets
// inbox-wake reach a Tern block, and records which shell OWNS a seat so the stale shell's claim is refused.
//
// Truth source = the Tern daemon (`tern inspect --json`), NEVER the agents-bridge mirror (agents.json can freeze — the advisory-mirror
// lesson). `tern ls --json` carries no agent state, but `inspect` panes[] carry `working:boolean` — that is the not-working gate.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentState } from "./herdr.js";

export type Shell = "tern" | "herdr";

export const TERN_BIN = process.env.TERN_BIN || "tern";

/** Tern reachable from THIS process: inside a Tern pane (TERN_PANE) or an explicit TERN_BIN. Pure. */
export function ternSpawnable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TERN_PANE || !!env.TERN_BIN;
}

/** The shell THIS process runs in, from its own env (self-attestation). Tern wins if both are set (a Tern pane launched from a herdr
 *  pane inherits HERDR_*, never the reverse). null = cannot attest (e.g. a codex seat's MCP child, which inherits neither). Pure. */
export function selfShell(env: NodeJS.ProcessEnv = process.env): Shell | null {
  if (env.TERN_PANE) return "tern";
  if ((env.HERDR_ENV ?? "") === "1" && env.HERDR_PANE_ID) return "herdr";
  return null;
}

/** Resolve sid → {paneId, state} from `tern inspect --json` (pure). A pane matches when it has NOT exited and its command line carries
 *  `--resume <sid>` as a whole token. `working:true` ⇒ "working", `false` ⇒ "idle", absent ⇒ "unknown" (still never interrupted).
 *  More than one live pane for the sid ⇒ ambiguous ⇒ null (don't guess which one to type into; delivery is already durable). */
export function ternPaneInfoForSession(inspectJson: unknown, sid: string): { paneId: string; state: AgentState } | null {
  if (!sid) return null;
  const panes = (inspectJson as { panes?: unknown })?.panes;
  if (!Array.isArray(panes)) return null;
  const hits: { paneId: string; state: AgentState }[] = [];
  for (const p of panes) {
    const rec = p as { pane?: unknown; exited?: unknown; args?: unknown; command?: unknown; working?: unknown };
    if (rec == null || (rec.pane !== 0 && !rec.pane)) continue;
    if (rec.exited !== null && rec.exited !== undefined) continue; // exited block ⇒ not a wake target
    const tokens = Array.isArray(rec.args) ? rec.args.map(String).join(" ").split(/\s+/) : String(rec.command ?? "").split(/\s+/);
    let found = false;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--resume" && tokens[i + 1] === sid) { found = true; break; }
      if (tokens[i] === `--resume=${sid}`) { found = true; break; }
    }
    if (!found) continue;
    const state: AgentState = rec.working === true ? "working" : rec.working === false ? "idle" : "unknown";
    hits.push({ paneId: String(rec.pane), state });
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** The exact argv pair used to wake a Tern block: type the line, then press Enter (verified working this morning). Pure. */
export function ternInjectCommands(paneId: string, text: string): [string[], string[]] {
  return [["send", paneId, "text", text], ["send", paneId, "keys", "Enter"]];
}

/** Run a tern CLI command; resolves {code, stdout}. Never throws. */
function ternRun(args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(TERN_BIN, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

export async function ternPaneInfoLive(sid: string): Promise<{ paneId: string; state: AgentState } | null> {
  const { code, stdout } = await ternRun(["inspect", "--json"]);
  if (code !== 0) return null;
  try { return ternPaneInfoForSession(JSON.parse(stdout), sid); } catch { return null; }
}

/** Inject the wake line into a Tern block: text, then Enter. true only when BOTH sends exited 0. */
export async function ternInject(paneId: string, text: string): Promise<boolean> {
  const [typeCmd, enterCmd] = ternInjectCommands(paneId, text);
  if ((await ternRun(typeCmd)).code !== 0) return false;
  return (await ternRun(enterCmd)).code === 0;
}

// --- seat-shell registration (one file per seat: no shared read-modify-write) ---------------------------------------------------

export function seatShellDir(home: string): string { return path.join(home, ".agenthop", "swarm", "seat-shell"); }
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `pid` is a RESERVED slot (coordinator, 2026-10-15): tern-restore will record the seat's `tern acp` child pid here in the same step
 *  as the shell, for presence. Optional; the claim gate and wake routing do not read it. */
export type SeatShellRead = { kind: "registered"; shell: Shell; pid?: number } | { kind: "absent" } | { kind: "unreadable" };

/** Three-state read of a seat's registered shell. ENOENT ⇒ absent; a read fault / malformed / unknown value ⇒ unreadable. */
export function readSeatShell(home: string, sid: string): SeatShellRead {
  if (!SID_RE.test(sid)) return { kind: "unreadable" };
  let raw: string;
  try { raw = readFileSync(path.join(seatShellDir(home), `${sid}.json`), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }; }
  try {
    const v = JSON.parse(raw) as { shell?: unknown; pid?: unknown };
    if (v && (v.shell === "tern" || v.shell === "herdr")) {
      const pid = Number.isSafeInteger(v.pid) && (v.pid as number) > 0 ? (v.pid as number) : undefined; // a bad pid is ignored, never fatal
      return pid === undefined ? { kind: "registered", shell: v.shell } : { kind: "registered", shell: v.shell, pid };
    }
  } catch { /* fallthrough */ }
  return { kind: "unreadable" };
}

/** Register a seat's shell: O_EXCL-owned temp written through its own fd, then an atomic rename. Throws on a bad sid/shell or IO fault. */
export function writeSeatShell(home: string, sid: string, shell: Shell, nowSec: number, pid?: number): void {
  if (!SID_RE.test(sid)) throw new Error(`invalid sid: ${sid}`);
  if (shell !== "tern" && shell !== "herdr") throw new Error(`invalid shell: ${String(shell)}`);
  if (pid !== undefined && !(Number.isSafeInteger(pid) && pid > 0)) throw new Error(`invalid pid: ${String(pid)}`);
  const dir = seatShellDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${sid}.json`);
  let tmp = "";
  let fd: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    tmp = `${dest}.tmp-${randomBytes(8).toString("hex")}`;
    try { fd = openSync(tmp, "wx", 0o600); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 32) continue; throw e; }
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ sid, shell, ...(pid !== undefined ? { pid } : {}), registeredAtSec: Math.floor(nowSec) })}\n`);
    closeSync(fd); fd = undefined;
    renameSync(tmp, dest);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
    try { unlinkSync(tmp); } catch { /* only our own temp */ }
    throw e;
  }
}

/** Which transports to try for a seat, in order. Registered ⇒ only that shell. Absent/unreadable ⇒ both, Tern first (the migration
 *  target; a Tern block that exists is the live one). Pure. */
export function wakeRoute(reg: SeatShellRead): Shell[] {
  return reg.kind === "registered" ? [reg.shell] : ["tern", "herdr"];
}

/** Unique-claimant decision. Refuse ONLY on a positive mismatch: the seat is registered to one shell and this process attests the
 *  other. An unregistered/unreadable seat, or a process that cannot attest (null), is allowed — never strand a seat's mail. Pure. */
export function claimAllowed(reg: SeatShellRead, self: Shell | null): boolean {
  if (reg.kind !== "registered" || self === null) return true;
  return reg.shell === self;
}
