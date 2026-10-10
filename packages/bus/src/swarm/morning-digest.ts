// Morning digest — pure composition (borrowed from nanoMuse "a feed each morning"; our north-star "verify in the morning").
// A CORE projection generated ONCE from existing state; every entry (console / TG / future PWA) is a delivery END, not a
// generator. Pure: given gathered source lines, roll them into one short brief. The IO (read PROGRESS.md tail / control-log
// deltas / cleared reviews, schedule it) lives in the driver; this only decides the digest TEXT so it is identical everywhere.

import { flagDefaultOn } from "./flag-default.js";

/** Already-gathered, already-user-facing source lines (pointers/summaries, never inlined artifacts — S18). All optional; an
 *  empty digest is a valid "quiet night". */
export type DigestSources = {
  clearedReviews?: readonly string[];   // reviews that reached 0-remain overnight
  shipped?: readonly string[];          // deliverables sent / merged
  pending?: readonly string[];          // still awaiting a verdict / a user decision
  alerts?: readonly string[];           // anything that needs the user's eye (blocked, deadlines)
};

const section = (title: string, lines: readonly string[] | undefined): string[] =>
  lines && lines.length > 0 ? [`${title}:`, ...lines.map((l) => `  - ${l}`)] : [];

/** Compose the morning brief. `dateStr` is the caller's already-formatted local date (pure: no clock/locale here). A night
 *  with nothing to report yields an explicit "quiet night" line, never an empty message. Alerts lead (they need the eye). */
export function composeDigest(sources: DigestSources, dateStr: string): string {
  const body = [
    ...section("needs you", sources.alerts),
    ...section("cleared", sources.clearedReviews),
    ...section("shipped", sources.shipped),
    ...section("still pending", sources.pending),
  ];
  const head = `morning brief — ${dateStr}`;
  return body.length === 0 ? `${head}\n(quiet night — nothing to report)` : [head, ...body].join("\n");
}

export type DigestSection = { title: string; lines: string[] };
export type DigestProjection = { schema: "morning-digest/v1"; date: string; generatedAtSec: number; sections: DigestSection[] };

/** Build the morning-digest PROJECTION (frozen schema morning-digest/v1) from the SAME gathered sources composeDigest renders to
 *  text — ONE generation, structured so every delivery END (console / TG) renders it identically (entry-layer ruling: the
 *  generator never touches an entry). Sections mirror composeDigest's order (alerts lead); an all-empty night yields a single
 *  explicit "quiet night" section, never an empty projection the consumer must special-case. `generatedAtSec` is injected
 *  (floored; non-finite ⇒ 0). Pure. */
export function digestProjection(sources: DigestSources, dateStr: string, generatedAtSec: number): DigestProjection {
  const groups: readonly [string, readonly string[] | undefined][] = [
    ["needs you", sources.alerts],
    ["cleared", sources.clearedReviews],
    ["shipped", sources.shipped],
    ["still pending", sources.pending],
  ];
  const sections: DigestSection[] = [];
  for (const [title, lines] of groups) if (lines && lines.length > 0) sections.push({ title, lines: [...lines] });
  if (sections.length === 0) sections.push({ title: "quiet night", lines: ["nothing to report"] });
  return { schema: "morning-digest/v1", date: dateStr, generatedAtSec: Number.isFinite(generatedAtSec) ? Math.floor(generatedAtSec) : 0, sections };
}

/** morning-digest wiring — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], user ruling 2026-10-10 five-flags): the dispatcher
 *  generates the daily brief unless SWARM_DIGEST is explicitly 0/false/no/off. */
export function digestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_DIGEST);
}

/** Pure daily-trigger throttle: generate today's digest at/after `targetHour` (local), at most ONCE per calendar date. True iff
 *  it is the target hour or later AND today's brief was not already generated (`lastDate` !== `todayStr`). A non-finite hour ⇒
 *  false (no clock ⇒ never spam). The caller SEEDS `lastDate` from the on-disk projection's date so a mid-day restart does not
 *  re-generate the same day's brief (idempotent per date — like the gauge-sampling throttle, but keyed on the calendar date
 *  rather than an elapsed interval). Pure. */
export function shouldGenerateDigest(todayStr: string, hourNow: number, targetHour: number, lastDate: string | null): boolean {
  if (!Number.isFinite(hourNow) || !Number.isFinite(targetHour)) return false;
  if (lastDate === todayStr) return false;
  return hourNow >= targetHour;
}
