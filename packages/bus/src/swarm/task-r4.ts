/**
 * Shared R4 gate evaluation (T3; frozen design 60c9ffa7 + risk errata c790ff1d + loader-interface ruling f06894b8) —
 * PURE. Its own module so BOTH the planner (translateDraft, gate insertion) and the loader (loadPlan managed-T3 mode,
 * gate enforcement) use ONE rule set and cannot drift. No dependency on TaskSpec/TaskPlan — it operates on the minimal
 * {nodeId, sourceWriteScope} shape, so task-plan.ts and task-translate.ts can both import it with no cycle.
 *
 * Owner attribution (loader ruling): a SPECIFIC path has exactly one owner = its LONGEST matching prefix (src/io/a.ts
 * under policy src/=core, src/io/=io ⇒ {io}, NOT {core,io}); a BROAD declared scope that is an ANCESTOR of policy
 * prefixes additionally touches every nested domain (src/ ⇒ {core, io}). Frozen/risk use plain bidirectional overlap
 * (an ancestor scope covers a nested frozen/risk subtree, and a nested path is covered by an ancestor prefix).
 *
 * The four-condition OR, MINUS the phased threshold (条件3 超阈值 — notImplemented this batch; its CPA-cost form lands
 * with the ledger): >=2 owner domains (job-level) / frozen-contract write / known-irreversible path / unknown ownership
 * / unknown-risk path. criticalPath is NOT read here: a critical unknown-risk node becomes needsClarification upstream
 * (no plan is produced), so a LOADABLE plan conservatively treats any unknown-risk node as design-required.
 */

export type OwnerDomainPolicy = { version: string; ownerByPrefix: Array<{ prefix: string; domain: string }>; frozenScopePrefixes: string[] };
export type RiskPolicy = { version: string; irreversiblePrefixes: string[]; undecidablePrefixes: string[] };

export const overlaps = (p: string, q: string): boolean => p === q || p.startsWith(q) || q.startsWith(p);
export const overlapsAny = (path: string, prefixes: string[]): boolean => prefixes.some((q) => overlaps(path, q));

/** Owner domains a declared scope path touches: its own LONGEST-prefix owner + any policy prefix strictly NESTED under
 *  it (so a broad scope fans out, a specific path stays single-owner). */
export function domainsTouched(path: string, policy: OwnerDomainPolicy): Set<string> {
  const out = new Set<string>();
  let best: { prefix: string; domain: string } | null = null;
  for (const e of policy.ownerByPrefix) {
    if (path === e.prefix || path.startsWith(e.prefix)) { if (best === null || e.prefix.length > best.prefix.length) best = e; } // path is under e
    else if (e.prefix.startsWith(path)) out.add(e.domain); // e nested strictly under a broad path
  }
  if (best) out.add(best.domain);
  return out;
}

/** Is the path under (or equal to) ANY owner prefix? If not, its own ownership is unmapped — a broad scope spanning
 *  unmapped area is unknown-owner even when it also touches a known NESTED subtree (reviewer seam #1). */
export const pathHasOwner = (path: string, policy: OwnerDomainPolicy): boolean => policy.ownerByPrefix.some((e) => path === e.prefix || path.startsWith(e.prefix));

export type R4NodeInput = { nodeId: string; sourceWriteScope?: string[] };
export type R4Assessment = { designRequired: boolean; reasons: string[]; unknownRiskNodeIds: string[]; unknownOwnerPaths: string[] };

export function evaluateR4(nodes: R4NodeInput[], owner: OwnerDomainPolicy, risk: RiskPolicy): R4Assessment {
  const domains = new Set<string>();
  const unknownOwnerPaths = new Set<string>();
  let frozen = false;
  let irreversible = false;
  let unknownRisk = false;
  const unknownRiskNodeIds: string[] = [];
  for (const n of nodes) {
    let nodeUnknownRisk = false;
    for (const p of n.sourceWriteScope ?? []) {
      for (const d of domainsTouched(p, owner)) domains.add(d);
      // #1: unknown ownership = the path itself is under NO owner prefix (a broad scope over unmapped area counts, even
      // if it also touches a known nested subtree) — not just domainsTouched.size===0.
      if (!pathHasOwner(p, owner)) unknownOwnerPaths.add(p);
      if (overlapsAny(p, owner.frozenScopePrefixes)) frozen = true;
      // #2: irreversible and unknown are INDEPENDENT facts — a broad scope hitting both keeps both (no "known beats
      // unknown" collapse): irreversible -> design (condition 4); unknown -> clarify-if-critical / design-if-not upstream.
      if (overlapsAny(p, risk.irreversiblePrefixes)) irreversible = true;
      if (overlapsAny(p, risk.undecidablePrefixes)) { unknownRisk = true; nodeUnknownRisk = true; }
    }
    if (nodeUnknownRisk) unknownRiskNodeIds.push(n.nodeId);
  }
  const reasons = [
    domains.size >= 2 ? `cross-domain (${[...domains].sort().join(",")})` : "",
    frozen ? "frozen-contract write" : "",
    irreversible ? "irreversible path" : "",
    unknownOwnerPaths.size > 0 ? `unknown ownership (${[...unknownOwnerPaths].sort().join(",")})` : "",
    unknownRisk ? "unknown risk" : "",
  ].filter(Boolean);
  const designRequired = domains.size >= 2 || frozen || irreversible || unknownOwnerPaths.size > 0 || unknownRisk;
  return { designRequired, reasons, unknownRiskNodeIds, unknownOwnerPaths: [...unknownOwnerPaths] };
}
