import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordLearn, recordSelfObserve, readIdentityLog, buildProjection, whois, type SelfLike } from "../src/bus-identity.js";

/**
 * Batch-B recording-hook EFFECT (Codex review P2-1/P2-2/P2-3): the sequence core.ts now emits must make whois resolve the
 * published identity. Drives the REAL bus-identity feed/fold/whois (not core's closure — that wiring is integration-verified
 * by the reviewer's core probes); this pins the sequence's outcome so a regression in WHAT we record is caught here.
 */

const home = (): string => mkdtempSync(path.join(tmpdir(), "idhooks-"));
const self = (id: string, stableId: string, title: string): SelfLike => ({ id, stableId, title, tool: "codex", cwd: "/w", pid: process.pid });
const proj = (h: string) => { const r = readIdentityLog(h); return buildProjection(r.events, r.corruption); };

describe("batch-B hooks → whois resolution", () => {
  test("P2-1: a guess for the SAME id confirmed authoritative becomes hard-resolvable (native + handle)", () => {
    const h = home();
    // guess bootstrap (authoritative=false): native is only `possible`
    recordLearn(h, "run-1", undefined, "N-A", "bootstrap", false);
    recordSelfObserve(h, self("run-1", "N-A", "codex:Work-N-A"), false, "local");
    expect(whois(proj(h), "N-A").kind).not.toBe("entity"); // a pure guess does not determinately resolve

    // the SAME id is now confirmed authoritative — the P2-1 upgrade records a correction + a HARD observe
    recordLearn(h, "run-1", undefined, "N-A", "correction", true);
    recordSelfObserve(h, self("run-1", "N-A", "codex:Work-N-A"), true, "local");
    expect(whois(proj(h), "N-A").kind).toBe("entity");           // native now hard
    expect(whois(proj(h), "codex:Work-N-A").kind).toBe("entity"); // handle resolves too
  });

  test("P2-2: after a bootstrap learn + self-observe, the published HANDLE resolves (not only the native)", () => {
    const h = home();
    recordLearn(h, "run-2", undefined, "N-B", "bootstrap", true);
    recordSelfObserve(h, self("run-2", "N-B", "codex:Work-N-B"), true, "local"); // the P2-2 observe records the handle (derivedFrom native)
    expect(whois(proj(h), "N-B").kind).toBe("entity");
    expect(whois(proj(h), "codex:Work-N-B").kind).toBe("entity"); // a wait.owner stored as this handle can now get probeTargets
  });

  test("P2-3 premise: two sessions sharing a handle ⇒ whois candidates (the ambiguity doAction must withhold on)", () => {
    const h = home();
    recordSelfObserve(h, self("run-x", "N-X", "codex:Work-dup"), true, "local");
    recordSelfObserve(h, self("run-y", "N-Y", "codex:Work-dup"), true, "local");
    expect(whois(proj(h), "codex:Work-dup").kind).toBe("candidates"); // ambiguous ⇒ sweep withholds delivery (no misroute)
    // the distinct natives still resolve uniquely
    expect(whois(proj(h), "N-X").kind).toBe("entity");
    expect(whois(proj(h), "N-Y").kind).toBe("entity");
  });
});
