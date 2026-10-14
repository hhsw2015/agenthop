/**
 * Projects registry PURE core (dialog-officer M2-a, deliverable ①). The registry `~/.agenthop/projects.json` is Carly's ONLY
 * cross-project view (master-plan §G): project name → { repo, coordinatorSid, resumeCmd, fleetSnapshot, durableRoot }. Carly the
 * switchboard reads it READ-ONLY — "continue project X" ⇒ look up X ⇒ if its coordinator is not alive, wake THAT coordinator (the
 * one action she is allowed; reviving the fleet is the coordinator's fleet-recovery job, never hers). Each project has its own
 * coordinator sid + durable root; Carly is cross-project, coordinators are per-project (coordinator↔project 1:1, §F/§0).
 *
 * This module owns the FROZEN schema + the PURE builder/merge. The IO half (reads env + roster snapshot for known projects,
 * writes projects.json atomically, read-only loader) lives in the `-store` sibling.
 *
 * Invariants:
 *  - DETERMINISTIC: `serializeRegistry` emits projects sorted by name with sorted entry keys, so a regen with equal inputs is
 *    byte-identical (idempotent writes).
 *  - FC-7 ADDITIVE / NON-DESTRUCTIVE MERGE: a regen is a UNION — a freshly generated entry overrides by name, but a project that
 *    already exists and was not regenerated (an incomplete roster snapshot, a manually-seeded project) is PRESERVED, never dropped.
 *  - HONEST: only a COMPLETE entry (non-empty name + repo + coordinatorSid) is admitted; a half-known project is skipped, never
 *    written with blank routing that would misroute a wake.
 *
 * Pure: no fs, no clock, no top-level side effects.
 */

export type ProjectEntry = {
  repo: string;            // the project's git repo path
  coordinatorSid: string;  // THIS project's coordinator stable sid (the wake target; durable-inbox key)
  resumeCmd: string;       // command that revives the coordinator's pane (switchboard wake); "" when unknown
  fleetSnapshot: string;   // path to the project's fleet snapshot (fleet-recovery input); "" when unknown
  durableRoot: string;     // the project's independent durable root; "" ⇒ the legacy shared ~/.agenthop
};

export type ProjectsRegistry = { projects: Record<string, ProjectEntry> };

/** Normalize one raw entry to a complete ProjectEntry (every field a string; missing optionals ⇒ ""). Never throws. */
function normalizeEntry(e: Partial<ProjectEntry>): ProjectEntry {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    repo: str(e.repo),
    coordinatorSid: str(e.coordinatorSid),
    resumeCmd: str(e.resumeCmd),
    fleetSnapshot: str(e.fleetSnapshot),
    durableRoot: str(e.durableRoot),
  };
}

/** An entry is ADMISSIBLE iff the switchboard can actually act on it: a non-empty name AND some way to reach/revive the project's
 *  coordinator — a live `coordinatorSid` to message OR a `resumeCmd` to wake an offline one (the switchboard's whole point is waking
 *  an ABSENT coordinator, so requiring a live sid would be wrong). A name with neither is useless and is skipped (honest). Pure. */
export function isAdmissible(name: string, e: ProjectEntry): boolean {
  return typeof name === "string" && name !== "" && (e.coordinatorSid !== "" || e.resumeCmd !== "");
}

/**
 * Build the registry from freshly generated entries, merged NON-DESTRUCTIVELY over an existing registry (FC-7 union):
 *  - start from `existing` (preserves projects a regen didn't cover — incomplete snapshot / manual seed),
 *  - overlay each admissible generated entry by name (regen wins on conflict),
 *  - drop any entry (existing or generated) that is not admissible — never emit blank routing.
 * Pure + deterministic: the result is a plain object; `serializeRegistry` imposes the byte order.
 */
export function buildProjectsRegistry(
  generated: ReadonlyArray<{ name: string; entry: Partial<ProjectEntry> }>,
  existing: ProjectsRegistry = { projects: {} },
): ProjectsRegistry {
  const out: Record<string, ProjectEntry> = {};
  const existingProjects = existing && existing.projects && typeof existing.projects === "object" ? existing.projects : {};
  for (const [name, raw] of Object.entries(existingProjects)) {
    const e = normalizeEntry(raw as Partial<ProjectEntry>);
    if (isAdmissible(name, e)) out[name] = e;
  }
  for (const g of generated) {
    const e = normalizeEntry(g.entry);
    if (isAdmissible(g.name, e)) out[g.name] = e; // regen overrides by name
  }
  return { projects: out };
}

/** Deterministic JSON: projects sorted by name, each entry's keys in a fixed order. Trailing newline so the file is a clean line.
 *  Equal inputs ⇒ byte-identical output (idempotent write). Pure. */
export function serializeRegistry(reg: ProjectsRegistry): string {
  const names = Object.keys(reg.projects).sort();
  const projects: Record<string, ProjectEntry> = {};
  for (const n of names) {
    const e = reg.projects[n];
    projects[n] = {
      repo: e.repo,
      coordinatorSid: e.coordinatorSid,
      resumeCmd: e.resumeCmd,
      fleetSnapshot: e.fleetSnapshot,
      durableRoot: e.durableRoot,
    };
  }
  return JSON.stringify({ projects }, null, 2) + "\n";
}

/** Parse a registry from disk text, tolerating junk: a non-object / missing `projects` ⇒ empty registry; each entry normalized.
 *  Never throws (a corrupt file degrades to empty, so a regen rebuilds it). Pure. */
export function parseRegistry(text: string): ProjectsRegistry {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { projects: {} }; }
  if (!raw || typeof raw !== "object") return { projects: {} };
  const projectsRaw = (raw as { projects?: unknown }).projects;
  if (!projectsRaw || typeof projectsRaw !== "object") return { projects: {} };
  const out: Record<string, ProjectEntry> = {};
  for (const [name, e] of Object.entries(projectsRaw as Record<string, unknown>)) {
    out[name] = normalizeEntry((e ?? {}) as Partial<ProjectEntry>);
  }
  return { projects: out };
}

/** Read-only lookup: the entry for `name`, or null. Pure (the IO loader reads the file, passes the parsed registry here). */
export function lookupProject(reg: ProjectsRegistry, name: string): ProjectEntry | null {
  return Object.prototype.hasOwnProperty.call(reg.projects, name) ? reg.projects[name] : null;
}
