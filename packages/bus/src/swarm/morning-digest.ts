// Morning digest — pure composition (borrowed from nanoMuse "a feed each morning"; our north-star "verify in the morning").
// A CORE projection generated ONCE from existing state; every entry (console / TG / future PWA) is a delivery END, not a
// generator. Pure: given gathered source lines, roll them into one short brief. The IO (read PROGRESS.md tail / control-log
// deltas / cleared reviews, schedule it) lives in the driver; this only decides the digest TEXT so it is identical everywhere.

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
