// Morning-digest IO shell — the driver half of the pure morning-digest core. Gathers the night's already-user-facing source
// lines, writes the frozen morning-digest/v1 projection atomically, tracks the coordinator-brief delivery with its OWN durable
// marker (separate obligation from the projection, MD-P2-1), and classifies the four projection read states (MD-P2-4). Fail-soft:
// a source READ ERROR is reported as "unknown" (never a false quiet night, MD-P2-2); the pure composition lives in morning-digest.ts.

import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { digestProjection, type DigestSources, type ProjState, type NotifyState, type DigestProjection } from "./morning-digest.js";

function digestDir(home: string): string { return path.join(home, ".agenthop", "console", "morning-digest"); }
function digestPath(home: string): string { return path.join(digestDir(home), "digest.json"); }
function notifiedPath(home: string): string { return path.join(digestDir(home), "notified.json"); }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function atomicWriteJson(file: string, value: unknown): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** Atomically write the morning-digest projection (schema morning-digest/v1). Returns true on success, false on any write fault
 *  (the caller leaves the obligation unmet and retries). Never throws. */
export function writeDigestProjection(home: string, sources: DigestSources, dateStr: string, generatedAtSec: number): boolean {
  return atomicWriteJson(digestPath(home), digestProjection(sources, dateStr, generatedAtSec));
}

/** Validate a parsed value as a COMPLETE morning-digest/v1 projection (schema + non-empty date + finite generatedAtSec + a
 *  well-formed sections array of {title, lines:string[]}). Returns the normalized projection or null. Pure. */
function parseProjection(parsed: unknown): DigestProjection | null {
  if (!isObj(parsed)) return null;
  if (parsed.schema !== "morning-digest/v1" || typeof parsed.date !== "string" || parsed.date.length === 0) return null;
  if (typeof parsed.generatedAtSec !== "number" || !Number.isFinite(parsed.generatedAtSec)) return null;
  if (!Array.isArray(parsed.sections)) return null;
  const sections: { title: string; lines: string[] }[] = [];
  for (const s of parsed.sections) {
    if (!isObj(s) || typeof s.title !== "string" || !Array.isArray(s.lines) || s.lines.some((l) => typeof l !== "string")) return null;
    sections.push({ title: s.title, lines: s.lines as string[] });
  }
  return { schema: "morning-digest/v1", date: parsed.date, generatedAtSec: parsed.generatedAtSec, sections };
}

/** MD-P2-4 — classify the on-disk projection into FOUR distinct states: a COMPLETE valid projection proves today's generation
 *  (and carries the frozen body); ENOENT ⇒ "absent"; a parse/shape failure ⇒ "corrupt" (carrier damaged); any other read error ⇒
 *  "unknown" (can't tell — must not be treated as "never generated"). Never throws. */
export function readDigestProjection(home: string): ProjState {
  let raw: string;
  try { raw = readFileSync(digestPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { kind: "corrupt" }; }
  const projection = parseProjection(parsed);
  return projection ? { kind: "valid", date: projection.date, projection } : { kind: "corrupt" };
}

/** MD-R2-P2-1 — atomically (over)write a READY projection. Used to RESTORE a corrupt carrier from the frozen body kept in the
 *  notify marker — the SAME published content, never a re-gather. Returns true on success. Never throws. */
export function writeDigestProjectionRaw(home: string, projection: DigestProjection): boolean {
  return atomicWriteJson(digestPath(home), projection);
}

/** MD-P2-1 — read the two-phase coordinator-brief marker. "sent" / "pending" carry today's FROZEN body (the MD-R2-P2-1 restore
 *  source). A LEGACY date-only record (no `state`, FC-7) is read as "pending" — NEVER guessed "sent" (that would lose an un-sent
 *  r3 claim); the inbox idempotency key makes continuing it safe (a re-send overwrites, never duplicates). A read error / corrupt
 *  JSON / missing date ⇒ "unknown" (must not prove not-sent). Never throws. */
export function readNotifiedState(home: string): NotifyState {
  let raw: string;
  try { raw = readFileSync(notifiedPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unknown" }; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { kind: "unknown" }; } // MD-P2-1: a corrupt marker must NOT prove "not sent" ⇒ unknown
  if (!isObj(o) || typeof o.date !== "string" || o.date.length === 0) return { kind: "unknown" };
  const body = parseProjection(o.body) ?? undefined;
  if (o.state === "sent") return { kind: "sent", date: o.date, ...(body ? { body } : {}) };     // CONFIRMED ⇒ never re-send
  if (o.state === "pending") return { kind: "pending", date: o.date, ...(body ? { body } : {}) }; // unfinished ⇒ CONTINUE
  return { kind: "pending", date: o.date }; // FC-7 legacy date-only: re-send-eligible (idempotency-key-safe), never guessed "sent"
}

/** MD-P2-1 — write the two-phase delivery marker, carrying the FROZEN body (the MD-R2-P2-1 restore source). "pending" is CLAIMED
 *  before the send; "sent" is written only AFTER a confirmed delivery. Returns false on a write fault — the caller must NOT send
 *  on a failed "pending" claim (retry next tick). Never throws. */
export function markNotified(home: string, dateStr: string, state: "pending" | "sent", body: DigestProjection): boolean {
  return atomicWriteJson(notifiedPath(home), { date: dateStr, state, body });
}

/** MD-R7-P2-2 — durably ARCHIVE a legacy (pre-credential, date-only) notify marker before the daily `notified.json` is overwritten
 *  by a newer day, so its un-migrated obligation is not silently discharged. One file PER DATE under `needs-migration/` (append-only:
 *  an existing record is NEVER modified), so the old evidence only ever grows. The date is sanitized to one safe path segment and
 *  also stored verbatim in the body. Returns true if the record is durably present (newly written OR already archived); false on a
 *  write fault — the caller must then NOT overwrite the marker (keep the old record recoverable, retry). Never throws. */
export function archiveLegacyMigration(home: string, dateStr: string): boolean {
  const safe = dateStr.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown-date";
  const file = path.join(digestDir(home), "needs-migration", `${safe}.json`);
  if (existsSync(file)) return true; // append-only: an archived migration record is never modified
  return atomicWriteJson(file, { schema: "morning-digest-migration/v1", date: dateStr, archivedAtSec: Math.floor(Date.now() / 1000), reason: "legacy date-only notify marker superseded by a newer day; pre-credential delivery is unconfirmable — migrate manually, never auto-resend" });
}

const clip = (s: string): string => (s.length > 160 ? `${s.slice(0, 160)}…` : s);

// --- ③ 待你拍板: the authoritative console decisions mirror (console-decisions/v1) — a STRUCTURED source, not a PROGRESS grep. ----
const DECISIONS_SCHEMA = "console-decisions/v1";

/** Minimal fail-soft guard: pull the awaiting-ruling item lines from one console-decisions/v1 mirror (schema + batch.items[] with a
 *  non-empty summary). Returns null if the file is not a well-formed mirror — the caller surfaces that as an ANOMALY (a corrupt
 *  ruling batch must be VISIBLE, never silently dropped: a missed ruling is the worst failure for an acceptance brief). Pure. */
function mirrorItemLines(parsed: unknown): string[] | null {
  if (!isObj(parsed) || parsed.schema !== DECISIONS_SCHEMA || !isObj(parsed.batch)) return null;
  const items = (parsed.batch as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  const out: string[] = [];
  for (const it of items) {
    if (!isObj(it) || typeof it.summary !== "string" || it.summary.length === 0) return null;
    const action = typeof it.suggestedAction === "string" && it.suggestedAction.length > 0 ? ` → ${it.suggestedAction}` : "";
    const gate = it.hardGate === true ? " [hard-gate]" : "";
    out.push(`${it.summary}${gate}${action}`);
  }
  return out;
}

/** Gather 待你拍板 + any corrupt-batch anomalies from the console decisions dir. Returns null ONLY when the dir EXISTS but cannot be
 *  enumerated (a read fault ⇒ unknown, MD-P2-2 — cannot assert "no rulings pending"). ENOENT ⇒ the line is not producing yet ⇒
 *  empty. A single unreadable/corrupt batch FILE is surfaced as an anomaly (visible, non-blocking), never silently dropped. */
function gatherDecisions(home: string, perGroup: number): { rulings: string[]; anomalies: string[] } | null {
  const dir = path.join(home, ".agenthop", "swarm", "console", "decisions");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { rulings: [], anomalies: [] } : null; }
  const rulings: string[] = [], anomalies: string[] = [];
  for (const n of names) {
    if (rulings.length >= perGroup) break;
    let lines: string[] | null;
    try { lines = mirrorItemLines(JSON.parse(readFileSync(path.join(dir, n), "utf8"))); }
    catch { lines = null; } // a read/parse fault on one batch
    if (lines === null) { if (anomalies.length < perGroup) anomalies.push(clip(`决策批 ${n.replace(/\.json$/, "")} 不可读/损坏 — 待你拍板可能漏项`)); continue; }
    for (const l of lines) { if (rulings.length >= perGroup) break; rulings.push(clip(l)); }
  }
  return { rulings, anomalies };
}

/** Gather the digest sources as an ACCEPTANCE BRIEFING (验收简报化), fail-soft. Two source classes:
 *  ③ 待你拍板 — the AUTHORITATIVE console decisions mirror (structured read, not a grep).
 *  ①④② — the PROGRESS.md narrative tail (the control-log + reviews converge there; the idle-explainer schema is not frozen yet, so
 *        its anomalies ride the ⚠/卡/哨兵 markers for now — 先接可得源). Each tail bullet is bucketed into exactly ONE acceptance
 *        category; a line matching NONE is DROPPED (⑤ pure running-log noise — incl. inter-agent in-flight review like 待复审/送审,
 *        which is not a USER acceptance item). 待你拍板 comes ONLY from the structured mirror, never from a PROGRESS 待裁 grep.
 *  Returns null on a READ ERROR other than ENOENT (MD-P2-2: an unreadable source is UNKNOWN — never a false quiet night): a
 *  decisions-dir enumerate fault, or a PROGRESS read fault. ENOENT of either ⇒ that source simply contributes nothing. */
export function gatherDigestSources(home: string, tailLines = 80, perGroup = 8): DigestSources | null {
  const dec = gatherDecisions(home, perGroup);
  if (dec === null) return null; // MD-P2-2: cannot enumerate the authoritative rulings source ⇒ unknown
  let raw: string;
  try { raw = readFileSync(path.join(home, ".agenthop", "swarm", "PROGRESS.md"), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { awaitingRuling: dec.rulings, anomalies: dec.anomalies, awaitingTest: [], doneOvernight: [] };
    return null; // PROGRESS read fault ⇒ unknown
  }
  const anomalies: string[] = [...dec.anomalies], awaitingTest: string[] = [], doneOvernight: string[] = [];
  // In-flight markers (待X / 尚未 / 未签 / 送审 / a NON-zero REMAIN): a line carrying one is NOT "done" — keeps "待签收 … 2 REMAIN"
  // out of 昨夜完成 (MD-P2-3 negation-awareness). Such inter-agent in-flight review is not a user acceptance item ⇒ it DROPS (⑤).
  const inflightRe = /待|尚未|未签|送审|候审|候签|\bpending\b|[1-9]\d*\s*remain/i;
  for (const line of raw.split("\n").slice(-tailLines)) {
    const t = line.trim();
    if (!t.startsWith("- ") && !t.startsWith("* ")) continue; // bullet lines only (pointers, S18)
    const body = t.slice(2).trim();
    if (body.length === 0) continue;
    const brief = clip(body);
    if (/⚠|blocked|卡点|卡死|卡住|deadline|超时|哨兵|sentinel|异常/i.test(body)) { if (anomalies.length < perGroup) anomalies.push(brief); }                       // ④ 异常
    else if (/待验收|待实测|待你测|待实机|待自测|待体验|needs?-?test/i.test(body)) { if (awaitingTest.length < perGroup) awaitingTest.push(brief); }                // ② 待你验收 (user real-test)
    else if (/✅|已签收|已并|merged|装机|landed|\b0\s*remain\b/i.test(body) && !inflightRe.test(body)) { if (doneOvernight.length < perGroup) doneOvernight.push(brief); } // ① 昨夜完成 (sign-off/landed; the SHA rides the line)
    // ⑤ else: pure running-log noise ⇒ DROPPED.
  }
  return { awaitingRuling: dec.rulings, anomalies, awaitingTest, doneOvernight };
}
