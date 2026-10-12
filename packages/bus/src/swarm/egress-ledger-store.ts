/**
 * egress-ledger IO seam (brief §④). Persists the hash chain as ONE FILE PER ENTRY (`<seq>.json`, atomic tmp+rename) under a
 * holder-lock APPEND lock, so concurrent appends from two sessions on one home dir serialize and never fork the chain. The pure
 * chain math + verify live in egress-ledger.ts; this file only does the locked read-tail → chainEntry → atomic write, plus the
 * two-phase record API (intent first / result after, bridge r8). Everything is fail-OPEN: a recording fault NEVER blocks the
 * caller's send — it returns null/false and leaves a visible gap, it does not throw into the egress path.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";
import { chainEntry, parseEgressEntry, type EgressBody, type EgressEntry, type ByteMagnitude, type EgressOutcome } from "./egress-ledger.js";

/** The ledger dir. Default `<home>/.agenthop/swarm/egress/`; `AGENTHOP_EGRESS_DIR` overrides (tests). */
export function egressDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTHOP_EGRESS_DIR ?? path.join(home, ".agenthop", "swarm", "egress");
}

/** PROJ-1/2 lesson: refuse to write if the egress dir (or its `swarm` parent) is a SYMLINK — a planted link would redirect our
 *  writes outside the 0o700 boundary. lstat does not follow; a missing dir is fine (we create it). Returns false ⇒ skip write. */
function boundaryOk(dir: string): boolean {
  for (const d of [dir, path.dirname(dir)]) {
    try { if (lstatSync(d).isSymbolicLink()) return false; } catch { /* ENOENT (not yet created) is fine */ }
  }
  return true;
}

const seqRe = /^(\d+)\.json$/;
function entryFile(dir: string, seq: number): string { return path.join(dir, `${String(seq).padStart(12, "0")}.json`); }
function lockSite(dir: string): LockSite { return { lockDir: path.join(dir, ".append.lockd"), intentDir: dir, intentPrefix: "egress.append.hold." }; }

/** Read the whole ledger in seq order. A corrupt/partial entry file parses to null and is DROPPED here (verifyEgressChain is the
 *  integrity authority — it classifies a trailing null as incomplete-tail, an interior one as tampering). Read faults PROPAGATE
 *  via the readdir throw so the caller (verify/list CLI) never folds an unreadable dir to an empty ledger. */
export function readEgressLedger(dir: string): EgressEntry[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; } // dir absent ⇒ empty ledger (list/verify both treat as 0 entries)
  const seqs = names.map((n) => seqRe.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b);
  const out: EgressEntry[] = [];
  for (const seq of seqs) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(entryFile(dir, seq), "utf8")); } catch { continue; } // orphan .tmp never matches seqRe; a half-written file ⇒ skip (verify flags the gap)
    const e = parseEgressEntry(raw);
    if (e !== null) out.push(e);
  }
  return out;
}

/** The highest persisted entry (the chain tail), or null when empty. */
function readTail(dir: string): EgressEntry | null {
  const all = readEgressLedger(dir);
  return all.length > 0 ? all[all.length - 1]! : null;
}

/**
 * Append one body under the append lock: ensure the dir, take the lock (bounded retry), read the tail, chainEntry, write the next
 * `<seq>.json` atomically (tmp+rename — a crash before rename leaves an ignored `.tmp-*` orphan, after rename a complete entry; no
 * half entry ever enters the chain), release. Returns the entry, or null on ANY fault (fail-OPEN — the caller's send proceeds).
 */
function appendBody(dir: string, body: EgressBody): EgressEntry | null {
  if (!boundaryOk(dir)) return null;
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  let token: string | null = null;
  for (let i = 0; i < 50 && token === null; i += 1) token = acquireHolderLock(lockSite(dir)); // bounded spin (single-machine, infrequent)
  if (token === null) return null; // could not serialize ⇒ fail-open (skip the record, not the send)
  try {
    const entry = chainEntry(readTail(dir), body);
    const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    try { renameSync(tmp, entryFile(dir, entry.seq)); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best-effort */ } throw e; }
    return entry;
  } catch { return null; } // fail-open
  finally { releaseHolderLock(lockSite(dir), token); }
}

/** Record an egress INTENT (before/around the call). Returns the eventId (to pair the later result), or null on a recording fault
 *  (fail-open — the caller's send is NOT blocked). dest-HOST only (the caller must pass a bare host, never a URL). */
export function recordEgressIntent(dir: string, e: { destHost: string; callFace: string; initiatorSid: string }, nowSec: number): string | null {
  const eventId = `eg_${randomBytes(8).toString("hex")}`;
  const entry = appendBody(dir, { kind: "intent", eventId, tsSec: nowSec, destHost: e.destHost, callFace: e.callFace, initiatorSid: e.initiatorSid });
  return entry === null ? null : eventId;
}

/** Record an egress RESULT (after the call), pairing the intent's eventId. Returns false on a recording fault (fail-open). */
export function recordEgressResult(dir: string, e: { eventId: string; byteMagnitude: ByteMagnitude; outcome: EgressOutcome }, nowSec: number): boolean {
  return appendBody(dir, { kind: "result", eventId: e.eventId, tsSec: nowSec, byteMagnitude: e.byteMagnitude, outcome: e.outcome }) !== null;
}
