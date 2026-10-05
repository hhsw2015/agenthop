import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beatStart, beatEnd, type Heartbeat } from "../src/swarm/heartbeat.js";

/** Per-loop heartbeat (cluster-liveness L1 subset): each loop records its OWN tick; one loop freezing must not stop the
 *  other's field from advancing, and the two concurrent loops never clobber each other (synchronous per-loop RMW). */

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "hb-")), "heartbeat.json");
const read = (f: string): Heartbeat => JSON.parse(readFileSync(f, "utf8"));
const meta = { instance: "disp-1", pid: 1234 };

describe("beatStart / beatEnd", () => {
  test("start marks inFlight {step,startedSec}; end advances lastTickSec + clears inFlight", () => {
    const f = file();
    beatStart(f, meta, "pass", "pass+taskPass", 100, "task");
    expect(read(f)).toMatchObject({ instance: "disp-1", pid: 1234, pass: { inFlight: { step: "pass+taskPass", startedSec: 100 }, mode: "task", lastTickSec: null } });
    beatEnd(f, meta, "pass", 150, "task");
    expect(read(f).pass).toMatchObject({ lastTickSec: 150, inFlight: null });
  });

  test("per-loop INDEPENDENCE: a pass write preserves sweep's field (RMW, no clobber)", () => {
    const f = file();
    beatEnd(f, meta, "sweep", 200, "sweep");                    // sweep ticked
    beatStart(f, meta, "pass", "pass+taskPass", 210, "task");   // pass starts
    const hb = read(f);
    expect(hb.sweep.lastTickSec).toBe(200);                     // untouched by the pass write
    expect(hb.pass.inFlight).toMatchObject({ startedSec: 210 });
  });

  test("a FROZEN loop stays in-flight (no end beat) while the other loop advances — the L1 property", () => {
    const f = file();
    beatStart(f, meta, "pass", "pass+taskPass", 300, "task");   // pass starts, never ends (wedged)
    for (const t of [310, 320, 330]) { beatStart(f, meta, "sweep", "sweep", t); beatEnd(f, meta, "sweep", t); }
    const hb = read(f);
    expect(hb.pass.inFlight).toMatchObject({ startedSec: 300 }); // pass wedged — still in-flight from t=300
    expect(hb.pass.lastTickSec).toBeNull();                      // never completed a tick
    expect(hb.sweep.lastTickSec).toBe(330);                      // sweep kept advancing independently
  });

  test("P2: a TRANSIENT read error skips the beat — does NOT clobber the other loop's field", () => {
    const f = file();
    beatEnd(f, meta, "sweep", 200, "sweep"); // sweep has real data on disk
    const throwRead = (): string => { const e = new Error("EIO") as NodeJS.ErrnoException; e.code = "EIO"; throw e; };
    beatStart(f, meta, "pass", "pass+taskPass", 210, "task", throwRead); // read throws a transient (non-ENOENT) error
    const hb = read(f);
    expect(hb.sweep.lastTickSec).toBe(200); // PRESERVED — the transient read did not reset sweep to empty
    expect(hb.pass.inFlight).toBeNull();    // the pass beat was skipped (no clobbering write)
  });

  test("ENOENT is still treated as the first write (not a transient skip)", () => {
    const f = file();
    const enoent = (): string => { const e = new Error("absent") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; };
    beatStart(f, meta, "pass", "pass+taskPass", 100, "task", enoent);
    expect(read(f).pass.inFlight).toMatchObject({ startedSec: 100 }); // initialized
  });
});
