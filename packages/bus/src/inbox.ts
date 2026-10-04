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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type InboxMsg = { from: string; fromLabel: string; fromMode?: string; text: string; via: "local" | "relay"; ts: number; actionId?: string; taskRef?: string; title?: string };
export type Claimed = { file: string; msg: InboxMsg };

/** Validate a parsed inbox record against the transport schema (F28 poison-pill defense). from/fromLabel/text are REQUIRED
 *  strings, via ∈ {local,relay}, ts a finite number — a missing/mistyped one is exactly what reached xml()'s `.replace(undefined)`
 *  and crashed the whole bus server. fromMode/actionId (and any future display fields like taskRef/title) are optional and
 *  tolerated. Returns the typed msg, or null ⇒ the caller QUARANTINES it (never delivers, never derefs an undefined). */
export function validInboxMsg(raw: unknown): InboxMsg | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.from !== "string" || typeof r.fromLabel !== "string" || typeof r.text !== "string") return null;
  if (r.via !== "local" && r.via !== "relay") return null;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  if (r.fromMode !== undefined && typeof r.fromMode !== "string") return null;
  if (r.actionId !== undefined && typeof r.actionId !== "string") return null;
  // S11 display fields (taskRef/title): optional, but when PRESENT must be preserved, not dropped (review 6da8b5c-P2 — the
  // validator rebuild was silently losing them). A present-but-mistyped one is rejected like the other optionals.
  if (r.taskRef !== undefined && typeof r.taskRef !== "string") return null;
  if (r.title !== undefined && typeof r.title !== "string") return null;
  return {
    from: r.from, fromLabel: r.fromLabel, text: r.text, via: r.via, ts: r.ts,
    ...(typeof r.fromMode === "string" ? { fromMode: r.fromMode } : {}),
    ...(typeof r.actionId === "string" ? { actionId: r.actionId } : {}),
    ...(typeof r.taskRef === "string" ? { taskRef: r.taskRef } : {}),
    ...(typeof r.title === "string" ? { title: r.title } : {}),
  };
}

/** Move a POISON inbox file out of the delivery path (into inbox/<sid>/quarantine/) so it can never be re-claimed and re-crash
 *  the server (F28 poison-pill perpetual motion), + append a dead-letter line to the F26 ledger for audit/routing-incident input.
 *  NEVER throws — quarantine is pure damage-control and must not itself take down the flush. */
export function quarantineInbox(home: string, claimedFile: string, reason: string, raw?: string): void {
  const dir = path.dirname(claimedFile);
  const qdir = path.join(dir, "quarantine");
  const base = path.basename(claimedFile).replace(/\.claim-[^.]+$/, "");
  // UNIQUE, unguessable target: Date.now() alone collides for two poison files stripping to the same base in the same ms, and
  // rename() overwrites — destroying the first file's evidence (review 6da8b5c-P2-3). A random suffix makes each quarantine
  // name distinct, so no move clobbers another's bytes (no exists-then-rename TOCTOU either).
  const target = path.join(qdir, `${base}.${Date.now()}.${randomBytes(6).toString("hex")}`);
  try { mkdirSync(qdir, { recursive: true, mode: 0o700 }); renameSync(claimedFile, target); }
  catch {
    // The move did NOT happen: either the file already vanished (a concurrent drainer took it — ENOENT) or the FS failed
    // (mkdir/rename error). In BOTH cases do NOT write a "quarantined" dead-letter — that would be a false audit for a file
    // still in the delivery path (review 6da8b5c-P2-2). The file (if still present) stays .claim-<pid>, safely OUT of the
    // deliverable .json set; recoverStaleClaims + the next claim re-attempt the quarantine. Never throw (don't kill flush).
    return;
  }
  // The file is REALLY quarantined now ⇒ record the dead-letter audit line. Best-effort: if the append fails the bytes are
  // still safely preserved in quarantine/ (the durable evidence), so a lost audit line never risks re-delivery or a crash.
  try {
    let from: string | undefined; let preview: string | undefined;
    if (raw !== undefined) { try { const r = JSON.parse(raw) as Record<string, unknown>; if (typeof r.from === "string") from = r.from; if (typeof r.text === "string") preview = r.text.slice(0, 120); } catch { /* unparseable ⇒ no fields */ } }
    const to = path.basename(dir); // the recipient sid = the inbox dir name
    const line = JSON.stringify({ ts: Date.now(), ...(from !== undefined ? { from } : {}), to, error: `quarantined: ${reason}`, ...(preview !== undefined ? { preview } : {}) });
    const ledger = path.join(home, ".agenthop", "swarm", "dead-letters.jsonl");
    mkdirSync(path.dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${line}\n`, { mode: 0o644 });
  } catch { /* audit best-effort; the bytes are already quarantined */ }
}

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
      try { renameSync(src, claimed); } catch { continue; } // atomic: a concurrent drainer already took it / it vanished -> skip
      let raw: string;
      try { raw = readFileSync(claimed, "utf8"); } catch { continue; } // vanished right after the claim -> skip
      // F28: validate the transport schema on read; a poison file (unparseable OR missing/mistyped required fields) is
      // QUARANTINED out of the delivery path (never deref'd, never crashes the server, never re-claimed) — not returned.
      let msg: InboxMsg | null;
      try { msg = validInboxMsg(JSON.parse(raw)); } catch { msg = null; }
      if (msg === null) { quarantineInbox(home, claimed, "schema/parse", raw); continue; }
      out.push({ file: claimed, msg });
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
