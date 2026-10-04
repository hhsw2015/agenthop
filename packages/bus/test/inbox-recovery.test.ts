import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// F28 P2-4 recovery branches (review bb6dad5). Both faults are mid-syscall and can't be reproduced by FS state alone, so
// node:fs is seamed by FILENAME SENTINEL — a pure passthrough except two cases, so every other test here is on real fs:
//   • linkSync throws ENOENT when the target includes "FORCE_ENOENT"  (A: ENOENT with the source still present)
//   • renameSync throws EACCES when RELEASING (.claim-* -> .json) a file whose name includes "FORCE_RELEASE_FAIL" (B)
// The claim rename (.json -> .claim-*) is left real, so claiming always succeeds and only the release/link under test fails.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    linkSync: (src: string, dest: string, ...rest: unknown[]) => {
      if (String(dest).includes("FORCE_ENOENT")) { const e = new Error("mock ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; }
      return (real.linkSync as (...a: unknown[]) => void)(src, dest, ...rest);
    },
    renameSync: (from: string, to: string, ...rest: unknown[]) => {
      if (String(from).includes(".claim-") && String(to).endsWith(".json") && String(to).includes("FORCE_RELEASE_FAIL")) {
        const e = new Error("mock EACCES") as NodeJS.ErrnoException; e.code = "EACCES"; throw e;
      }
      return (real.renameSync as (...a: unknown[]) => void)(from, to, ...rest);
    },
  };
});

// Imported AFTER the mock so inbox.ts binds the seamed node:fs.
const { claimInbox, quarantineInbox, retryStuckPoison } = await import("../src/inbox.js");

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-inbox-rec-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const inboxDirOf = (key: string) => path.join(HOME, ".agenthop", "inbox", key);
const writeRaw = (key: string, name: string, content: string): void => { const d = inboxDirOf(key); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, name), content); };

describe("F28 P2-4: ENOENT is not conflated with a vanished source (A)", () => {
  test("quarantineInbox: link fails ENOENT but the source is PRESENT ⇒ 'failed' (not 'vanished') — the caller must release", () => {
    const d = inboxDirOf("s1"); mkdirSync(d, { recursive: true });
    const f = path.join(d, "poison-FORCE_ENOENT.json.claim-1"); // a live-pid claim the mock makes link-ENOENT on
    writeFileSync(f, JSON.stringify({ text: "no-from", via: "local", ts: 1 }));
    expect(quarantineInbox(HOME, f, "schema/parse")).toBe("failed"); // source still in hand ⇒ recoverable, NOT vanished
    expect(existsSync(f)).toBe(true);                                 // bytes preserved in place for the release/retry
  });

  test("claimInbox: an ENOENT-with-source-present poison is RELEASED back to .json (recoverable), never stranded as .claim-<live-pid>", () => {
    writeRaw("s1", "0000000000001000-FORCE_ENOENT.json", JSON.stringify({ text: "no-from", via: "local", ts: 1000 })); // missing from
    const stuck = new Set<string>();
    expect(claimInbox(HOME, ["s1"], "p", stuck).length).toBe(0); // poison ⇒ not delivered
    const names = readdirSync(inboxDirOf("s1"));
    expect(names).toContain("0000000000001000-FORCE_ENOENT.json");      // RELEASED to .json (the "failed" branch releases)
    expect(names.some((n) => n.includes(".claim-"))).toBe(false);       // NOT misclassified "vanished" and left as .claim-<live-pid>
    expect(stuck.size).toBe(0);                                          // release succeeded ⇒ no stuck obligation
  });
});

describe("F28 P2-4: a release failure leaves a recoverable obligation (B)", () => {
  test("claimInbox records a poison it could neither quarantine NOR release; retryStuckPoison discharges it once the fault clears", () => {
    writeRaw("s1", "0000000000001000-FORCE_RELEASE_FAIL.json", JSON.stringify({ text: "no-from", via: "local", ts: 1000 })); // poison
    writeFileSync(path.join(inboxDirOf("s1"), "quarantine"), "blocker"); // a FILE at quarantine/ ⇒ mkdir(quarantine) fails ⇒ quarantine "failed"
    const stuck = new Set<string>();

    expect(claimInbox(HOME, ["s1"], "p", stuck).length).toBe(0); // quarantine failed + release failed (mock) ⇒ no delivery, no throw
    expect(stuck.size).toBe(1);                                  // the double-failure is RECORDED, not swallowed (the P2-4-B gap)
    const names0 = readdirSync(inboxDirOf("s1"));
    expect(names0.some((n) => n.includes(".claim-"))).toBe(true); // still a .claim-<live-pid> — recoverStaleClaims won't free it

    rmSync(path.join(inboxDirOf("s1"), "quarantine")); // the FS fault clears (quarantine/ is now creatable)
    retryStuckPoison(HOME, stuck);                      // the flush timer's retry

    expect(stuck.size).toBe(0);                                                                  // obligation discharged
    expect(readdirSync(path.join(inboxDirOf("s1"), "quarantine")).length).toBe(1);               // the poison is finally quarantined
    expect(readdirSync(inboxDirOf("s1")).some((n) => n.includes(".claim-"))).toBe(false);        // no stranded live-pid claim left
  });
});
