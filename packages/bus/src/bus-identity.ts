import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * bus-identity v1 — the alias table + whois kernel (bus-identity-design.md, frozen 2026-10-04).
 * Answers "any id form → which entity, is it alive, how do I reply" without conflating identity (recorded)
 * with liveness (probed). Batch A: the self-contained module + its pure kernels. The announce/learnStableId
 * feed points (core.ts/directory.ts) and the sweep seam (task-sweep.ts) are Batch B — landed by their
 * single-editors against the call sites / interface this module exports.
 *
 * Design disciplines carried here (and the review that put teeth on them — review packet
 * bus-identity-implementation-A-debbb28, 71210d67, 8P1/5P2/1P3):
 *
 *  - Identity is recorded, liveness is probed, two evidence faces never merged (§1).
 *  - entityId is independent and STABLE: it is derived from the incarnation key (the run id), not from a
 *    union root, so appending an incarnation or discovering a late collision never retargets a published id
 *    (§2.2; review P2-5).
 *  - v1 does NOT merge across runs. Two distinct runs sharing a hard native are two entities with a
 *    possible-related link and (when concurrent-conflicting) a collision annotation — NOT one entity. A
 *    cross-run merge needs a trusted continuity/pairing relation, which has no representation in the v1 event
 *    model, so it does not happen (§3; review P1-2 range ruling by 68fb42aa). Within ONE run/announce,
 *    co-occurring forms (01a0ead5 native + 673c6525 run) are one entity — that is one incarnation, not a
 *    merge, and is the preserved main-acceptance positive.
 *  - PROPAGATION DOES NOT RAISE CONFIDENCE — only source evidence does (§2.3). A guessed field broadcast in
 *    an announce stays `possible`, and `possible` claims never enter determinate resolution (review P1-1).
 *  - Revocation is SOURCE-SCOPED, never a global value blacklist: a revoke drops exactly the target event's
 *    own claims; a correction supersedes, within its one incarnation, the corrected value and anything
 *    derived from it. An independent entity holding the same literal as hard is untouched (review P1-4).
 *  - An event id is an identity: same id + same payload is a replay no-op; same id + different payload is a
 *    conflict that is reported, never two facts (review P2-4).
 *  - Append-only log: a newline-terminated record is committed; a torn tail is RECOVERED (truncated) before
 *    the next append so a successful append is always replayable; a committed record that fails schema
 *    validation is an explicit corruption fact, never silently skipped or executed (§2.5; review P2-1/P2-3).
 *  - A read failure is not an empty log: ENOENT is "new/empty", any other errno is "incomplete/unavailable"
 *    (review P2-2).
 *  - liveness is three-state; "no output evidence" (unknown) is not "confirmed no output" (none), and host
 *    facts are read by recency with conflicts collapsing to suspected, never by array order (review P1-5/P1-6).
 *
 * No top-level side effects (the msglog P1 lesson): tests live in bus-identity.selftest.mts.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (design §2.1/§2.3)
// ---------------------------------------------------------------------------------------------

export type Form = "run" | "native" | "handle" | "presence";
export type Confidence = "hard" | "possible";
export type Provenance = "same-announce" | "learn-bootstrap" | "learn-correction" | "thread-switch" | "heuristic" | "import";
export type Scope = "local" | "relay";
const FORMS = new Set<string>(["run", "native", "handle", "presence"]);
const CONFIDENCES = new Set<string>(["hard", "possible"]);
const PROVENANCES = new Set<string>(["same-announce", "learn-bootstrap", "learn-correction", "thread-switch", "heuristic", "import"]);
const LEARN_KINDS = new Set<string>(["bootstrap", "correction", "thread-switch"]);

/** A verifiable process birth, to resist pid reuse (design §2.4). Absent ⇒ pid-reuse defence degrades. */
export type Birth = { hostStartTicks?: string; bootId?: string };

/** One id-form claim tying a value to an incarnation, carrying WHERE it came from and how sure. */
export type Claim = {
  value: string;
  form: Form;
  confidence: Confidence;
  provenance: Provenance;
  /** The eventId that produced this claim — the anchor for source-scoped revoke (review P1-4). */
  source?: string;
  /** The value this claim was derived from (e.g. a handle built from a native) — so a correction of the
   *  origin value cascades to its derivatives without a global value blacklist (review P1-4 derived handle). */
  derivedFrom?: string;
  /** Retired by a thread-switch/correction/revoke; kept for history, excluded from all resolution. */
  superseded?: boolean;
};

/** One process/thread life = a set of co-occurring claims plus probe targets. */
export type Incarnation = {
  key: string; // stable within the log (the run id, or a minted key when absent)
  claims: Claim[];
  busPid?: number;
  hostPid?: number;
  birth?: Birth;
  scope: Scope;
  tool?: string;
  cwd?: string;
  firstSeenSec: number;
  lastSeenSec: number;
};

export type IdentityEntity = {
  entityId: string; // independent, persistent, derived from the incarnation key — NOT a native/run/handle/pid literal
  incarnations: Incarnation[];
  tool?: string;
  cwd?: string;
  /** possible-related entities (shared native across runs / heuristic suspicion) — NOT merged (design §2.3). */
  possibleRelated: string[];
};

// ---------------------------------------------------------------------------------------------
// Append log (design §2.5 + round-3 commit/recovery rules)
// ---------------------------------------------------------------------------------------------

/** One append-log event. `observe` = an announce/self snapshot; `learn` = a stableId transition;
 *  `revoke` = withdraw a prior event's claims (source-scoped); `split` = declare shared-native holders distinct. */
export type IdentityEvent =
  | ({ v: 1; eventId: string; ts: number; type: "observe"; incarnation: Omit<Incarnation, "firstSeenSec" | "lastSeenSec"> })
  | { v: 1; eventId: string; ts: number; type: "learn"; incarnationKey: string; from?: string; to: string; form: Form; kind: "bootstrap" | "correction" | "thread-switch"; authoritative: boolean }
  | { v: 1; eventId: string; ts: number; type: "revoke"; targetEventId: string; reason: string }
  | { v: 1; eventId: string; ts: number; type: "split"; of: string; reason: string };

export function identityDir(home: string = homedir()): string {
  return process.env.BUS_IDENTITY_DIR || path.join(home, ".agenthop", "bus-identity");
}
function logPath(home: string): string {
  return path.join(identityDir(home), "alias-log.jsonl");
}

export function mintEventId(rand: () => string = () => randomUUID()): string {
  return `e-${rand()}`;
}

/** digest of an event's payload (eventId excluded) — same eventId + same digest = replay no-op; same
 *  eventId + different digest = conflict (review P2-4). */
export function eventDigest(e: IdentityEvent): string {
  const { eventId: _omit, ...rest } = e as IdentityEvent & { eventId: string };
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

/**
 * Structural validation (review P2-3): a record is a valid, replayable event only if its version, variant
 * and required fields check out. JSON-parseable is NOT enough — `null`, `{}`, a v:2 record or a non-finite
 * ts are all invalid and must become corruption, never silently used or executed.
 */
export function isValidEvent(x: unknown): x is IdentityEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (e.v !== 1) return false;
  if (typeof e.eventId !== "string" || e.eventId === "") return false;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return false;
  switch (e.type) {
    case "observe": {
      const inc = e.incarnation as Record<string, unknown> | undefined;
      if (typeof inc !== "object" || inc === null) return false;
      if (typeof inc.key !== "string" || inc.key === "") return false;
      if (inc.scope !== "local" && inc.scope !== "relay") return false;
      if (!Array.isArray(inc.claims)) return false;
      for (const c of inc.claims as unknown[]) if (!isValidClaim(c)) return false;
      if (inc.busPid !== undefined && !isPosInt(inc.busPid)) return false;
      if (inc.hostPid !== undefined && !isPosInt(inc.hostPid)) return false;
      return true;
    }
    case "learn":
      return typeof e.incarnationKey === "string" && e.incarnationKey !== ""
        && typeof e.to === "string" && e.to !== ""
        && (e.from === undefined || typeof e.from === "string")
        && typeof e.form === "string" && FORMS.has(e.form)
        && typeof e.kind === "string" && LEARN_KINDS.has(e.kind)
        && typeof e.authoritative === "boolean";
    case "revoke":
      return typeof e.targetEventId === "string" && e.targetEventId !== "" && typeof e.reason === "string";
    case "split":
      return typeof e.of === "string" && e.of !== "" && typeof e.reason === "string";
    default:
      return false;
  }
}
function isValidClaim(c: unknown): boolean {
  if (typeof c !== "object" || c === null) return false;
  const k = c as Record<string, unknown>;
  return typeof k.value === "string" && k.value !== ""
    && typeof k.form === "string" && FORMS.has(k.form)
    && typeof k.confidence === "string" && CONFIDENCES.has(k.confidence)
    && typeof k.provenance === "string" && PROVENANCES.has(k.provenance);
}
function isPosInt(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/**
 * Append one event. Before appending, RECOVER a torn (no-trailing-newline) tail by truncating it, so the
 * new record is never glued onto a half-written line and a successful append is always replayable (review
 * P2-1). A committed record validated as corrupt ends in a newline and is left intact (not truncated). An
 * invalid event is rejected (false) rather than written as something that cannot be replayed (review P2-3).
 * Returns false (never throws) so logging can't break the bus.
 */
export function appendEvent(home: string, e: IdentityEvent): boolean {
  if (!isValidEvent(e)) return false;
  try {
    mkdirSync(identityDir(home), { recursive: true });
    const p = logPath(home);
    if (existsSync(p)) {
      const buf = readFileSync(p);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
        // torn tail: drop everything after the last committed newline before appending
        const lastNl = buf.lastIndexOf(0x0a);
        writeFileSync(p, lastNl >= 0 ? buf.subarray(0, lastNl + 1) : Buffer.alloc(0));
      }
    }
    appendFileSync(p, `${JSON.stringify(e)}\n`);
    return true;
  } catch {
    return false;
  }
}

export type LogStatus = "ok" | "missing" | "error";
export type LogReadResult = {
  events: IdentityEvent[];
  /** Bytes of a trailing line with no newline — the UNCOMMITTED tail; recovered by appendEvent before write. */
  uncommittedTail: string | null;
  /** A committed (newline-terminated) line that failed to parse OR validate — an explicit corruption fact
   *  (design round-3; review P2-3). NOT skipped silently; the caller surfaces it and rebuilds. */
  corruption: Array<{ lineIndex: number; raw: string }>;
  /** ok = read fine; missing = ENOENT (a genuinely empty/new log); error = a read failure (review P2-2). */
  status: LogStatus;
  /** errno when status === "error". */
  errorCode?: string;
};

/**
 * Parse log text into committed events, a recoverable uncommitted tail, and committed corruption:
 *  - well-formed, schema-valid committed events,
 *  - a single uncommitted (no trailing newline) tail — recovered by appendEvent on the next write,
 *  - any committed-but-corrupt record (bad JSON OR a parseable-but-invalid event, incl. a newline-terminated
 *    bad last record) — reported as a corruption fact, never dropped or executed.
 */
export function readLog(raw: string): LogReadResult {
  const events: IdentityEvent[] = [];
  const corruption: Array<{ lineIndex: number; raw: string }> = [];
  let uncommittedTail: string | null = null;

  if (raw === "") return { events, uncommittedTail, corruption, status: "ok" };
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  // split on "\n": if the content ends with "\n", the final element is "" (drop it); otherwise the final
  // element is the uncommitted tail (no terminating newline).
  if (endsWithNewline) {
    lines.pop(); // the trailing ""
  } else {
    uncommittedTail = lines.pop() ?? null;
    if (uncommittedTail === "") uncommittedTail = null;
  }

  lines.forEach((line, i) => {
    if (line === "") return; // blank committed line — ignore (not a record)
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruption.push({ lineIndex: i, raw: line }); // committed bad JSON
      return;
    }
    if (!isValidEvent(parsed)) {
      corruption.push({ lineIndex: i, raw: line }); // parseable but not a replayable event
      return;
    }
    events.push(parsed);
  });
  return { events, uncommittedTail, corruption, status: "ok" };
}

/** Read the on-disk log. ENOENT ⇒ missing (empty-ok); any other read error ⇒ error (incomplete), NOT a
 *  fake-empty log (review P2-2). Caller inspects .status / .corruption / .uncommittedTail. */
export function readIdentityLog(home: string): LogReadResult {
  let raw: string;
  try {
    raw = readFileSync(logPath(home), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { events: [], uncommittedTail: null, corruption: [], status: "missing" };
    return { events: [], uncommittedTail: null, corruption: [], status: "error", errorCode: code };
  }
  return readLog(raw);
}

// ---------------------------------------------------------------------------------------------
// Feed helpers (batch B call sites use ONLY these — the provenance/confidence mapping stays here, so
// core.ts/directory.ts need just an import + a one-line call, and the logic lives in this reviewed module)
// ---------------------------------------------------------------------------------------------

/** The subset of SelfInfo the feed needs (structural, so this module stays standalone). */
export type SelfLike = { id: string; stableId?: string; title: string; tool: string; cwd: string; pid: number };

/** Read the host pid the presence hook passed (AGENTHOP_HOST_PID) — the process whose life actually
 *  answers "is the session alive" (design §2.4). busPid is this bus process; hostPid is the host. */
export function hostPidFrom(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = Number(env.AGENTHOP_HOST_PID);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}

/**
 * Record this session's own identity forms as one `observe` (batch-B call site: once at startBusCore, and
 * any time self is re-announced). `nativeAuthoritative` = is self.stableId from the env/metadata (hard) or
 * a daemon guess (possible) — propagation here never raises it; the caller passes the source truth. The
 * handle records `derivedFrom: stableId` so a later correction of the native cascades to the handle.
 */
export function recordSelfObserve(home: string, self: SelfLike, nativeAuthoritative: boolean, scope: Scope = "local", env: NodeJS.ProcessEnv = process.env): boolean {
  const claims: Claim[] = [
    { value: self.id, form: "run", confidence: "hard", provenance: "same-announce" },
    { value: self.title, form: "handle", confidence: nativeAuthoritative || !self.stableId ? "hard" : "possible", provenance: "same-announce", ...(self.stableId ? { derivedFrom: self.stableId } : {}) },
  ];
  if (self.stableId) claims.push({ value: self.stableId, form: "native", confidence: nativeAuthoritative ? "hard" : "possible", provenance: "same-announce" });
  return appendEvent(home, {
    v: 1, eventId: mintEventId(), ts: Math.floor(Date.now() / 1000), type: "observe",
    incarnation: { key: self.id, claims, scope, busPid: self.pid, hostPid: hostPidFrom(env), tool: self.tool, cwd: self.cwd },
  });
}

/**
 * Record a stableId transition (batch-B call site: inside learnStableId). `kind`:
 *   - "bootstrap"    : first stableId this run ever had (from undefined)
 *   - "correction"   : a prior GUESS is being replaced by an authoritative value (supersedes the guess + its derivatives)
 *   - "thread-switch": one authoritative thread id replaced by another (A→B; NOT equivalence, supersedes A)
 * `authoritative` is passed straight from core's own flag — the source truth for confidence.
 */
export function recordLearn(home: string, runKey: string, from: string | undefined, to: string, kind: "bootstrap" | "correction" | "thread-switch", authoritative: boolean, form: Form = "native"): boolean {
  return appendEvent(home, { v: 1, eventId: mintEventId(), ts: Math.floor(Date.now() / 1000), type: "learn", incarnationKey: runKey, from, to, form, kind, authoritative });
}

// ---------------------------------------------------------------------------------------------
// Fold: events → entities + resolution indexes (design §2.2/§2.3/§3)
// ---------------------------------------------------------------------------------------------

export type Projection = {
  entities: Map<string, IdentityEntity>;
  /** value → entityId[], HARD non-pid claims only — the determinate resolution index (review P1-1). */
  aliasIndex: Map<string, Set<string>>;
  /** value → entityId[], possible claims — informational (possible-related hints), never determinate. */
  possibleIndex: Map<string, Set<string>>;
  /** pid string → entityId[] — queried only as an unverified historical fallback; a pid alone never
   *  resolves to a determinate current identity without a probe (review P2-7). */
  pidIndex: Map<string, Set<string>>;
  /** committed-corrupt records seen during the read that produced these events. */
  corruption: Array<{ lineIndex: number; raw: string }>;
  /** native values shared by concurrent, differently-situated entities (9ac3eb4 class) — annotation only. */
  collisions: Map<string, string[]>; // native value → entityIds sharing it
  /** same eventId carrying a different payload than the first occurrence — rejected, reported (review P2-4). */
  conflicts: Array<{ eventId: string; reason: string }>;
  /** the projection may be missing events (a read error, or committed corruption was present). */
  incomplete: boolean;
};

/** Build entities (1:1 with incarnation keys) + resolution indexes from the event log. */
export function buildProjection(events: IdentityEvent[], corruption: LogReadResult["corruption"] = [], opts: { incomplete?: boolean } = {}): Projection {
  // 0. Event-identity: de-dup replays, reject same-id/different-payload conflicts (review P2-4). This runs on
  //    REPLAY from the log, not just at append time.
  const seen = new Map<string, string>(); // eventId → digest
  const conflicts: Array<{ eventId: string; reason: string }> = [];
  const ordered: IdentityEvent[] = [];
  for (const e of events) {
    const d = eventDigest(e);
    const prior = seen.get(e.eventId);
    if (prior === undefined) { seen.set(e.eventId, d); ordered.push(e); continue; }
    if (prior === d) continue; // same id + same payload → replay no-op
    conflicts.push({ eventId: e.eventId, reason: "same eventId, different payload — conflicting fact rejected" });
  }

  // 1. Revoked event ids (the targets of revoke events). A revoke whose OWN event is revoked still revokes
  //    its target (revokes don't nest meaningfully); but a learn/observe whose event id is a revoke target
  //    contributes nothing (source-scoped revoke = skip the target event's own claims) (review P1-4a/P1-4d).
  const revokedEventIds = new Set<string>();
  for (const e of ordered) if (e.type === "revoke") revokedEventIds.add(e.targetEventId);

  // 2. Build incarnations in event order.
  const incs = new Map<string, Incarnation>();
  const ensure = (key: string, ts: number): Incarnation => {
    let inc = incs.get(key);
    if (!inc) { inc = { key, claims: [], scope: "local", firstSeenSec: ts, lastSeenSec: ts }; incs.set(key, inc); }
    return inc;
  };
  // addClaim: propagation-safe. A new HARD claim upgrades an existing `possible` of the same (value,form) —
  // hard is source evidence by recorder construction. A `possible` broadcast never upgrades (review P2-6).
  const addClaim = (inc: Incarnation, c: Claim) => {
    const existing = inc.claims.find((x) => x.value === c.value && x.form === c.form && !x.superseded);
    if (!existing) { inc.claims.push({ ...c }); return; }
    if (c.confidence === "hard" && existing.confidence === "possible") {
      existing.confidence = "hard";
      existing.provenance = c.provenance;
      existing.source = c.source;
      if (c.derivedFrom !== undefined) existing.derivedFrom = c.derivedFrom;
    }
  };
  // supersede every live claim in THIS incarnation whose value is `v` or which was derived from `v` — scoped
  // to one incarnation, so an independent entity's identical literal is never touched (review P1-4a/P1-4b).
  const supersede = (inc: Incarnation, v: string) => {
    for (const c of inc.claims) if (!c.superseded && (c.value === v || c.derivedFrom === v)) c.superseded = true;
  };

  for (const e of ordered) {
    if (e.type === "observe") {
      if (revokedEventIds.has(e.eventId)) continue; // source-scoped revoke: this event's claims never apply
      const src = e.incarnation;
      const inc = ensure(src.key, e.ts);
      for (const c of src.claims) addClaim(inc, { ...c, source: e.eventId });
      inc.scope = src.scope; // latest observe's scope wins
      inc.busPid ??= src.busPid;
      inc.hostPid ??= src.hostPid;
      inc.birth ??= src.birth;
      inc.tool ??= src.tool;
      inc.cwd ??= src.cwd;
      inc.firstSeenSec = Math.min(inc.firstSeenSec, e.ts);
      inc.lastSeenSec = Math.max(inc.lastSeenSec, e.ts);
    } else if (e.type === "learn") {
      if (revokedEventIds.has(e.eventId)) continue; // a revoked correction/thread-switch does not act (P1-4d)
      const inc = incs.get(e.incarnationKey);
      if (!inc) continue;
      const confidence: Confidence = e.authoritative ? "hard" : "possible";
      const provenance: Provenance = e.kind === "bootstrap" ? "learn-bootstrap" : e.kind === "correction" ? "learn-correction" : "thread-switch";
      // A correction/thread-switch with from !== to retires the old value (and its derivatives) in this
      // incarnation. from === to is a self-confirmation, NOT a revoke: it must not blacklist the value — it
      // upgrades it (handled by addClaim's possible→hard) (review P1-4c).
      if ((e.kind === "correction" || e.kind === "thread-switch") && e.from && e.from !== e.to) supersede(inc, e.from);
      addClaim(inc, { value: e.to, form: e.form, confidence, provenance, source: e.eventId });
    }
    // revoke/split are handled structurally (revoke above; split after indexes).
  }

  // 3. Materialize entities 1:1 with incarnation keys. entityId is derived from the key → STABLE across
  //    appended incarnations and late collisions (review P1-2/P2-5). No cross-run union.
  const entities = new Map<string, IdentityEntity>();
  const keyToEntity = new Map<string, string>();
  for (const inc of incs.values()) {
    if (inc.claims.length === 0 && inc.busPid == null && inc.hostPid == null) continue; // fully-revoked/empty
    const entityId = `ent-${shortHash(inc.key)}`;
    keyToEntity.set(inc.key, entityId);
    entities.set(entityId, { entityId, incarnations: [inc], possibleRelated: [], tool: inc.tool, cwd: inc.cwd });
  }

  // 4. split events declare shared-native holders distinct — exclude those values from the possible-related
  //    and collision computations (review P2-5). Entity ids are never affected (nothing was ever merged).
  const splitValues = new Set<string>();
  for (const e of ordered) if (e.type === "split" && !revokedEventIds.has(e.eventId)) splitValues.add(e.of);

  // 5. Resolution indexes. aliasIndex = HARD, non-superseded claims only (review P1-1). possibleIndex =
  //    possible claims (informational). pidIndex = raw pids (review P2-7).
  const aliasIndex = new Map<string, Set<string>>();
  const possibleIndex = new Map<string, Set<string>>();
  const pidIndex = new Map<string, Set<string>>();
  const add = (idx: Map<string, Set<string>>, value: string, entityId: string) => (idx.get(value) ?? idx.set(value, new Set()).get(value)!).add(entityId);
  const hardNativeHolders = new Map<string, Set<string>>(); // native value → entityIds (for possible-related + collisions)

  for (const ent of entities.values()) {
    for (const inc of ent.incarnations) {
      for (const c of inc.claims) {
        if (c.superseded) continue;
        if (c.confidence === "hard") {
          add(aliasIndex, c.value, ent.entityId);
          if (c.form === "native") add(hardNativeHolders, c.value, ent.entityId);
        } else {
          add(possibleIndex, c.value, ent.entityId);
        }
      }
      if (inc.busPid != null) add(pidIndex, String(inc.busPid), ent.entityId);
      if (inc.hostPid != null) add(pidIndex, String(inc.hostPid), ent.entityId);
    }
  }

  // 6. possible-related + collisions from shared hard natives (minus split-declared-distinct values).
  const collisions = new Map<string, string[]>();
  for (const [nativeVal, holders] of hardNativeHolders) {
    if (holders.size < 2 || splitValues.has(nativeVal)) continue;
    const ids = [...holders];
    for (const id of ids) {
      const ent = entities.get(id)!;
      for (const other of ids) if (other !== id && !ent.possibleRelated.includes(other)) ent.possibleRelated.push(other);
    }
    // collision = a concurrent, differently-situated pair holds this native (9ac3eb4 class).
    const incsOf = ids.map((id) => entities.get(id)!.incarnations[entities.get(id)!.incarnations.length - 1]!);
    let conflict = false;
    for (let i = 0; i < incsOf.length; i++) for (let j = i + 1; j < incsOf.length; j++) {
      const a = incsOf[i]!, b = incsOf[j]!;
      if (overlaps(a, b) && a.busPid !== b.busPid && (a.cwd ?? "") !== (b.cwd ?? "")) conflict = true;
    }
    if (conflict) collisions.set(nativeVal, ids);
  }

  const incomplete = !!opts.incomplete || corruption.length > 0 || conflicts.length > 0;
  return { entities, aliasIndex, possibleIndex, pidIndex, corruption, collisions, conflicts, incomplete };
}

function overlaps(a: Incarnation, b: Incarnation): boolean {
  return a.firstSeenSec <= b.lastSeenSec && b.firstSeenSec <= a.lastSeenSec;
}
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// whois kernel (design §4) — pure; CLI/agent shells add IO (probeFacts).
// ---------------------------------------------------------------------------------------------

export type WhoisResult =
  | { kind: "entity"; entity: IdentityEntity; collisionOn?: string }
  | { kind: "candidates"; entities: IdentityEntity[]; on: string }
  | { kind: "pid"; entities: IdentityEntity[]; on: string } // matched by pid only — unverified, probe to confirm
  | { kind: "not-seen" };

/**
 * Locate the entity for ANY id form, treating the input as an OPAQUE string (design §4.1/§9.5 — never guess
 * by shape). Determinate resolution reads only HARD, non-superseded aliases: a `possible` guess never makes
 * a determinate hit, and never turns a unique hard id ambiguous (review P1-1). A literal held hard by several
 * entities (collision / shared native) returns candidates, never pick-first. A pid-only match returns a
 * distinct `pid` result — unverified historical, requiring a probe (review P2-7).
 */
export function whois(proj: Projection, id: string): WhoisResult {
  const q = id.trim();
  if (!q) return { kind: "not-seen" };

  // exact hard, then prefix hard (resolvePeer parity) — determinate resolution.
  let hitIds = proj.aliasIndex.get(q);
  if (!hitIds || hitIds.size === 0) {
    const pref = new Set<string>();
    for (const [value, ents] of proj.aliasIndex) if (value.startsWith(q)) for (const e of ents) pref.add(e);
    hitIds = pref;
  }
  const ents = [...(hitIds ?? [])].map((e) => proj.entities.get(e)).filter((e): e is IdentityEntity => !!e);
  if (ents.length === 1) {
    const collisionOn = [...proj.collisions.entries()].find(([, ids]) => ids.includes(ents[0]!.entityId))?.[0];
    return { kind: "entity", entity: ents[0]!, collisionOn };
  }
  if (ents.length > 1) return { kind: "candidates", entities: ents, on: q };

  // pid fallback — never a determinate current identity (a pid can be reused). Even a single match is
  // returned as `pid` so the caller must probe/verify before trusting it.
  const pidHits = proj.pidIndex.get(q);
  if (pidHits && pidHits.size > 0) {
    const pents = [...pidHits].map((e) => proj.entities.get(e)).filter((e): e is IdentityEntity => !!e);
    if (pents.length > 0) return { kind: "pid", entities: pents, on: q };
  }
  return { kind: "not-seen" };
}

/** Pick the probe targets for the sweep seam / CLI from an entity's latest incarnation (batch-B uses this so
 *  it never reaches into the incarnation shape). */
export function probeTargets(ent: IdentityEntity): { hostPid?: number; busPid?: number; scope: Scope; birth?: Birth } {
  const inc = ent.incarnations[ent.incarnations.length - 1];
  return { hostPid: inc?.hostPid, busPid: inc?.busPid, scope: inc?.scope ?? "local", birth: inc?.birth };
}

// ---------------------------------------------------------------------------------------------
// liveness kernel (design §5) — three-state + evidence policy. Pure given probe facts.
// ---------------------------------------------------------------------------------------------

export type ProbeResultKind = "present" | "absent" | "eperm" | "reported" | "stale";
export type ProbeFact = { target: "busPid" | "hostPid" | "remote"; result: ProbeResultKind; at: number; pid?: number; birthOk?: boolean };
export type LivenessState = "alive" | "suspected" | "dead";
export type Liveness = { state: LivenessState; evidence: ProbeFact[]; reason: string };
/** Output evidence is THREE-state: `unknown` (not sampled / observer failed) is NOT `none` (verified silent). */
export type OutputEvidence = "recent" | "none" | "unknown";

/**
 * Fold probe facts into a three-state liveness, per the death policy (design §5; review P1-5/P1-6):
 *  - dead ONLY when the correctly-bound hostPid probes absent WITH a verified birth AND output is verified
 *    `none`. A single signal, EPERM, a missing target, identity ambiguity, a remote-only view, or unknown
 *    output → suspected. "unknown output" is never promoted to "no output" (review P1-5).
 *  - host facts are read by RECENCY, and conflicting host facts (differing pid or result) collapse to
 *    suspected — the result never depends on array order, and an old negative never overrides a new positive
 *    (review P1-6).
 *  - a remote (relay) target is reported/stale, never OS-probed → suspected, never alive/dead.
 */
export function liveness(facts: ProbeFact[], output: OutputEvidence = "unknown"): Liveness {
  if (facts.length === 0) return { state: "suspected", evidence: facts, reason: "no probe target" };

  const hostFacts = facts.filter((f) => f.target === "hostPid");
  const bus = facts.find((f) => f.target === "busPid");
  const remote = facts.find((f) => f.target === "remote");

  // Remote-only: never OS-probed.
  if (hostFacts.length === 0 && !bus && remote) {
    return { state: "suspected", evidence: facts, reason: `remote ${remote.result} — reported freshness, not OS-probed` };
  }

  if (hostFacts.length > 0) {
    // Conflicting host evidence (different pid or different result) → suspected, order-independent (P1-6).
    const distinct = new Set(hostFacts.map((f) => `${f.pid ?? ""}\u0000${f.result}`));
    if (distinct.size > 1) return { state: "suspected", evidence: facts, reason: "conflicting host evidence — cannot bind a current instance" };
    const host = hostFacts.reduce((a, b) => (b.at > a.at ? b : a)); // most recent of the consistent set

    if (host.result === "present") {
      if (host.birthOk === true) return { state: "alive", evidence: facts, reason: "host pid present, birth verified" };
      return { state: "suspected", evidence: facts, reason: "host pid present but birth unverified (could be pid reuse)" };
    }
    if (host.result === "absent") {
      if (output === "recent") return { state: "suspected", evidence: facts, reason: "host pid absent but recent output — conflict" };
      if (host.birthOk === true && output === "none") return { state: "dead", evidence: facts, reason: "host pid absent, birth verified, output verified none" };
      if (host.birthOk === true) return { state: "suspected", evidence: facts, reason: "host pid absent, birth verified, but output unknown — not confirmed dead (§11.5)" };
      return { state: "suspected", evidence: facts, reason: "host pid absent but birth unverified — unknown, not dead (§11.5)" };
    }
    if (host.result === "eperm") return { state: "suspected", evidence: facts, reason: "host pid EPERM — exists but not signalable" };
  }

  // No usable host fact: a bus endpoint signal alone (bus death ≠ host death) → suspected.
  if (bus) return { state: "suspected", evidence: facts, reason: bus.result === "present" ? "bus endpoint present, host unknown" : "bus endpoint absent, host unknown" };
  return { state: "suspected", evidence: facts, reason: "insufficient evidence" };
}
