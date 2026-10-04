/**
 * Persistent sid -> cc-socks socket-path registry (bus-reachability §1 / F31). A Claude node records WHERE its live UI
 * socket is, keyed by its durable session id, so a SENDER can native-direct to it (push.ts pushClaudeDirect) even when
 * the sender's broker roster is empty (tonight's "0 peers" outbound) or the target's agenthop node has died — as long as
 * the target's Claude host (and its /tmp/cc-socks/<pid>.sock) is still alive. Roster-INDEPENDENT on purpose, mirroring the
 * presence/<sid>.pid registry resolveSession already reads.
 *
 * The socket path is NOT a secret (the cc-socks dir is listable and the socket is owner-only), and it is machine-local by
 * construction (a /tmp path), so this never needs to — and never should — travel over the cross-machine relay.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

function ccFile(home: string, sid: string): string {
  return path.join(home, ".agenthop", "presence", `${sid.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown"}.cc`);
}

/** Record this Claude node's cc-socks socket path under its sid (atomic temp+rename, 0600). Best-effort: a failure here just
 *  means a would-be native-direct sender falls back to the durable inbox — never fatal. */
export function writeCcSocket(home: string, sid: string, socketPath: string): void {
  try {
    const file = ccFile(home, sid);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, socketPath, { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best-effort: native-direct degrades to the durable inbox */ }
}

/** The cc-socks socket path recorded for `sid`, or null if none (⇒ not a Claude target, or never recorded). */
export function readCcSocket(home: string, sid: string): string | null {
  try { const p = readFileSync(ccFile(home, sid), "utf8").trim(); return p.length > 0 ? p : null; }
  catch { return null; }
}

/** Drop this node's cc record on a clean shutdown (best-effort; a stale record just yields a failed connect ⇒ durable fallback). */
export function clearCcSocket(home: string, sid: string): void {
  try { unlinkSync(ccFile(home, sid)); } catch { /* already gone */ }
}
