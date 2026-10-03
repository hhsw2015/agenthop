/**
 * Durable per-session inbox. When an inbound bus message cannot be PUSHED into the host's live UI (the native channel
 * is not ready yet — e.g. a Codex session that has not taken its first turn, so it has no rollout for `codex queue`, or
 * a session whose cc-socks env is missing), it must not sit in a volatile in-memory array that only an explicit
 * agenthop_recv drains. We persist it to disk and let core.ts re-attempt delivery on a timer, the moment the session
 * becomes reachable (noteThread), and after any successful push — so a queued message auto-surfaces with no manual
 * recv and survives an MCP-subprocess restart.
 *
 * Concurrency: a drainer CLAIMS a message by atomically renaming its file, delivers, then ACKs (removes) on success or
 * RELEASES (renames back) on failure — so the retry timer and an explicit recv never deliver the same message twice.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type InboxMsg = { from: string; fromLabel: string; fromMode?: string; text: string; via: "local" | "relay"; ts: number; actionId?: string };
export type Claimed = { file: string; msg: InboxMsg };

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}
function inboxDir(home: string, key: string): string {
  return path.join(home, ".agenthop", "inbox", sanitize(key));
}

/** Append a message to the durable inbox for `key` (atomic temp+rename, 0600). */
export function writeInbox(home: string, key: string, msg: InboxMsg): void {
  const dir = inboxDir(home, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${msg.ts.toString().padStart(16, "0")}-${Math.random().toString(36).slice(2, 8)}.json`;
  const file = path.join(dir, base);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(msg), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Atomically claim every pending message under ANY of `keys` (oldest first). The claimer must ack or release each. */
export function claimInbox(home: string, keys: string[], claimer: string): Claimed[] {
  const out: Claimed[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const dir = inboxDir(home, key);
    if (seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { continue; }
    for (const n of names) {
      const src = path.join(dir, n);
      const claimed = `${src}.claim-${claimer}`;
      try {
        renameSync(src, claimed); // atomic: if a concurrent drainer already took it, this throws -> skip
        out.push({ file: claimed, msg: JSON.parse(readFileSync(claimed, "utf8")) as InboxMsg });
      } catch {
        // claimed/removed by someone else, or malformed — skip (a malformed claimed file is cleaned below on ack)
      }
    }
  }
  return out;
}

/** Delivered successfully -> remove the claimed file. */
export function ackInbox(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

/** Could not deliver -> put it back for a later attempt (strip the .claim-<id> suffix). */
export function releaseInbox(file: string): void {
  try { renameSync(file, file.replace(/\.claim-[^.]+$/, "")); } catch { /* best-effort */ }
}

/**
 * Release claims whose holder process is gone. A drainer that crashed/restarted (or broke out of its flush
 * loop) mid-delivery leaves the file as `.claim-<pid>`; claimInbox only sees `.json`, so without this sweep
 * that message is stranded forever — the exact loss the durable inbox exists to prevent. A claim held by a
 * LIVE pid is left alone (it is being delivered right now). Run at startup, before the first flush.
 */
export function recoverStaleClaims(home: string, keys: string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    const dir = inboxDir(home, key);
    if (seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = n.match(/\.claim-(\d+)$/);
      if (!m || alive(Number(m[1]))) continue;
      try { renameSync(path.join(dir, n), path.join(dir, n.replace(/\.claim-\d+$/, ""))); } catch { /* best-effort */ }
    }
  }
}

/** True while the pid is a running process — including one we may not signal (EPERM). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
