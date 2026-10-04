import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDelegation, observeCandidate, acceptDelegation, receiptMatches,
  readDelegations, writeDelegations, emptyDelegationRegistry,
  type CompletionSlot, type OpenSpec,
} from "../src/swarm/delegation-envelope.js";

/** L2-struct sub-increment 1 (cluster-liveness §2b/§2c): the managed-delegation envelope + dual-custody lifecycle —
 *  request → production → (completion-slot verified) → consumption → accepted, matched on the ROUND identity (requestId). */

const slot = (over: Partial<CompletionSlot> = {}): CompletionSlot => ({ locator: "out/r/job-x/build/result.json", targetDigest: "sha-abc", resultFormat: "report", acceptor: "codex:verifier", ...over });
const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 }, completionSlot: slot(), owner: "rw-1", productionDeadlineSec: 5000, ...over });

describe("openDelegation", () => {
  test("new request ⇒ envelope (phase=production) + a production-wait spec", () => {
    const r = openDelegation(emptyDelegationRegistry(), spec(), 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({ requestId: "job-x/build/r1", payloadDigest: "pd-1", phase: "production", productionWaitId: "deleg-job-x%2Fbuild%2Fr1-prod", openedAtSec: 1000 });
    expect(r.openProductionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-prod", jobId: "job-x", owner: "rw-1", deadlineSec: 5000, requestId: "job-x/build/r1" });
    expect(r.registry.envelopes["job-x/build/r1"]!.phase).toBe("production");
  });

  test("idempotent on the SAME (requestId, payloadDigest) — no new wait (replay-safe)", () => {
    const first = openDelegation(emptyDelegationRegistry(), spec(), 1000);
    expect(first.ok).toBe(true); if (!first.ok) return;
    const again = openDelegation(first.registry, spec(), 1100);
    expect(again.ok).toBe(true); if (!again.ok) return;
    expect(again.openProductionWait).toBeUndefined();          // not re-opened
    expect(again.registry).toBe(first.registry);                // unchanged
  });

  test("same requestId with a DIFFERENT payloadDigest ⇒ CONFLICT (never overwritten, §2b)", () => {
    const first = openDelegation(emptyDelegationRegistry(), spec(), 1000);
    expect(first.ok).toBe(true); if (!first.ok) return;
    const clash = openDelegation(first.registry, spec({ payloadDigest: "pd-2" }), 1100);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toMatch(/conflict/);
  });

  test("missing requestId / payloadDigest ⇒ rejected", () => {
    expect(openDelegation(emptyDelegationRegistry(), spec({ requestId: "" }), 1000).ok).toBe(false);
    expect(openDelegation(emptyDelegationRegistry(), spec({ payloadDigest: "" }), 1000).ok).toBe(false);
  });
});

describe("observeCandidate — completion-slot verification + production→consumption", () => {
  const opened = () => { const r = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!r.ok) throw new Error("open"); return r.registry; };

  test("a candidate matching locator + targetDigest ⇒ close production + open consumption (owner=acceptor)", () => {
    const r = observeCandidate(opened(), { requestId: "job-x/build/r1", observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc" }, 1200, 1100);
    expect(r.verified).toBe(true);
    if (!r.verified) return;
    expect(r.closeProductionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-prod", resolution: { outcome: "produced" } });
    expect(r.openConsumptionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-cons", owner: "codex:verifier", deadlineSec: 1200, requestId: "job-x/build/r1" });
    expect(r.registry.envelopes["job-x/build/r1"]).toMatchObject({ phase: "consumption", consumptionWaitId: "deleg-job-x%2Fbuild%2Fr1-cons", producedAtSec: 1100 });
  });

  test("a WRONG target digest (stale round / wrong SHA / half-write) does NOT verify — closes nothing", () => {
    const r = observeCandidate(opened(), { requestId: "job-x/build/r1", observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-STALE" }, 1200, 1100);
    expect(r.verified).toBe(false);
    if (!r.verified) expect(r.reason).toMatch(/target digest mismatch/);
  });

  test("a locator mismatch does NOT verify; an unknown requestId does NOT verify; a non-production phase does NOT re-verify", () => {
    expect(observeCandidate(opened(), { requestId: "job-x/build/r1", observedLocator: "elsewhere", observedDigest: "sha-abc" }, 1200, 1100).verified).toBe(false);
    expect(observeCandidate(opened(), { requestId: "nope", observedLocator: "x", observedDigest: "y" }, 1200, 1100).verified).toBe(false);
    const prod = observeCandidate(opened(), { requestId: "job-x/build/r1", observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc" }, 1200, 1100);
    if (!prod.verified) throw new Error("expected verified");
    expect(observeCandidate(prod.registry, { requestId: "job-x/build/r1", observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc" }, 1300, 1200).verified).toBe(false); // already consumption
  });
});

describe("acceptDelegation + receiptMatches", () => {
  const consuming = () => {
    const o = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!o.ok) throw new Error("open");
    const p = observeCandidate(o.registry, { requestId: "job-x/build/r1", observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc" }, 1200, 1100);
    if (!p.verified) throw new Error("produce"); return p.registry;
  };

  test("accept in consumption ⇒ done + close consumption wait; accept in a non-consumption phase ⇒ rejected", () => {
    const r = acceptDelegation(consuming(), "job-x/build/r1", "codex:verifier", 1300);
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.closeConsumptionWait).toMatchObject({ waitId: "deleg-job-x%2Fbuild%2Fr1-cons", resolution: { outcome: "accepted" } });
    expect(r.registry.envelopes["job-x/build/r1"]).toMatchObject({ phase: "done", acceptedAtSec: 1300 });
    expect(acceptDelegation(r.registry, "job-x/build/r1", "x", 1400).accepted).toBe(false); // already done
  });

  test("receiptMatches: matching round identity + production ⇒ true; wrong id/payload/subject/phase ⇒ false", () => {
    const o = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!o.ok) throw new Error("open");
    const env = o.registry.envelopes["job-x/build/r1"];
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(true);
    expect(receiptMatches(env, { requestId: "other", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(false);
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-X", subject: { jobId: "job-x", revision: 1 } })).toBe(false);
    expect(receiptMatches(env, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 2 } })).toBe(false); // epoch mismatch
    expect(receiptMatches(undefined, { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x" } })).toBe(false); // no envelope ⇒ "请走信封"
    expect(receiptMatches(consuming().envelopes["job-x/build/r1"], { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } })).toBe(false); // not production
  });
});

describe("readDelegations / writeDelegations", () => {
  test("round-trips atomically; missing ⇒ empty; corrupt ⇒ throws (no silent reset)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deleg-"));
    const file = path.join(dir, "delegations.json");
    expect(readDelegations(file)).toEqual({ envelopes: {} });
    const o = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!o.ok) throw new Error("open");
    writeDelegations(file, o.registry);
    expect(existsSync(file)).toBe(true);
    expect(readDelegations(file)).toEqual(o.registry);
    writeFileSync(file, "{ not json");
    expect(() => readDelegations(file)).toThrow();
  });
});
