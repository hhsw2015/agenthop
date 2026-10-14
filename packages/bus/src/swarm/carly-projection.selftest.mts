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

// ---- DS-PROJ-SOURCE: a CORRUPT (undecodable) non-consumed batch ⇒ uncertain ⇒ keep the good queue, never clear to (none) ----
{
  const home = tmpHome();
  const b = openBatch(home, { owner: "coord", nowSec: 1, items: [{ id: "keep1", kind: "k", summary: "keep this ruling", suggestedAction: "approve" }] });
  runCarlyProjection(home);
  const good = read(heartbeatFile(home));
  t("DS-PROJ-SOURCE: good queue established", good.includes("keep1"));
  // corrupt the still-enumerated batch.json (bad JSON ⇒ readBatch null, not consumed)
  writeFileSync(path.join(home, ".agenthop", "console", "decision-batches", b.batchId, "batch.json"), "{ corrupt not json");
  const st = readCarlyStatus(home);
  t("DS-PROJ-SOURCE: corrupt non-consumed batch ⇒ certain=false", st.certain === false);
  const r = runCarlyProjection(home);
  t("DS-PROJ-SOURCE: sweep SKIPS + good queue preserved (not cleared to none)", r.wrote === false && read(heartbeatFile(home)) === good);
}
// ---- DS-PROJ-MARKER: orphan BEGIN AND orphan END must not break the match / accumulate / break idempotency ----
{
  const home = tmpHome();
  mkdirSync(path.dirname(heartbeatFile(home)), { recursive: true });
  const her = "# her notes\n\n<!-- swarm begin -->\nstale dangling line (no end)\n\nmore of her text\n";
  writeFileSync(heartbeatFile(home), her);
  writeManagedFile(heartbeatFile(home), "BODY1");
  const after1 = read(heartbeatFile(home));
  writeManagedFile(heartbeatFile(home), "BODY1"); // same body ⇒ byte-idempotent, must not eat her text
  t("DS-PROJ-MARKER: orphan BEGIN + her text preserved + 2nd write idempotent", read(heartbeatFile(home)) === after1 && after1.includes("stale dangling line") && after1.includes("more of her text"));
}
{
  // orphan END leading the file: three generations must NOT accumulate three blocks, and a body update must REPLACE the old content.
  const home = tmpHome();
  mkdirSync(path.dirname(heartbeatFile(home)), { recursive: true });
  const her = "her text <!-- swarm end --> a stray end, no begin\n";
  writeFileSync(heartbeatFile(home), her);
  writeManagedFile(heartbeatFile(home), "OLD-ASK");
  writeManagedFile(heartbeatFile(home), "OLD-ASK"); // same ⇒ idempotent, not a 2nd block
  const after2 = read(heartbeatFile(home));
  t("DS-PROJ-MARKER: orphan END ⇒ exactly ONE block, idempotent (no accumulation)", (after2.split(SWARM_BEGIN).length - 1) === 1 && (after2.match(/OLD-ASK/g) || []).length === 1);
  writeManagedFile(heartbeatFile(home), "NEW-ASK"); // body update
  const after3 = read(heartbeatFile(home));
  t("DS-PROJ-MARKER: body update REPLACES old managed content (not appended)", after3.includes("NEW-ASK") && !after3.includes("OLD-ASK") && after3.startsWith("her text <!-- swarm end -->"));
}
// ---- DS-PROJ-MARKER r4: a BYTE-0 orphan BEGIN (no END) must RETURN (no infinite loop), preserve her bytes, stay idempotent ----
{
  // pure: the minimal reproducer — must return, not hang (lastIndexOf(BEGIN,-1) clamps to 0 ⇒ old loop spun forever).
  const minimal = SWARM_BEGIN + "\npartial"; // first byte is an orphan BEGIN, whole file has no END
  const out = spliceManagedBlock(minimal, wrapManagedBlock("X"));
  t("DS-PROJ-MARKER r4: byte-0 orphan BEGIN ⇒ splice returns (append) + 'partial' kept", out.includes("partial") && out.includes(wrapManagedBlock("X")));
  // store path: write twice (idempotent) then update body (replace) — all must terminate.
  const home = tmpHome();
  mkdirSync(path.dirname(heartbeatFile(home)), { recursive: true });
  writeFileSync(heartbeatFile(home), minimal);
  writeManagedFile(heartbeatFile(home), "B1");
  const a1 = read(heartbeatFile(home));
  writeManagedFile(heartbeatFile(home), "B1");
  t("DS-PROJ-MARKER r4: byte-0 orphan BEGIN ⇒ idempotent + her 'partial' preserved", read(heartbeatFile(home)) === a1 && a1.includes("partial") && a1.startsWith(SWARM_BEGIN + "\npartial"));
  writeManagedFile(heartbeatFile(home), "B2");
  const a2 = read(heartbeatFile(home));
  t("DS-PROJ-MARKER r4: byte-0 orphan BEGIN ⇒ body update REPLACES (B2 in, B1 out)", a2.includes("B2") && !a2.includes("B1") && a2.includes("partial"));
}
// ---- DS-PROJ-CONFLICT: holder-identity lock — a LIVE/unknown holder HOLDs (never stolen); a DEAD (ESRCH) holder is reclaimed ----
{
  const home = tmpHome();
  writeCarlyProjection(home, FULL);
  const good = read(heartbeatFile(home));
  const lockDir = heartbeatFile(home) + ".lockd";
  // a LIVE/unknown holder: pid 1 (init) probes EPERM, not ESRCH ⇒ not reclaimable ⇒ contend ⇒ HOLD
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "1.deadbeef"), "");
  const skipped = writeManagedFile(heartbeatFile(home), "SHOULD-NOT-LAND");
  t("DS-PROJ-CONFLICT: a live/unknown holder ⇒ write HOLDs (false) + file untouched (never stolen)", skipped === false && read(heartbeatFile(home)) === good);
  try { execSync(`rm -rf ${JSON.stringify(lockDir)}`); } catch { /* */ }
  // a DEAD holder (ESRCH pid) ⇒ reclaimed ⇒ write proceeds. Guard: only if the chosen pid really is ESRCH on this host.
  let deadPid = 999999; let isDead = false;
  try { process.kill(deadPid, 0); } catch (e) { isDead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
  if (isDead) {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, `${deadPid}.deadbeef`), "");
    const wrote = writeManagedFile(heartbeatFile(home), "NOWLANDS");
    t("DS-PROJ-CONFLICT: a DEAD (ESRCH) holder ⇒ reclaimed ⇒ write proceeds", wrote === true && read(heartbeatFile(home)).includes("NOWLANDS"));
  } else {
    console.log("skip - DS-PROJ-CONFLICT dead-reclaim (pid 999999 not ESRCH here)");
  }
  // a clean write leaves no lock residue (ownership-safe release)
  const w = writeManagedFile(heartbeatFile(home), "CLEAN");
  let residue = true; try { execSync(`test -e ${JSON.stringify(lockDir)}`); } catch { residue = false; }
  t("DS-PROJ-CONFLICT: clean write releases the lock (no lockdir residue)", w === true && residue === false);
}

console.log("all carly-projection selftests passed");
