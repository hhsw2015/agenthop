/**
 * attribution-chain (pure core) — multica ④ #1 borrow (its internal/attribution, MUL-4302 "accountable-human
 * resolution contract"). Resolve EXACTLY ONE accountable human for a dispatch/task AND the LEVEL of the
 * waterfall at which it resolved — an EXPLAINABLE provenance tag, never an authorization input.
 *
 * Three hard invariants (our C8 / R16 red lines, the same principle multica converges on):
 *   ① accountable = "on behalf of" — a REPRESENTATIVE, not blame.
 *   ② this is a SOURCE tag, TRACEABILITY ONLY: NO permission decision reads accountableHuman. Authorization
 *      stays with the C8 capability (HMAC, mint.ts). Traceability ⊥ authorization — this module exports no
 *      authz function and is never on the cap path.
 *   ③ delegation NEVER escalates privilege (R16): naming an accountable human grants nothing and issues no
 *      credential; it only records whom the chain represents.
 *
 * DORMANT: gated behind SWARM_ATTRIBUTION (default OFF). OFF ⇒ nothing computes or stores it, and it is wired
 * into no live dispatcher. Pure classification only; it reuses existing identity (seat ids / cap originator) and
 * builds no new identity or cap system.
 */

/** The explainable waterfall, highest priority first. The FIRST level that resolves exactly one human wins.
 *  Mirrors multica's resolution ladder. */
export type ResolutionLevel =
  | "direct"            // a human acted directly on the record
  | "delegated"         // resolved via a cross-hop delegation copy carrying the origin human
  | "comment-source"    // resolved via a comment / source chain's root human
  | "automation-owner"  // the owning human of an automation / cron rule that fired it
  | "fallback";         // degraded: no explicit human resolvable ⇒ a configured fallback owner

/** Priority order (index = waterfall rank). The resolution is by this ORDER, never by a clock (FC-6). */
export const RESOLUTION_LEVELS: readonly ResolutionLevel[] = ["direct", "delegated", "comment-source", "automation-owner", "fallback"];

export type Attribution = { accountableHuman: string; resolutionLevel: ResolutionLevel };

/** Provenance signals — one candidate human per level (empty/absent ⇒ that level does not resolve). The caller
 *  gathers these from the record's EXISTING fields / identity; this module only CLASSIFIES. */
export type AttributionInput = {
  directHuman?: string;
  delegationOriginHuman?: string;
  commentSourceHuman?: string;
  automationOwnerHuman?: string;
  fallbackHuman?: string;
};

/** Is the attribution seam armed? Default OFF — only an explicit truthy SWARM_ATTRIBUTION arms it (dormant). */
export function attributionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SWARM_ATTRIBUTION ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

const nonEmpty = (s: string | undefined): s is string => typeof s === "string" && s.trim().length > 0;

/**
 * Resolve EXACTLY ONE accountable human + the level. DETERMINISTIC waterfall by LEVEL PRIORITY — never a
 * timestamp or any clock (FC-6: no latest-wins). Returns null when NO level resolves (not even a fallback):
 * the caller then leaves the record UNATTRIBUTED rather than inventing a human. The result is a SOURCE tag
 * only (invariant ②) — never pass it to an authorization gate.
 */
export function resolveAccountable(input: AttributionInput): Attribution | null {
  const ladder: readonly [ResolutionLevel, string | undefined][] = [
    ["direct", input.directHuman],
    ["delegated", input.delegationOriginHuman],
    ["comment-source", input.commentSourceHuman],
    ["automation-owner", input.automationOwnerHuman],
    ["fallback", input.fallbackHuman],
  ];
  for (const [level, human] of ladder) {
    if (nonEmpty(human)) return { accountableHuman: human.trim(), resolutionLevel: level };
  }
  return null;
}

/** True iff a value is one of the five canonical levels — for ledger read-side tolerance (an unknown level on
 *  a record is ignored, never trusted). */
export function isResolutionLevel(v: unknown): v is ResolutionLevel {
  return typeof v === "string" && (RESOLUTION_LEVELS as readonly string[]).includes(v);
}
