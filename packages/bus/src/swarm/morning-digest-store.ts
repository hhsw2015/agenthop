// Morning-digest IO shell — the driver half of the pure morning-digest core. Gathers the night's already-user-facing source
// lines, writes the frozen morning-digest/v1 projection atomically, tracks the coordinator-brief delivery with its OWN durable
// marker (separate obligation from the projection, MD-P2-1), and classifies the four projection read states (MD-P2-4). Fail-soft:
// a source READ ERROR is reported as "unknown" (never a false quiet night, MD-P2-2); the pure composition lives in morning-digest.ts.

import { mkdirSync, writeFileSync, renameSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { digestProjection, type DigestSources, type ProjState, type NotifyState, type DigestProjection } from "./morning-digest.js";
import { listBatchesStrict, readBatch } from "./decision-batch-store.js";
import type { DecisionItem } from "./decision-batch.js";

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

const clip = (s: string, max = 160): string => (s.length > max ? `${s.slice(0, max)}…` : s);

// --- ③ 待你拍板: the AUTHORITATIVE decision-batches store (~/.agenthop/console/decision-batches/<id>/) — NOT the derived console
//     mirror. A missing/closed/failed mirror is not proof of "no pending rulings" (MDV2-1); the store is the source of truth. ----

/** Errno-aware consumed-marker probe: a batch is RULED once its terminal `consumed.json` exists; absent (ENOENT) ⇒ still awaiting;
 *  any other fault ⇒ "unknown" (never read as awaiting-or-ruled — surfaced as an anomaly so a possibly-pending batch is visible). */
function batchConsumed(home: string, batchId: string): "consumed" | "pending" | "unknown" {
  try { lstatSync(path.join(home, ".agenthop", "console", "decision-batches", batchId, "consumed.json")); return "consumed"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "pending" : "unknown"; }
}

/** One awaiting-ruling item line. MDV2-4: clip ONLY the summary text; the hard-gate flag, the suggested action, and a (batch,item)
 *  locating ref are RESERVED and never truncated away — they are exactly what the brief committed to surface. */
function itemLine(batchId: string, it: DecisionItem): string {
  const gate = it.hardGate ? " [hard-gate]" : "";
  const action = it.suggestedAction && it.suggestedAction.length > 0 ? ` → ${it.suggestedAction}` : "";
  const ref = ` (b:${batchId} i:${it.id})`;
  const budget = Math.max(24, 140 - gate.length - action.length - ref.length);
  return `${clip(it.summary, budget)}${gate}${action}${ref}`;
}

/** Gather 待你拍板 from the AUTHORITATIVE decision-batches store (MDV2-1: a missing derived mirror is NOT quiet). A batch awaits a
 *  ruling when batch.json is present (listBatchesStrict) AND consumed.json is absent. Scans EVERY batch — the `perGroup` cap limits
 *  OUTPUT only, never the scan (MDV2-2): a later corrupt batch stays visible and the overflow count is reported. Each batch is read
 *  through the canonical `readBatch` (full schema validation); a malformed batch or an unreadable consumed-state is surfaced as a
 *  VISIBLE anomaly (MDV2-3), never silently dropped or mis-rendered as a normal item. Returns null ONLY when the store dir cannot be
 *  enumerated (listBatchesStrict throws ⇒ unknown, never a false quiet night). ENOENT ⇒ [] = a CONFIRMED-empty store (authoritative,
 *  so a genuine quiet). */
function gatherDecisions(home: string, perGroup: number): { rulings: string[]; anomalies: string[]; overflow: number } | null {
  let ids: string[];
  try { ids = listBatchesStrict(home); } // ENOENT ⇒ []; a read fault PROPAGATES (throws)
  catch { return null; }                 // MDV2-1: cannot enumerate the authoritative store ⇒ unknown
  const rulings: string[] = [], anomalies: string[] = [];
  let pending = 0;
  for (const id of [...ids].sort()) {
    const state = batchConsumed(home, id);
    if (state === "consumed") continue;
    if (state === "unknown") { anomalies.push(clip(`决策批 ${id} 消费状态不可读 — 可能待你拍板`)); continue; }
    let batch;
    try { batch = readBatch(home, id); } // canonical validation (MDV2-3); unsafe id / read fault ⇒ throw/null below
    catch { batch = null; }
    if (batch === null) { anomalies.push(clip(`决策批 ${id} 不可读/损坏 — 待你拍板可能漏项`)); continue; }
    for (const it of batch.items) { pending++; if (rulings.length < perGroup) rulings.push(itemLine(id, it)); } // MDV2-2: scan never stops at the cap
  }
  return { rulings, anomalies, overflow: Math.max(0, pending - perGroup) };
}

// --- ①④② from the PROGRESS narrative tail: STATE + EVIDENCE based, not bare keywords (MDV2-5). -------------------------------------
const COMPLETION_RE = /✅|已签收|已并|已合并|\bmerged\b|装机|\blanded\b/i; // an explicit sign-off / landing marker (NOT bare "0 remain")
const NEGATION_RE   = /\bnot\b|未|尚未|即[将合并装]|即可|若|回滚|\brevert\b|撤销|放弃/i; // negation / conditional ⇒ NOT a completion fact
const INFLIGHT_RE   = /待复审|待审|送审|候审|候签|待签|\bpending\b|[1-9]\d*\s*remain/i;   // inter-agent in-flight review ⇒ DROP (⑤)
const ANOMALY_RE    = /⚠|\bblocked\b|卡点|卡死|卡住|超时|deadline|失联|中断|异常|\bstuck\b/i; // a real anomaly STATE (NOT the word 哨兵/sentinel)
const AWAITTEST_RE  = /待验收|待实测|待你测|待实机|待自测|待体验|needs?-?test/i;            // landed, awaiting the user's own real-test
/** A VERIFIABLE commit token: a 7-40 hex run containing a hex LETTER (so a bare decimal date like "20261011" is not mistaken for a sha). */
const hasSha = (s: string): boolean => (s.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).some((t) => /[a-f]/i.test(t));

/** Gather the digest sources as an ACCEPTANCE BRIEFING (验收简报化), fail-soft.
 *  ③ 待你拍板 — the AUTHORITATIVE decision-batches store (gatherDecisions), not a grep.
 *  ①④② — the PROGRESS.md narrative tail, bucketed by STATE + EVIDENCE (MDV2-5): 完成 needs a completion marker AND a verifiable SHA
 *        AND no negation/conditional AND is not in-flight; 异常 needs a real anomaly STATE word (not the bare word 哨兵/sentinel, which
 *        mis-bucketed a completion); 待你验收 is an explicit user-test marker. 待你拍板 NEVER comes from a PROGRESS 待裁 grep. A line
 *        matching none — including inter-agent in-flight review (待复审/送审) and bare chatter — is DROPPED (⑤).
 *  Returns null on a READ ERROR (MD-P2-2 / MDV2-1: UNKNOWN, never a false quiet night): the decisions store cannot be enumerated, or
 *  PROGRESS is unreadable. ENOENT of either ⇒ that source contributes nothing (a CONFIRMED-empty authoritative store is a real quiet). */
export function gatherDigestSources(home: string, tailLines = 80, perGroup = 8): DigestSources | null {
  const dec = gatherDecisions(home, perGroup);
  if (dec === null) return null; // MDV2-1: cannot enumerate the authoritative rulings store ⇒ unknown
  const awaitingRuling = [...dec.rulings];
  if (dec.overflow > 0) awaitingRuling.push(`+${dec.overflow} 更多待你拍板未显示 — 见 ~/.agenthop/console/decision-batches/`); // MDV2-2: overflow is visible
  let raw: string;
  try { raw = readFileSync(path.join(home, ".agenthop", "swarm", "PROGRESS.md"), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { awaitingRuling, anomalies: dec.anomalies, awaitingTest: [], recentDone: [] };
    return null; // PROGRESS read fault ⇒ unknown
  }
  const anomalies: string[] = [...dec.anomalies], awaitingTest: string[] = [], recentDone: string[] = [];
  for (const line of raw.split("\n").slice(-tailLines)) {
    const t = line.trim();
    if (!t.startsWith("- ") && !t.startsWith("* ")) continue; // bullet lines only (pointers, S18)
    const body = t.slice(2).trim();
    if (body.length === 0) continue;
    const brief = clip(body);
    // ① 完成(签收/落地) FIRST: a completion marker + a verifiable SHA + no negation/conditional + not in-flight. Checked before 异常
    //    so "✅ 哨兵修复已并 @<sha> 0 REMAIN" reads as a completion, not an anomaly (the 哨兵 word no longer mis-buckets it).
    if (COMPLETION_RE.test(body) && hasSha(body) && !NEGATION_RE.test(body) && !INFLIGHT_RE.test(body)) { if (recentDone.length < perGroup) recentDone.push(brief); }
    else if (ANOMALY_RE.test(body)) { if (anomalies.length < perGroup) anomalies.push(brief); }                 // ④ 异常 (real state)
    else if (AWAITTEST_RE.test(body) && !NEGATION_RE.test(body)) { if (awaitingTest.length < perGroup) awaitingTest.push(brief); } // ② 待你验收
    // ⑤ else (incl. in-flight review 待复审/送审, a no-SHA completion, bare chatter) ⇒ DROPPED.
  }
  return { awaitingRuling, anomalies, awaitingTest, recentDone };
}
