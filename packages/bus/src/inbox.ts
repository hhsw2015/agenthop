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
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { isSubmitIntent, type SubmitIntent } from "./submit-intent.js";
import { redactSecrets } from "./redact.js";

export type InboxMsg = { from: string; fromLabel: string; fromMode?: string; text: string; via: string; ts: number; actionId?: string; taskRef?: string; title?: string; intent?: SubmitIntent };
export type Claimed = { file: string; msg: InboxMsg };

/** Validate a parsed inbox record against the transport schema (F28 poison-pill defense). from/fromLabel/text are REQUIRED
 *  strings, via any NON-EMPTY string, ts a finite number — a missing/mistyped one is exactly what reached xml()'s
 *  `.replace(undefined)` and crashed the whole bus server. F38: `via` is a free-form provenance LABEL ("local"/"relay"
 *  carry transport semantics; an unknown label like "durable-inbox" is kept and displayed as-is, never a reason to
 *  quarantine) — the validator and the S11 docs were two sources of truth and a documented "durable-inbox" write got
 *  wrongly isolated; one schema now, tolerant of the label. fromMode/actionId (and display fields taskRef/title) are
 *  optional and tolerated. Returns the typed msg, or null ⇒ the caller QUARANTINES it (never delivers, never derefs undefined). */
export function validInboxMsg(raw: unknown): InboxMsg | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.from !== "string" || typeof r.fromLabel !== "string" || typeof r.text !== "string") return null;
  if (typeof r.via !== "string" || r.via.length === 0) return null; // F38: any non-empty label; missing/empty still rejected
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  if (r.fromMode !== undefined && typeof r.fromMode !== "string") return null;
  if (r.actionId !== undefined && typeof r.actionId !== "string") return null;
  // S11 display fields (taskRef/title): optional, but when PRESENT must be preserved, not dropped (review 6da8b5c-P2 — the
  // validator rebuild was silently losing them). A present-but-mistyped one is rejected like the other optionals.
  if (r.taskRef !== undefined && typeof r.taskRef !== "string") return null;
  if (r.title !== undefined && typeof r.title !== "string") return null;
  if (r.intent !== undefined && !isSubmitIntent(r.intent)) return null; // submit-tag: a present intent must be a known value
  return {
    from: r.from, fromLabel: r.fromLabel, text: r.text, via: r.via, ts: r.ts,
    ...(typeof r.fromMode === "string" ? { fromMode: r.fromMode } : {}),
    ...(typeof r.actionId === "string" ? { actionId: r.actionId } : {}),
    ...(typeof r.taskRef === "string" ? { taskRef: r.taskRef } : {}),
    ...(typeof r.title === "string" ? { title: r.title } : {}),
    ...(isSubmitIntent(r.intent) ? { intent: r.intent } : {}),
  };
}

/** Canonical constructor for an inbox envelope (F38): the ONE validated way scripts/members build a durable message, so a
 *  hand-written S11 record can never drift from validInboxMsg again (the root cause this fix closes). Fills ts (now) and a
 *  via label ("durable-inbox") when omitted, keeps only known fields, and re-validates — throwing on anything the receiver
 *  would quarantine. S11 docs point here instead of hand-writing JSON. */
export function composeInboxMsg(i: {
  from: string; fromLabel: string; text: string; via?: string; ts?: number; fromMode?: string; actionId?: string; taskRef?: string; title?: string; intent?: SubmitIntent;
}): InboxMsg {
  const msg: InboxMsg = {
    from: i.from, fromLabel: i.fromLabel, text: i.text,
    via: i.via ?? "durable-inbox",
    ts: i.ts ?? Date.now(),
    ...(i.fromMode !== undefined ? { fromMode: i.fromMode } : {}),
    ...(i.actionId !== undefined ? { actionId: i.actionId } : {}),
    ...(i.taskRef !== undefined ? { taskRef: i.taskRef } : {}),
    ...(i.title !== undefined ? { title: i.title } : {}),
    ...(i.intent !== undefined ? { intent: i.intent } : {}),
  };
  const valid = validInboxMsg(msg);
  if (valid === null) throw new Error("composeInboxMsg: produced an invalid inbox message (from/fromLabel/text must be strings, via a non-empty string, ts finite)");
  return valid;
}

/** Move a POISON inbox file out of the delivery path (into inbox/<sid>/quarantine/) so it can never be re-claimed and re-crash
 *  the server (F28 poison-pill perpetual motion), + append a dead-letter line to the F26 ledger for audit/routing-incident input.
 *  NEVER throws — quarantine is pure damage-control and must not itself take down the flush. */
export type QuarantineResult = "quarantined" | "vanished" | "failed";
export function quarantineInbox(home: string, claimedFile: string, reason: string, raw?: string): QuarantineResult {
  const dir = path.dirname(claimedFile);
  const qdir = path.join(dir, "quarantine");
  const base = path.basename(claimedFile).replace(/\.claim-[^.]+$/, "");
  // UNIQUE, unguessable target: Date.now() alone collides for two poison files stripping to the same base in the same ms, and
  // rename() overwrites — destroying the first file's evidence (review 6da8b5c-P2-3). A random suffix makes each quarantine
  // name distinct, so no move clobbers another's bytes (no exists-then-rename TOCTOU either).
  try {
    mkdirSync(qdir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      const target = path.join(qdir, `${base}.${Date.now()}.${randomBytes(8).toString("hex")}`);
      try { linkSync(claimedFile, target); break; } // atomic NO-OVERWRITE (P2-3): EEXIST if the name exists -> retry a fresh one
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 8) continue; throw e; }
    }
    // The link now holds the bytes in quarantine/; remove the source. Best-effort: if the link already succeeded but this
    // unlink fails (or the source raced away), the bytes ARE preserved in quarantine — do NOT fall into the catch below and
    // misreport a move that actually happened.
    try { unlinkSync(claimedFile); } catch { /* bytes already safe via the link */ }
  } catch (e) {
    // The move did NOT happen: either the file already vanished (a concurrent drainer took it — ENOENT) or the FS failed
    // (mkdir/link error). In BOTH cases do NOT write a "quarantined" dead-letter — that would be a false audit for a file
    // still in the delivery path (review 6da8b5c-P2-2). The file (if still present) stays .claim-<pid>, safely OUT of the
    // deliverable .json set; recoverStaleClaims + the next claim re-attempt the quarantine. Never throw (don't kill flush).
    // ENOENT is AMBIGUOUS (review bb6dad5-P2-4-A): linkSync raises it both when the SOURCE is gone (truly "vanished") AND
    // when the destination quarantine/ dir was removed between mkdir and link while the source .claim-<pid> is fully
    // present. errno alone can't tell them apart — so only "vanished" when the source is CONFIRMED gone; otherwise the move
    // failed with the source still in hand and the caller MUST release it (reporting "vanished" would skip recovery and
    // strand a live-pid claim, re-opening P2-4). The re-check MUST preserve the errno class (review 6c4c33a-P2): existsSync
    // folds a query failure (EACCES on the source dir's search bit, EIO, ...) into `false`, which would mislabel an
    // unconfirmable source as "vanished" and drop the retry obligation — only a definite ENOENT from lstat is "gone".
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && sourceConfirmedGone(claimedFile)) return "vanished";
    return "failed"; // FS err, or an ENOENT whose source is present/unconfirmable ⇒ caller releases to retry (P2-2/P2-4-A, 6c4c33a-P2)
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
  return "quarantined";
}

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}
/** The on-disk inbox DIR NAME for a key (the sanitized form). Exposed so a consumer scanning inbox dirs (e.g. the F40
 *  unclaimed-mail sentinel) can map a session's raw keys to the dir names it would compare against — the same mapping writes use. */
export function inboxDirName(key: string): string {
  return sanitize(key);
}
function inboxDir(home: string, key: string): string {
  return path.join(home, ".agenthop", "inbox", sanitize(key));
}

/** Watch this session's inbox dir(s) so a durably-written message surfaces NEAR-LIVE (B2/B3 option b): a sender writes to our
 *  inbox, our watch fires, the caller flushes — instead of waiting for the periodic flush timer. Best-effort accelerator ONLY:
 *  the timer remains the delivery floor, so a missed or platform-unsupported watch event just delays surfacing, never drops (the
 *  durable copy is the guarantee). mkdir each dir first so the watch has a target; { persistent: false } so a watcher never by
 *  itself keeps the process alive. Returns a stop fn that closes every watcher. */
export function watchInbox(home: string, keys: string[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const dir = inboxDir(home, key);
    if (seen.has(dir)) continue; // the stableId + per-run id can map to the same sanitized dir
    seen.add(dir);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      watchers.push(watch(dir, { persistent: false }, () => onChange()));
    } catch { /* best-effort: the periodic flush is the floor */ }
  }
  return () => { for (const w of watchers) { try { w.close(); } catch { /* already closed */ } } };
}

/** Append a message to the durable inbox for `key` (atomic temp+rename, 0600). VALIDATES at the WRITE boundary (F32/B8):
 *  the producer's record must pass validInboxMsg BEFORE it is published — the same schema the receiver enforces after claim.
 *  Without this a malformed write (e.g. ts="bad-clock" or NaN) publishes a .json the receiver can only QUARANTINE, and ts=null
 *  used to crash here on `.toString()` instead of a clean rejection. The receiver-side validator is crash/poison defense (F28),
 *  not a substitute for refusing an invalid write at the source. Throwing is the fail-fast rejection; every caller passes a
 *  well-formed envelope, so this never fires on the live paths — it guards a future/untrusted producer. The NORMALIZED record
 *  (known fields only) is what gets persisted, so no junk field is ever written. */
export function writeInbox(home: string, key: string, msg: InboxMsg, idempotencyKey?: string): WriteResult {
  const valid = validInboxMsg(msg);
  if (valid === null) throw new Error("writeInbox: refusing to publish an invalid inbox message (from/fromLabel/text must be strings, via a non-empty string, ts a finite number)");
  const dir = inboxDir(home, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The key is used as the MESSAGE file's basename (and in the recovery scan), so it MUST be a safe single path segment — no
  // separators, no traversal — or a crafted key could write/overwrite OUTSIDE `dir`, into another session's box (MD-R7-P1-1). A key
  // that is NOT one safe segment falls through to the random-name path (no dedup), which is always confined to `dir`. "." / ".." are
  // allowed: they yield the safe filenames "..json" / "...json", never a parent reference; only separators (and oversized keys) are rejected.
  if (idempotencyKey !== undefined && /^[A-Za-z0-9._-]{1,120}$/.test(idempotencyKey)) return publishOnce(dir, idempotencyKey, valid);
  // No key (or an unsafe key) ⇒ the historical unique random name (every write is a new, independent message, confined to `dir`).
  const base = `${valid.ts.toString().padStart(16, "0")}-${Math.random().toString(36).slice(2, 8)}.json`;
  const file = path.join(dir, base);
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(valid), { mode: 0o600 });
  renameSync(tmp, file);
  return "published";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Exactly-once publication of one logical EVENT (an idempotencyKey) — the DURABLE-FIRST credential protocol (the dual of FC-2's
// publish-after-fact). The message .json is the delivery TARGET only (claim renames it, ack deletes it), so its presence can never
// prove delivery. A separate CREDENTIAL under `.pubcred/` records the event's publication lifecycle and NO claim/ack ever touches
// it, so it survives claim, ack and restart. The credential filename is a SHA-256 of the key (never the key itself), so any key —
// including "." / ".." — is a safe single path segment (MD-R6-P2-1). Protocol: claim the credential PENDING (O_EXCL single-winner)
// BEFORE publishing, publish the message, then upgrade to PUBLISHED. Recovery on a PENDING credential fs-verifies whether the
// message landed (FC-2 r6 recipe): present ⇒ upgrade (never resend); absent ⇒ insufficient evidence (consumed OR never-sent) ⇒
// retain pending (no resend, no silent drop). (digest MD-P2-1)
// ---------------------------------------------------------------------------------------------------------------------------------
/** The outcome of a keyed publish, so the CALLER confirms its own obligation only on a real delivery — never on a defer/retain/unknown
 *  (a loser must not settle the winner's work, MD-P2-1): "published" (this call delivered) / "already" (this event was ALREADY
 *  delivered — a prior publish, an upgrade of a landed send, or a prior-version credential) / "deferred" (a concurrent winner is
 *  publishing) / "pending" (a prior attempt is unconfirmable — message neither present nor provably un-sent) / "unknown" (the
 *  credential is unreadable). Only "published" / "already" are confirmed; the rest must keep the obligation VISIBLE for a later retry. */
export type WriteResult = "published" | "already" | "deferred" | "pending" | "unknown";

/** Three-state existence probe for a marker file: "present" / "absent" (confirmed ENOENT) / "unknown" (any other error — a read
 *  fault must NOT be read as absence, or a crafted/transient EACCES would license a re-publish). lstat (no symlink follow). */
function probeMarker(markerPath: string): "present" | "absent" | "unknown" {
  try { lstatSync(markerPath); return "present"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}

function credDirOf(dir: string): string { return path.join(dir, ".pubcred"); }
function credPathOf(dir: string, idempotencyKey: string): string {
  return path.join(credDirOf(dir), createHash("sha256").update(idempotencyKey).digest("hex"));
}
/** Credential state: "absent" (never claimed) / "pending" (claimed, publish in flight or interrupted) / "published" (confirmed
 *  delivered) / "unknown" (a non-ENOENT read fault OR an unrecognized body — must NOT be read as not-published). */
function readCredState(cred: string): "absent" | "pending" | "published" | "unknown" {
  let raw: string;
  try { raw = readFileSync(cred, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
  const t = raw.trim();
  return t === "published" ? "published" : t === "pending" ? "pending" : "unknown";
}
/** Atomically set the credential to a terminal/intermediate state (tmp+rename). Best-effort; never throws. */
function writeCredState(cred: string, state: "pending" | "published"): void {
  try {
    mkdirSync(path.dirname(cred), { recursive: true, mode: 0o700 });
    const tmp = `${cred}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, state, { mode: 0o600 });
    renameSync(tmp, cred);
  } catch { /* best-effort */ }
}
/** Is the message for this event on disk right now — unclaimed (`<key>.json`) OR in-flight (`<key>.json.claim-<pid>`)? The message
 *  keeps the KEY as its basename (deterministic, and `${key}.json` is a safe filename even for "." / ".."), so recovery can fs-verify
 *  the landing without the credential. */
function eventMessagePresent(dir: string, idempotencyKey: string): boolean {
  const base = `${idempotencyKey}.json`;
  if (existsSync(path.join(dir, base))) return true;
  try { return readdirSync(dir).some((n) => n === base || n.startsWith(`${base}.claim-`)); } catch { return false; }
}
function publishOnce(dir: string, idempotencyKey: string, valid: InboxMsg): WriteResult {
  const cred = credPathOf(dir, idempotencyKey);
  const msgFile = path.join(dir, `${idempotencyKey}.json`);
  // Prior-version (r6) credential compat import: r6 recorded publication as a `.published/<key>` marker (raw-key filename). The probe
  // is THREE-state (MD-R7-P2-1, FC-2 r3 recipe "read-error/absent KEEP vs read-and-invalid"): present ⇒ a confirmed historical r6
  // delivery ⇒ never republish on upgrade; UNKNOWN (a read fault — e.g. the `.published` dir temporarily unreadable, EACCES) ⇒ can't
  // tell ⇒ retain the obligation and retry (an `existsSync` here would read EACCES as "absent" and re-deliver); only a confirmed
  // ENOENT absent ⇒ no prior delivery ⇒ fall through. Exclude "." / ".." (r6 never wrote a valid marker for them, and probing
  // `.published/..` would resolve to the inbox dir).
  if (idempotencyKey !== "." && idempotencyKey !== "..") {
    const r6 = probeMarker(path.join(dir, ".published", idempotencyKey));
    if (r6 === "present") return "already";
    if (r6 === "unknown") return "unknown";
  }
  const state = readCredState(cred);
  if (state === "published") return "already";  // confirmed delivered
  if (state === "unknown") return "unknown";    // unreadable credential ⇒ can't tell; caller keeps the obligation visible, never confirms
  if (state === "pending") {
    // Recovery: a pending credential proves a publish was ATTEMPTED. fs-verify whether the message landed.
    if (eventMessagePresent(dir, idempotencyKey)) { writeCredState(cred, "published"); return "already"; } // landed/in-flight ⇒ confirm, never resend
    return "pending"; // message absent ⇒ consumed OR never-sent (indistinguishable) ⇒ retain (no resend, no confirm, no drop)
  }
  // state === "absent" ⇒ fresh publish, DURABLE-FIRST: claim the credential EXCLUSIVELY so two racing publishers that both saw
  // "absent" cannot both publish — exactly one wins the O_EXCL create; the loser defers.
  try {
    mkdirSync(credDirOf(dir), { recursive: true, mode: 0o700 });
    writeFileSync(cred, "pending", { flag: "wx", mode: 0o600 }); // O_EXCL: EEXIST ⇒ a concurrent publisher already claimed
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "deferred"; // a concurrent publisher won the claim ⇒ defer (keep obligation)
    throw e; // the credential store is unwritable ⇒ do NOT publish without a durable claim; re-throw so the caller retries (+ logs)
  }
  // FC-7: an IDENTICAL notice already published under a legacy RANDOM name (pre-key), still on disk (unclaimed or in-flight), is
  // ADOPTED into the keyed ledger — upgrade to published, keep the legacy message, skip the new write — instead of co-existing as a
  // second copy. Scoped to a matching non-empty taskRef + identical text so distinct keyless messages are never collapsed. (A
  // legacy message already CONSUMED leaves no trace: that is the "insufficient evidence ⇒ unknown-in-migration" case.)
  if (typeof valid.taskRef === "string" && valid.taskRef.length > 0 && adoptLegacyKeyless(dir, idempotencyKey, valid)) {
    writeCredState(cred, "published");
    return "already";
  }
  try {
    const tmp = `${msgFile}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(valid), { mode: 0o600 });
    renameSync(tmp, msgFile);      // publish (claim renames this, ack deletes it)
  } catch (e) {
    // The message write FAILED in-process ⇒ we KNOW it did not land ("confirmed absent"). Roll back the pending claim so the next
    // retry re-publishes from "absent" — never leave it stuck pending, which recovery would retain as unknown (a silent drop). Re-throw
    // so the caller leaves ITS obligation open and retries (matching the historical throw-on-write-fault contract).
    try { unlinkSync(cred); } catch { /* best-effort rollback */ }
    throw e;
  }
  writeCredState(cred, "published"); // confirm
  return "published";
}

/** FC-7 — scan for a LEGACY keyless publication (a different basename) of the SAME notice (matching taskRef + identical text),
 *  whether unclaimed (`<rand>.json`) or in-flight (`<rand>.json.claim-<pid>`). Pure read; a fault ⇒ false (fall through to publish). */
function adoptLegacyKeyless(dir: string, idempotencyKey: string, valid: InboxMsg): boolean {
  const self = `${idempotencyKey}.json`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  for (const n of names) {
    const base = n.replace(/\.claim-[^.]+$/, "");       // stable base (strip any in-flight claim suffix)
    if (!base.endsWith(".json") || base === self) continue; // only OTHER messages (not this event's own file)
    let prior: unknown;
    try { prior = JSON.parse(readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
    if (prior !== null && typeof prior === "object" && (prior as InboxMsg).taskRef === valid.taskRef && (prior as InboxMsg).text === valid.text) return true;
  }
  return false;
}

/** Atomically claim every pending message under ANY of `keys` (oldest first). The claimer must ack or release each.
 *  `stuck` (optional): a per-process set the caller keeps across flushes. A poison file this call can neither quarantine
 *  NOR release (both failed on a transient FS fault) is recorded here so a later flush re-attempts it — see retryStuckPoison. */
export function claimInbox(home: string, keys: string[], claimer: string, stuck?: Set<string>): Claimed[] {
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
      // poison ⇒ quarantine. A "failed" quarantine (FS error) RELEASES the claim so a later flush retries (recoverStaleClaims
      // won't free this still-LIVE pid) — the move stays a recoverable to-do, never a silently-stuck live-pid claim (P2-2).
      // If the release ALSO fails (same dir-level fault) the file is stuck as .claim-<our-live-pid> with no auto-retry path;
      // record it in `stuck` so THIS process re-attempts quarantine on a later flush (review bb6dad5-P2-4-B). After the
      // process exits the lingering .claim-<dead-pid> is reclaimable by stale recovery as the final backstop.
      if (msg === null) {
        if (quarantineInbox(home, claimed, "schema/parse", raw) === "failed" && !releaseInbox(claimed)) stuck?.add(claimed);
        continue;
      }
      out.push({ file: claimed, msg });
    }
  }
  return out;
}

/** Delivered successfully -> remove the claimed file. */
export function ackInbox(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

/** Could not deliver -> put it back for a later attempt (strip the .claim-<id> suffix). Returns whether the rename
 *  succeeded: a FALSE return is the caller's signal that the file is still stuck as .claim-<pid> and needs a retry
 *  obligation recorded (review bb6dad5-P2-4-B) — the failure must not be swallowed silently. */
export function releaseInbox(file: string): boolean {
  try { renameSync(file, file.replace(/\.claim-[^.]+$/, "")); return true; } catch { return false; }
}

/** Re-attempt quarantine for poison files a prior claim could neither quarantine NOR release (both failed on a transient
 *  FS fault, review bb6dad5-P2-4-B). The caller runs this each flush with its per-process stuck set: once the fault clears
 *  the file leaves the set. A file that quarantined/vanished has discharged its obligation; one we can at least release
 *  back to .json becomes reclaimable by the next claim; anything still faulting stays for the next tick (and after this
 *  process exits, stale recovery reclaims the dead-pid claim). Pure damage-control: never throws. */
export function retryStuckPoison(home: string, stuck: Set<string>): void {
  for (const f of stuck) {
    let raw: string | undefined;
    try { raw = readFileSync(f, "utf8"); } catch { /* unreadable/gone -> quarantineInbox resolves the vanish below */ }
    if (quarantineInbox(home, f, "schema/parse", raw) !== "failed") { stuck.delete(f); continue; } // quarantined or vanished
    if (releaseInbox(f)) stuck.delete(f); // at least back to .json -> a later claim re-handles it; else keep for next tick
  }
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

/** True ONLY when the source is CONFIRMED gone (a definite ENOENT from lstat). A present file ⇒ false; any other errno
 *  (EACCES on the dir's search bit, EIO, ...) ⇒ "can't confirm" ⇒ false, so the caller keeps the retry obligation instead
 *  of treating an unverifiable source as vanished (review 6c4c33a-P2). lstat (not stat) so a broken symlink still counts as
 *  present, and no following into a dir we may not be able to traverse. */
function sourceConfirmedGone(file: string): boolean {
  try { lstatSync(file); return false; } // source present -> not gone
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } // only a definite ENOENT = gone; EACCES/EIO = unconfirmable = NOT gone
}

/** True while the pid is a running process — including one we may not signal (EPERM). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// ============================================================================================================
// FC-2 — poison dead-letter quarantine (SWARM_POISON_DLQ, default OFF). Under at-least-once delivery, a message whose
// delivery reliably THROWS (the host erring on THIS content) head-of-line-blocks the queue, re-claimed + retried forever.
// After a strike threshold it is moved to quarantine/ (bytes preserved, never deleted) and the coordinator is told. A push
// that merely RETURNS FALSE is channel-not-ready (transient) and NEVER strikes — so a channel outage cannot false-quarantine
// a healthy message. The strike count lives in a sidecar keyed by the message's STABLE base, invisible to claimInbox.
// ============================================================================================================

/** FC-2 dormant gate: OFF ⇒ the drainer's failure path is byte-for-byte v0 (release + retry, no strike counting). */
export function poisonDlqEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_POISON_DLQ ?? "");
}

/** FC-2 strike threshold (default 3; SWARM_POISON_DLQ_THRESHOLD). A non-integer or < 1 value falls back to 3 (a 0/negative
 *  threshold would quarantine on the first strike, or never — both wrong). */
export function poisonDlqThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SWARM_POISON_DLQ_THRESHOLD);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}

/** FC-2 quarantine decision: a message has struck out once its delivery-CRASH count reaches the threshold. Pure. (Strikes
 *  count only pushes that THREW — never a push that returned false, which is channel-not-ready and must not consume a strike.) */
export function shouldQuarantinePoison(strikes: number, threshold: number): boolean {
  return Number.isFinite(strikes) && threshold >= 1 && strikes >= threshold;
}

/** FC-2 — the strike sidecar for a (claimed or released) message file, keyed by the STABLE base (`<base>.json`) so the count
 *  survives the claim→release→reclaim cycle. Not a `.json` file ⇒ claimInbox never lists it as a deliverable message. */
function stableBase(file: string): string { return file.replace(/\.claim-[^.]+$/, ""); }
function poisonSidecar(file: string): string { return `${stableBase(file)}.poison`; }

/** FC-2 (PD-P2-4) — parse a sidecar's ENTIRE content as a non-negative safe integer. A prefix like "2-not-a-counter" or any
 *  trailing junk is REJECTED (null) — a corrupt/unconfirmable count must never authorize an early quarantine. */
function parsePoisonCount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** FC-2 — record one delivery-CRASH strike and return the new total. `mem` is the drainer's per-process count map (keyed by the
 *  stable base) and is AUTHORITATIVE, so the count advances even when the sidecar write fails (PD-P2-3 — otherwise a persistent
 *  write fault would re-read 0 every call and never reach the threshold, re-opening the head-of-line block). The sidecar is the
 *  cross-restart persistence; a corrupt sidecar is ignored (PD-P2-4), never trusted over `mem`. next = max(disk, mem) + 1.
 *  Best-effort write (tmp + rename); NEVER throws. */
export function recordPoisonStrike(file: string, mem: Map<string, number>): number {
  const key = stableBase(file);
  const sc = `${key}.poison`;
  let disk = 0;
  try { const p = parsePoisonCount(readFileSync(sc, "utf8")); if (p !== null) disk = p; } catch { /* none/unreadable/corrupt ⇒ 0 */ }
  const next = Math.max(disk, mem.get(key) ?? 0) + 1;
  mem.set(key, next);
  try { const tmp = `${sc}.tmp-${randomBytes(4).toString("hex")}`; writeFileSync(tmp, String(next), { mode: 0o600 }); renameSync(tmp, sc); } catch { /* best-effort: mem already advanced, so quarantine is never blocked by a write fault */ }
  return next;
}

/** FC-2 — clear the strike count (on a successful ack, or after a quarantine move): drop the in-memory entry AND the sidecar.
 *  Best-effort; never throws. */
export function clearPoisonStrikes(file: string, mem: Map<string, number>): void {
  mem.delete(stableBase(file));
  try { unlinkSync(poisonSidecar(file)); } catch { /* already gone */ }
}

/** FC-2 (PD-P2-1) — strip transport-UNSAFE control chars (NUL + other C0/DEL, keeping \t \n \r) so the NOTICE itself can never
 *  become a poison message. A legal envelope may carry U+0000, which a real Codex push rejects (ERR_INVALID_ARG_VALUE); copying
 *  it verbatim into the alert would make the ALERT a poison that blocks the coordinator's inbox. The original bytes stay intact
 *  in quarantine/; only this human-facing notice is sanitized. D-multica ②: after the control-char strip, `redactSecrets` masks
 *  any secret token (AWS/GitHub/OpenAI/Anthropic/Slack/PEM) so a quarantined poison's content preview cannot leak a key when the
 *  notice is forwarded to the coordinator / persisted. */
function sanitizeForTransport(s: string): string {
  return redactSecrets(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "�"));
}

/** FC-2 — build the S19 dead-letter notification for the coordinator when a poison message is quarantined: content preview +
 *  failure trace + strike count, as an InboxMsg, all TRANSPORT-SANITIZED (PD-P2-1). Pure (no IO); the caller writes it. */
export function buildPoisonS19(mySid: string, myLabel: string, poison: InboxMsg, strikes: number, trace: string): InboxMsg {
  // RS-1: sanitize (control-char strip + secret redaction) the FULL text FIRST, THEN bound for display. Clipping first would
  // split a PEM block or a fixed-length token across the 240 boundary, so redactSecrets could not match it and a sensitive
  // fragment would survive into this notice (and the durable poison-notices queue, and the forward). quarantine/ keeps originals.
  const safe = sanitizeForTransport(poison.text);
  const preview = safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
  const text = `[poison-dlq] 毒件已隔离(投递崩溃 ${strikes} 次,已达阈值)。来源 ${sanitizeForTransport(poison.fromLabel)} via ${sanitizeForTransport(poison.via)};失败轨迹: ${sanitizeForTransport(trace)};内容预览: ${preview}`;
  return { from: mySid, fromLabel: myLabel, text, via: "local", ts: Date.now(), taskRef: "poison-dlq", title: "poison quarantine" };
}

/** FC-2 (PD-P2-2) — the DURABLE poison-notice queue dir. A single quarantine is below the F26 dead-letter burst threshold, so
 *  the coordinator notice cannot live only in a bounded in-process array (a restart or an overflow would silently discharge the
 *  obligation). Each obligation is a file here; a later flush (any process) re-scans and delivers it, deleting only after a
 *  CONFIRMED send. Under `.agenthop/swarm/` (NOT an inbox key) so claimInbox/inboxKeys never touch it. */
function poisonNoticeDir(home: string): string { return path.join(home, ".agenthop", "swarm", "poison-notices"); }
/** Prior-version / legacy queue files are MOVED here — kept + exposed for manual migration, never target-guessed nor deleted
 *  (FC-7 / PD-R5-P2-1 / PD-R3-P1-1 A). A subdir of the queue (no `.json` of its own) so the drain scan never re-reads it. */
function poisonMigrationDir(home: string): string { return path.join(poisonNoticeDir(home), "needs-migration"); }

/** FC-2 — a persisted notice (schema v2) binds its TARGET coordinator (PD-R3-P1-1: deliver to the record's OWN target, never the
 *  drainer's SWARM_COORDINATOR) and the SOURCE message path (PD-R4-P2-1 / PD-R5-P2-2: the drain delivers ONLY after it VERIFIES
 *  from the filesystem that the source was really quarantined — the quarantined bytes are the proof, so no separately-written
 *  "confirmed" flag can be lost to a crash or a write fault). Written BEFORE the quarantine move so the obligation survives a
 *  notice-write failure (PD-P2-2). */
type PoisonNotice = { schema: "poison-notice/v2"; target: string; source: string; msg: InboxMsg };

/** FC-2 — the stable SOURCE path of a (claimed) message file, minus any `.claim-<pid>` — identifies the poison EVENT. Pure. */
export function poisonNoticeSource(file: string): string { return stableBase(file); }
/** The deterministic queue filename key for a source (so a retry OVERWRITES the same record, never piling up). Pure. */
function keyForSource(source: string): string { return createHash("sha256").update(source).digest("hex").slice(0, 32); }

/** Parse a queue file. Current form = schema "poison-notice/v2" {target,source,msg}. A PRIOR bound version (schema
 *  "poison-notice/v1") OR a LEGACY bare-InboxMsg file is recognized as `migrate` — kept + exposed for manual migration, NEVER
 *  target-guessed and NEVER deleted (FC-7 / PD-R5-P2-1 / PD-R3-P1-1 A). A read-OK but structurally invalid file => null (corrupt). */
function parsePoisonNotice(raw: string): { kind: "current"; target: string; source: string; msg: InboxMsg } | { kind: "migrate" } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const schema = (parsed as { schema?: unknown }).schema;
    if (schema === "poison-notice/v2") {
      const t = (parsed as { target?: unknown }).target;
      const s = (parsed as { source?: unknown }).source;
      const m = validInboxMsg((parsed as { msg?: unknown }).msg);
      if (typeof t === "string" && t.length > 0 && typeof s === "string" && s.length > 0 && m) return { kind: "current", target: t, source: s, msg: m };
      return null; // malformed v2 => corrupt
    }
    if (schema === "poison-notice/v1") return { kind: "migrate" }; // PD-R5-P2-1: a prior bound version — import, never delete
  }
  return validInboxMsg(parsed) ? { kind: "migrate" } : null; // FC-7: a bare-InboxMsg legacy record (never target-guessed)
}

/** FC-2 — is the poison SOURCE actually quarantined? quarantineInbox links the bytes to `<dir>/quarantine/<base>.<ts>.<hex>`
 *  (ts = Date.now() digits, hex = 16 lowercase hex). PROOF requires an EXACT match of THIS event's receipt shape, not a mere
 *  prefix (PD-R6-P2-1 A: a different event `<base>.other.json` would receipt as `<base>.other.json.<ts>.<hex>`, which shares the
 *  `<base>.` prefix — so match the full `^<base>\.\d+\.[0-9a-f]{16}$` where the segment after the source basename is strictly the
 *  generated suffix), AND the entry must be a regular FILE (PD-R6-P2-1 B: a directory or a broken/sym-link named like a receipt
 *  is not our quarantined bytes; quarantineInbox hard-links, so a real receipt is always a plain file). A missing/unreadable
 *  quarantine dir, or an entry that vanishes/can't be stat'd, is NOT proof (keep + retry). Pure over the fs. */
function isQuarantineConfirmed(source: string): boolean {
  const qdir = path.join(path.dirname(source), "quarantine");
  const base = path.basename(source);
  const receipt = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.[0-9a-f]{16}$`);
  let names: string[];
  try { names = readdirSync(qdir); } catch { return false; } // missing/unreadable quarantine dir ⇒ not confirmed
  for (const n of names) {
    if (!receipt.test(n)) continue; // not THIS event's receipt shape (distinguishes the source basename from the generated suffix)
    try { if (lstatSync(path.join(qdir, n)).isFile()) return true; } catch { /* vanished / unstattable ⇒ not proof */ }
    // a directory / symlink / broken link named like a receipt is NOT the quarantined bytes ⇒ keep scanning
  }
  return false;
}

/** FC-2 (PD-P2-2) — persist the durable obligation for a poison EVENT BEFORE its quarantine move (keyed by the source =>
 *  idempotent; a retry OVERWRITES, never piling up). Atomic tmp+rename. Returns TRUE on success / FALSE on any write fault — the
 *  caller MUST keep the source + strike when this fails (never quarantine-then-lose the obligation). Never throws. */
export function enqueuePoisonNotice(home: string, source: string, target: string, notice: InboxMsg): boolean {
  try {
    const dir = poisonNoticeDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec: PoisonNotice = { schema: "poison-notice/v2", target, source, msg: notice };
    const file = path.join(dir, `${keyForSource(source)}.json`);
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch { return false; } // caller keeps the source + strike (PD-P2-2) when the obligation can't be persisted
}

/** FC-2 — the deterministic re-scan entry. A "migrate" record (a prior bound version or a legacy bare msg) is MOVED to
 *  needs-migration/ (kept + exposed, never target-guessed/deleted, FC-7 / PD-R5-P2-1 / PD-R3-P1-1 A); a corrupt (read-OK but
 *  invalid) file is dropped; a READ ERROR or missing file is KEPT (PD-R3-P2-1). A "current" record is delivered to its BOUND
 *  target ONLY ONCE its quarantine is VERIFIED on the filesystem (PD-R4-P2-1: never a premature success; PD-R5-P2-2: the fs is
 *  the recoverable confirmation, so a crash/write fault can't strand it) — else KEPT. `deliver` returns "sent"/"skip" (=> delete)
 *  or "retry" (=> keep). The caller gates this on SWARM_POISON_DLQ. Never throws. */
export function drainPoisonNotices(home: string, deliver: (target: string, msg: InboxMsg) => "sent" | "retry" | "skip", cap = 64): void {
  const dir = poisonNoticeDir(home);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return; } // no dir => nothing pending
  let processed = 0;
  for (const n of names) {
    if (processed >= cap) break; // bound the per-tick batch; the rest drain next flush
    const f = path.join(dir, n);
    let raw: string;
    try { raw = readFileSync(f, "utf8"); } catch { continue; } // gone OR a transient read error (EACCES/EIO) => KEEP (PD-R3-P2-1)
    const rec = parsePoisonNotice(raw);
    if (rec === null) { try { unlinkSync(f); } catch { /* gone */ } continue; } // read OK but invalid => corrupt => drop
    if (rec.kind === "migrate") { // FC-7 / PD-R5-P2-1 / PD-R3-P1-1 A: keep + expose, never guess/deliver/delete
      try { mkdirSync(poisonMigrationDir(home), { recursive: true, mode: 0o700 }); renameSync(f, path.join(poisonMigrationDir(home), n)); } catch { /* best-effort; leave in place if the move fails */ }
      continue;
    }
    if (!isQuarantineConfirmed(rec.source)) continue; // PD-R4-P2-1 / PD-R5-P2-2: quarantine not yet verified => keep (no premature/false report)
    processed += 1;
    let r: "sent" | "retry" | "skip";
    try { r = deliver(rec.target, rec.msg); } catch { r = "retry"; } // a throwing deliver => keep + retry
    if (r !== "retry") { try { unlinkSync(f); } catch { /* gone */ } } // delivered or permanently-skipped => discharged
  }
}
