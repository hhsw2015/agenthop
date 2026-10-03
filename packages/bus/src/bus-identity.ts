import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * bus-identity v1 — the alias table + whois kernel (bus-identity-design.md, frozen 2026-10-04,
 * SHA 31976429…). Answers "any id form → which entity, is it alive, how do I reply" without conflating
 * identity (recorded) with liveness (probed). Batch A: the self-contained module + its pure kernels. The
 * announce/learnStableId feed points (core.ts/directory.ts) and the sweep seam (task-sweep.ts) are Batch B
 * — landed by their single-editors against the call sites / interface this module exports.
 *
 * Design disciplines carried here:
 *  - Identity is recorded, liveness is probed, two evidence faces never merged (design §1).
 *  - entityId is independent/self-minted; native/run/handle/pid are alias CLAIMS with provenance+confidence
 *    (design §2.2). A shared id literal is NOT entity equality (the 9ac3eb4 collision).
 *  - PROPAGATION DOES NOT RAISE CONFIDENCE — only source evidence does (design §2.3). A guessed field
 *    broadcast in an announce stays `possible`.
 *  - Append-only log: a newline-terminated record is committed; a torn tail is repaired before append; a
 *    corrupt committed record is an explicit corruption fact, never silently skipped (design §2.5, round-3).
 *
 * No top-level side effects (the msglog P1 lesson): tests live in bus-identity.selftest.mts.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (design §2.1/§2.3)
// ---------------------------------------------------------------------------------------------

export type Form = "run" | "native" | "handle" | "presence" | "busPid" | "hostPid";
export type Confidence = "hard" | "possible";
export type Provenance = "same-announce" | "learn-bootstrap" | "learn-correction" | "thread-switch" | "heuristic" | "import";
export type Scope = "local" | "relay";

/** A verifiable process birth, to resist pid reuse (design §2.4). Absent ⇒ pid-reuse defence degrades. */
export type Birth = { hostStartTicks?: string; bootId?: string };

/** One id-form claim tying a value to an incarnation, carrying WHERE it came from and how sure. */
export type Claim = {
  value: string;
  form: Form;
  confidence: Confidence;
  provenance: Provenance;
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
  entityId: string; // independent, persistent, NOT any native/run/handle/pid literal (design §2.2)
  incarnations: Incarnation[];
  tool?: string;
  cwd?: string;
  /** possible-related entities (heuristic / cross-run suspicion) — NOT merged (design §2.3). */
  possibleRelated: string[];
};

// ---------------------------------------------------------------------------------------------
// Append log (design §2.5 + round-3 commit/recovery rules)
// ---------------------------------------------------------------------------------------------

/** One append-log event. `observe` = an announce/self snapshot; `learn` = a stableId transition;
 *  `revoke` = withdraw a prior event's claims; `split` = separate a mis-merged entity. */
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

/** digest of an event's payload (eventId excluded) — same eventId + same digest = replay no-op. */
export function eventDigest(e: IdentityEvent): string {
  const { eventId: _omit, ...rest } = e as IdentityEvent & { eventId: string };
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

/**
 * Append one event. A record is COMMITTED only once its newline-terminated line is on disk; a failed write
 * returns false and advances nothing. Returns false (never throws) so logging can't break the bus.
 */
export function appendEvent(home: string, e: IdentityEvent): boolean {
  try {
    mkdirSync(identityDir(home), { recursive: true });
    appendFileSync(logPath(home), `${JSON.stringify(e)}\n`);
    return true;
  } catch {
    return false;
  }
}

export type LogReadResult = {
  events: IdentityEvent[];
  /** Bytes of a trailing line with no newline — the UNCOMMITTED tail; recoverable by truncation. */
  uncommittedTail: string | null;
  /** A committed (newline-terminated) line that failed to parse — an explicit corruption fact (design
   *  round-3). NOT skipped silently; the caller must surface it and rebuild rather than lose a published event. */
  corruption: Array<{ lineIndex: number; raw: string }>;
};

/**
 * Read the log, separating three cases per the round-3 commit/recovery rules:
 *  - well-formed committed events,
 *  - a single uncommitted (no trailing newline) tail — recoverable by truncate-then-append,
 *  - any committed-but-corrupt record (including a newline-terminated bad-JSON LAST record) — reported as
 *    a corruption fact, never dropped.
 */
export function readLog(raw: string): LogReadResult {
  const events: IdentityEvent[] = [];
  const corruption: Array<{ lineIndex: number; raw: string }> = [];
  let uncommittedTail: string | null = null;

  if (raw === "") return { events, uncommittedTail, corruption };
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
    try {
      events.push(JSON.parse(line) as IdentityEvent);
    } catch {
      // A committed (newline-terminated) record that will not parse: corruption, not a truncatable tail.
      corruption.push({ lineIndex: i, raw: line });
    }
  });
  return { events, uncommittedTail, corruption };
}

/** Read the on-disk log. Missing file ⇒ empty. Caller inspects .corruption / .uncommittedTail. */
export function readIdentityLog(home: string): LogReadResult {
  try {
    return readLog(readFileSync(logPath(home), "utf8"));
  } catch {
    return { events: [], uncommittedTail: null, corruption: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// Fold: events → entities + alias index (design §2.2/§2.3/§3)
// ---------------------------------------------------------------------------------------------

export type Projection = {
  entities: Map<string, IdentityEntity>;
  /** value → entityId[]. One-to-many: a shared literal (collision / pid reuse) points at several. */
  aliasIndex: Map<string, Set<string>>;
  /** Revoked (value,form) pairs — excluded from resolution. Keyed `${value}\u0000${form}`. */
  revoked: Set<string>;
  /** committed-corrupt records seen during the read that produced these events. */
  corruption: Array<{ lineIndex: number; raw: string }>;
  /** native values observed under concurrent, differently-situated incarnations (9ac3eb4 class). */
  collisions: Map<string, string[]>; // native value → entityIds sharing it
};

/** De-dup + revoke-aware; builds incarnations from observe/learn, then merges only on HARD native evidence. */
export function buildProjection(events: IdentityEvent[], corruption: LogReadResult["corruption"] = []): Projection {
  // Replay revokes first (an event revokes a prior eventId's claims).
  const revokedEventIds = new Set<string>();
  for (const e of events) if (e.type === "revoke") revokedEventIds.add(e.targetEventId);

  // 1. Incarnations, keyed by incarnation.key.
  const incs = new Map<string, Incarnation>();
  const addClaim = (inc: Incarnation, c: Claim) => {
    if (!inc.claims.some((x) => x.value === c.value && x.form === c.form)) inc.claims.push(c);
  };
  for (const e of events) {
    if (e.type === "observe") {
      if (revokedEventIds.has(e.eventId)) continue;
      const src = e.incarnation;
      const inc = incs.get(src.key) ?? { key: src.key, claims: [], scope: src.scope, firstSeenSec: e.ts, lastSeenSec: e.ts, busPid: src.busPid, hostPid: src.hostPid, birth: src.birth, tool: src.tool, cwd: src.cwd };
      for (const c of src.claims) addClaim(inc, c);
      inc.busPid ??= src.busPid;
      inc.hostPid ??= src.hostPid;
      inc.birth ??= src.birth;
      inc.tool ??= src.tool;
      inc.cwd ??= src.cwd;
      inc.firstSeenSec = Math.min(inc.firstSeenSec, e.ts);
      inc.lastSeenSec = Math.max(inc.lastSeenSec, e.ts);
      incs.set(src.key, inc);
    } else if (e.type === "learn") {
      if (revokedEventIds.has(e.eventId)) continue;
      const inc = incs.get(e.incarnationKey);
      if (!inc) continue;
      // A guess (authoritative=false) is `possible` and only a candidate; an authoritative bootstrap is hard.
      // A correction/thread-switch records the new value's own source confidence; propagation never lifts it.
      const confidence: Confidence = e.authoritative ? "hard" : "possible";
      const provenance: Provenance = e.kind === "bootstrap" ? "learn-bootstrap" : e.kind === "correction" ? "learn-correction" : "thread-switch";
      addClaim(inc, { value: e.to, form: e.form, confidence, provenance });
    }
  }

  // Build the revoked (value,form) set.
  const revoked = new Set<string>();
  //  - explicit revoke events
  for (const e of events) {
    if (!revokedEventIds.has(e.eventId)) continue;
    if (e.type === "observe") for (const c of e.incarnation.claims) revoked.add(`${c.value}\u0000${c.form}`);
    else if (e.type === "learn") revoked.add(`${e.to}\u0000${e.form}`);
  }
  //  - a CORRECTION of a guess revokes the guessed value's resolvable association (design §2.3): the
  //    daemon guessed `from`, authoritative metadata later proved `to`; the guess must stop resolving, not
  //    be left as a live `possible` alias. No eventId bookkeeping needed at the call site — the correction
  //    event names the superseded value.
  for (const e of events) {
    if (e.type === "learn" && e.kind === "correction" && e.from) revoked.add(`${e.from}\u0000${e.form}`);
  }

  // 2. Merge incarnations into entities, ONLY on a shared HARD native claim, and NOT across a collision.
  const incList = [...incs.values()];
  const parent = new Map<string, string>(); // union-find over incarnation keys
  const find = (k: string): string => { while (parent.get(k) && parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k)!)!); k = parent.get(k)!; } return k; };
  for (const inc of incList) parent.set(inc.key, inc.key);
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Group incarnations by each hard native value.
  const byNative = new Map<string, Incarnation[]>();
  for (const inc of incList) {
    for (const c of inc.claims) {
      if (c.form !== "native" || c.confidence !== "hard") continue;
      if (revoked.has(`${c.value}\u0000native`)) continue;
      (byNative.get(c.value) ?? byNative.set(c.value, []).get(c.value)!).push(inc);
    }
  }
  const collisions = new Map<string, string[]>();
  for (const [nativeVal, group] of byNative) {
    // Collision check (§3): concurrent incarnations that differ in BOTH busPid and cwd are NOT one entity.
    const concurrentConflict = (a: Incarnation, b: Incarnation): boolean =>
      overlaps(a, b) && a.busPid !== b.busPid && (a.cwd ?? "") !== (b.cwd ?? "");
    let anyConflict = false;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) if (concurrentConflict(group[i]!, group[j]!)) anyConflict = true;
    if (anyConflict) {
      collisions.set(nativeVal, []); // filled with entityIds after keys assigned
      continue; // do NOT merge any of them on this native — each stays separate (conservative split)
    }
    for (let i = 1; i < group.length; i++) union(group[0]!.key, group[i]!.key);
  }

  // 3. Materialize entities from union-find roots; mint an independent entityId per root.
  const rootToEntity = new Map<string, string>();
  const entities = new Map<string, IdentityEntity>();
  for (const inc of incList) {
    const root = find(inc.key);
    let entityId = rootToEntity.get(root);
    if (!entityId) {
      entityId = `ent-${shortHash(root)}`;
      rootToEntity.set(root, entityId);
      entities.set(entityId, { entityId, incarnations: [], possibleRelated: [], tool: inc.tool, cwd: inc.cwd });
    }
    const ent = entities.get(entityId)!;
    ent.incarnations.push(inc);
    ent.tool ??= inc.tool;
    ent.cwd ??= inc.cwd;
  }
  // order each entity's incarnations by first-seen (the restart/thread chain)
  for (const ent of entities.values()) ent.incarnations.sort((a, b) => a.firstSeenSec - b.firstSeenSec);

  // 4. Fill collisions with the entityIds that ended up sharing a native, and alias index.
  const aliasIndex = new Map<string, Set<string>>();
  const addAlias = (value: string, entityId: string) => (aliasIndex.get(value) ?? aliasIndex.set(value, new Set()).get(value)!).add(entityId);
  for (const ent of entities.values()) {
    for (const inc of ent.incarnations) {
      for (const c of inc.claims) {
        if (revoked.has(`${c.value}\u0000${c.form}`)) continue;
        addAlias(c.value, ent.entityId);
      }
      if (inc.busPid != null) addAlias(String(inc.busPid), ent.entityId);
      if (inc.hostPid != null) addAlias(String(inc.hostPid), ent.entityId);
    }
  }
  for (const nativeVal of collisions.keys()) collisions.set(nativeVal, [...(aliasIndex.get(nativeVal) ?? [])]);

  return { entities, aliasIndex, revoked, corruption, collisions };
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
  | { kind: "not-seen" };

/**
 * Locate the entity for ANY id form, treating the input as an OPAQUE string (design §4.1/§9.5 — never
 * guess by shape). Dedup to entities first, THEN decide unique vs ambiguous. A literal matching several
 * entities (collision / pid reuse) returns candidates, never pick-first.
 */
export function whois(proj: Projection, id: string): WhoisResult {
  const q = id.trim();
  if (!q) return { kind: "not-seen" };
  // exact
  let hitIds = proj.aliasIndex.get(q);
  // prefix fallback (resolvePeer parity): only when no exact hit
  if (!hitIds || hitIds.size === 0) {
    const pref = new Set<string>();
    for (const [value, ents] of proj.aliasIndex) if (value.startsWith(q)) for (const e of ents) pref.add(e);
    hitIds = pref;
  }
  const ents = [...(hitIds ?? [])].map((e) => proj.entities.get(e)).filter((e): e is IdentityEntity => !!e);
  if (ents.length === 0) return { kind: "not-seen" };
  if (ents.length === 1) {
    const collisionOn = [...proj.collisions.entries()].find(([, ids]) => ids.includes(ents[0]!.entityId))?.[0];
    return { kind: "entity", entity: ents[0]!, collisionOn };
  }
  return { kind: "candidates", entities: ents, on: q };
}

// ---------------------------------------------------------------------------------------------
// liveness kernel (design §5) — three-state + evidence policy. Pure given probe facts.
// ---------------------------------------------------------------------------------------------

export type ProbeResultKind = "present" | "absent" | "eperm" | "reported" | "stale";
export type ProbeFact = { target: "busPid" | "hostPid" | "remote"; result: ProbeResultKind; at: number; pid?: number; birthOk?: boolean };
export type LivenessState = "alive" | "suspected" | "dead";
export type Liveness = { state: LivenessState; evidence: ProbeFact[]; reason: string };

/**
 * Fold probe facts into a three-state liveness, per the death policy (design §5):
 *  - dead ONLY when the correctly-bound hostPid probes absent WITH a matching birth AND there is no recent
 *    output. A single signal, EPERM, a missing target, identity ambiguity, or a remote-only view → suspected.
 *  - roster absence and the same announce's TTL expiry are ONE source, not two independent evidences.
 *  - a remote (relay) target is reported/stale, never OS-probed → suspected, never alive/dead.
 * `recentOutput`: true if the entity produced something recently (overrides a lone negative probe).
 */
export function liveness(facts: ProbeFact[], recentOutput = false): Liveness {
  if (facts.length === 0) return { state: "suspected", evidence: facts, reason: "no probe target" };

  const host = facts.find((f) => f.target === "hostPid");
  const bus = facts.find((f) => f.target === "busPid");
  const remote = facts.find((f) => f.target === "remote");

  // Remote-only: never OS-probed.
  if (!host && !bus && remote) {
    return { state: "suspected", evidence: facts, reason: `remote ${remote.result} — reported freshness, not OS-probed` };
  }
  // alive/dead require a VERIFIED birth (birthOk === true). Without it (birthOk undefined = no birth
  // evidence, the common v1 case), a raw pid present/absent is only suspected — design §11.5: "birth 缺 →
  // unknown,绝不判 dead" and present-without-verified-birth could be pid reuse. The raw pid result is still
  // surfaced as evidence.
  if (host?.result === "present") {
    if (host.birthOk === true) return { state: "alive", evidence: facts, reason: "host pid present, birth verified" };
    return { state: "suspected", evidence: facts, reason: "host pid present but birth unverified (could be pid reuse)" };
  }
  if (host?.result === "absent") {
    if (recentOutput) return { state: "suspected", evidence: facts, reason: "host pid absent but recent output — conflict" };
    if (host.birthOk === true) return { state: "dead", evidence: facts, reason: "host pid absent, birth verified, no recent output" };
    return { state: "suspected", evidence: facts, reason: "host pid absent but birth unverified — unknown, not dead (§11.5)" };
  }
  // EPERM / unknown host, or only a bus endpoint signal → suspected (bus endpoint death ≠ host death).
  if (host?.result === "eperm") return { state: "suspected", evidence: facts, reason: "host pid EPERM — exists but not signalable" };
  if (!host && bus) {
    return { state: "suspected", evidence: facts, reason: bus.result === "present" ? "bus endpoint present, host unknown" : "bus endpoint absent, host unknown" };
  }
  return { state: "suspected", evidence: facts, reason: "insufficient evidence" };
}
