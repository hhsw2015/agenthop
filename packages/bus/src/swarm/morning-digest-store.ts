// Morning-digest IO shell — the driver half of the pure morning-digest core. Gathers the night's already-user-facing source
// lines, writes the frozen morning-digest/v1 projection atomically, and reads back its date to seed the daily throttle across a
// restart. All fail-soft: a read fault yields an empty group (an all-empty gather is a valid "quiet night"); a write fault
// returns false (the caller treats it as a missed day, retried tomorrow). The pure composition lives in morning-digest.ts.

import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { digestProjection, type DigestSources } from "./morning-digest.js";

function digestDir(home: string): string { return path.join(home, ".agenthop", "console", "morning-digest"); }
function digestPath(home: string): string { return path.join(digestDir(home), "digest.json"); }

/** Atomically write the morning-digest projection (schema morning-digest/v1) built from `sources`. tmp + rename so a reader never
 *  sees a half-written file. Returns true on success, false on any write fault. Never throws (fail-soft). */
export function writeDigestProjection(home: string, sources: DigestSources, dateStr: string, generatedAtSec: number): boolean {
  try {
    const dir = digestDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const proj = digestProjection(sources, dateStr, generatedAtSec);
    const file = digestPath(home);
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(proj), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** The `date` of the on-disk projection — seeds the daily throttle so a mid-day restart does not re-generate today's brief.
 *  Returns null when the file is absent / unreadable / not a valid morning-digest/v1 projection. Never throws. */
export function readDigestDate(home: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(digestPath(home), "utf8")) as Record<string, unknown>;
    return raw && raw.schema === "morning-digest/v1" && typeof raw.date === "string" && raw.date.length > 0 ? raw.date : null;
  } catch { return null; }
}

/** Gather the digest sources, best-effort + fail-soft. PROGRESS.md is the coordinator's narrative projection of the control log +
 *  reviews (the three dispatch-named sources converge there), so one BOUNDED tail read classifies the night's bullet lines into
 *  the digest groups by leading marker. Only bullet lines (pointers/summaries, never inlined artifacts — S18) are taken, each
 *  clipped. First-match order (alerts lead) so a line is counted once. A read fault ⇒ every group empty ⇒ a valid quiet night. */
export function gatherDigestSources(home: string, tailLines = 80, perGroup = 8): DigestSources {
  const alerts: string[] = [], clearedReviews: string[] = [], shipped: string[] = [], pending: string[] = [];
  try {
    const all = readFileSync(path.join(home, ".agenthop", "swarm", "PROGRESS.md"), "utf8").split("\n");
    for (const line of all.slice(Math.max(0, all.length - tailLines))) {
      const t = line.trim();
      if (!t.startsWith("- ") && !t.startsWith("* ")) continue; // bullet lines only
      const body = t.slice(2).trim();
      if (body.length === 0) continue;
      const brief = body.length > 160 ? `${body.slice(0, 160)}…` : body;
      if (/⚠|blocked|卡点|卡死|deadline|超时/i.test(body)) { if (alerts.length < perGroup) alerts.push(brief); }
      else if (/✅|签收|cleared|0\s*remain/i.test(body)) { if (clearedReviews.length < perGroup) clearedReviews.push(brief); }
      else if (/已并|merged|交付|装机|\bdone\b/i.test(body)) { if (shipped.length < perGroup) shipped.push(brief); }
      else if (/送审|待签|remain|候|pending|待/i.test(body)) { if (pending.length < perGroup) pending.push(brief); }
    }
  } catch { /* no PROGRESS / unreadable ⇒ quiet night */ }
  return { alerts, clearedReviews, shipped, pending };
}
