// Morning-digest IO shell — the driver half of the pure morning-digest core. Gathers the night's already-user-facing source
// lines, writes the frozen morning-digest/v1 projection atomically, tracks the coordinator-brief delivery with its OWN durable
// marker (separate obligation from the projection, MD-P2-1), and classifies the four projection read states (MD-P2-4). Fail-soft:
// a source READ ERROR is reported as "unknown" (never a false quiet night, MD-P2-2); the pure composition lives in morning-digest.ts.

import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { digestProjection, type DigestSources, type ProjState, type NotifyState } from "./morning-digest.js";

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

/** MD-P2-4 — classify the on-disk projection into its FOUR distinct states: only a COMPLETE valid projection (schema + non-empty
 *  date + finite generatedAtSec + a well-formed sections array) proves today's generation. ENOENT ⇒ "absent"; a parse/shape
 *  failure ⇒ "corrupt" (repairable by an idempotent rewrite); any other read error ⇒ "unknown" (can't tell — must not be treated
 *  as "never generated"). Never throws. */
export function readDigestProjection(home: string): ProjState {
  let raw: string;
  try { raw = readFileSync(digestPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { kind: "corrupt" }; }
  if (!isObj(parsed)) return { kind: "corrupt" };
  if (parsed.schema !== "morning-digest/v1" || typeof parsed.date !== "string" || parsed.date.length === 0) return { kind: "corrupt" };
  if (typeof parsed.generatedAtSec !== "number" || !Number.isFinite(parsed.generatedAtSec)) return { kind: "corrupt" };
  if (!Array.isArray(parsed.sections)) return { kind: "corrupt" };
  for (const s of parsed.sections) {
    if (!isObj(s) || typeof s.title !== "string" || !Array.isArray(s.lines) || s.lines.some((l) => typeof l !== "string")) return { kind: "corrupt" };
  }
  return { kind: "valid", date: parsed.date };
}

/** MD-P2-1 — read the coordinator-brief delivery marker (separate obligation from the projection). "notified" (confirmed for a
 *  date), "none" (absent — not yet), "unknown" (a read error — don't risk a double-send). Never throws. */
export function readNotifiedState(home: string): NotifyState {
  let raw: string;
  try { raw = readFileSync(notifiedPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unknown" }; }
  try { const o = JSON.parse(raw) as Record<string, unknown>; return typeof o.date === "string" && o.date.length > 0 ? { kind: "notified", date: o.date } : { kind: "none" }; }
  catch { return { kind: "none" }; } // corrupt marker ⇒ treat as not-notified (a re-send is deduped by notifyCoordinator)
}

/** MD-P2-1 — record a CONFIRMED coordinator-brief delivery for `dateStr`, so a restart does not re-send today's brief. Returns
 *  true on success; a write fault leaves the obligation open for a later retry. Never throws. */
export function markNotified(home: string, dateStr: string): boolean {
  return atomicWriteJson(notifiedPath(home), { date: dateStr });
}

/** Gather the digest sources, fail-soft. PROGRESS.md is the coordinator's narrative projection of the control log + reviews (the
 *  three dispatch-named sources converge there), so one BOUNDED tail read classifies the night's bullet lines by marker. Returns
 *  null on a READ ERROR other than ENOENT (MD-P2-2: an unreadable source is UNKNOWN — the caller must not publish a false quiet
 *  night); ENOENT (no PROGRESS yet) ⇒ a genuinely empty gather (a valid quiet night). Classification is NEGATION-AWARE
 *  (MD-P2-3): pending/awaiting markers (待签 / 尚未 / 未签 / 送审 / 待复审 / 待审 / a NON-zero REMAIN) are matched BEFORE the
 *  cleared markers, so "待签收 … 2 REMAIN" and "尚未签收 … 待复审" stay pending. Only bullet lines (pointers, S18), each clipped. */
export function gatherDigestSources(home: string, tailLines = 80, perGroup = 8): DigestSources | null {
  let raw: string;
  try { raw = readFileSync(path.join(home, ".agenthop", "swarm", "PROGRESS.md"), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { alerts: [], clearedReviews: [], shipped: [], pending: [] } : null; }
  const alerts: string[] = [], clearedReviews: string[] = [], shipped: string[] = [], pending: string[] = [];
  const all = raw.split("\n");
  const pendingRe = /待签|待复审|待审|尚未|未签|送审|候审|候签|\bpending\b|[1-9]\d*\s*remain/i; // NON-zero remain + awaiting forms
  for (const line of all.slice(Math.max(0, all.length - tailLines))) {
    const t = line.trim();
    if (!t.startsWith("- ") && !t.startsWith("* ")) continue; // bullet lines only
    const body = t.slice(2).trim();
    if (body.length === 0) continue;
    const brief = body.length > 160 ? `${body.slice(0, 160)}…` : body;
    if (/⚠|blocked|卡点|卡死|deadline|超时/i.test(body)) { if (alerts.length < perGroup) alerts.push(brief); }
    else if (pendingRe.test(body)) { if (pending.length < perGroup) pending.push(brief); } // PENDING before cleared (MD-P2-3)
    else if (/✅|cleared|已签收|签收|\b0\s*remain\b/i.test(body)) { if (clearedReviews.length < perGroup) clearedReviews.push(brief); }
    else if (/已并|merged|交付|装机|\bdone\b/i.test(body)) { if (shipped.length < perGroup) shipped.push(brief); }
  }
  return { alerts, clearedReviews, shipped, pending };
}
