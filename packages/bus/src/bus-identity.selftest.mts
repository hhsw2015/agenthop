// Selftest for bus-identity (kept out of the module — no top-level side effects, the msglog P1 lesson).
//   tsx packages/bus/src/bus-identity.selftest.mts
// Covers the batch-A regression list across BOTH review rounds: packet -debbb28 (71210d67) and the round-2
// verification -57090b1 (3cf91b69). Each named behavior threshold appears with its finding id.
import {
  appendEvent, buildProjection, eventDigest, hostPidFrom, identityDir, isValidEvent, liveness, mintEventId,
  probeTargets, readIdentityLog, readLog, recordLearn, recordSelfObserve, whois,
  type Claim, type IdentityEntity, type ProbeFact,
} from "./bus-identity.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };
const eidOf = (r: ReturnType<typeof whois>): string => (r.kind === "entity" ? r.entity.entityId : "");

type Over = Partial<{ ts: number; busPid: number; hostPid: number; cwd: string; tool: string; scope: "local" | "relay"; eventId: string }>;
const obs = (key: string, claims: Claim[], over: Over = {}): import("./bus-identity.js").IdentityEvent => ({
  v: 1, eventId: over.eventId ?? mintEventId(() => key + "-" + (over.ts ?? 1)), ts: over.ts ?? 1, type: "observe",
  incarnation: { key, claims, scope: over.scope ?? "local", busPid: over.busPid, hostPid: over.hostPid, cwd: over.cwd, tool: over.tool },
});
const learn = (key: string, from: string | undefined, to: string, kind: "bootstrap" | "correction" | "thread-switch", authoritative: boolean, over: { ts?: number; form?: Claim["form"]; eventId?: string } = {}): import("./bus-identity.js").IdentityEvent =>
  ({ v: 1, eventId: over.eventId ?? mintEventId(() => `l-${key}-${from ?? ""}-${to}-${over.ts ?? 2}`), ts: over.ts ?? 2, type: "learn", incarnationKey: key, from, to, form: over.form ?? "native", kind, authoritative });
const revoke = (targetEventId: string, ts = 3): import("./bus-identity.js").IdentityEvent => ({ v: 1, eventId: mintEventId(() => `r-${targetEventId}-${ts}`), ts, type: "revoke", targetEventId, reason: "test" });
const split = (of: string, ts = 4): import("./bus-identity.js").IdentityEvent => ({ v: 1, eventId: mintEventId(() => `s-${of}-${ts}`), ts, type: "split", of, reason: "test" });
const hard = (value: string, form: Claim["form"]): Claim => ({ value, form, confidence: "hard", provenance: "same-announce" });
const poss = (value: string, form: Claim["form"]): Claim => ({ value, form, confidence: "possible", provenance: "heuristic" });
const srcClaim = (value: string, form: Claim["form"], source: string, derivedFrom?: string, parentForm: Claim["form"] = "native"): Claim => ({ value, form, confidence: "hard", provenance: "same-announce", source, ...(derivedFrom ? { derivedFrom: { value: derivedFrom, form: parentForm } } : {}) });

// --- ACCEPTANCE: 01a0ead5 (native) + 673c6525 (run) co-occur in ONE announce → one entity (must survive) ---
{
  const ev = [obs("673c6525", [hard("673c6525", "run"), hard("01a0ead5", "native"), hard("codex:Work-01a0ead5", "handle")], { busPid: 71862, hostPid: 94076, tool: "codex", cwd: "/Users/w/Work" })];
  const proj = buildProjection(ev);
  const a = whois(proj, "01a0ead5"), b = whois(proj, "673c6525");
  t("acceptance: native id resolves to an entity", a.kind === "entity");
  t("acceptance: both forms resolve to the SAME entity (one generation, not a merge)", a.kind === "entity" && b.kind === "entity" && a.entity.entityId === b.entity.entityId);
  t("acceptance: entityId is independent, not the native/run literal", a.kind === "entity" && a.entity.entityId !== "01a0ead5" && a.entity.entityId !== "673c6525");
  t("acceptance: handle also resolves to it", whois(proj, "codex:Work-01a0ead5").kind === "entity");
}

// --- P1-1: a `possible` claim never resolves, and never turns a unique hard id ambiguous ---
{
  const proj = buildProjection([obs("R", [hard("R", "run"), poss("guessed-native-123", "native")])]);
  t("P1-1: possible native does NOT resolve (exact)", whois(proj, "guessed-native-123").kind === "not-seen");
  t("P1-1: possible native does NOT resolve (prefix)", whois(proj, "guessed-native").kind === "not-seen");
  t("P1-1: the hard run still resolves", whois(proj, "R").kind === "entity");
}
{
  const proj = buildProjection([obs("Q", [hard("Q", "run"), hard("N", "native")], { busPid: 1 }), obs("R", [hard("R", "run"), poss("N", "native")], { busPid: 2 })]);
  const w = whois(proj, "N");
  t("P1-1: possible does not make a hard id ambiguous", w.kind === "entity" && eidOf(w) === eidOf(whois(proj, "Q")));
}
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-p11-"));
  try {
    recordSelfObserve(home, { id: "run1", stableId: "guessNat", title: "claude:dir-guessNat", tool: "claude", cwd: "/w", pid: 5000 }, false);
    const proj = buildProjection(readIdentityLog(home).events);
    t("P1-1 feed: a guessed announce's native does not resolve", whois(proj, "guessNat").kind === "not-seen");
    t("P1-1 feed: the derived guessed handle does not resolve", whois(proj, "claude:dir-guessNat").kind === "not-seen");
    t("P1-1 feed: the hard run still resolves", whois(proj, "run1").kind === "entity");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- P1-2: shared hard native across TWO runs is NOT a merge (two entities, candidates) ---
{
  const proj = buildProjection([
    obs("runA", [hard("runA", "run"), hard("90b58f9c", "native")], { busPid: 101, cwd: "/a", ts: 10 }),
    obs("runB", [hard("runB", "run"), hard("90b58f9c", "native")], { busPid: 202, cwd: "/b", ts: 10 }),
  ]);
  t("P1-2: shared native + concurrent diff busPid/cwd → TWO entities", proj.entities.size === 2);
  const w = whois(proj, "90b58f9c");
  t("P1-2: the shared native returns candidates, not pick-first", w.kind === "candidates" && w.entities.length === 2);
  t("P1-2: collision recorded (concurrent-conflict class)", proj.collisions.has("90b58f9c"));
  t("P1-2: each run id still resolves to its own single entity", whois(proj, "runA").kind === "entity" && whois(proj, "runB").kind === "entity");
  t("P1-2: entities list each other as possible-related, not merged", [...proj.entities.values()].every((e) => e.possibleRelated.length === 1));
}
{
  const proj = buildProjection([
    obs("rA", [hard("rA", "run"), hard("Nz", "native")], { busPid: 1, cwd: "/same", ts: 5 }),
    obs("rB", [hard("rB", "run"), hard("Nz", "native")], { busPid: 2, cwd: "/same", ts: 5 }),
  ]);
  t("P1-2 concurrent_same_cwd: two entities, candidates, not a collision", proj.entities.size === 2 && whois(proj, "Nz").kind === "candidates" && !proj.collisions.has("Nz"));
}
{
  const proj = buildProjection([
    obs("rX", [hard("rX", "run"), hard("Nc", "native")], { busPid: 1, cwd: "/x", ts: 1 }),
    obs("rY", [hard("rY", "run"), hard("Nc", "native")], { busPid: 2, cwd: "/y", ts: 999 }),
  ]);
  t("P1-2 cross_run_without_continuation: two entities (no continuity → no merge)", proj.entities.size === 2 && whois(proj, "Nc").kind === "candidates");
}

// --- P1-3: thread-switch SEPARATES threads — A and B are BOTH distinct, each-resolvable entities ---
{
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 })];
  const proj = buildProjection(ev);
  const wA = whois(proj, "A"), wB = whois(proj, "B");
  t("P1-3 thread_switch_keeps_historical_A_separate_from_B: both resolve", wA.kind === "entity" && wB.kind === "entity");
  t("P1-3 thread_switch_keeps_historical_A_separate_from_B: distinct entities, A not deleted", eidOf(wA) !== "" && eidOf(wA) !== eidOf(wB));
  t("P1-3: the bare run is necessarily ambiguous across its threads", whois(proj, "R").kind === "candidates");
}
{
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 }), obs("R", [hard("R", "run"), hard("A", "native")], { ts: 3 })];
  const proj = buildProjection(ev);
  const wA = whois(proj, "A"), wB = whois(proj, "B");
  t("P1-3 thread_switch_late_old_snapshot_does_not_remerge_threads: A and B stay distinct", wA.kind === "entity" && wB.kind === "entity" && eidOf(wA) !== eidOf(wB));
}
{
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2 }), learn("R", "B", "A", "thread-switch", true, { ts: 3 })];
  const proj = buildProjection(ev);
  t("P1-3 thread_switch_A_B_A_keeps_B_history: B still resolves after switching back", whois(proj, "B").kind === "entity");
  t("P1-3 A→B→A: A resolves too (its generations are candidates)", whois(proj, "A").kind === "candidates" || whois(proj, "A").kind === "entity");
}
{
  // P1-3 residual: a late no-native pre-bootstrap snapshot naming its source root rejoins its OWN lineage (A),
  // never the current thread B (no default-to-last-generation).
  const ev = [
    obs("R", [hard("R", "run"), hard("old-run-handle", "handle")], { ts: 1, eventId: "rootObs" }), // pre-native: run + handle, no native
    learn("R", undefined, "A", "bootstrap", true, { ts: 2 }),                                       // R#rootObs gains native A
    learn("R", "A", "B", "thread-switch", true, { ts: 3 }),                                         // forks a new generation (native B)
  ];
  const noLate = buildProjection(ev);
  const idA = eidOf(whois(noLate, "A")), idB = eidOf(whois(noLate, "B"));
  const late = obs("R", [{ value: "old-run-handle", form: "handle", confidence: "hard", provenance: "same-announce", source: "rootObs" }], { ts: 4, eventId: "lateSnap" });
  const withLate = buildProjection([...ev, late]);
  const wh = whois(withLate, "old-run-handle");
  t("P1-3 no-native late snapshot rejoins its source lineage (A), never the current thread B", wh.kind === "entity" && wh.entity.entityId === idA && idB !== "" && wh.entity.entityId !== idB);
}
{
  // P1-3 round-4: an explicit source beats an UNRELATED pre-native generation U (no "pre-native wins" default).
  const ev = [
    obs("R", [hard("R", "run"), hard("A", "native"), { value: "old-A-handle", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: { value: "A", form: "native" } }], { ts: 1, eventId: "Aroot" }),
    learn("R", "A", "B", "thread-switch", true, { ts: 2, eventId: "Bswitch" }),
    obs("R", [hard("R", "run")], { ts: 3, eventId: "Uobs" }),                                   // no-native, no source → creates independent pre-native U
    obs("R", [{ value: "old-A-handle", form: "handle", confidence: "hard", provenance: "same-announce", source: "Aroot", derivedFrom: { value: "A", form: "native" } }], { ts: 4, eventId: "lateA" }), // source=Aroot → A, NOT U
  ];
  const proj = buildProjection(ev);
  const wh = whois(proj, "old-A-handle");
  t("P1-3: explicit source beats an unrelated pre-native generation (resolves to A, not candidates/U)", wh.kind === "entity" && wh.entity.entityId === eidOf(whois(proj, "A")));
}
{
  // P1-3 round-4: routing is order-independent — a mixed-source no-native observe sends each claim to its own
  // source's generation regardless of claim order.
  const runC = { value: "R", form: "run" as const, confidence: "hard" as const, provenance: "same-announce" as const, source: "Bswitch" };
  const hC = { value: "old-A-handle", form: "handle" as const, confidence: "hard" as const, provenance: "same-announce" as const, source: "Aroot", derivedFrom: { value: "A", form: "native" as const } };
  const base = (order: Claim[]) => [
    obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "Aroot" }),
    learn("R", "A", "B", "thread-switch", true, { ts: 2, eventId: "Bswitch" }),
    obs("R", order, { ts: 3, eventId: "mixed" }),
  ];
  const p1 = buildProjection(base([runC, hC])), p2 = buildProjection(base([hC, runC]));
  t("P1-3: order-independent — old handle resolves to A under both claim orders", eidOf(whois(p1, "old-A-handle")) !== "" && eidOf(whois(p1, "old-A-handle")) === eidOf(whois(p1, "A")) && eidOf(whois(p2, "old-A-handle")) === eidOf(whois(p2, "A")));
}
{
  // R4-P2-1: an entityId that is literally another entity's hard alias must NOT be shadowed — it is ambiguous.
  const baseA = [obs("RA", [hard("RA", "run")], { ts: 1 })];
  const idA = eidOf(whois(buildProjection(baseA), "RA"));
  const proj = buildProjection([...baseA, obs("RB", [hard("RB", "run"), hard(idA, "presence")], { ts: 2 })]);
  const w = whois(proj, idA);
  t("R4-P2-1: entityId that is also another entity's hard alias → candidates, not shadowed", w.kind === "candidates" && w.entities.length === 2);
}
{
  // P1-3 round-5: a derivative routes to the generation holding its explicit PARENT (native A), NOT a
  // generation that merely copied the same source's run claim.
  const ev = [
    obs("R", [hard("R", "run"), hard("Bnat", "native")], { ts: 1, eventId: "Bcreate" }),            // gen B (native Bnat)
    obs("R", [srcClaim("R", "run", "S"), srcClaim("A", "native", "S")], { ts: 2, eventId: "S" }),    // A's announce S: native A + run R, source=S → gen A
    obs("R", [srcClaim("R", "run", "S"), hard("Bnat", "native")], { ts: 3, eventId: "Bcopy" }),      // B copies run R source=S (with-native Bnat → B's gen)
    obs("R", [srcClaim("H", "handle", "S", "A")], { ts: 4, eventId: "lateH" }),                      // late H: source=S, derivedFrom={A,native} → must route to A
  ];
  const proj = buildProjection(ev);
  t("P1-3: a derivative routes by its parent native, not a generation that copied the source's run", eidOf(whois(proj, "H")) !== "" && eidOf(whois(proj, "H")) === eidOf(whois(proj, "A")) && eidOf(whois(proj, "H")) !== eidOf(whois(proj, "Bnat")));
}
{
  // P1-3 round-5: a correction targets the POSSIBLE guess, never an independent hard identity of another thread.
  const ev = [
    obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "hardA" }),  // old independent hard A
    obs("R", [srcClaim("R", "run", "uobs")], { ts: 2, eventId: "uobs" }),             // no-native residual → pre-native U
    learn("R", undefined, "A", "bootstrap", false, { ts: 3 }),                         // U gains the only possible A
    learn("R", "A", "C", "correction", true, { ts: 4 }),                               // correct A→C: must hit U's guess
  ];
  const proj = buildProjection(ev);
  const idHardA = eidOf(whois(buildProjection([obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "hardA" })]), "A"));
  t("P1-3: correction hits the possible guess, the independent hard A keeps its identity", whois(proj, "A").kind === "entity" && eidOf(whois(proj, "A")) === idHardA && whois(proj, "C").kind === "entity" && eidOf(whois(proj, "C")) !== idHardA);
}

// --- P1-4: source-scoped, transitive revoke/correction (no global value blacklist) ---
{
  const e1 = obs("R", [hard("R", "run"), hard("A", "native")], { busPid: 1, ts: 1 });
  const e2 = obs("Q", [hard("Q", "run"), hard("A", "native")], { busPid: 2, ts: 1 });
  const proj = buildProjection([e1, e2, revoke(e1.eventId)]);
  t("P1-4 revoke_does_not_delete_independent_hard_claim", whois(proj, "A").kind === "entity" && eidOf(whois(proj, "A")) === eidOf(whois(proj, "Q")));
  t("P1-4: the revoked run no longer resolves", whois(proj, "R").kind === "not-seen");
}
{
  const handle: Claim = { value: "tool:dir-A", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: { value: "A", form: "native" } };
  const e1 = obs("R", [hard("R", "run"), hard("A", "native"), handle], { ts: 1 });
  const proj = buildProjection([e1, revoke(e1.eventId)]);
  t("P1-4: revoked source's native + derived handle both gone", whois(proj, "A").kind === "not-seen" && whois(proj, "tool:dir-A").kind === "not-seen");
}
{
  // correction cascades transitively: native A → handle H (derivedFrom A) → presence P (derivedFrom H).
  const H: Claim = { value: "H", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: { value: "A", form: "native" } };
  const P: Claim = { value: "P", form: "presence", confidence: "hard", provenance: "same-announce", derivedFrom: { value: "H", form: "handle" } };
  const proj = buildProjection([obs("R", [hard("R", "run"), hard("A", "native"), H, P], { ts: 1 }), learn("R", "A", "B", "correction", true, { ts: 2 })]);
  t("P1-4 correction_cascades_transitive_derivatives: A, H, P all retired", whois(proj, "A").kind === "not-seen" && whois(proj, "H").kind === "not-seen" && whois(proj, "P").kind === "not-seen");
  t("P1-4: the corrected value resolves", whois(proj, "B").kind === "entity");
}
{
  // cross-event copy carrying the origin source is withdrawn when the origin is revoked.
  const copy = obs("R", [srcClaim("A", "native", "derive-source"), srcClaim("H", "handle", "derive-source", "A")], { ts: 3, eventId: "derive-copy" });
  const proj = buildProjection([obs("R", [hard("R", "run")], { ts: 1 }), learn("R", undefined, "A", "bootstrap", true, { ts: 2, eventId: "derive-source" }), copy, revoke("derive-source")]);
  t("P1-4 scope_b_revoke_source_cascades_to_cross_event_handle: copy A + H withdrawn", whois(proj, "A").kind === "not-seen" && whois(proj, "H").kind === "not-seen");
  t("P1-4 scope_b: the independent run survives", whois(proj, "R").kind === "entity");
}
{
  // a late HARD copy carrying the revoked source cannot revive it.
  const copy = obs("R", [srcClaim("A", "native", "derive-source")], { ts: 3, eventId: "derive-copy" });
  const late = obs("R", [srcClaim("A", "native", "derive-source")], { ts: 9, eventId: "late-copy" });
  const proj = buildProjection([obs("R", [hard("R", "run")], { ts: 1 }), learn("R", undefined, "A", "bootstrap", true, { ts: 2, eventId: "derive-source" }), copy, revoke("derive-source"), late]);
  t("P1-4 late_hard_copy_cannot_revive_revoked_source", whois(proj, "A").kind === "not-seen");
}
{
  // a revoked correction does not act, and its linked copy does not take effect either.
  const corr = learn("R", "A", "B", "correction", true, { ts: 2, eventId: "corrEvt" });
  const copy = obs("R", [srcClaim("B", "native", "corrEvt")], { ts: 3, eventId: "corr-copy" });
  const proj = buildProjection([obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), corr, copy, revoke("corrEvt")]);
  t("P1-4 scope_d_revoked_correction_with_linked_copy_does_not_act: A still resolves", whois(proj, "A").kind === "entity");
  t("P1-4 scope_d: the linked B copy does not resolve", whois(proj, "B").kind === "not-seen");
}
{
  const proj = buildProjection([obs("R", [hard("R", "run"), poss("Aguess", "native")], { ts: 1 }), learn("R", "Aguess", "Btrue", "correction", true, { ts: 2 })]);
  t("P1-4 simple: the corrected guess no longer resolves, the authoritative value does", whois(proj, "Aguess").kind === "not-seen" && whois(proj, "Btrue").kind === "entity");
}
{
  // P1-4 residual: closeDerived must cascade down the derivation EDGE, not across a bare literal. S1/S2 (same
  // run R) each independently hard native A; H derives from S2's A; C1 copies A with source=S1; revoke S1 →
  // S2's A and its H both survive (only the S1-sourced copy is withdrawn).
  const S2 = obs("R", [hard("R", "run"), hard("A", "native"), { value: "H", form: "handle", confidence: "hard", provenance: "same-announce", source: "S2", derivedFrom: { value: "A", form: "native" } }], { ts: 2, eventId: "S2", busPid: 1 });
  const C1 = obs("R", [srcClaim("A", "native", "S1")], { ts: 3, eventId: "C1", busPid: 1 });
  const proj = buildProjection([obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "S1", busPid: 1 }), S2, C1, revoke("S1")]);
  t("P1-4 independent source: revoking S1 leaves S2's hard A resolvable", whois(proj, "A").kind === "entity");
  t("P1-4 independent source: S2's derived H is NOT collaterally killed", whois(proj, "H").kind === "entity");
}
{
  // P1-4 (round-4 P2, other direction): a corrected guess's derivatives must RETIRE even when an INDEPENDENT
  // same-literal claim is live — they are retired with their OWN parent (same source), not by the bare literal.
  const ev = [
    obs("Rg", [hard("Rg", "run"), poss("A", "native"), { value: "guess-H", form: "handle", confidence: "possible", provenance: "heuristic", derivedFrom: { value: "A", form: "native" } }, { value: "guess-P", form: "presence", confidence: "possible", provenance: "heuristic", derivedFrom: { value: "guess-H", form: "handle" } }], { ts: 1, eventId: "gobs" }),
    learn("Rg", "A", "B", "correction", true, { ts: 2 }),
    obs("Rind", [hard("Rind", "run"), hard("A", "native")], { ts: 1 }),
  ];
  const proj = buildProjection(ev);
  const rg = whois(proj, "Rg");
  const claims = rg.kind === "entity" ? rg.entity.incarnations.flatMap((i) => i.claims) : [];
  const gH = claims.find((c) => c.value === "guess-H"), gP = claims.find((c) => c.value === "guess-P");
  t("P1-4 (P2): a corrected guess's derivatives retire even with an independent live same-literal", !!gH && gH.superseded === true && !!gP && gP.superseded === true);
  t("P1-4 (P2): the independent live A is unaffected", whois(proj, "Rind").kind === "entity" && whois(proj, "A").kind === "entity");
}
{
  // P1-4 round-5: a correction's invalidation reaches LATE copies of the corrected source assertion.
  const gp = (v: string, f: Claim["form"], df?: { value: string; form: Claim["form"] }): Claim => ({ value: v, form: f, confidence: "possible", provenance: "heuristic", source: "gsrc", ...(df ? { derivedFrom: df } : {}) });
  const ev = [
    obs("Rg", [hard("Rg", "run"), gp("A", "native"), gp("H", "handle", { value: "A", form: "native" })], { ts: 1, eventId: "gobs" }),
    learn("Rg", "A", "B", "correction", true, { ts: 2 }),
    obs("Rg", [gp("A", "native")], { ts: 3, eventId: "lateA" }),                        // late copy of the corrected guess A (source gsrc)
    obs("Rg", [gp("H", "handle", { value: "A", form: "native" })], { ts: 4, eventId: "lateH" }), // late copy of its derivative
  ];
  const proj = buildProjection(ev);
  const rg = whois(proj, "Rg");
  const claims = rg.kind === "entity" ? rg.entity.incarnations.flatMap((i) => i.claims) : [];
  const guessClaims = claims.filter((c) => (c.value === "A" && c.form === "native") || (c.value === "H" && c.form === "handle"));
  t("P1-4 (P2): late copies of a corrected guess (and derivatives) all retire", guessClaims.length >= 3 && guessClaims.every((c) => c.superseded === true) && whois(proj, "B").kind === "entity");
}
{
  // P1-4 round-5: the invalidation also reaches a CROSS-RUN copy of the corrected source assertion.
  const gp = (v: string, f: Claim["form"], df?: { value: string; form: Claim["form"] }): Claim => ({ value: v, form: f, confidence: "possible", provenance: "heuristic", source: "xsrc", ...(df ? { derivedFrom: df } : {}) });
  const ev = [
    obs("Rorig", [hard("Rorig", "run"), gp("A", "native"), gp("H", "handle", { value: "A", form: "native" })], { ts: 1, eventId: "oobs" }),
    obs("Rother", [hard("Rother", "run"), gp("A", "native"), gp("H", "handle", { value: "A", form: "native" })], { ts: 2, eventId: "copyobs" }),
    learn("Rorig", "A", "B", "correction", true, { ts: 3 }),
  ];
  const proj = buildProjection(ev);
  const other = whois(proj, "Rother");
  const oc = other.kind === "entity" ? other.entity.incarnations.flatMap((i) => i.claims) : [];
  const oA = oc.find((c) => c.value === "A" && c.form === "native"), oH = oc.find((c) => c.value === "H" && c.form === "handle");
  t("P1-4 (P2): a cross-run copy of the corrected guess + its derivative retire", !!oA && oA.superseded === true && !!oH && oH.superseded === true);
}
{
  // P1-4 round-5: within one observe where run and native share a literal+source, the native's handle retires
  // with the NATIVE (matched by form), and the hard run of the same literal is preserved.
  const ev = [
    obs("X", [{ value: "X", form: "run", confidence: "hard", provenance: "same-announce" }, { value: "X", form: "native", confidence: "possible", provenance: "heuristic" }, { value: "H", form: "handle", confidence: "possible", provenance: "heuristic", derivedFrom: { value: "X", form: "native" } }], { ts: 1, eventId: "obs1" }),
    learn("X", "X", "B", "correction", true, { ts: 2 }),
  ];
  const w = whois(buildProjection(ev), "X");
  const claims = w.kind === "entity" ? w.entity.incarnations.flatMap((i) => i.claims) : [];
  const runX = claims.find((c) => c.value === "X" && c.form === "run"), natX = claims.find((c) => c.value === "X" && c.form === "native"), h = claims.find((c) => c.value === "H" && c.form === "handle");
  t("P1-4 (P2): same-literal — native retired + handle retired, hard run preserved", !!runX && !runX.superseded && !!natX && natX.superseded === true && !!h && h.superseded === true);
}
{
  // P1-3 round-6: an ambiguous-parent derivative (two hard A generations, no disambiguating source) stays
  // UNDECIDED — never dumped into a residual generation a later unrelated bootstrap (C) can claim.
  const ev = [
    obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "a0" }),
    learn("R", "A", "B", "thread-switch", true, { ts: 2, eventId: "sw1" }),
    learn("R", "B", "A", "thread-switch", true, { ts: 3, eventId: "sw2" }),           // A->B->A: two hard A generations
    obs("R", [srcClaim("R", "run", "uobs")], { ts: 4, eventId: "uobs" }),             // unrelated no-native -> pre-native U
    obs("R", [{ value: "Hx", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: { value: "A", form: "native" } }], { ts: 5, eventId: "hobs" }), // parent {A,native}, NO source
    learn("R", undefined, "C", "bootstrap", true, { ts: 6 }),                          // U bootstraps C
  ];
  const proj = buildProjection(ev);
  t("P1-3: an ambiguous-parent derivative stays undecided, never claimed by an unrelated bootstrap", whois(proj, "Hx").kind === "not-seen" && whois(proj, "C").kind === "entity" && proj.undecided.some((c) => c.value === "Hx"));
}
{
  // P1-3 round-6: a non-derivative copy rejoins the ORIGINAL binding's generation; a non-creating event does
  // not spawn a phantom owner.
  const ev = [
    obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "aroot" }),
    obs("R", [hard("R", "run"), hard("A", "native"), hard("P", "presence")], { ts: 2, eventId: "S" }), // S: non-creating observe on A, records P (source defaults to S)
    learn("R", "A", "B", "thread-switch", true, { ts: 3, eventId: "sw" }),
    obs("R", [srcClaim("P", "presence", "S")], { ts: 4, eventId: "copy" }),                            // copy P source=S -> rejoin A's gen, no phantom
  ];
  const proj = buildProjection(ev);
  const w = whois(proj, "P");
  t("P1-3: a non-derivative copy rejoins its original binding (no phantom owner)", w.kind === "entity" && eidOf(w) === eidOf(whois(proj, "A")));
}
{
  // P1-3 round-6: a late derivative of a KNOWN-but-RETIRED parent rejoins that generation (no phantom), retires.
  const ev = [
    obs("Rk", [hard("Rk", "run"), poss("A", "native"), { value: "Hk", form: "handle", confidence: "possible", provenance: "heuristic", source: "ks", derivedFrom: { value: "A", form: "native" } }], { ts: 1, eventId: "ks" }),
    learn("Rk", "A", "B", "correction", true, { ts: 2 }),
    obs("Rk", [{ value: "Hk2", form: "handle", confidence: "hard", provenance: "same-announce", source: "ks", derivedFrom: { value: "A", form: "native" } }], { ts: 3, eventId: "late" }),
  ];
  const proj = buildProjection(ev);
  t("P1-3: a late derivative of a known-retired parent rejoins its generation (no phantom) and retires", whois(proj, "Hk2").kind === "not-seen" && proj.entities.size === 1 && whois(proj, "B").kind === "entity");
}
{
  // P1-4 round-6: a correction retiring possible A from MULTIPLE sources records ALL of them, so every source's
  // cross-run copies retire (not just the first).
  const mk = (v: string, f: Claim["form"], src: string, d?: { value: string; form: Claim["form"] }): Claim => ({ value: v, form: f, confidence: "possible", provenance: "heuristic", source: src, ...(d ? { derivedFrom: d } : {}) });
  const ev = [
    obs("R", [hard("R", "run"), mk("A", "native", "S1")], { ts: 1, eventId: "o1" }), // possible A, source S1
    obs("R", [mk("A", "native", "S2")], { ts: 2, eventId: "o2" }),                    // possible A, source S2 (same generation, second incarnation)
    learn("R", "A", "B", "correction", true, { ts: 3 }),
    obs("Rx", [hard("Rx", "run"), mk("A", "native", "S2"), mk("H", "handle", "S2", { value: "A", form: "native" })], { ts: 4, eventId: "copy2" }), // cross-run copy of the SECOND source
  ];
  const proj = buildProjection(ev);
  const other = whois(proj, "Rx");
  const oc = other.kind === "entity" ? other.entity.incarnations.flatMap((i) => i.claims) : [];
  const oA = oc.find((c) => c.value === "A" && c.form === "native"), oH = oc.find((c) => c.value === "H" && c.form === "handle");
  t("P1-4 (P2): all retired sources recorded — a second source's cross-run copy also retires", !!oA && oA.superseded === true && !!oH && oH.superseded === true);
}
{
  // P1-4 round-6: the undecided pool participates in global invalidation — an undecided claim whose source is
  // revoked is withdrawn, not left dangling.
  const ev = [
    obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1, eventId: "a0" }),
    learn("R", "A", "B", "thread-switch", true, { ts: 2, eventId: "sw1" }),
    learn("R", "B", "A", "thread-switch", true, { ts: 3, eventId: "sw2" }),           // two hard A gens -> Hx ambiguous
    obs("R", [{ value: "Hx", form: "handle", confidence: "hard", provenance: "same-announce", source: "S", derivedFrom: { value: "A", form: "native" } }], { ts: 4, eventId: "hobs" }),
    revoke("S"),
  ];
  const proj = buildProjection(ev);
  const uH = proj.undecided.find((c) => c.value === "Hx");
  t("P1-4 (P2): the undecided pool participates in revoke invalidation", !!uH && uH.superseded === true);
}
{
  // P1-4 round-6: a derivative copied in another run's observe retires when its parent is corrected (global
  // consistency; no active copy survives).
  const mk = (v: string, f: Claim["form"], src: string, d?: { value: string; form: Claim["form"] }): Claim => ({ value: v, form: f, confidence: "possible", provenance: "heuristic", source: src, ...(d ? { derivedFrom: d } : {}) });
  const ev = [
    obs("R", [hard("R", "run"), mk("A", "native", "proot"), mk("H", "handle", "proot", { value: "A", form: "native" })], { ts: 1, eventId: "proot" }),
    obs("Q", [hard("Q", "run"), mk("H", "handle", "proot", { value: "A", form: "native" })], { ts: 2, eventId: "qobs" }),
    learn("R", "A", "B", "correction", true, { ts: 3 }),
  ];
  const proj = buildProjection(ev);
  t("P1-4 (P2): a copied derivative retires when its parent is corrected (no active copy anywhere)", whois(proj, "H").kind === "not-seen" && whois(proj, "B").kind === "entity");
}
{
  // P1-4 round-7: a copy that keeps the same (value,form,source) but DROPS the optional derivedFrom still
  // retires — the fixpoint propagates by the claim's OWN signature, not only its parent edge.
  const mk = (v: string, f: Claim["form"], src: string, d?: { value: string; form: Claim["form"] }): Claim => ({ value: v, form: f, confidence: "possible", provenance: "heuristic", source: src, ...(d ? { derivedFrom: d } : {}) });
  const run = (order: "copy-after" | "copy-before") => {
    const sObs = obs("R", [hard("R", "run"), mk("A", "native", "S"), mk("H", "handle", "S", { value: "A", form: "native" })], { ts: 1, eventId: "S" });
    const qObs = obs("Q", [hard("Q", "run"), mk("H", "handle", "S")], { ts: 2, eventId: "qobs" }); // same (H,handle,S,possible), NO derivedFrom
    const corr = learn("R", "A", "B", "correction", true, { ts: 3 });
    const ev = order === "copy-after" ? [sObs, corr, qObs] : [sObs, qObs, corr];
    return buildProjection(ev);
  };
  const findH = (proj: ReturnType<typeof buildProjection>): Claim | undefined => {
    const inEnts = [...proj.entities.values()].flatMap((e) => e.incarnations).flatMap((i) => i.claims);
    return [...inEnts, ...proj.undecided].find((c) => c.value === "H" && c.form === "handle" && c.source === "S" && c.derivedFrom === undefined);
  };
  for (const order of ["copy-before", "copy-after"] as const) {
    const proj = run(order);
    const qH = findH(proj);
    t(`P1-4 (P2): a derivedFrom-less same-signature copy retires (${order})`, !!qH && qH.superseded === true);
  }
}
{
  const proj = buildProjection([obs("R", [hard("R", "run"), poss("A", "native")], { ts: 1 }), learn("R", "A", "A", "correction", true, { ts: 2 })]);
  t("P1-4: from==to self-confirmation resolves (not globally blocked)", whois(proj, "A").kind === "entity");
}

// --- P2-6: authoritative confirmation upgrades its own guess; a broadcast does not ---
{
  const proj = buildProjection([obs("R", [hard("R", "run")], { ts: 1 }), learn("R", undefined, "A", "bootstrap", false, { ts: 2 }), learn("R", undefined, "A", "bootstrap", true, { ts: 3 })]);
  t("P2-6: an authoritative confirmation upgrades its own possible guess", whois(proj, "A").kind === "entity");
}
{
  const proj = buildProjection([obs("R", [hard("R", "run"), poss("A", "native")], { ts: 1 }), obs("R", [hard("R", "run"), poss("A", "native")], { ts: 2 })]);
  t("P2-6: a repeated possible broadcast does NOT upgrade", whois(proj, "A").kind === "not-seen");
}

// --- P2-7: a pid is never a determinate current identity ---
{
  const proj = buildProjection([obs("runP", [hard("runP", "run")], { hostPid: 600099 })]);
  t("P2-7: a pid query returns the unverified `pid` kind", whois(proj, "600099").kind === "pid");
  t("P2-7: the hard run id still resolves determinately", whois(proj, "runP").kind === "entity");
}
{
  const w = whois(buildProjection([obs("r1", [hard("r1", "run")], { hostPid: 700000, busPid: 1 }), obs("r2", [hard("r2", "run")], { hostPid: 700000, busPid: 2 })]), "700000");
  t("P2-7: a reused pid returns `pid` with multiple candidates", w.kind === "pid" && w.entities.length === 2);
}

// --- P2-5: stable entityId + event-level split ---
{
  const id1 = eidOf(whois(buildProjection([obs("R", [hard("R", "run")], { ts: 1 })]), "R"));
  const id2 = eidOf(whois(buildProjection([obs("R", [hard("R", "run")], { ts: 1 }), obs("R", [hard("R", "run")], { ts: 2 })]), "R"));
  t("P2-5 entity_id_survives_appended_incarnation", id1 !== "" && id1 === id2);
}
{
  const idBefore = eidOf(whois(buildProjection([obs("R", [hard("R", "run"), hard("N", "native")], { busPid: 1, cwd: "/a", ts: 1 })]), "R"));
  const idAfter = eidOf(whois(buildProjection([obs("R", [hard("R", "run"), hard("N", "native")], { busPid: 1, cwd: "/a", ts: 1 }), obs("S", [hard("S", "run"), hard("N", "native")], { busPid: 2, cwd: "/b", ts: 1 })]), "R"));
  t("P2-5 late_collision_does_not_retarget_published_key", idBefore !== "" && idBefore === idAfter);
}
{
  // P2-5: a published entityId is directly queryable (history-queryable), and split is INERT — recorded,
  // never mutating/retargeting an entity.
  const base = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 })];
  const eid = eidOf(whois(buildProjection(base), "A"));
  const post = buildProjection([...base, split(eid)]);
  t("P2-5: a published entityId is directly queryable (not not-seen)", whois(post, eid).kind === "entity");
  t("P2-5: split is inert — applied=false, entity unchanged and still resolvable", post.splits.length === 1 && !post.splits[0]!.applied && post.entities.has(eid) && whois(post, "A").kind === "entity");
}
{
  // P2-5.3: revoking an earlier thread-switch must NOT renumber/reuse a later entity's published id.
  const ev = [obs("R", [hard("R", "run"), hard("A", "native")], { ts: 1 }), learn("R", "A", "B", "thread-switch", true, { ts: 2, eventId: "switchB" }), learn("R", "B", "C", "thread-switch", true, { ts: 3, eventId: "switchC" })];
  const before = buildProjection(ev);
  const idB = eidOf(whois(before, "B")), idC = eidOf(whois(before, "C"));
  const after = buildProjection([...ev, revoke("switchB")]);
  t("P2-5.3: C's entityId survives revoking an earlier switch (eventId-anchored, not positional)", idC !== "" && idC === eidOf(whois(after, "C")));
  t("P2-5.3: C does NOT reuse the revoked B's old entityId", idB !== "" && eidOf(whois(after, "C")) !== idB && whois(after, "B").kind === "not-seen");
}

// --- P2-4: event identity — replay no-op vs same-id-different-payload conflict ---
{
  const a = obs("k", [hard("A", "native"), hard("k", "run")], { eventId: "same-id", ts: 1 });
  const b = obs("k", [hard("B", "native"), hard("k", "run")], { eventId: "same-id", ts: 1 });
  const proj = buildProjection([a, b]);
  t("P2-4: same eventId + different payload is a reported conflict, second NOT applied", proj.conflicts.length === 1 && whois(proj, "A").kind === "entity" && whois(proj, "B").kind === "not-seen");
}
{
  const a = obs("k", [hard("k", "run")], { eventId: "same-id2", ts: 1 });
  const proj = buildProjection([a, { ...a }]);
  t("P2-4: same eventId + same payload is a replay no-op", proj.conflicts.length === 0 && proj.entities.size === 1);
}

// --- eventDigest ---
{
  const e1 = obs("k", [hard("k", "run")]);
  t("same payload → same digest", eventDigest(e1) === eventDigest({ ...(e1 as Extract<typeof e1, { type: "observe" }>) }));
  const e3 = obs("k", [hard("k", "run"), hard("extra", "native")]);
  t("different payload → different digest", eventDigest(e1) !== eventDigest({ ...e3, eventId: e1.eventId }));
}

// --- P2-3: schema validation ---
{
  t("P2-3: null is corruption, not an event", readLog("null\n").corruption.length === 1 && readLog("null\n").events.length === 0);
  t("P2-3: {} is corruption", readLog("{}\n").corruption.length === 1);
  t("P2-3: a v:2 record is corruption", readLog('{"v":2,"eventId":"x","ts":1,"type":"observe","incarnation":{"key":"k","claims":[],"scope":"local"}}\n').corruption.length === 1);
  t("P2-3: a non-numeric ts is corruption", readLog('{"v":1,"eventId":"x","ts":null,"type":"observe","incarnation":{"key":"k","claims":[],"scope":"local"}}\n').corruption.length === 1);
  t("P2-3: a missing incarnation is corruption", readLog('{"v":1,"eventId":"x","ts":1,"type":"observe"}\n').corruption.length === 1);
  t("P2-3: a malformed claim is corruption", readLog('{"v":1,"eventId":"x","ts":1,"type":"observe","incarnation":{"key":"k","scope":"local","claims":[{"value":"x"}]}}\n').corruption.length === 1);
  t("P2-3: isValidEvent accepts a well-formed observe", isValidEvent(obs("k", [hard("k", "run")])));
  t("P2-3: appendEvent rejects an invalid event", appendEvent(mkdtempSync(path.join(tmpdir(), "ah-id-iv-")), { v: 2 } as unknown as import("./bus-identity.js").IdentityEvent) === false);
}

// --- P2-1: torn-tail recovery TRUNCATES, never rewrites the committed prefix ---
{
  const good = JSON.stringify(obs("k", [hard("k", "run")]));
  t("committed event parsed", readLog(good + "\n").events.length === 1);
  const r2 = readLog(good + "\n" + '{"half":');
  t("torn tail is uncommitted, recoverable", r2.events.length === 1 && r2.uncommittedTail === '{"half":' && r2.corruption.length === 0);
  t("round-3: newline-terminated corrupt last record = corruption, not a tail", (() => { const r = readLog(good + "\n{bad json}\n"); return r.events.length === 1 && r.corruption.length === 1 && r.uncommittedTail === null; })());
  t("mid-stream corruption reported", (() => { const r = readLog("{bad}\n" + good + "\n"); return r.corruption.length === 1 && r.events.length === 1; })());
}
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-tail-"));
  try {
    const dir = identityDir(home); mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "alias-log.jsonl");
    const e1 = obs("k1", [hard("k1", "run")], { ts: 1 }), e2 = obs("k2", [hard("k2", "run")], { ts: 2 });
    writeFileSync(p, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n" + '{"half":'); // E1,E2 committed + torn tail
    const ok3 = appendEvent(home, obs("k3", [hard("k3", "run")], { ts: 3 }));
    const r = readIdentityLog(home);
    t("P2-1: append after torn tail returns true", ok3 === true);
    t("P2-1: the committed prefix (E1,E2) survives recovery, torn tail dropped, E3 added", r.events.length === 3 && r.corruption.length === 0 && r.uncommittedTail === null);
    const ok4 = appendEvent(home, obs("k4", [hard("k4", "run")], { ts: 4 }));
    t("P2-1: a second append is clean (no residual torn tail)", ok4 === true && readIdentityLog(home).events.length === 4);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- P2-2: a read failure is not an empty log ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-rd-"));
  try {
    t("P2-2: a genuinely absent log is `missing`", readIdentityLog(home).status === "missing");
    mkdirSync(path.join(identityDir(home), "alias-log.jsonl"), { recursive: true });
    const r = readIdentityLog(home);
    t("P2-2: a read error is `error`, not a fake-empty log", r.status === "error" && r.events.length === 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- liveness three-state (P1-5 unknown≠none, P1-6 recency/conflict incl. birth) ---
{
  const f = (target: ProbeFact["target"], result: ProbeFact["result"], over: Partial<ProbeFact> = {}): ProbeFact => ({ target, result, at: over.at ?? 1, pid: over.pid, birthOk: over.birthOk });
  t("present + birth verified → alive", liveness([f("hostPid", "present", { birthOk: true })]).state === "alive");
  t("present + birth unverified → suspected (pid reuse)", liveness([f("hostPid", "present")]).state === "suspected");
  t("absent + birth verified + output none → dead", liveness([f("hostPid", "absent", { birthOk: true })], "none").state === "dead");
  t("P1-5: absent + birth verified + output UNKNOWN (default) → suspected", liveness([f("hostPid", "absent", { birthOk: true })]).state === "suspected");
  t("P1-5: absent + birth verified + output unknown (explicit) → suspected", liveness([f("hostPid", "absent", { birthOk: true })], "unknown").state === "suspected");
  t("absent + birth verified + recent output → suspected (conflict)", liveness([f("hostPid", "absent", { birthOk: true })], "recent").state === "suspected");
  t("absent + birth unverified → suspected (§11.5)", liveness([f("hostPid", "absent")], "none").state === "suspected");
  t("host EPERM → suspected", liveness([f("hostPid", "eperm")]).state === "suspected");
  t("bus endpoint absent, host unknown → suspected", liveness([f("busPid", "absent")]).state === "suspected");
  t("remote only → suspected", liveness([f("remote", "stale")]).state === "suspected");
  t("no target → suspected", liveness([]).state === "suspected");
  // P1-6: conflicting host facts (pid/result) → suspected, order-independent.
  const conflict = [f("hostPid", "absent", { at: 10, pid: 1, birthOk: true }), f("hostPid", "present", { at: 20, pid: 2, birthOk: true })];
  t("P1-6: conflicting host facts → suspected", liveness(conflict, "none").state === "suspected");
  t("P1-6: order-independent (reversed → still suspected)", liveness([...conflict].reverse(), "none").state === "suspected");
  t("P1-6: same pid present@new + absent@old → suspected", liveness([f("hostPid", "present", { at: 20, pid: 1, birthOk: true }), f("hostPid", "absent", { at: 10, pid: 1, birthOk: true })], "none").state === "suspected");
  t("P1-6: consistent host facts use the recent one (present → alive)", liveness([f("hostPid", "present", { at: 10, pid: 1, birthOk: true }), f("hostPid", "present", { at: 20, pid: 1, birthOk: true })]).state === "alive");
  // P1-6: SAME pid/result/at but birth-verification disagreement → suspected, order-independent (the round-2 gap).
  const birthConflictAbsent = [f("hostPid", "absent", { at: 200, pid: 5, birthOk: true }), f("hostPid", "absent", { at: 200, pid: 5, birthOk: false })];
  t("P1-6 birth conflict (absent): equal-at verified/mismatch → suspected", liveness(birthConflictAbsent, "none").state === "suspected");
  t("P1-6 birth conflict (absent): reversed → still suspected", liveness([...birthConflictAbsent].reverse(), "none").state === "suspected");
  const birthConflictPresent = [f("hostPid", "present", { at: 200, pid: 5, birthOk: true }), f("hostPid", "present", { at: 200, pid: 5, birthOk: false })];
  t("P1-6 birth conflict (present): equal-at verified/mismatch → suspected", liveness(birthConflictPresent).state === "suspected");
  t("P1-6 birth conflict (present): reversed → still suspected", liveness([...birthConflictPresent].reverse()).state === "suspected");
}

// --- probeTargets (sweep seam helper) ---
{
  const w = whois(buildProjection([obs("R", [hard("R", "run")], { busPid: 11, hostPid: 22, scope: "local" })]), "R");
  t("probeTargets reads the latest incarnation's pids + scope", w.kind === "entity" && (() => { const tgt = probeTargets(w.entity); return tgt.busPid === 11 && tgt.hostPid === 22 && tgt.scope === "local"; })());
}

// --- feed helpers round trip ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-id-feed-"));
  try {
    recordSelfObserve(home, { id: "run-xyz", stableId: "nat-xyz", title: "codex:Work-nat-xyz", tool: "codex", cwd: "/w", pid: 4242 }, true, "local", { AGENTHOP_HOST_PID: "4000" } as NodeJS.ProcessEnv);
    const proj = buildProjection(readIdentityLog(home).events);
    t("feed: run + native resolve to the same entity", eidOf(whois(proj, "run-xyz")) !== "" && eidOf(whois(proj, "run-xyz")) === eidOf(whois(proj, "nat-xyz")));
    t("feed: busPid and hostPid are pid-indexed (unverified)", whois(proj, "4242").kind === "pid" && whois(proj, "4000").kind === "pid");
    t("hostPidFrom reads AGENTHOP_HOST_PID", hostPidFrom({ AGENTHOP_HOST_PID: "77" } as NodeJS.ProcessEnv) === 77 && hostPidFrom({} as NodeJS.ProcessEnv) === undefined);
    recordLearn(home, "run-xyz", undefined, "guessN", "bootstrap", false);
    recordLearn(home, "run-xyz", "guessN", "trueN", "correction", true);
    const proj2 = buildProjection(readIdentityLog(home).events);
    t("feed: a corrected guess does not resolve, the authoritative value does", whois(proj2, "guessN").kind === "not-seen" && whois(proj2, "trueN").kind === "entity");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// =============================================================================================
// immune-backlog #1 — ported once-red probes (reviewer scenario ids, fe0376cd task 2026-10-04).
// Each case replicates an adversarial probe shape that was once RED in a review round and is now
// permanently catchable here. Names carry the reviewer's scenario id + its round (R6/R7). The other
// ~70 reviewer scenarios map to the cases above (see _ACK/migration list); these are the shapes not
// already covered 1:1 by the round-by-round cases.
// =============================================================================================
{
  const C = (value: string, form: Claim["form"], confidence: Claim["confidence"], extra: Partial<Claim> = {}): Claim => ({ value, form, confidence, provenance: "same-announce", ...extra });
  const P = (ev: import("./bus-identity.js").IdentityEvent[]) => buildProjection(ev);
  const AV = (p: ReturnType<typeof buildProjection>, v: string) => [...p.entities.values()].flatMap((e) => e.incarnations).flatMap((i) => i.claims).filter((c) => c.value === v && !c.superseded);
  const UV = (p: ReturnType<typeof buildProjection>, v: string) => p.undecided.filter((c) => c.value === v);
  const K = (p: ReturnType<typeof buildProjection>, v: string) => whois(p, v).kind;

  // R6: an initial run-derived handle stays paired with the run through a later native bootstrap.
  {
    const base = [obs("run-parent-R", [C("run-parent-R", "run", "hard")], { ts: 1, eventId: "rp-root" }), obs("run-parent-R", [C("run-derived-H", "handle", "hard", { source: "rp-root", derivedFrom: { value: "run-parent-R", form: "run" } })], { ts: 2, eventId: "rp-copy" })];
    const beforeId = eidOf(whois(P(base), "run-derived-H"));
    const p = P([...base, learn("run-parent-R", undefined, "run-parent-A", "bootstrap", true, { ts: 3, eventId: "rp-boot" })]);
    t("immune R6 explicit_run_parent_routes_and_survives_native_bootstrap", beforeId !== "" && K(p, "run-derived-H") === "entity" && eidOf(whois(p, "run-derived-H")) === beforeId && eidOf(whois(p, "run-derived-H")) === eidOf(whois(p, "run-parent-A")));
  }
  // R6: correcting native X retires only the native-derived possible handle; the run-derived hard handle survives.
  {
    const p = P([obs("form-X", [C("form-X", "run", "hard"), C("form-X", "native", "possible"), C("run-H", "handle", "hard", { derivedFrom: { value: "form-X", form: "run" } }), C("native-H", "handle", "possible", { derivedFrom: { value: "form-X", form: "native" } })], { ts: 1, eventId: "form-root" }), learn("form-X", "form-X", "form-Y", "correction", true, { ts: 2, eventId: "form-corr" })]);
    t("immune R6 explicit_parent_form_protects_run_from_same_literal_guess", K(p, "run-H") === "entity" && K(p, "native-H") === "not-seen" && !p.possibleIndex.has("native-H"));
  }
  // R6: a legacy/invalid derivedFrom shape is schema-rejected as corruption; the explicit {value,form} is accepted.
  {
    const mkEv = (parent: unknown) => ({ v: 1, eventId: "fmt", ts: 1, type: "observe", incarnation: { key: "fmt-R", scope: "local", claims: [{ value: "fmt-R", form: "run", confidence: "hard", provenance: "same-announce" }, { value: "fmt-H", form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: parent }] } });
    const bad = ["bare-string", { value: "fmt-R" }, { value: "fmt-R", form: "invalid" }].every((parent) => isValidEvent(mkEv(parent)) === false);
    t("immune R6 explicit_parent_form_rejects_legacy_derivedFrom_shapes", bad && isValidEvent(mkEv({ value: "fmt-R", form: "run" })) === true);
  }
  // R6: a hard handle whose explicit parent form is run survives correction of a same-source same-literal native.
  {
    const p = P([obs("X", [C("X", "run", "hard"), C("X", "native", "possible"), C("run-H4", "handle", "hard", { derivedFrom: { value: "X", form: "run" } }), C("native-H4", "handle", "possible", { derivedFrom: { value: "X", form: "native" } })], { ts: 1, eventId: "rps-root" }), learn("X", "X", "true-B4", "correction", true, { ts: 2, eventId: "rps-corr" })]);
    t("immune R6 explicit_run_parent_survives_same_source_native_correction", K(p, "X") === "entity" && K(p, "run-H4") === "entity" && K(p, "true-B4") === "entity" && AV(p, "native-H4").length === 0);
  }
  // R6: correcting one run's guess does not invalidate an independent other run's same-literal guess.
  {
    const p = P([obs("R-independent", [C("R-independent", "run", "hard"), C("independent-A", "native", "possible")], { ts: 1, eventId: "root-to-correct" }), obs("Q-independent", [C("Q-independent", "run", "hard"), C("independent-A", "native", "possible"), C("independent-H", "handle", "possible", { derivedFrom: { value: "independent-A", form: "native" } })], { ts: 2, eventId: "unrelated-root" }), learn("R-independent", "independent-A", "independent-B", "correction", true, { ts: 3, eventId: "correct-one-origin" })]);
    const a = AV(p, "independent-A");
    t("immune R6 independent_other_run_guess_does_not_inherit_source_invalidation", K(p, "independent-B") === "entity" && a.length === 1 && a[0]!.source === "unrelated-root" && p.possibleIndex.has("independent-H") && K(p, "independent-A") === "not-seen");
  }
  // R6: a possible derivative with no observed matching parent stays unresolved and auditable, not cross-bound.
  {
    const p = P([obs("Q-unknown", [C("Q-unknown", "run", "hard"), C("unknown-H", "handle", "possible", { derivedFrom: { value: "missing-A", form: "native" } })], { ts: 1, eventId: "unknown-root" }), obs("R-known", [C("R-known", "run", "hard"), C("missing-A", "native", "possible")], { ts: 2, eventId: "known-other-root" }), learn("R-known", "missing-A", "known-B", "correction", true, { ts: 3, eventId: "correct-known-other" })]);
    t("immune R6 unknown_parent_stays_possible_without_inferred_cross_source_binding", K(p, "known-B") === "entity" && K(p, "unknown-H") === "not-seen" && UV(p, "unknown-H").length === 1 && !UV(p, "unknown-H")[0]!.superseded);
  }
  // R6/R7: a cross-run copy carrying only the derivative (parent elsewhere) follows the known corrected parent.
  {
    const p = P([obs("R-parent", [C("R-parent", "run", "hard"), C("parent-A", "native", "possible"), C("parent-H", "handle", "possible", { derivedFrom: { value: "parent-A", form: "native" } })], { ts: 1, eventId: "parent-root" }), obs("Q-parent", [C("Q-parent", "run", "hard"), C("parent-H", "handle", "possible", { source: "parent-root", derivedFrom: { value: "parent-A", form: "native" } })], { ts: 2, eventId: "handle-only-copy" }), learn("R-parent", "parent-A", "parent-B", "correction", true, { ts: 3, eventId: "correct-parent" })]);
    t("immune R7 cross_run_derivative_only_copy_follows_known_corrected_parent", K(p, "parent-B") === "entity" && K(p, "Q-parent") === "entity" && !p.possibleIndex.has("parent-H") && AV(p, "parent-H").length === 0 && UV(p, "parent-H").every((c) => c.superseded === true));
  }
  // R6: every source retired locally by a correction retires its cross-run copies, regardless of observation order.
  for (const roots of [["S1", "S2"], ["S2", "S1"]] as const) {
    const p = P([
      obs("R-multi", [C("R-multi", "run", "hard"), C("multi-A", "native", "possible")], { ts: 1, eventId: roots[0] }),
      obs("R-multi", [C("R-multi", "run", "hard"), C("multi-A", "native", "possible")], { ts: 2, eventId: roots[1] }),
      obs("Q1", [C("Q1", "run", "hard"), C("multi-A", "native", "possible", { source: "S1" }), C("H1", "handle", "possible", { source: "S1", derivedFrom: { value: "multi-A", form: "native" } })], { ts: 3, eventId: "copy-S1" }),
      obs("Q2", [C("Q2", "run", "hard"), C("multi-A", "native", "possible", { source: "S2" }), C("H2", "handle", "possible", { source: "S2", derivedFrom: { value: "multi-A", form: "native" } })], { ts: 4, eventId: "copy-S2" }),
      learn("R-multi", "multi-A", "multi-B", "correction", true, { ts: 5, eventId: "correct-multi" }),
    ]);
    t(`immune R6 all_locally_corrected_sources_retire_cross_run_copies (${roots.join("_")})`, K(p, "multi-B") === "entity" && ["multi-A", "H1", "H2"].every((v) => AV(p, v).length === 0 && !p.possibleIndex.has(v)));
  }
  // R6: a second locally-corrected source cannot reappear via a late explicit copy.
  {
    const p = P([
      obs("R-late-multi", [C("R-late-multi", "run", "hard"), C("late-multi-A", "native", "possible")], { ts: 1, eventId: "late-S1" }),
      obs("R-late-multi", [C("R-late-multi", "run", "hard"), C("late-multi-A", "native", "possible")], { ts: 2, eventId: "late-S2" }),
      learn("R-late-multi", "late-multi-A", "late-multi-B", "correction", true, { ts: 4, eventId: "correct-late-multi" }),
      obs("R-late-multi", [C("late-multi-A", "native", "possible", { source: "late-S2" }), C("late-multi-H", "handle", "possible", { source: "late-S2", derivedFrom: { value: "late-multi-A", form: "native" } })], { ts: 3, eventId: "late-copy-S2" }),
    ]);
    t("immune R6 second_locally_corrected_source_cannot_return_in_late_copy", K(p, "late-multi-B") === "entity" && ["late-multi-A", "late-multi-H"].every((v) => !p.possibleIndex.has(v) && AV(p, v).length === 0));
  }
  // R7: the global fixpoint retires an A->H->P chain even with P observed before H and both derivatives undecided.
  {
    const p = P([
      obs("R-chain", [C("R-chain", "run", "hard"), C("chain-A", "native", "possible")], { ts: 1, eventId: "chain-root" }),
      obs("Q-chain-P", [C("Q-chain-P", "run", "hard"), C("chain-P", "presence", "possible", { source: "chain-root", derivedFrom: { value: "chain-H", form: "handle" } })], { ts: 2, eventId: "chain-P-copy" }),
      obs("Q-chain-H", [C("Q-chain-H", "run", "hard"), C("chain-H", "handle", "possible", { source: "chain-root", derivedFrom: { value: "chain-A", form: "native" } })], { ts: 3, eventId: "chain-H-copy" }),
      learn("R-chain", "chain-A", "chain-B", "correction", true, { ts: 4, eventId: "chain-correction" }),
    ]);
    t("immune R7 global_fixpoint_retires_reverse_order_multihop_undecided_chain", K(p, "chain-B") === "entity" && ["chain-H", "chain-P"].every((v) => { const u = UV(p, v); return u.length === 1 && u[0]!.superseded === true && AV(p, v).length === 0 && K(p, v) === "not-seen"; }));
  }
  // R7: revoking source S1 retires its undecided copy; an independent S2 hard A/H of the same value/form survive.
  {
    const p = P([
      obs("R-revoke-S1", [C("R-revoke-S1", "run", "hard"), C("shared-A", "native", "hard"), C("shared-H", "handle", "hard", { derivedFrom: { value: "shared-A", form: "native" } })], { ts: 1, eventId: "revoke-S1" }),
      obs("R-revoke-S2", [C("R-revoke-S2", "run", "hard"), C("shared-A", "native", "hard"), C("shared-H", "handle", "hard", { derivedFrom: { value: "shared-A", form: "native" } })], { ts: 2, eventId: "revoke-S2" }),
      obs("Q-revoke", [C("Q-revoke", "run", "hard"), C("shared-H", "handle", "hard", { source: "revoke-S1", derivedFrom: { value: "shared-A", form: "native" } })], { ts: 3, eventId: "revoke-copy" }),
      revoke("revoke-S1", 4),
    ]);
    const u = UV(p, "shared-H");
    t("immune R7 undecided_source_revoke_keeps_independent_hard_same_value_form", u.length === 1 && u[0]!.superseded === true && AV(p, "shared-H").every((c) => c.source === "revoke-S2") && AV(p, "shared-A").every((c) => c.source === "revoke-S2") && K(p, "shared-H") === "entity" && K(p, "shared-A") === "entity");
  }
  // R7: correcting S1's guess retires its undecided copy; an independent S2 hard A/H stay untouched.
  {
    const p = P([
      obs("R-correct-S1", [C("R-correct-S1", "run", "hard"), C("other-A", "native", "possible"), C("other-H", "handle", "possible", { derivedFrom: { value: "other-A", form: "native" } })], { ts: 1, eventId: "correct-S1" }),
      obs("R-correct-S2", [C("R-correct-S2", "run", "hard"), C("other-A", "native", "hard"), C("other-H", "handle", "hard", { derivedFrom: { value: "other-A", form: "native" } })], { ts: 2, eventId: "correct-S2" }),
      obs("Q-correct", [C("Q-correct", "run", "hard"), C("other-H", "handle", "possible", { source: "correct-S1", derivedFrom: { value: "other-A", form: "native" } })], { ts: 3, eventId: "correct-copy" }),
      learn("R-correct-S1", "other-A", "other-B", "correction", true, { ts: 4, eventId: "correct-S1-proof" }),
    ]);
    const u = UV(p, "other-H");
    t("immune R7 undecided_correction_keeps_independent_hard_same_value_form", u.length === 1 && u[0]!.superseded === true && AV(p, "other-H").every((c) => c.source === "correct-S2") && K(p, "other-H") === "entity" && K(p, "other-A") === "entity" && K(p, "other-B") === "entity");
  }
  // R7: a derivative explicitly rooted in hard run X survives a correction of native X at the same source.
  {
    const p = P([
      obs("X", [C("X", "run", "hard"), C("X", "native", "possible"), C("run-control-H", "handle", "hard", { derivedFrom: { value: "X", form: "run" } }), C("native-control-H", "handle", "possible", { derivedFrom: { value: "X", form: "native" } })], { ts: 1, eventId: "run-control-root" }),
      obs("Q-run-control", [C("Q-run-control", "run", "hard"), C("run-control-H", "handle", "hard", { source: "run-control-root", derivedFrom: { value: "X", form: "run" } })], { ts: 2, eventId: "run-control-copy" }),
      learn("X", "X", "run-control-B", "correction", true, { ts: 3, eventId: "run-control-correction" }),
    ]);
    const u = UV(p, "run-control-H");
    t("immune R7 undecided_run_parent_is_not_invalidated_by_same_source_native", u.length === 1 && !u[0]!.superseded && AV(p, "run-control-H").length >= 1 && AV(p, "native-control-H").length === 0 && K(p, "run-control-H") === "entity" && K(p, "X") === "entity" && K(p, "run-control-B") === "entity");
  }
  // R7: a revoked correction does not act (guess stays possible, replacement vanishes); its copied authority derivative retires.
  {
    const p = P([
      obs("R-undo", [C("R-undo", "run", "hard"), C("undo-A", "native", "possible")], { ts: 1, eventId: "undo-origin" }),
      learn("R-undo", "undo-A", "undo-B", "correction", true, { ts: 2, eventId: "undo-authority" }),
      obs("Q-undo", [C("Q-undo", "run", "hard"), C("undo-H", "handle", "hard", { source: "undo-authority", derivedFrom: { value: "undo-B", form: "native" } })], { ts: 3, eventId: "undo-authority-copy" }),
      revoke("undo-authority", 4),
    ]);
    const a = AV(p, "undo-A"), u = UV(p, "undo-H");
    t("immune R7 revoked_correction_retires_undecided_authority_derivative", a.length === 1 && a[0]!.confidence === "possible" && K(p, "undo-A") === "not-seen" && K(p, "undo-B") === "not-seen" && u.length === 1 && u[0]!.superseded === true && K(p, "undo-H") === "not-seen");
  }
  // R7: a hard run sharing the guessed native literal survives without keeping that native's H/P chain active.
  {
    const p = P([
      obs("same-A", [C("same-A", "run", "hard")], { ts: 1, eventId: "run-root" }),
      obs("same-A", [C("same-A", "native", "possible"), C("guess-H", "handle", "possible", { source: "guess-root", derivedFrom: { value: "same-A", form: "native" } }), C("guess-P", "presence", "possible", { source: "guess-root", derivedFrom: { value: "guess-H", form: "handle" } })], { ts: 2, eventId: "guess-root" }),
      learn("same-A", "same-A", "truth-B", "correction", true, { ts: 3, eventId: "correct-guess" }),
    ]);
    t("immune R7 live_independent_run_literal_cannot_keep_corrected_native_derivatives", K(p, "same-A") === "entity" && K(p, "truth-B") === "entity" && !p.possibleIndex.has("guess-H") && AV(p, "guess-H").length === 0 && !p.possibleIndex.has("guess-P") && AV(p, "guess-P").length === 0);
  }
  // R7: an independent hard handle sharing a literal cannot keep a second-hop presence of a corrected guess alive.
  {
    const p = P([
      obs("R-hop", [C("R-hop", "run", "hard"), C("shared-H", "handle", "hard")], { ts: 1, eventId: "independent-handle-root" }),
      obs("R-hop", [C("guess-A", "native", "possible"), C("shared-H", "handle", "possible", { source: "guess-hop-root", derivedFrom: { value: "guess-A", form: "native" } }), C("derived-P", "presence", "possible", { source: "guess-hop-root", derivedFrom: { value: "shared-H", form: "handle" } })], { ts: 2, eventId: "guess-hop-root" }),
      learn("R-hop", "guess-A", "truth-hop-B", "correction", true, { ts: 3, eventId: "correct-hop" }),
    ]);
    t("immune R7 live_independent_handle_literal_cannot_keep_second_hop_guess", !p.possibleIndex.has("guess-A") && K(p, "shared-H") === "entity" && !AV(p, "shared-H").some((c) => c.source === "guess-hop-root") && !p.possibleIndex.has("derived-P") && AV(p, "derived-P").length === 0 && K(p, "truth-hop-B") === "entity");
  }
  // R7: a direct source revoke kills every S1-rooted copy (full chain) while a live S2 same-literal native + handle survive.
  {
    const p = P([
      obs("R-direct", [C("R-direct", "run", "hard"), C("direct-A", "native", "hard"), C("bad-H", "handle", "hard", { source: "direct-S1", derivedFrom: { value: "direct-A", form: "native" } }), C("bad-P", "presence", "hard", { source: "direct-S1", derivedFrom: { value: "bad-H", form: "handle" } })], { ts: 1, eventId: "direct-S1" }),
      obs("R-direct", [C("R-direct", "run", "hard"), C("direct-A", "native", "hard"), C("good-H", "handle", "hard", { source: "direct-S2", derivedFrom: { value: "direct-A", form: "native" } })], { ts: 2, eventId: "direct-S2" }),
      obs("R-direct", [C("R-direct", "run", "hard"), C("direct-A", "native", "hard", { source: "direct-S1" }), C("bad-H", "handle", "hard", { source: "direct-S1", derivedFrom: { value: "direct-A", form: "native" } }), C("bad-P", "presence", "hard", { source: "direct-S1", derivedFrom: { value: "bad-H", form: "handle" } })], { ts: 3, eventId: "direct-copy" }),
      revoke("direct-S1", 4),
    ]);
    t("immune R7 explicit_revoke_preserves_independent_root_and_kills_bad_full_chain", K(p, "good-H") === "entity" && K(p, "direct-A") === "entity" && AV(p, "bad-H").length === 0 && AV(p, "bad-P").length === 0 && !p.possibleIndex.has("bad-H"));
  }
}

console.log("all bus-identity selftests passed");
