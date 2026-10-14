/**
 * carly-projection selftest (tsx-run). Covers deliverable ③:
 *  - pure: buildHeartbeatBody FROZEN 4-field schema (id | deadlineISO | waitingFor | ask), honest-empty "(none)", order kept,
 *    a `|` in data substituted (always 4 fields), a newline in data flattened (can't inject a marker).
 *  - pure: buildMemoryBody alerts + one-line digest, honest-empty.
 *  - pure: spliceManagedBlock DUAL-WRITE isolation — replace between markers / append when absent / don't destroy a half-marker.
 *  - store 3-fixture law: idempotent byte-same rerun / her bytes preserved / concurrent-style second write = one complete file /
 *    a corrupt pre-existing file cleanly re-spliced.
 *  - MEMORY.md carries the usage note (④) incl. the relay-verbatim line, inside the managed region.
 *
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/carly-projection.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  SWARM_BEGIN,
  SWARM_END,
  buildHeartbeatBody,
  buildMemoryBody,
  wrapManagedBlock,
  spliceManagedBlock,
  type CarlyStatus,
  type HeartbeatEntry,
} from "./carly-projection.js";
import {
  writeManagedFile,
  writeCarlyProjection,
  heartbeatFile,
  memoryFile,
  CARLY_USAGE_NOTE,
  readCarlyStatus,
  runCarlyProjection,
} from "./carly-projection-store.js";
import { openBatch } from "./decision-batch-store.js";
import { writeDigestProjection } from "./morning-digest-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "carly-"));
const read = (f: string) => readFileSync(f, "utf8");

const E1: HeartbeatEntry = { id: "R21", deadlineISO: "2026-10-15T00:00:00Z", waitingFor: "user", ask: "merge batch-21?" };
const E2: HeartbeatEntry = { id: "R22", deadlineISO: "", waitingFor: "codex:Work", ask: "flip SWARM_DIALOG_OFFICER?" };
const FULL: CarlyStatus = { heartbeat: [E1, E2], alerts: ["seat codex:Work idle 20m (blocked on input)"], digest: "3 merged, 1 in review" };
const EMPTY: CarlyStatus = { heartbeat: [], alerts: [], digest: null };

// ---- pure: HEARTBEAT frozen 4-field schema ----
{
  t("heartbeat empty ⇒ '(none)' (no pipes ⇒ zero entries to her scan)", buildHeartbeatBody([]) === "(none)");
  const body = buildHeartbeatBody([E1, E2]);
  const lines = body.split("\n");
  t("heartbeat: one line per entry, order kept", lines.length === 2 && lines[0].startsWith("R21 |") && lines[1].startsWith("R22 |"));
  t("heartbeat: exactly 4 pipe-fields per line", lines.every((l) => l.split(" | ").length === 4));
  t("heartbeat: missing deadline ⇒ '-'", lines[1].split(" | ")[1] === "-");
  t("heartbeat: fields are id|deadline|who|ask", lines[0] === "R21 | 2026-10-15T00:00:00Z | user | merge batch-21?");
}
// a `|` or newline in data must not create extra fields / lines
{
  const evil: HeartbeatEntry = { id: "X", deadlineISO: "-", waitingFor: "user", ask: "do a | b\nand " + SWARM_END };
  const line = buildHeartbeatBody([evil]);
  t("heartbeat: a '|' in data is substituted ⇒ still exactly 4 fields", line.split(" | ").length === 4);
  t("heartbeat: a newline/end-marker in data is flattened ⇒ one line, no second marker", !line.includes("\n") && !line.includes(SWARM_END));
}

// ---- pure: MEMORY body ----
{
  t("memory empty ⇒ alerts + digest both '(none)'", (buildMemoryBody(EMPTY).match(/\(none\)/g) || []).length === 2);
  const m = buildMemoryBody(FULL);
  t("memory data ⇒ alert + digest rendered", m.includes("seat codex:Work idle 20m") && m.includes("3 merged, 1 in review"));
}

// ---- pure: splice isolation ----
{
  const her = "# Carly's notes\n\nmy own stuff\n";
  const appended = spliceManagedBlock(her, wrapManagedBlock("BODY"));
  t("splice: no markers ⇒ append, her bytes verbatim", appended.startsWith(her) && appended.includes(wrapManagedBlock("BODY")));
  const replaced = spliceManagedBlock(appended, wrapManagedBlock("BODY2"));
  t("splice: existing block replaced in place, her bytes preserved", replaced.startsWith(her) && replaced.includes("BODY2") && !replaced.includes("BODY\n" + SWARM_END));
  t("splice: idempotent on a current block", spliceManagedBlock(replaced, wrapManagedBlock("BODY2")) === replaced);
  const half = "before\n" + SWARM_BEGIN + "\ndangling\n";
  const out = spliceManagedBlock(half, wrapManagedBlock("B"));
  t("splice: lone BEGIN (corrupt) ⇒ append, her text not destroyed", out.startsWith(half) && out.includes(wrapManagedBlock("B")));
}

// ---- store 3-fixture ----
{
  const home = tmpHome();
  writeCarlyProjection(home, FULL);
  const hb1 = read(heartbeatFile(home)), mem1 = read(memoryFile(home));
  writeCarlyProjection(home, FULL);
  t("3-fixture[idempotent]: rerun byte-identical (HEARTBEAT + MEMORY)", read(heartbeatFile(home)) === hb1 && read(memoryFile(home)) === mem1);
  t("HEARTBEAT carries the 4-field queue", hb1.includes("R21 | 2026-10-15T00:00:00Z | user | merge batch-21?"));
  t("MEMORY carries usage note (④) incl. the relay-verbatim line", mem1.includes(CARLY_USAGE_NOTE) && mem1.includes("VERBATIM") && mem1.includes(SWARM_BEGIN));
}
{
  const home = tmpHome();
  mkdirSync(path.dirname(heartbeatFile(home)), { recursive: true });
  const herHeader = "# My heartbeat\n\nI like this file.\n";
  writeFileSync(heartbeatFile(home), herHeader);
  writeCarlyProjection(home, FULL);
  const after = read(heartbeatFile(home));
  t("3-fixture[isolation]: her pre-existing bytes preserved before the block", after.startsWith(herHeader) && after.includes(SWARM_BEGIN));
}
{
  const home = tmpHome();
  writeCarlyProjection(home, FULL);
  writeCarlyProjection(home, EMPTY);
  const hb = read(heartbeatFile(home));
  t("3-fixture[concurrent]: final = one complete block (latest), no stale remnants",
    (hb.split(SWARM_BEGIN).length - 1) === 1 && (hb.split(SWARM_END).length - 1) === 1 && hb.includes("(none)") && !hb.includes("R21"));
}
{
  const home = tmpHome();
  mkdirSync(path.dirname(heartbeatFile(home)), { recursive: true });
  writeFileSync(heartbeatFile(home), "GARBAGE PARTIAL " + SWARM_BEGIN + " no end");
  writeManagedFile(heartbeatFile(home), "CLEAN");
  t("3-fixture[half-write]: a corrupt half-marked file ⇒ clean complete block appended", read(heartbeatFile(home)).includes(wrapManagedBlock("CLEAN")));
}

// ---- live-source adapter (readCarlyStatus / runCarlyProjection) ----
{
  // empty home ⇒ readable, certain, honest-empty
  const home = tmpHome();
  const r = runCarlyProjection(home);
  t("live: empty home ⇒ wrote (certain, honest-empty)", r.wrote === true);
  t("live: empty ⇒ HEARTBEAT (none)", read(heartbeatFile(home)).includes("(none)"));

  // seed an awaiting decision batch ⇒ HEARTBEAT entries
  openBatch(home, { owner: "coord", nowSec: 1, items: [
    { id: "d1", kind: "merge", summary: "merge batch-21?", suggestedAction: "approve" },
    { id: "d2", kind: "flip", summary: "flip flag?", suggestedAction: "hold" },
  ] });
  const st = readCarlyStatus(home);
  t("live: awaiting batch items ⇒ heartbeat entries (certain)", st.certain && st.status.heartbeat.length === 2 && st.status.heartbeat.some((h) => h.ask === "merge batch-21?" && h.waitingFor === "user"));

  // seed an idle-explainer anomaly ⇒ alert
  mkdirSync(path.join(home, ".agenthop", "swarm", "console"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "swarm", "console", "idle-explainer.json"), JSON.stringify({ anomaly: true, reason: "all idle but 3 unclaimed inboxes" }));
  // seed a digest ⇒ one-line digest
  writeDigestProjection(home, { awaitingRuling: ["x", "y"], anomalies: [] }, "2026-10-14", 1);
  const st2 = readCarlyStatus(home);
  t("live: idle-explainer anomaly ⇒ alert", st2.status.alerts.some((a) => a.includes("unclaimed inboxes")));
  t("live: digest projection ⇒ one-line digest", typeof st2.status.digest === "string" && st2.status.digest.length > 0);

  // the full projection writes both files with the real content
  runCarlyProjection(home);
  t("live: HEARTBEAT carries a real 4-field entry", read(heartbeatFile(home)).includes("d1 | - | user | merge batch-21?"));
  t("live: MEMORY carries the alert", read(memoryFile(home)).includes("unclaimed inboxes"));
}
{
  // FC-2: an unreadable decision-batches dir ⇒ uncertain ⇒ SKIP the write (keep her last-good files)
  const NOTROOT = (process.getuid?.() ?? 1) !== 0;
  if (NOTROOT) {
    const home = tmpHome();
    runCarlyProjection(home); // establish a good HEARTBEAT first
    const good = read(heartbeatFile(home));
    const dbDir = path.join(home, ".agenthop", "console", "decision-batches");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(path.join(dbDir, "batch-x"), "not a dir entry"); // make a file so the dir is non-empty
    execSync(`chmod 000 ${JSON.stringify(dbDir)}`);
    const r = runCarlyProjection(home);
    execSync(`chmod 755 ${JSON.stringify(dbDir)}`); // restore for cleanup
    t("live FC-2: unreadable decision dir ⇒ skip write, last-good HEARTBEAT untouched", r.wrote === false && r.reason === "source-uncertain" && read(heartbeatFile(home)) === good);
  } else {
    console.log("skip - live FC-2 unreadable dir (root)");
  }
}

console.log("all carly-projection selftests passed");
