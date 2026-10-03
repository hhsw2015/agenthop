// Selftest for bus-identity (kept out of the module — no top-level side effects, the msglog P1 lesson).
//   tsx packages/bus/src/bus-identity.selftest.mts
// Covers the frozen design's regression list: independent key + collision-not-merged (P1-1/§3),
// propagation-doesn't-raise-confidence (P1-2/§2.3), pid/liveness three-state (P1-3/P1-4/§5),
// revoke, and the log commit/recovery rules incl. the round-3 newline-terminated-corrupt boundary (§2.5).
import {
  appendEvent, buildProjection, eventDigest, hostPidFrom, identityDir, liveness, mintEventId, readIdentityLog, readLog, recordLearn, recordSelfObserve, whois,
  type Claim, type IdentityEvent, type ProbeFact,
} from "./bus-identity.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

const obs = (key: string, claims: Claim[], over: Partial<{ ts: number; busPid: number; hostPid: number; cwd: string; tool: string }> = {}): IdentityEvent => ({
  v: 1, eventId: mintEventId(() => key + "-" + (over.ts ?? 1)), ts: over.ts ?? 1, type: "observe",
  incarnation: { key, claims, scope: "local", busPid: over.busPid, hostPid: over.hostPid, cwd: over.cwd, tool: over.tool },
});
const hard = (value: string, form: Claim["form"]): Claim => ({ value, form, confidence: "hard", provenance: "same-announce" });

// --- acceptance: 01a0ead5 (native) + 673c6525 (run) co-occur → one entity, both whois hit it ---
{
  const ev = [obs("673c6525", [hard("673c6525", "run"), hard("01a0ead5", "native"), hard("codex:Work-01a0ead5", "handle")], { busPid: 71862, hostPid: 94076, tool: "codex", cwd: "/Users/w/Work" })];
  const proj = buildProjection(ev);
  const a = whois(proj, "01a0ead5"), b = whois(proj, "673c6525");
  t("native id resolves to an entity", a.kind === "entity");
  t("run id resolves to an entity", b.kind === "entity");
  t("both id forms resolve to the SAME entity (acceptance)", a.kind === "entity" && b.kind === "entity" && a.entity.entityId === b.entity.entityId);
  t("entityId is independent, not the native/run literal", a.kind === "entity" && a.entity.entityId !== "01a0ead5" && a.entity.entityId !== "673c6525");
  t("handle also resolves to it", whois(proj, "codex:Work-01a0ead5").kind === "entity");
}

// --- P1-1 / §3: same native, two concurrent diff-busPid diff-cwd = TWO entities (9ac3eb4) ---
{
  const ev = [
    obs("runA", [hard("runA", "run"), hard("90b58f9c", "native")], { busPid: 101, cwd: "/a", ts: 10 }),
    obs("runB", [hard("runB", "run"), hard("90b58f9c", "native")], { busPid: 202, cwd: "/b", ts: 10 }),
  ];
  const proj = buildProjection(ev);
  t("collision: shared native + concurrent + diff busPid/cwd → NOT merged (two entities)", proj.entities.size === 2);
  const w = whois(proj, "90b58f9c");
  t("the shared native returns candidates, not pick-first", w.kind === "candidates" && w.entities.length === 2);
  t("collision recorded on the native value", proj.collisions.has("90b58f9c"));
  t("but each run id resolves to its own single entity", whois(proj, "runA").kind === "entity" && whois(proj, "runB").kind === "entity");
}

// --- same native, SAME busPid+cwd (legit reconnect) → merged ---
{
  const ev = [
    obs("runA", [hard("runA", "run"), hard("N", "native")], { busPid: 5, cwd: "/x", ts: 1 }),
    obs("runA2", [hard("runA2", "run"), hard("N", "native")], { busPid: 5, cwd: "/x", ts: 2 }),
  ];
  t("same native, same busPid/cwd → one entity, two incarnations", (() => { const p = buildProjection(ev); return p.entities.size === 1 && [...p.entities.values()][0]!.incarnations.length === 2; })());
}

// --- P1-2: a guessed native (learn, authoritative=false) does NOT merge; propagation doesn't raise it ---
{
  const ev: IdentityEvent[] = [
    obs("R", [hard("R", "run")], { busPid: 9, cwd: "/q", ts: 1 }),
    { v: 1, eventId: "g1", ts: 2, type: "learn", incarnationKey: "R", to: "A", form: "native", kind: "correction", authoritative: false }, // daemon guess A
    obs("threadA", [hard("A", "native"), hard("runX", "run")], { busPid: 9, cwd: "/q", ts: 3 }), // a real thread A elsewhere
  ];
  const proj = buildProjection(ev);
  // R's guessed A is `possible`, so R must NOT be merged with the hard-native-A incarnation.
  const wR = whois(proj, "R");
  const entOfR = wR.kind === "entity" ? wR.entity.entityId : "";
  const wA = whois(proj, "A");
  const entOfA = wA.kind === "entity" ? wA.entity.entityId : (wA.kind === "candidates" ? "many" : "");
  t("a guessed native is possible, does NOT merge R into the hard-A entity", entOfR !== entOfA || entOfA === "many");
}

// --- P1-2: a CORRECTION revokes the guessed value's resolvable association (§2.3) ---
{
  const ev: IdentityEvent[] = [
    obs("R", [hard("R", "run")], { busPid: 9, cwd: "/q", ts: 1 }),
    { v: 1, eventId: "lg", ts: 2, type: "learn", incarnationKey: "R", to: "Aguess", form: "native", kind: "bootstrap", authoritative: false },
    { v: 1, eventId: "lc", ts: 3, type: "learn", incarnationKey: "R", from: "Aguess", to: "Btrue", form: "native", kind: "correction", authoritative: true },
  ];
  const proj = buildProjection(ev);
  t("the corrected guess no longer resolves", whois(proj, "Aguess").kind === "not-seen");
  t("the authoritative corrected value resolves", whois(proj, "Btrue").kind === "entity");
}

// --- revoke withdraws a claim from resolution ---
{
  const ev: IdentityEvent[] = [
    obs("r1", [hard("r1", "run"), hard("badnative", "native")], { busPid: 1, ts: 1 }),
    { v: 1, eventId: "rev1", ts: 2, type: "revoke", targetEventId: (obs("r1", []).eventId), reason: "mis-observed" },
  ];
  // Note: the revoke targets the observe eventId; reconstruct it the same way the obs() helper mints.
  const observeId = mintEventId(() => "r1-1");
  const ev2: IdentityEvent[] = [
    { ...(obs("r1", [hard("r1", "run"), hard("badnative", "native")], { busPid: 1, ts: 1 }) as Extract<IdentityEvent, { type: "observe" }>), eventId: observeId },
    { v: 1, eventId: "rev1", ts: 2, type: "revoke", targetEventId: observeId, reason: "mis-observed" },
  ];
  const proj = buildProjection(ev2);
  t("a revoked observe drops its claims (badnative not found)", whois(proj, "badnative").kind === "not-seen");
}

// --- log commit/recovery (round-3) ---
{
  const good = JSON.stringify(obs("k", [hard("k", "run")]));
  // 1. newline-terminated good lines = committed
  const r1 = readLog(good + "\n");
  t("committed event parsed", r1.events.length === 1 && r1.uncommittedTail === null && r1.corruption.length === 0);
  // 2. torn tail (no trailing newline) = recoverable uncommitted tail, NOT corruption
  const r2 = readLog(good + "\n" + '{"half":');
  t("torn tail is uncommitted, recoverable", r2.events.length === 1 && r2.uncommittedTail === '{"half":' && r2.corruption.length === 0);
  // 3. ROUND-3 boundary: a newline-terminated but bad-JSON LAST record = committed corruption, NOT a tail
  const r3 = readLog(good + "\n" + "{bad json}\n");
  t("newline-terminated corrupt last record = corruption, not skipped, not a tail", r3.events.length === 1 && r3.corruption.length === 1 && r3.uncommittedTail === null);
  // 4. mid-stream committed corruption is reported, not silently skipped
  const r4 = readLog("{bad}\n" + good + "\n");
  t("mid-stream corruption reported", r4.corruption.length === 1 && r4.events.length === 1);
}

// --- eventId/digest: same id+payload replay is a no-op signal; different payload differs ---
{
  const e1 = obs("k", [hard("k", "run")]);
  const e2 = { ...(e1 as Extract<IdentityEvent, { type: "observe" }>) };
  t("same payload → same digest (replay no-op)", eventDigest(e1) === eventDigest(e2));
  const e3 = obs("k", [hard("k", "run"), hard("extra", "native")]);
  t("different payload → different digest", eventDigest(e1) !== eventDigest({ ...e3, eventId: e1.eventId }));
}

// --- liveness three-state (P1-4/§5) ---
{
  const f = (target: ProbeFact["target"], result: ProbeFact["result"], over: Partial<ProbeFact> = {}): ProbeFact => ({ target, result, at: 1, ...over });
  t("host present + birth VERIFIED → alive", liveness([f("hostPid", "present", { birthOk: true })]).state === "alive");
  t("host present + birth UNVERIFIED → suspected (pid reuse possible)", liveness([f("hostPid", "present")]).state === "suspected");
  t("host absent + birth VERIFIED + no recent output → dead", liveness([f("hostPid", "absent", { birthOk: true })], false).state === "dead");
  t("host absent + birth UNVERIFIED → suspected, NOT dead (§11.5)", liveness([f("hostPid", "absent")]).state === "suspected");
  t("host absent but recent output → suspected (conflict)", liveness([f("hostPid", "absent", { birthOk: true })], true).state === "suspected");
  t("host absent but birth mismatch (pid reuse) → suspected", liveness([f("hostPid", "absent", { birthOk: false })]).state === "suspected");
  t("host EPERM → suspected", liveness([f("hostPid", "eperm")]).state === "suspected");
  t("bus endpoint absent, host unknown → suspected (not dead)", liveness([f("busPid", "absent")]).state === "suspected");
  t("remote only → suspected, never alive/dead", liveness([f("remote", "stale")]).state === "suspected");
  t("no target → suspected", liveness([]).state === "suspected");
}

// --- round trip on disk ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-ident-"));
  try {
    t("append then read back", (() => {
      appendEvent(home, obs("k", [hard("k", "run"), hard("K", "native")], { busPid: 7 }));
      const r = readIdentityLog(home);
      return r.events.length === 1 && r.corruption.length === 0;
    })());
    // a torn tail on disk is reported as recoverable, not corruption
    writeFileSync(path.join(identityDir(home), "alias-log.jsonl"), JSON.stringify(obs("k", [hard("k", "run")])) + "\n" + '{"torn":');
    t("on-disk torn tail is recoverable, not corruption", (() => { const r = readIdentityLog(home); return r.uncommittedTail !== null && r.corruption.length === 0; })());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- feed helpers: recordSelfObserve + recordLearn produce a resolvable entity ---
{
  const home = mkdtempSync(path.join(tmpdir(), "ah-ident-feed-"));
  try {
    const self = { id: "run-xyz", stableId: "nat-xyz", title: "codex:Work-nat-xyz", tool: "codex", cwd: "/w", pid: 4242 };
    recordSelfObserve(home, self, true, "local", { AGENTHOP_HOST_PID: "4000" } as NodeJS.ProcessEnv);
    const r = readIdentityLog(home);
    const proj = buildProjection(r.events);
    t("feed: run id resolves", whois(proj, "run-xyz").kind === "entity");
    t("feed: native resolves to same entity", (() => { const a = whois(proj, "run-xyz"), b = whois(proj, "nat-xyz"); return a.kind === "entity" && b.kind === "entity" && a.entity.entityId === b.entity.entityId; })());
    t("feed: busPid and hostPid both indexed", whois(proj, "4242").kind === "entity" && whois(proj, "4000").kind === "entity");
    t("hostPidFrom reads AGENTHOP_HOST_PID", hostPidFrom({ AGENTHOP_HOST_PID: "77" } as NodeJS.ProcessEnv) === 77 && hostPidFrom({} as NodeJS.ProcessEnv) === undefined);
    // a guess bootstrap then correction via the helpers
    recordLearn(home, "run-xyz", undefined, "guessN", "bootstrap", false);
    recordLearn(home, "run-xyz", "guessN", "trueN", "correction", true);
    const proj2 = buildProjection(readIdentityLog(home).events);
    t("feed: corrected guess does not resolve", whois(proj2, "guessN").kind === "not-seen");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("all bus-identity selftests passed");
