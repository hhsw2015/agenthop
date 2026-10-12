// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/morning-digest-store.selftest.mts
// PROJ-2 (infra audit): the digest write face (digest.json / notified.json / needs-migration) was missing the console-projection
// symlink boundary門. Pins digestBoundaryOk + the atomicWriteJson CP-3 refusal across all write entry points, with the 3 zero-bug
// fixture classes (crash-recovery / restart-idempotency / concurrency-race), each asserting an OBSERVABLE TERMINAL STATE.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestBoundaryOk, writeDigestProjectionRaw, readDigestProjection, markNotified, readNotifiedState } from "./morning-digest-store.js";
import type { DigestProjection } from "./morning-digest.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "proj2-digest-selftest-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const consoleDir = (h: string) => path.join(h, ".agenthop", "console");
const digestDir = (h: string) => path.join(consoleDir(h), "morning-digest");
const proj = (date: string): DigestProjection => ({ schema: "morning-digest/v1", date, generatedAtSec: 1000, sections: [{ title: "T", lines: ["a"] }] });

try {
  // ── digestBoundaryOk: the pure boundary decision ────────────────────────────────────────────────────────────────
  t("boundaryOk: ENOENT chain -> true", digestBoundaryOk(freshHome()) === true);
  { const h = freshHome(); mkdirSync(digestDir(h), { recursive: true }); t("boundaryOk: real dir chain -> true", digestBoundaryOk(h) === true); }
  { const h = freshHome(); mkdirSync(consoleDir(h), { recursive: true }); symlinkSync(mkdtempSync(path.join(scratch, "e-")), digestDir(h)); t("boundaryOk: symlinked morning-digest -> false", digestBoundaryOk(h) === false); }
  { const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true }); symlinkSync(mkdtempSync(path.join(scratch, "e-")), consoleDir(h)); t("boundaryOk: symlinked console -> false", digestBoundaryOk(h) === false); }

  // ── normal write round-trip ─────────────────────────────────────────────────────────────────────────────────────
  {
    const h = freshHome();
    t("write: writeDigestProjectionRaw true + reads valid", writeDigestProjectionRaw(h, proj("2026-10-12")) === true && readDigestProjection(h).kind === "valid");
    t("write: markNotified true + reads sent", markNotified(h, "2026-10-12", "sent", proj("2026-10-12")) === true && readNotifiedState(h).kind === "sent");
  }

  // ── FIXTURE 1: crash-recovery (leftover .tmp never blocks/corrupts a later write) ────────────────────────────────
  {
    const h = freshHome(); mkdirSync(digestDir(h), { recursive: true });
    writeFileSync(path.join(digestDir(h), "digest.json.tmp-deadbeef"), "{partial");
    t("fixture[crash]: good write after crash-leftover reads valid", writeDigestProjectionRaw(h, proj("2026-10-12")) === true && readDigestProjection(h).kind === "valid");
  }

  // ── FIXTURE 2: restart-idempotency (re-write last-wins + valid; notified marker consistent) ──────────────────────
  {
    const h = freshHome();
    writeDigestProjectionRaw(h, proj("2026-10-11"));
    writeDigestProjectionRaw(h, proj("2026-10-12"));
    const s = readDigestProjection(h);
    t("fixture[idem]: digest re-write last-wins + valid", s.kind === "valid" && s.date === "2026-10-12");
    markNotified(h, "2026-10-12", "pending", proj("2026-10-12"));
    markNotified(h, "2026-10-12", "sent", proj("2026-10-12"));
    const n = readNotifiedState(h);
    t("fixture[idem]: notified marker last-wins (sent)", n.kind === "sent" && n.date === "2026-10-12");
  }

  // ── FIXTURE 3: concurrency-race (interleaved writes read complete; CP-3 REFUSES + no escape) ─────────────────────
  {
    const h = freshHome();
    for (let i = 0; i < 15; i++) {
      writeDigestProjectionRaw(h, proj(`2026-10-${10 + (i % 20)}`));
      if (readDigestProjection(h).kind !== "valid") throw new Error("FAILED: fixture[race] read saw a torn digest");
    }
    t("fixture[race]: interleaved writes always read valid", readDigestProjection(h).kind === "valid");
  }
  {
    // CP-3 OBSERVABLE TERMINAL STATE: a symlinked digest dir ⇒ write REFUSED (returns false) ⇒ nothing escapes to the target.
    const h = freshHome(); mkdirSync(consoleDir(h), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-escape-"));
    symlinkSync(ext, digestDir(h));
    const wrote = writeDigestProjectionRaw(h, proj("2026-10-12"));
    t("fixture[race]: CP-3 refuses symlinked digest dir (returns false)", wrote === false);
    t("fixture[race]: CP-3 — NO escape write at the target (digest.json)", !existsSync(path.join(ext, "digest.json")));
    const noted = markNotified(h, "2026-10-12", "sent", proj("2026-10-12"));
    t("fixture[race]: CP-3 refuses markNotified too (false) + NO escape (notified.json)", noted === false && !existsSync(path.join(ext, "notified.json")));
  }

  // ── IP2-1: the READ side must refuse a redirected path — never trust a FOREIGN projection / sent marker as this home's proof ────
  {
    const h = freshHome(); mkdirSync(consoleDir(h), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-read-"));
    // digestDir(home) = console/morning-digest is symlinked to ext, so the getters read ext/digest.json + ext/notified.json directly
    // (place the FOREIGN files AT ext/, not ext/morning-digest/, so the layout genuinely puts them in the getter's read path).
    writeFileSync(path.join(ext, "digest.json"), JSON.stringify(proj("2026-10-12"))); // a FOREIGN valid projection
    writeFileSync(path.join(ext, "notified.json"), JSON.stringify({ date: "2026-10-12", state: "sent", body: proj("2026-10-12") })); // a FOREIGN sent marker
    symlinkSync(ext, digestDir(h)); // console/morning-digest -> ext (redirect)
    t("IP2-1: readDigestProjection through a redirect ⇒ unknown (not foreign 'valid')", readDigestProjection(h).kind === "unknown");
    t("IP2-1: readNotifiedState through a redirect ⇒ unknown (not foreign 'sent' — never suppresses this home's digest)", readNotifiedState(h).kind === "unknown");
  }

  console.log("\nPROJ-2 morning-digest-store selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
