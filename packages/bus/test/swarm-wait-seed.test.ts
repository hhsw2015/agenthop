import { describe, expect, test } from "vitest";
import { validSeedWait } from "../src/swarm/wait-seed.js";
import type { WaitRecord } from "../src/swarm/control-log.js";

/** Seed validation (§0b R2, P2-5/R3): bad entries rejected with a reason; a null entry must NOT throw (it would abort the
 *  import of the following valid entries). */

const good: WaitRecord = { waitId: "w1", kind: "wait", subject: { jobId: "job" }, state: "open", deadlineSec: 1000, owner: "claude:owner", timeoutPolicy: "bypass" };

describe("validSeedWait", () => {
  test("a valid bare WaitRecord passes", () => {
    expect(validSeedWait(good)).toEqual(good);
  });
  test("a valid {put:'wait',wait} wrapper passes (unwrapped)", () => {
    expect(validSeedWait({ put: "wait", wait: good })).toEqual(good);
  });
  test("null entry ⇒ rejected with a reason, NOT a thrown error (R3 — must not abort [null, good])", () => {
    expect(validSeedWait(null)).toBe("entry is not an object");
    // the whole point: a parser over [null, good] can reject null and still accept good
    const entries: unknown[] = [null, good];
    const results = entries.map(validSeedWait);
    expect(typeof results[0]).toBe("string");     // null rejected
    expect(results[1]).toEqual(good);             // good still validated
  });
  test("missing owner ⇒ rejected (the original poison record)", () => {
    const { owner: _o, ...noOwner } = good;
    expect(validSeedWait(noOwner)).toBe("missing/invalid owner");
  });
  test("bad kind / state / timeoutPolicy / deadline / subject each rejected with a reason", () => {
    expect(validSeedWait({ ...good, kind: "frob" })).toContain("bad kind");
    expect(validSeedWait({ ...good, state: "weird" })).toContain("bad state");
    expect(validSeedWait({ ...good, timeoutPolicy: "nope" })).toContain("bad timeoutPolicy");
    expect(validSeedWait({ ...good, deadlineSec: "soon" })).toContain("deadlineSec");
    expect(validSeedWait({ ...good, subject: {} })).toContain("subject.jobId");
    expect(validSeedWait(42)).toBe("entry is not an object");
  });
});
