import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDelegation, observeCandidate, acceptDelegation, receiptMatches,
  readDelegations, writeDelegations, emptyDelegationRegistry,
  type CompletionSlot, type OpenSpec, type Candidate, type DelegationRegistry,
} from "../src/swarm/delegation-envelope.js";

/** L2-struct sub-increment 1 (cluster-liveness §2b/§2c): the managed-delegation envelope + dual-custody lifecycle —
 *  request → production → (completion-slot verified) → consumption → accepted, matched on the ROUND identity (requestId). */

const slot = (over: Partial<CompletionSlot> = {}): CompletionSlot => ({ locator: "out/r/job-x/build/result.json", targetDigest: "sha-abc", resultFormat: "report", acceptor: "codex:verifier", ...over });
const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ requestId: "job-x/build/r1", payloadDigest: "pd-1", payload: "build the thing", subject: { jobId: "job-x", revision: 1 }, completionSlot: slot(), owner: "rw-1", productionDeadlineSec: 5000, ...over });
const goodCand = (over: Partial<Candidate> = {}): Candidate => ({ observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc", record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } }, ...over });
const opened = (): DelegationRegistry => { const r = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!r.ok) throw new Error(r.reason); return r.registry; };

describe("openDelegation", () => {
  test("new request (with inline payload) ⇒ envelope (phase=production) + a production-wait spec", () => {
    const r = openDelegation(emptyDelegationRegistry(), spec(), 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({ requestId: "job-x/build/r1", payloadDigest: "pd-1", payload: "build the thing", phase: "production", productionWaitId: "deleg-job-x%2Fbuild%2Fr1-prod", openedAtSec: 1000 });
    expect(r.openProductionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-prod", jobId: "job-x", owner: "rw-1", deadlineSec: 5000, requestId: "job-x/build/r1" });
  });

  test("P1-1: a bare digest (no inline payload, no locator+version) is REJECTED — can't rebuild the request", () => {
    expect(openDelegation(emptyDelegationRegistry(), spec({ payload: undefined }), 1000).ok).toBe(false);
    // a locator WITHOUT a fixed version is also insufficient
    expect(openDelegation(emptyDelegationRegistry(), spec({ payload: undefined, payloadLocator: "req/r1.json" }), 1000).ok).toBe(false);
    // locator + version IS a reconstructable source
    const viaLocator = openDelegation(emptyDelegationRegistry(), spec({ payload: undefined, payloadLocator: "req/r1.json", payloadVersion: "v1" }), 1000);
    expect(viaLocator.ok).toBe(true);
    if (viaLocator.ok) expect(viaLocator.envelope).toMatchObject({ payloadLocator: "req/r1.json", payloadVersion: "v1" });
  });

  test("idempotent on the SAME (requestId, payloadDigest) — no new wait; DIFFERENT payloadDigest ⇒ CONFLICT", () => {
    const first = openDelegation(emptyDelegationRegistry(), spec(), 1000);
    expect(first.ok).toBe(true); if (!first.ok) return;
    const again = openDelegation(first.registry, spec(), 1100);
    expect(again.ok).toBe(true); if (!again.ok) return;
    expect(again.openProductionWait).toBeUndefined();
    expect(again.registry).toBe(first.registry);
    const clash = openDelegation(first.registry, spec({ payloadDigest: "pd-2" }), 1100);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toMatch(/conflict/);
  });

  test("missing requestId / payloadDigest ⇒ rejected", () => {
    expect(openDelegation(emptyDelegationRegistry(), spec({ requestId: "" }), 1000).ok).toBe(false);
    expect(openDelegation(emptyDelegationRegistry(), spec({ payloadDigest: "" }), 1000).ok).toBe(false);
  });
});

describe("observeCandidate — completion-slot + completion-record verification", () => {
  test("a candidate matching locator + targetDigest + record identity ⇒ close production + open consumption (owner=acceptor)", () => {
    const r = observeCandidate(opened(), goodCand(), 1200, 1100);
    expect(r.verified).toBe(true);
    if (!r.verified) return;
    expect(r.closeProductionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-prod", resolution: { outcome: "produced" } });
    expect(r.openConsumptionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-cons", owner: "codex:verifier", deadlineSec: 1200, requestId: "job-x/build/r1" });
    expect(r.registry.envelopes["job-x/build/r1"]).toMatchObject({ phase: "consumption", consumptionWaitId: "deleg-job-x%2Fbuild%2Fr1-cons", producedAtSec: 1100 });
  });

  test("a WRONG target digest (stale/wrong/half-write) does NOT verify — closes nothing", () => {
    const r = observeCandidate(opened(), goodCand({ observedDigest: "sha-STALE" }), 1200, 1100);
    expect(r.verified).toBe(false);
    if (!r.verified) expect(r.reason).toMatch(/target digest mismatch/);
  });

  test("P1-2: a completion record bound to ANOTHER request/epoch does NOT verify (same locator + target digest)", () => {
    // wrong payloadDigest — the result is FOR a different request
    const wrongPayload = observeCandidate(opened(), goodCand({ record: { requestId: "job-x/build/r1", payloadDigest: "pd-OTHER", subject: { jobId: "job-x", revision: 1 } } }), 1200, 1100);
    expect(wrongPayload.verified).toBe(false);
    if (!wrongPayload.verified) expect(wrongPayload.reason).toMatch(/payloadDigest/);
    // wrong subject revision — r7 result cannot fulfil the r8 (revision) envelope even at the same locator/target
    const wrongEpoch = observeCandidate(opened(), goodCand({ record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 7 } } }), 1200, 1100);
    expect(wrongEpoch.verified).toBe(false);
    if (!wrongEpoch.verified) expect(wrongEpoch.reason).toMatch(/epoch|subject/);
  });

  test("a locator mismatch / unknown requestId / non-production phase does NOT verify", () => {
    expect(observeCandidate(opened(), goodCand({ observedLocator: "elsewhere" }), 1200, 1100).verified).toBe(false);
    expect(observeCandidate(opened(), goodCand({ record: { requestId: "nope", payloadDigest: "x", subject: { jobId: "job-x" } } }), 1200, 1100).verified).toBe(false);
    const prod = observeCandidate(opened(), goodCand(), 1200, 1100);
    if (!prod.verified) throw new Error("expected verified");
    expect(observeCandidate(prod.registry, goodCand(), 1300, 1200).verified).toBe(false); // already consumption
  });
});

describe("acceptDelegation + receiptMatches", () => {
  const consuming = (): DelegationRegistry => {
    const p = observeCandidate(opened(), goodCand(), 1200, 1100);
    if (!p.verified) throw new Error("produce"); return p.registry;
  };

  test("P2: only the declared acceptor can accept — a producer or empty `by` is REJECTED", () => {
    expect(acceptDelegation(consuming(), "job-x/build/r1", "rw-1", 1300).accepted).toBe(false);          // the producer
    expect(acceptDelegation(consuming(), "job-x/build/r1", "", 1300).accepted).toBe(false);              // empty
    expect(acceptDelegation(consuming(), "job-x/build/r1", "codex:someone-else", 1300).accepted).toBe(false);
    const ok = acceptDelegation(consuming(), "job-x/build/r1", "codex:verifier", 1300);                  // the declared acceptor
    expect(ok.accepted).toBe(true);
    if (!ok.accepted) return;
    expect(ok.closeConsumptionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-cons", resolution: { outcome: "accepted" } });
    expect(ok.registry.envelopes["job-x/build/r1"]).toMatchObject({ phase: "done", acceptedAtSec: 1300 });
    expect(acceptDelegation(ok.registry, "job-x/build/r1", "codex:verifier", 1400).accepted).toBe(false); // already done
  });

  test("receiptMatches: matching round identity + production ⇒ true; wrong id/payload/subject/phase ⇒ false", () => {
    const env = opened().envelopes["job-x/build/r1"];
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(true);
    expect(receiptMatches(env, { requestId: "other", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(false);
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-X", subject: { jobId: "job-x", revision: 1 } })).toBe(false);
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 2 } })).toBe(false);
    expect(receiptMatches(undefined, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x" } })).toBe(false);
    expect(receiptMatches(consuming().envelopes["job-x/build/r1"], { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(false); // not production
  });
});

describe("readDelegations / writeDelegations", () => {
  test("round-trips atomically; missing ⇒ empty; corrupt ⇒ throws (no silent reset)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deleg-"));
    const file = path.join(dir, "delegations.json");
    expect(readDelegations(file)).toEqual({ envelopes: {} });
    writeDelegations(file, opened());
    expect(existsSync(file)).toBe(true);
    expect(readDelegations(file)).toEqual(opened());
    writeFileSync(file, "{ not json");
    expect(() => readDelegations(file)).toThrow();
  });
});
