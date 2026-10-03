// Selftest for bus-identity (kept out of the module — no top-level side effects, the msglog P1 lesson).
//   tsx packages/bus/src/bus-identity.selftest.mts
// Covers the batch-A rework regression list (review packet bus-identity-implementation-A-debbb28, 71210d67,
// 8P1/5P2/1P3). Each named threshold from the report appears below with its finding id.
import {
  appendEvent, buildProjection, eventDigest, hostPidFrom, identityDir, isValidEvent, liveness, mintEventId,
  probeTargets, readIdentityLog, readLog, recordLearn, recordSelfObserve, whois,
  type Claim, type IdentityEvent, type ProbeFact,
} from "./bus-identity.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

type Over = Partial<{ ts: number; busPid: number; hostPid: number; cwd: string; tool: string; scope: "local" | "relay"; eventId: string }>;
const obs = (key: string, claims: Claim[], over: Over = {}): IdentityEvent => ({
  v: 1, eventId: over.eventId ?? mintEventId(() => key + "-" + (over.ts ?? 1)), ts: over.ts ?? 1, type: "observe",
  incarnation: { key, claims, scope: over.scope ?? "local", busPid: over.busPid, hostPid: over.hostPid, cwd: over.cwd, tool: over.tool },
});
const learn = (key: string, from: string | undefined, to: string, kind: "bootstrap" | "correction" | "thread-switch", authoritative: boolean, over: { ts?: number; form?: Claim["form"]; eventId?: string } = {}): IdentityEvent =>
  ({ v: 1, eventId: over.eventId ?? mintEventId(() => `l-${key}-${from ?? ""}-${to}-${over.ts ?? 2}`), ts: over.ts ?? 2, type: "learn", incarnationKey: key, from, to, form: over.form ?? "native", kind, authoritative });
const revoke = (targetEventId: string, ts = 3): IdentityEvent => ({ v: 1, eventId: mintEventId(() => `r-${targetEventId}-${ts}`), ts, type: "revoke", targetEventId, reason: "test" });
const split = (of: string, ts = 4): IdentityEvent => ({ v: 1, eventId: mintEventId(() => `s-${of}-${ts}`), ts, type: "split", of, reason: "test" });
const hard = (value: string, form: Claim["form"]): Claim => ({ value, form, confidence: "hard", provenance: "same-announce" });
const poss = (value: string, form: Claim["form"]): Claim => ({ value, form, confidence: "possible", provenance: "heuristic" });

// --- ACCEPTANCE: 01a0ead5 (native) + 673c6525 (run) co-occur in ONE announce → one entity (must survive) ---
{
  const ev = [obs("673c6525", [hard("673c6525", "run"), hard("01a0ead5", "native"), hard("codex:Work-01a0ead5", "handle")], { busPid: 71862, hostPid: 94076, tool: "codex", cwd: "/Users/w/Work" })];
  const proj = buildProjection(ev);
  const a = whois(proj, "01a0ead5"), b = whois(proj, "673c6525");
  t("acceptance: native id resolves to an entity", a.kind === "entity");
  t("acceptance: run id resolves to an entity", b.kind === "entity");
  t("acceptance: both forms resolve to the SAME entity (same-announce, not a merge)", a.kind === "entity" && b.kind === "entity" && a.entity.entityId === b.entity.entityId);
  t("acceptance: entityId is independent, not the native/run literal", a.kind === "entity" && a.entity.entityId !== "01a0ead5" && a.entity.entityId !== "673c6525");
  t("acceptance: handle also resolves to it", whois(proj, "codex:Work-01a0ead5").kind === "entity");
}

// --- P1-1: a `possible` claim never resolves, and never turns a unique hard id ambiguous ---
{
  const ev = [obs("R", [hard("R", "run"), poss("guessed-native-123", "native")])];
  const proj = buildProjection(ev);
  t("P1-1: possible native does NOT resolve (exact)", whois(proj, "guessed-native-123").kind === "not-seen");
  t("P1-1: possible native does NOT resolve (prefix)", whois(proj, "guessed-native").kind === "not-seen");
  t("P1-1: the hard run still resolves", whois(proj, "R").kind === "entity");
}
{
  // Q holds N hard; R only guesses N (possible). N must resolve uniquely to Q, not become candidates.
  const ev = [obs("Q", [hard("Q", "run"), hard("N", "native")], { busPid: 1 }), obs("R", [hard("R", "run"), poss("N", "native")], { busPid: 2 })];
  const proj = buildProjection(ev);
  const w = whois(proj, "N");
  t("P1-1: possible does not make a hard id ambiguous", w.kind === "entity" && whois(proj, "Q").kind === "entity" && w.entity.entityId === (whois(proj, "Q") as { entity: { entityId: string } }).entity.entityId);
}
{
  // guess→announce→query via the real feed helper: nativeAuthoritative=false → native+handle possible.
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-p11-"));
  try {
    recordSelfObserve(home, { id: "run1", stableId: "guessNat", title: "claude:dir-guessNat", tool: "claude", cwd: "/w", pid: 5000 }, false);
    const proj = buildProjection(readIdentityLog(home).events);
    t("P1-1 feed: a guessed announce's native does not resolve", whois(proj, "guessNat").kind === "not-seen");
    t("P1-1 feed: the derived guessed handle does not resolve", whois(proj, "claude:dir-guessNat").kind === "not-seen");
    t("P1-1 feed: the hard run still resolves", whois(proj, "run1").kind === "entity");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- P1-2: shared hard native across TWO runs is NOT a merge (two entities, candidates, no re-whitening) ---
{
  const ev = [
    obs("runA", [hard("runA", "run"), hard("90b58f9c", "native")], { busPid: 101, cwd: "/a", ts: 10 }),
    obs("runB", [hard("runB", "run"), hard("90b58f9c", "native")], { busPid: 202, cwd: "/b", ts: 10 }),
  ];
  const proj = buildProjection(ev);
  t("P1-2: shared native + concurrent diff busPid/cwd → TWO entities", proj.entities.size === 2);
  const w = whois(proj, "90b58f9c");
  t("P1-2: the shared native returns candidates, not pick-first", w.kind === "candidates" && w.entities.length === 2);
  t("P1-2: collision recorded (concurrent-conflict class)", proj.collisions.has("90b58f9c"));
  t("P1-2: each run id still resolves to its own single entity", whois(proj, "runA").kind === "entity" && whois(proj, "runB").kind === "entity");
  t("P1-2: entities list each other as possible-related, not merged", [...proj.entities.values()].every((e) => e.possibleRelated.length === 1));
}
{
  // concurrent_same_cwd: diff busPid, SAME cwd → still two entities + candidates, but NOT a collision.
  const ev = [
    obs("rA", [hard("rA", "run"), hard("Nz", "native")], { busPid: 1, cwd: "/same", ts: 5 }),
    obs("rB", [hard("rB", "run"), hard("Nz", "native")], { busPid: 2, cwd: "/same", ts: 5 }),
  ];
  const proj = buildProjection(ev);
  t("P1-2 concurrent_same_cwd: two entities, candidates", proj.entities.size === 2 && whois(proj, "Nz").kind === "candidates");
  t("P1-2 concurrent_same_cwd: not flagged a collision (same cwd)", !proj.collisions.has("Nz"));
}
{
  // cross_run_without_continuation: non-overlapping, different everything → still two entities, candidates.
  const ev = [
    obs("rX", [hard("rX", "run"), hard("Nc", "native")], { busPid: 1, cwd: "/x", ts: 1 }),
    obs("rY", [hard("rY", "run"), hard("Nc", "native")], { busPid: 2, cwd: "/y", ts: 999 }),
  ];
  const proj = buildProjection(ev);
  t("P1-2 cross_run_without_continuation: two entities (no continuity → no merge)", proj.entities.size === 2 && whois(proj, "Nc").kind === "candidates");
}
{
  // same run key announced twice (legit reconnect) → ONE entity (one incarnation), not a cross-run merge.
  const ev = [obs("rr", [hard("rr", "run"), hard("Nr", "native")], { busPid: 5, cwd: "/x", ts: 1 }), obs("rr", [hard("rr", "run"), hard("Nr", "native")], { busPid: 5, cwd: "/x", ts: 2 })];
  const proj = buildProjection(ev);
  t("same run key twice → one entity (not a cross-run merge)", proj.entities.size === 1 && whois(proj, "Nr").kind === "entity");
}

// --- P1-3: thread-switch retires the old thread within the run; a standalone holder is untouched ---
{
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 })];
  const proj = buildProjection(ev);
  t("P1-3: after switch the new native resolves to the run", whois(proj, "B").kind === "entity");
  t("P1-3: the old thread id no longer resolves (superseded, no other holder)", whois(proj, "A").kind === "not-seen");
  t("P1-3: the run id still resolves", whois(proj, "R").kind === "entity");
}
{
  // A→B→A: switching back re-activates A, retires B.
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 }), learn("R", "B", "A", "thread-switch", true, { ts: 3 })];
  const proj = buildProjection(ev);
  t("P1-3 A→B→A: A resolves again", whois(proj, "A").kind === "entity");
  t("P1-3 A→B→A: B now retired", whois(proj, "B").kind === "not-seen");
}
{
  // a standalone entity holding A is NOT affected by R's A→B switch.
  const ev = [obs("Q", [hard("Q", "run"), hard("A", "native")], { busPid: 9, ts: 1 }), obs("R", [hard("R", "run"), hard("A", "native")], { busPid: 8, ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 })];
  const proj = buildProjection(ev);
  const wA = whois(proj, "A");
  t("P1-3: standalone holder of A still resolves to itself after R switches away", wA.kind === "entity" && wA.entity.entityId === (whois(proj, "Q") as { entity: { entityId: string } }).entity.entityId);
}

// --- P1-4: source-scoped revoke / correction (no global value blacklist) ---
{
  // revoke_does_not_delete_independent_hard_claim: revoke R's observe, Q's independent hard A survives.
  const e1 = obs("R", [hard("R", "run"), hard("A", "native")], { busPid: 1, ts: 1 });
  const e2 = obs("Q", [hard("Q", "run"), hard("A", "native")], { busPid: 2, ts: 1 });
  const proj = buildProjection([e1, e2, revoke(e1.eventId)]);
  const wA = whois(proj, "A");
  t("P1-4: revoking one source leaves an independent hard A resolvable (not globally deleted)", wA.kind === "entity" && wA.entity.entityId === (whois(proj, "Q") as { entity: { entityId: string } }).entity.entityId);
  t("P1-4: the revoked run no longer resolves", whois(proj, "R").kind === "not-seen");
}
{
  // revoke_cascades_to_derived_handle: revoking the source drops the native AND the handle derived from it.
  const handle: Claim = { value: "tool:dir-A", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: "A" };
  const e1 = obs("R", [hard("R", "run"), hard("A", "native"), handle], { ts: 1 });
  const proj = buildProjection([e1, revoke(e1.eventId)]);
  t("P1-4: revoked source's native gone", whois(proj, "A").kind === "not-seen");
  t("P1-4: revoked source's derived handle gone too", whois(proj, "tool:dir-A").kind === "not-seen");
}
{
  // correction cascades to derived handle (hard case): A→B correction supersedes A and handle(derivedFrom A).
  const handle: Claim = { value: "tool:dir-A", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: "A" };
  const ev = [obs("R", [hard("R", "run"), hard("A", "native"), handle], { ts: 1 }), learn("R", "A", "B", "correction", true, { ts: 2 })];
  const proj = buildProjection(ev);
  t("P1-4: correction supersedes the old native", whois(proj, "A").kind === "not-seen");
  t("P1-4: correction cascades to the derived handle", whois(proj, "tool:dir-A").kind === "not-seen");
  t("P1-4: the corrected value resolves", whois(proj, "B").kind === "entity");
}
{
  // correction_withdraws_from_guess (the simple 898bb0d path, kept green).
  const ev = [obs("R", [hard("R", "run"), poss("Aguess", "native")], { ts: 1 }), learn("R", "Aguess", "Btrue", "correction", true, { ts: 2 })];
  const proj = buildProjection(ev);
  t("P1-4 simple: the corrected guess no longer resolves", whois(proj, "Aguess").kind === "not-seen");
  t("P1-4 simple: the authoritative value resolves", whois(proj, "Btrue").kind === "entity");
}
{
  // from === to self-confirmation must NOT blacklist the value — it upgrades it.
  const ev = [obs("R", [hard("R", "run"), poss("A", "native")], { ts: 1 }), learn("R", "A", "A", "correction", true, { ts: 2 })];
  const proj = buildProjection(ev);
  t("P1-4c: from==to self-confirmation resolves (not globally blocked)", whois(proj, "A").kind === "entity");
}
{
  // a revoked correction event does NOT execute its `from` supersede.
  const corr = learn("R", "A", "B", "correction", true, { ts: 2 });
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), corr, revoke(corr.eventId, 3)];
  const proj = buildProjection(ev);
  t("P1-4d: a revoked correction does not revoke its `from` (A still resolves)", whois(proj, "A").kind === "entity");
  t("P1-4d: a revoked correction does not add its `to` (B absent)", whois(proj, "B").kind === "not-seen");
}
{
  // late copy does not revive a revoked value (a later possible re-announce stays unresolved).
  const e1 = obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 });
  const proj = buildProjection([e1, revoke(e1.eventId), obs("S", [hard("S", "run"), poss("A", "native")], { ts: 5 })]);
  t("P1-4: a late possible copy does not revive a revoked value", whois(proj, "A").kind === "not-seen");
}

// --- P2-6: authoritative confirmation upgrades its own guess; a broadcast does not ---
{
  const ev = [obs("R", [hard("R", "run")], { ts: 1 }), learn("R", undefined, "A", "bootstrap", false, { ts: 2 }), learn("R", undefined, "A", "bootstrap", true, { ts: 3 })];
  const proj = buildProjection(ev);
  t("P2-6: an authoritative confirmation upgrades its own possible guess to resolvable", whois(proj, "A").kind === "entity");
}
{
  const ev = [obs("R", [hard("R", "run"), poss("A", "native")], { ts: 1 }), obs("R", [hard("R", "run"), poss("A", "native")], { ts: 2 })];
  const proj = buildProjection(ev);
  t("P2-6: a repeated possible broadcast does NOT upgrade (stays unresolved)", whois(proj, "A").kind === "not-seen");
}

// --- P2-7: a pid is never a determinate current identity; it returns the `pid` (unverified) result ---
{
  const ev = [obs("runP", [hard("runP", "run")], { hostPid: 600099 })];
  const proj = buildProjection(ev);
  t("P2-7: a pid query returns the unverified `pid` kind, not a determinate entity", whois(proj, "600099").kind === "pid");
  t("P2-7: the hard run id still resolves determinately", whois(proj, "runP").kind === "entity");
}
{
  // pid reuse: two entities carry the same hostPid → pid result lists both (ambiguous, needs probe).
  const ev = [obs("r1", [hard("r1", "run")], { hostPid: 700000, busPid: 1 }), obs("r2", [hard("r2", "run")], { hostPid: 700000, busPid: 2 })];
  const w = whois(buildProjection(ev), "700000");
  t("P2-7: a reused pid returns `pid` with multiple candidates", w.kind === "pid" && w.entities.length === 2);
}

// --- P2-5: stable entityId lifecycle + split ---
{
  const id1 = (() => { const w = whois(buildProjection([obs("R", [hard("R", "run")], { ts: 1 })]), "R"); return w.kind === "entity" ? w.entity.entityId : ""; })();
  const id2 = (() => { const w = whois(buildProjection([obs("R", [hard("R", "run")], { ts: 1 }), obs("R", [hard("R", "run"), hard("extra", "native")], { ts: 2 })]), "R"); return w.kind === "entity" ? w.entity.entityId : ""; })();
  t("P2-5: entityId survives an appended incarnation/claim (stable key, not a union root)", id1 !== "" && id1 === id2);
}
{
  // late collision does not retarget a published key.
  const before = buildProjection([obs("R", [hard("R", "run"), hard("N", "native")], { busPid: 1, cwd: "/a", ts: 1 })]);
  const idBefore = (whois(before, "R") as { entity: { entityId: string } }).entity.entityId;
  const after = buildProjection([obs("R", [hard("R", "run"), hard("N", "native")], { busPid: 1, cwd: "/a", ts: 1 }), obs("S", [hard("S", "run"), hard("N", "native")], { busPid: 2, cwd: "/b", ts: 1 })]);
  const idAfter = (whois(after, "R") as { entity: { entityId: string } }).entity.entityId;
  t("P2-5: a late collision does not retarget the published entityId", idBefore === idAfter);
}
{
  // split declares shared-native holders distinct: possible-related + collision cleared, keys preserved.
  const base: IdentityEvent[] = [obs("R", [hard("R", "run"), hard("N", "native")], { busPid: 1, cwd: "/a", ts: 1 }), obs("S", [hard("S", "run"), hard("N", "native")], { busPid: 2, cwd: "/b", ts: 1 })];
  const pre = buildProjection(base);
  const post = buildProjection([...base, split("N")]);
  const keyR = (whois(pre, "R") as { entity: { entityId: string } }).entity.entityId;
  t("P2-5 split: before, holders are possible-related", [...pre.entities.values()].every((e) => e.possibleRelated.length === 1) && pre.collisions.has("N"));
  t("P2-5 split: after, possible-related + collision cleared", [...post.entities.values()].every((e) => e.possibleRelated.length === 0) && !post.collisions.has("N"));
  t("P2-5 split: both entity keys preserved", (whois(post, "R") as { entity: { entityId: string } }).entity.entityId === keyR);
}

// --- P2-4: event identity — replay no-op vs same-id-different-payload conflict ---
{
  const a = obs("k", [hard("A", "native"), hard("k", "run")], { eventId: "same-id", ts: 1 });
  const b = obs("k", [hard("B", "native"), hard("k", "run")], { eventId: "same-id", ts: 1 });
  const proj = buildProjection([a, b]);
  t("P2-4: same eventId + different payload is reported as a conflict", proj.conflicts.length === 1);
  t("P2-4: the conflicting second fact is NOT applied (only A's native present)", whois(proj, "A").kind === "entity" && whois(proj, "B").kind === "not-seen");
}
{
  const a = obs("k", [hard("k", "run")], { eventId: "same-id2", ts: 1 });
  const proj = buildProjection([a, { ...a }]);
  t("P2-4: same eventId + same payload is a replay no-op (no conflict, one entity)", proj.conflicts.length === 0 && proj.entities.size === 1);
}

// --- eventDigest ---
{
  const e1 = obs("k", [hard("k", "run")]);
  t("same payload → same digest", eventDigest(e1) === eventDigest({ ...(e1 as Extract<IdentityEvent, { type: "observe" }>) }));
  const e3 = obs("k", [hard("k", "run"), hard("extra", "native")]);
  t("different payload → different digest", eventDigest(e1) !== eventDigest({ ...e3, eventId: e1.eventId }));
}

// --- P2-3: schema validation — JSON-parseable is not a valid event ---
{
  t("P2-3: null is corruption, not an event", readLog("null\n").corruption.length === 1 && readLog("null\n").events.length === 0);
  t("P2-3: {} is corruption, not silently ignored", readLog("{}\n").corruption.length === 1);
  t("P2-3: a v:2 record is corruption (unknown version not used)", readLog('{"v":2,"eventId":"x","ts":1,"type":"observe","incarnation":{"key":"k","claims":[],"scope":"local"}}\n').corruption.length === 1);
  t("P2-3: a non-numeric ts is corruption", readLog('{"v":1,"eventId":"x","ts":null,"type":"observe","incarnation":{"key":"k","claims":[],"scope":"local"}}\n').corruption.length === 1);
  t("P2-3: a missing incarnation is corruption", readLog('{"v":1,"eventId":"x","ts":1,"type":"observe"}\n').corruption.length === 1);
  t("P2-3: a malformed claim is corruption", readLog('{"v":1,"eventId":"x","ts":1,"type":"observe","incarnation":{"key":"k","scope":"local","claims":[{"value":"x"}]}}\n').corruption.length === 1);
  t("P2-3: isValidEvent accepts a well-formed observe", isValidEvent(obs("k", [hard("k", "run")])));
  t("P2-3: appendEvent rejects an invalid event (returns false)", appendEvent(mkdtempSync(path.join(tmpdir(), "ah-id-iv-")), { v: 2 } as unknown as IdentityEvent) === false);
}

// --- P2-1: log commit / torn-tail recovery before append (round-3 rules preserved) ---
{
  const good = JSON.stringify(obs("k", [hard("k", "run")]));
  const r1 = readLog(good + "\n");
  t("committed event parsed", r1.events.length === 1 && r1.uncommittedTail === null && r1.corruption.length === 0);
  const r2 = readLog(good + "\n" + '{"half":');
  t("torn tail is uncommitted, recoverable", r2.events.length === 1 && r2.uncommittedTail === '{"half":' && r2.corruption.length === 0);
  const r3 = readLog(good + "\n" + "{bad json}\n");
  t("round-3: newline-terminated corrupt last record = corruption, not a tail", r3.events.length === 1 && r3.corruption.length === 1 && r3.uncommittedTail === null);
  const r4 = readLog("{bad}\n" + good + "\n");
  t("mid-stream corruption reported", r4.corruption.length === 1 && r4.events.length === 1);
}

// --- P2-1 on disk: a torn tail is RECOVERED before the next append, and the new event is replayable ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-tail-"));
  try {
    const dir = identityDir(home); mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "alias-log.jsonl");
    const e1 = obs("k", [hard("k", "run")], { ts: 1 });
    writeFileSync(p, JSON.stringify(e1) + "\n" + '{"half":'); // committed E1 + torn tail
    const okE3 = appendEvent(home, obs("k2", [hard("k2", "run")], { ts: 2 }));
    const r = readIdentityLog(home);
    t("P2-1: append after a torn tail returns true", okE3 === true);
    t("P2-1: torn tail recovered — both committed events replay, no corruption, no tail", r.events.length === 2 && r.corruption.length === 0 && r.uncommittedTail === null);
    t("P2-1: the appended event is intact (not glued onto the half-line)", whois(buildProjection(r.events), "k2").kind === "entity");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- P2-2: a read failure is not an empty log ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-rd-"));
  try {
    t("P2-2: a genuinely absent log is `missing` (empty-ok)", readIdentityLog(home).status === "missing");
    mkdirSync(path.join(identityDir(home), "alias-log.jsonl"), { recursive: true }); // make the log path a directory
    const r = readIdentityLog(home);
    t("P2-2: a read error is `error`, not a fake-empty log", r.status === "error" && r.events.length === 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- liveness three-state (P1-5 unknown≠none, P1-6 recency/conflict) ---
{
  const f = (target: ProbeFact["target"], result: ProbeFact["result"], over: Partial<ProbeFact> = {}): ProbeFact => ({ target, result, at: over.at ?? 1, pid: over.pid, birthOk: over.birthOk });
  t("present + birth verified → alive", liveness([f("hostPid", "present", { birthOk: true })]).state === "alive");
  t("present + birth unverified → suspected (pid reuse)", liveness([f("hostPid", "present")]).state === "suspected");
  t("absent + birth verified + output none → dead", liveness([f("hostPid", "absent", { birthOk: true })], "none").state === "dead");
  t("P1-5: absent + birth verified + output UNKNOWN (default) → suspected, not dead", liveness([f("hostPid", "absent", { birthOk: true })]).state === "suspected");
  t("P1-5: absent + birth verified + output unknown (explicit) → suspected", liveness([f("hostPid", "absent", { birthOk: true })], "unknown").state === "suspected");
  t("absent + birth verified + recent output → suspected (conflict)", liveness([f("hostPid", "absent", { birthOk: true })], "recent").state === "suspected");
  t("absent + birth unverified → suspected (§11.5)", liveness([f("hostPid", "absent")], "none").state === "suspected");
  t("host EPERM → suspected", liveness([f("hostPid", "eperm")]).state === "suspected");
  t("bus endpoint absent, host unknown → suspected", liveness([f("busPid", "absent")]).state === "suspected");
  t("remote only → suspected", liveness([f("remote", "stale")]).state === "suspected");
  t("no target → suspected", liveness([]).state === "suspected");
  // P1-6: conflicting host facts → suspected, order-independent; old negative never overrides new positive.
  const conflict = [f("hostPid", "absent", { at: 10, pid: 1, birthOk: true }), f("hostPid", "present", { at: 20, pid: 2, birthOk: true })];
  t("P1-6: conflicting host facts → suspected", liveness(conflict, "none").state === "suspected");
  t("P1-6: result is order-independent (reversed → still suspected)", liveness([...conflict].reverse(), "none").state === "suspected");
  t("P1-6: same pid present@new + absent@old → suspected (conflict)", liveness([f("hostPid", "present", { at: 20, pid: 1, birthOk: true }), f("hostPid", "absent", { at: 10, pid: 1, birthOk: true })], "none").state === "suspected");
  t("P1-6: consistent host facts use the recent one (present → alive)", liveness([f("hostPid", "present", { at: 10, pid: 1, birthOk: true }), f("hostPid", "present", { at: 20, pid: 1, birthOk: true })]).state === "alive");
}

// --- probeTargets (sweep seam helper) ---
{
  const proj = buildProjection([obs("R", [hard("R", "run")], { busPid: 11, hostPid: 22, scope: "local" })]);
  const w = whois(proj, "R");
  t("probeTargets reads the latest incarnation's pids + scope", w.kind === "entity" && (() => { const tgt = probeTargets(w.entity); return tgt.busPid === 11 && tgt.hostPid === 22 && tgt.scope === "local"; })());
}

// --- feed helpers round trip (recordSelfObserve + recordLearn) ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-feed-"));
  try {
    const self = { id: "run-xyz", stableId: "nat-xyz", title: "codex:Work-nat-xyz", tool: "codex", cwd: "/w", pid: 4242 };
    recordSelfObserve(home, self, true, "local", { AGENTHOP_HOST_PID: "4000" } as NodeJS.ProcessEnv);
    const proj = buildProjection(readIdentityLog(home).events);
    t("feed: run id resolves", whois(proj, "run-xyz").kind === "entity");
    t("feed: native resolves to the same entity", (() => { const a = whois(proj, "run-xyz"), b = whois(proj, "nat-xyz"); return a.kind === "entity" && b.kind === "entity" && a.entity.entityId === b.entity.entityId; })());
    t("feed: busPid and hostPid are pid-indexed (unverified)", whois(proj, "4242").kind === "pid" && whois(proj, "4000").kind === "pid");
    t("hostPidFrom reads AGENTHOP_HOST_PID", hostPidFrom({ AGENTHOP_HOST_PID: "77" } as NodeJS.ProcessEnv) === 77 && hostPidFrom({} as NodeJS.ProcessEnv) === undefined);
    recordLearn(home, "run-xyz", undefined, "guessN", "bootstrap", false);
    recordLearn(home, "run-xyz", "guessN", "trueN", "correction", true);
    const proj2 = buildProjection(readIdentityLog(home).events);
    t("feed: a corrected guess does not resolve", whois(proj2, "guessN").kind === "not-seen");
    t("feed: the authoritative corrected value resolves", whois(proj2, "trueN").kind === "entity");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log("all bus-identity selftests passed");
