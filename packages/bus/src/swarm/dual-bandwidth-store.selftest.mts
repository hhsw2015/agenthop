// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/dual-bandwidth-store.selftest.mts
// PROJ-1 (infra audit): the gauge write face was missing the console-projection symlink boundary門. Pins gaugeBoundaryOk +
// writeBandwidthProjection's CP-3 refusal, with the 3 zero-bug fixture classes (crash-recovery / restart-idempotency /
// concurrency-race), each asserting an OBSERVABLE TERMINAL STATE (what is / isn't on disk after the call).
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gaugeBoundaryOk, writeBandwidthProjection, readBandwidthProjection } from "./dual-bandwidth-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "proj1-gauge-selftest-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const consoleDir = (h: string) => path.join(h, ".agenthop", "console");
const gaugeDir = (h: string) => path.join(consoleDir(h), "bandwidth-gauge");
const gaugeFile = (h: string) => path.join(gaugeDir(h), "gauge.json");

try {
  // ── gaugeBoundaryOk: the pure boundary decision ─────────────────────────────────────────────────────────────────
  t("boundaryOk: ENOENT chain (nothing created yet) -> true (our mkdir makes real dirs)", gaugeBoundaryOk(freshHome()) === true);
  {
    const h = freshHome(); mkdirSync(gaugeDir(h), { recursive: true });
    t("boundaryOk: real dir chain -> true", gaugeBoundaryOk(h) === true);
  }
  {
    const h = freshHome(); mkdirSync(consoleDir(h), { recursive: true });
    symlinkSync(mkdtempSync(path.join(scratch, "ext-")), gaugeDir(h));
    t("boundaryOk: symlinked bandwidth-gauge -> false", gaugeBoundaryOk(h) === false);
  }
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    symlinkSync(mkdtempSync(path.join(scratch, "ext-")), consoleDir(h));
    t("boundaryOk: symlinked console -> false", gaugeBoundaryOk(h) === false);
  }

  // ── normal write round-trip (no boundary violation) ─────────────────────────────────────────────────────────────
  {
    const h = freshHome();
    writeBandwidthProjection(h, 1000);
    t("write: round-trips a valid gauge projection", readBandwidthProjection(h) !== null && existsSync(gaugeFile(h)));
  }

  // ── FIXTURE 1: crash-recovery (a crashed write's leftover .tmp never blocks or corrupts a later write) ───────────
  {
    const h = freshHome(); mkdirSync(gaugeDir(h), { recursive: true });
    writeFileSync(path.join(gaugeDir(h), "gauge.json.tmp-deadbeef"), "{partial"); // crashed writer's orphan
    writeBandwidthProjection(h, 2000);
    t("fixture[crash]: good write after a crash-leftover reads cleanly", readBandwidthProjection(h) !== null);
  }

  // ── FIXTURE 2: restart-idempotency (re-write is last-wins + always a complete valid file) ───────────────────────
  {
    const h = freshHome();
    writeBandwidthProjection(h, 3000);
    writeBandwidthProjection(h, 3001); // a second sampling pass
    t("fixture[idem]: re-write stays valid (no torn merge)", readBandwidthProjection(h) !== null);
  }

  // ── FIXTURE 3: concurrency-race (interleaved writes always read complete; CP-3 refuses a redirected dir) ─────────
  {
    const h = freshHome();
    for (let i = 0; i < 15; i++) {
      writeBandwidthProjection(h, 4000 + i);
      if (readBandwidthProjection(h) === null) throw new Error("FAILED: fixture[race] read saw a torn gauge");
    }
    t("fixture[race]: interleaved writes always read complete + valid", readBandwidthProjection(h) !== null);
  }
  {
    // CP-3 OBSERVABLE TERMINAL STATE: a symlinked gauge dir ⇒ the write is REFUSED ⇒ the external target is NOT written through.
    const h = freshHome(); mkdirSync(consoleDir(h), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-escape-"));
    symlinkSync(ext, gaugeDir(h));
    writeBandwidthProjection(h, 5000);
    t("fixture[race]: CP-3 refuses symlinked gauge dir — NO escape write at the target", !existsSync(path.join(ext, "gauge.json")));
  }
  {
    // CP-3 at the console level too: nothing escapes.
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-escape2-"));
    symlinkSync(ext, consoleDir(h));
    writeBandwidthProjection(h, 6000);
    t("fixture[race]: CP-3 refuses symlinked console — NO escape write", !existsSync(path.join(ext, "bandwidth-gauge", "gauge.json")) && !existsSync(path.join(ext, "gauge.json")));
  }

  console.log("\nPROJ-1 dual-bandwidth-store selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
