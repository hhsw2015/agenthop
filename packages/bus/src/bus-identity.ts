import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
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
 * Design disciplines carried here (and the two review rounds that put teeth on them — packets
 * bus-identity-implementation-A-debbb28 71210d67 and -57090b1 3cf91b69):
 *
 *  - Identity recorded, liveness probed — two evidence faces never merged (§1).
 *  - entityId is independent and STABLE: it is derived from a (run, thread-generation) key, not from a union
 *    root, so appending an observation or discovering a late collision never retargets a published id (§2.2).
 *  - The transport (a run/process) and the LOGICAL THREAD are different axes. One run that switches threads
 *    (A→B) yields TWO distinct, each-resolvable entities — not a renamed one, and not A deleted. The bare run
 *    id then resolves to several candidates (necessary ambiguity). A late snapshot of the old thread rejoins
 *    its own generation, never the current one (§2.3; review P1-3).
 *  - v1 does NOT merge across runs. Two distinct runs sharing a hard native are two entities with a
 *    possible-related link and (when concurrent-conflicting) a collision annotation (§3; review P1-2). Within
 *    ONE run+announce the co-occurring forms are one entity — one generation, not a merge (main acceptance).
 *  - PROPAGATION DOES NOT RAISE CONFIDENCE — only source evidence does (§2.3). A guessed field broadcast in
 *    an announce stays `possible`, and `possible` claims never enter determinate resolution (review P1-1).
 *  - Revocation is SOURCE-SCOPED and TRANSITIVE: every claim records the ROOT assertion it came from; a
 *    revoke withdraws exactly the claims from that source (across events — a propagated copy that carries the
 *    source is withdrawn too), and the withdrawal cascades down `derivedFrom` edges (native → handle →
 *    presence). An independent entity holding the same literal as hard is never touched (review P1-4).
 *  - An event id is an identity: same id + same payload is a replay no-op; same id + different payload is a
 *    conflict that is reported, never two facts (review P2-4).
 *  - Append-only log: a torn (no-newline) tail is RECOVERED by TRUNCATING it to the last committed newline —
 *    never by rewriting the committed prefix — so a recovery failure can never lose a committed event (§2.5;
 *    review P2-1). A committed record that fails schema validation is an explicit corruption fact, never
 *    silently skipped or executed (review P2-3). A read failure is not an empty log (review P2-2).
 *  - liveness is three-state; "no output evidence" (unknown) is not "confirmed no output" (none); host facts
 *    are read by recency and ANY conflict — including a birth-verification disagreement — collapses to
 *    suspected, never resolved by array order (review P1-5/P1-6).
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
  /** The ROOT assertion (eventId) this claim came from — the anchor for source-scoped, replayable revoke.
   *  A propagated copy keeps the origin's source, so revoking the origin withdraws the copy too (review P1-4). */
  source?: string;
  /** The value this claim was derived from (e.g. a handle built from a native) — the edge a revoke/correction
   *  cascades down, transitively (native → handle → presence) (review P1-4). */
  derivedFrom?: string;
  /** Retired by a thread-switch's old generation keeping history, a correction, or a revoke; kept for the
   *  record but excluded from all resolution. */
  superseded?: boolean;
};

/** One process/thread life = a set of co-occurring claims plus probe targets. */
export type Incarnation = {
  key: string; // the generation key this snapshot belongs to (`${runKey}#${genIdx}`)
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
  entityId: string; // independent, persistent, derived from the (run, generation) key — NOT a literal
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
 *  `revoke` = withdraw a prior event's claims (source-scoped); `split` = separate a mis-grouped entity. */
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
 * Structural validation (review P2-3): a record is a valid, replayable event only if its version, variant and
 * required fields check out. JSON-parseable is NOT enough — `null`, `{}`, a v:2 record or a non-finite ts are
 * all invalid and must become corruption, never silently used or executed.
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
 * Append one event. Before appending, RECOVER a torn (no-trailing-newline) tail by TRUNCATING the file to the
 * last committed newline — never by rewriting the committed prefix, so a failure mid-recovery can never lose a
 * committed event (review P2-1). A committed record validated as corrupt ends in a newline and is left intact.
 * An invalid event is rejected (false) rather than written as something that cannot be replayed (review P2-3).
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
        // torn tail: shrink the file to the last committed newline. truncate does NOT rewrite the retained
        // prefix, so if it fails the committed bytes [0, lastNl] are untouched.
        const lastNl = buf.lastIndexOf(0x0a);
        truncateSync(p, lastNl + 1); // lastNl === -1 ⇒ truncate to 0 (the whole file was an uncommitted line)
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
  /** A committed (newline-terminated) line that failed to parse OR validate — an explicit corruption fact. */
  corruption: Array<{ lineIndex: number; raw: string }>;
  /** ok = read fine; missing = ENOENT (a genuinely empty/new log); error = a read failure (review P2-2). */
  status: LogStatus;
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
// Feed helpers (batch B call sites use ONLY these — the provenance/confidence mapping stays here)
// ---------------------------------------------------------------------------------------------

/** The subset of SelfInfo the feed needs (structural, so this module stays standalone). */
export type SelfLike = { id: string; stableId?: string; title: string; tool: string; cwd: string; pid: number };

/** Read the host pid the presence hook passed (AGENTHOP_HOST_PID) — the process whose life actually answers
 *  "is the session alive" (design §2.4). busPid is this bus process; hostPid is the host. */
export function hostPidFrom(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = Number(env.AGENTHOP_HOST_PID);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}

/**
 * Record this session's own identity forms as one `observe`. `nativeAuthoritative` = is self.stableId from
 * env/metadata (hard) or a daemon guess (possible) — propagation here never raises it. The handle records
 * `derivedFrom: stableId` so a later correction of the native cascades to the handle.
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
 * Record a stableId transition. `kind`:
 *   - "bootstrap"    : first stableId this run ever had (from undefined)
 *   - "correction"   : a prior GUESS on the SAME logical thread is replaced (supersedes the guess + derivatives)
 *   - "thread-switch": the run moved to a DIFFERENT logical thread (A→B); A and B stay distinct entities
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
  /** value → entityId[], possible claims — informational, never determinate. */
  possibleIndex: Map<string, Set<string>>;
  /** pid string → entityId[] — an unverified historical fallback; a pid never resolves determinately (P2-7). */
  pidIndex: Map<string, Set<string>>;
  /** committed-corrupt records seen during the read that produced these events. */
  corruption: Array<{ lineIndex: number; raw: string }>;
  /** native values shared by concurrent, differently-situated entities (9ac3eb4 class) — annotation only. */
  collisions: Map<string, string[]>;
  /** same eventId carrying a different payload than the first occurrence — rejected, reported (P2-4). */
  conflicts: Array<{ eventId: string; reason: string }>;
  /** split events seen, with whether they separated a multi-incarnation entity (P2-5). */
  splits: Array<{ eventId: string; of: string; applied: boolean }>;
  /** the projection may be missing events (a read error, or committed corruption was present). */
  incomplete: boolean;
};

type Gen = { key: string; runKey: string; idx: number; incarnations: Incarnation[] };

/** Build entities (one per run/thread generation) + resolution indexes from the event log. */
export function buildProjection(events: IdentityEvent[], corruption: LogReadResult["corruption"] = [], opts: { incomplete?: boolean } = {}): Projection {
  // 0. Event-identity: de-dup replays, reject same-id/different-payload conflicts, on REPLAY (review P2-4).
  const seen = new Map<string, string>();
  const conflicts: Array<{ eventId: string; reason: string }> = [];
  const ordered: IdentityEvent[] = [];
  for (const e of events) {
    const d = eventDigest(e);
    const prior = seen.get(e.eventId);
    if (prior === undefined) { seen.set(e.eventId, d); ordered.push(e); continue; }
    if (prior === d) continue; // replay no-op
    conflicts.push({ eventId: e.eventId, reason: "same eventId, different payload — conflicting fact rejected" });
  }

  // 1. Revoked event ids (the targets of revoke events).
  const revokedEventIds = new Set<string>();
  for (const e of ordered) if (e.type === "revoke") revokedEventIds.add(e.targetEventId);

  // 2. Generations per run. The transport (run) and the logical thread are different axes: an observe/learn
  //    routes to the run's generation that already holds its native (thread), adopting into a pre-native
  //    generation, or forking a new one. A thread-switch always forks (review P1-3).
  const runGens = new Map<string, Gen[]>();
  const allGens: Gen[] = [];
  const gensOf = (runKey: string): Gen[] => runGens.get(runKey) ?? [];
  const newGen = (runKey: string, seed?: Incarnation): Gen => {
    const arr = runGens.get(runKey) ?? runGens.set(runKey, []).get(runKey)!;
    const g: Gen = { key: `${runKey}#${arr.length}`, runKey, idx: arr.length, incarnations: [] };
    arr.push(g); allGens.push(g);
    if (seed) { // thread-switch inherits the transport facts of the old generation
      g.incarnations.push({ key: g.key, claims: [], scope: seed.scope, busPid: seed.busPid, hostPid: seed.hostPid, birth: seed.birth, tool: seed.tool, cwd: seed.cwd, firstSeenSec: seed.lastSeenSec, lastSeenSec: seed.lastSeenSec });
    }
    return g;
  };
  const genClaims = (g: Gen): Claim[] => g.incarnations.flatMap((inc) => inc.claims);
  const genHeldNative = (g: Gen, v: string): boolean => genClaims(g).some((c) => c.form === "native" && c.value === v);
  const genHasHardNative = (g: Gen): boolean => genClaims(g).some((c) => c.form === "native" && c.confidence === "hard" && !c.superseded);
  const addClaim = (inc: Incarnation, c: Claim) => {
    const existing = inc.claims.find((x) => x.value === c.value && x.form === c.form && !x.superseded);
    if (!existing) { inc.claims.push({ ...c }); return; }
    if (c.confidence === "hard" && existing.confidence === "possible") {
      existing.confidence = "hard"; existing.provenance = c.provenance; existing.source = c.source;
      if (c.derivedFrom !== undefined) existing.derivedFrom = c.derivedFrom;
    }
  };
  // supersede, within ONE generation, the root claim (value+form) and everything derived from it, transitively
  // (native → handle → presence). Form-specific so a coincidental same-literal run claim is not hit (P1-4).
  const supersedeClosure = (g: Gen, rootValue: string, rootForm: Form) => {
    const all = genClaims(g);
    for (const c of all) if (!c.superseded && c.value === rootValue && c.form === rootForm) c.superseded = true;
    closeDerived(g);
  };
  const closeDerived = (g: Gen) => {
    let changed = true;
    while (changed) {
      changed = false;
      const dead = new Set(genClaims(g).filter((c) => c.superseded).map((c) => c.value));
      for (const c of genClaims(g)) if (!c.superseded && c.derivedFrom && dead.has(c.derivedFrom)) { c.superseded = true; changed = true; }
    }
  };
  const lastInc = (g: Gen, ts: number): Incarnation => {
    let inc = g.incarnations[g.incarnations.length - 1];
    if (!inc) { inc = { key: g.key, claims: [], scope: "local", firstSeenSec: ts, lastSeenSec: ts }; g.incarnations.push(inc); }
    return inc;
  };

  for (const e of ordered) {
    if (e.type === "observe") {
      if (revokedEventIds.has(e.eventId)) continue; // a revoked observe contributes nothing
      const src = e.incarnation;
      const runKey = src.key;
      const obsNative = src.claims.find((c) => c.form === "native")?.value;
      const gens = gensOf(runKey);
      let g: Gen | undefined;
      if (obsNative) g = gens.find((x) => genHeldNative(x, obsNative)) ?? gens.find((x) => !genHasHardNative(x));
      else g = gens.find((x) => !genHasHardNative(x)) ?? gens[gens.length - 1];
      if (!g) g = newGen(runKey);
      const inc: Incarnation = { key: g.key, claims: [], scope: src.scope, busPid: src.busPid, hostPid: src.hostPid, birth: src.birth, tool: src.tool, cwd: src.cwd, firstSeenSec: e.ts, lastSeenSec: e.ts };
      for (const c of src.claims) addClaim(inc, { ...c, source: c.source ?? e.eventId }); // keep an explicit root source (P1-4)
      g.incarnations.push(inc);
    } else if (e.type === "learn") {
      if (revokedEventIds.has(e.eventId)) continue; // a revoked learn (correction/switch) does not act (P1-4d)
      const runKey = e.incarnationKey;
      const conf: Confidence = e.authoritative ? "hard" : "possible";
      const provenance: Provenance = e.kind === "bootstrap" ? "learn-bootstrap" : e.kind === "correction" ? "learn-correction" : "thread-switch";
      const gens = gensOf(runKey);
      if (e.kind === "thread-switch" && e.from && e.from !== e.to) {
        // fork a NEW generation for the new thread; the old generation keeps `from` as its own identity.
        const old = gens.find((x) => genHeldNative(x, e.from!));
        const g = newGen(runKey, old?.incarnations[old.incarnations.length - 1]);
        const inc = lastInc(g, e.ts);
        addClaim(inc, { value: runKey, form: "run", confidence: "hard", provenance: "same-announce", source: e.eventId });
        addClaim(inc, { value: e.to, form: e.form, confidence: conf, provenance, source: e.eventId });
      } else {
        // bootstrap / correction / self-confirm — stay on the thread's own generation.
        let g = (e.from ? gens.find((x) => genHeldNative(x, e.from!)) : undefined) ?? gens.find((x) => !genHasHardNative(x));
        if (!g) g = newGen(runKey);
        if (e.kind === "correction" && e.from && e.from !== e.to) supersedeClosure(g, e.from, e.form);
        addClaim(lastInc(g, e.ts), { value: e.to, form: e.form, confidence: conf, provenance, source: e.eventId });
      }
    }
    // revoke/split handled structurally (revoke below; split after materialize).
  }

  // 3. Source-scoped revoke (across events) + transitive derivation closure (review P1-4).
  for (const g of allGens) {
    for (const c of genClaims(g)) if (c.source && revokedEventIds.has(c.source)) c.superseded = true;
    closeDerived(g);
  }

  // 4. Materialize entities — one per generation. entityId derived from the generation key ⇒ STABLE (P2-5).
  const entities = new Map<string, IdentityEntity>();
  const genEntityId = new Map<string, string>();
  for (const g of allGens) {
    if (g.incarnations.every((inc) => inc.claims.length === 0 && inc.busPid == null && inc.hostPid == null)) continue;
    const entityId = `ent-${shortHash(g.key)}`;
    genEntityId.set(g.key, entityId);
    const tool = g.incarnations.find((i) => i.tool)?.tool;
    const cwd = g.incarnations.find((i) => i.cwd)?.cwd;
    entities.set(entityId, { entityId, incarnations: g.incarnations, possibleRelated: [], tool, cwd });
  }

  // 5. split — an event-level entity separation (review P2-5). If the target entity carries more than one
  //    incarnation, detach the most recent one into a new entity; the old entityId is preserved with its
  //    remaining history (both stay resolvable → the shared id reads as candidates). v1's generation model
  //    already keeps different threads apart, so a single-incarnation entity has nothing to separate — the
  //    split is recorded as applied=false rather than silently clearing annotations.
  const splits: Array<{ eventId: string; of: string; applied: boolean }> = [];
  for (const e of ordered) {
    if (e.type !== "split" || revokedEventIds.has(e.eventId)) continue;
    const ent = entities.get(e.of);
    if (ent && ent.incarnations.length >= 2) {
      const detached = ent.incarnations.pop()!;
      const newId = `ent-${shortHash(`${e.of}~split~${e.eventId}`)}`;
      entities.set(newId, { entityId: newId, incarnations: [detached], possibleRelated: [], tool: detached.tool, cwd: detached.cwd });
      splits.push({ eventId: e.eventId, of: e.of, applied: true });
    } else {
      splits.push({ eventId: e.eventId, of: e.of, applied: false });
    }
  }

  // 6. Resolution indexes: aliasIndex = HARD non-superseded claims; possibleIndex = possible; pidIndex = pids.
  const aliasIndex = new Map<string, Set<string>>();
  const possibleIndex = new Map<string, Set<string>>();
  const pidIndex = new Map<string, Set<string>>();
  const add = (idx: Map<string, Set<string>>, value: string, entityId: string) => (idx.get(value) ?? idx.set(value, new Set()).get(value)!).add(entityId);
  const hardNativeHolders = new Map<string, Set<string>>();
  for (const ent of entities.values()) {
    for (const inc of ent.incarnations) {
      for (const c of inc.claims) {
        if (c.superseded) continue;
        if (c.confidence === "hard") { add(aliasIndex, c.value, ent.entityId); if (c.form === "native") add(hardNativeHolders, c.value, ent.entityId); }
        else add(possibleIndex, c.value, ent.entityId);
      }
      if (inc.busPid != null) add(pidIndex, String(inc.busPid), ent.entityId);
      if (inc.hostPid != null) add(pidIndex, String(inc.hostPid), ent.entityId);
    }
  }

  // 7. possible-related + collisions from shared hard natives.
  const collisions = new Map<string, string[]>();
  for (const [nativeVal, holders] of hardNativeHolders) {
    if (holders.size < 2) continue;
    const ids = [...holders];
    for (const id of ids) {
      const ent = entities.get(id)!;
      for (const other of ids) if (other !== id && !ent.possibleRelated.includes(other)) ent.possibleRelated.push(other);
    }
    const incsOf = ids.map((id) => { const i = entities.get(id)!.incarnations; return i[i.length - 1]!; });
    let conflict = false;
    for (let i = 0; i < incsOf.length; i++) for (let j = i + 1; j < incsOf.length; j++) {
      const a = incsOf[i]!, b = incsOf[j]!;
      if (overlaps(a, b) && a.busPid !== b.busPid && (a.cwd ?? "") !== (b.cwd ?? "")) conflict = true;
    }
    if (conflict) collisions.set(nativeVal, ids);
  }

  const incomplete = !!opts.incomplete || corruption.length > 0 || conflicts.length > 0;
  return { entities, aliasIndex, possibleIndex, pidIndex, corruption, collisions, conflicts, splits, incomplete };
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
 * Locate the entity for ANY id form, treating the input as an OPAQUE string (design §4.1/§9.5). Determinate
 * resolution reads only HARD, non-superseded aliases: a `possible` guess never makes a determinate hit and
 * never turns a unique hard id ambiguous (review P1-1). A literal held hard by several entities (collision /
 * shared native / a run across thread generations) returns candidates, never pick-first. A pid-only match
 * returns a distinct `pid` result — unverified historical, requiring a probe (review P2-7).
 */
export function whois(proj: Projection, id: string): WhoisResult {
  const q = id.trim();
  if (!q) return { kind: "not-seen" };

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
 *    output → suspected. "unknown output" is never promoted to "no output".
 *  - host facts are read by RECENCY, and ANY conflict — a differing pid, result, OR birth-verification —
 *    collapses to suspected; the result never depends on array order (review P1-6).
 *  - a remote (relay) target is reported/stale, never OS-probed → suspected, never alive/dead.
 */
export function liveness(facts: ProbeFact[], output: OutputEvidence = "unknown"): Liveness {
  if (facts.length === 0) return { state: "suspected", evidence: facts, reason: "no probe target" };

  const hostFacts = facts.filter((f) => f.target === "hostPid");
  const bus = facts.find((f) => f.target === "busPid");
  const remote = facts.find((f) => f.target === "remote");

  if (hostFacts.length === 0 && !bus && remote) {
    return { state: "suspected", evidence: facts, reason: `remote ${remote.result} — reported freshness, not OS-probed` };
  }

  if (hostFacts.length > 0) {
    // Conflicting host evidence (different pid, result, OR birth verification) → suspected, order-independent.
    const distinct = new Set(hostFacts.map((f) => `${f.pid ?? ""}\u0000${f.result}\u0000${f.birthOk ?? "?"}`));
    if (distinct.size > 1) return { state: "suspected", evidence: facts, reason: "conflicting host evidence — cannot bind a current instance" };
    const host = hostFacts.reduce((a, b) => (b.at > a.at ? b : a));

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

  if (bus) return { state: "suspected", evidence: facts, reason: bus.result === "present" ? "bus endpoint present, host unknown" : "bus endpoint absent, host unknown" };
  return { state: "suspected", evidence: facts, reason: "insufficient evidence" };
}
