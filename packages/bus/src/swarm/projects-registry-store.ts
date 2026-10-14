/**
 * Projects registry IO (dialog-officer M2-a, deliverable ① — the store half of projects-registry.ts). Maintains
 * `~/.agenthop/projects.json`: the SWARM generates it (from the roster snapshot + env), Carly reads it READ-ONLY. The pure
 * assembly (`assembleProjectEntries`) is unit-tested with fake facts; `generateRegistry` is the thin IO wrapper.
 *
 * Data-preservation discipline:
 *  - DS-REG-READ: the generate base distinguishes ENOENT (genuinely absent ⇒ initialize) from an UNKNOWN read/parse (EACCES /
 *    corrupt ⇒ HOLD, keep the old file, report unavailable) — a transient read fault must NEVER collapse to "empty" and overwrite
 *    offline-project wake info the live roster can't rebuild.
 *  - DS-REG-ROSTER: when the coordinator roster member cannot be LOCATED (presence resolvable ≠ roster complete), no entry is
 *    generated — the existing entry (with its repo/resumeCmd) is preserved by the union, never overwritten with blanks.
 *  - DS-TEMP-OWN: the write creates its temp EXCLUSIVELY (wx) and only cleans up a temp it owns.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import {
  type ProjectsRegistry,
  type ProjectEntry,
  serializeRegistry,
  buildProjectsRegistry,
  lookupProject,
  parseRegistry,
} from "./projects-registry.js";
import { readRosterMembers } from "./shell-succession.js";
import { resolveSession, listSessions } from "./task-liveness.js";
import type { RosterMember } from "./resume.js";

export function registryHome(home?: string): string { return home ?? process.env.AH_HOME ?? homedir(); }
export function registryFile(home?: string): string { return path.join(registryHome(home), ".agenthop", "projects.json"); }

/** Three-state read of the existing registry (DS-REG-READ): absent (ENOENT) / unknown (read fault OR unparseable — the file is
 *  present but we CANNOT trust it) / ok (a valid `{projects:{…}}` object, parsed tolerantly). Never collapses a fault to "empty". */
export type RegistryRead = { kind: "ok"; reg: ProjectsRegistry } | { kind: "absent" } | { kind: "unknown"; reason: string };
export function readRegistryResult(home?: string): RegistryRead {
  let text: string;
  try { text = readFileSync(registryFile(home), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unknown", reason: (e as Error).message }; // EACCES / ENOTDIR / … ⇒ uncertain, preserve
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { kind: "unknown", reason: "corrupt JSON" }; }
  if (!raw || typeof raw !== "object" || typeof (raw as { projects?: unknown }).projects !== "object" || (raw as { projects?: unknown }).projects === null) {
    return { kind: "unknown", reason: "not a registry object" };
  }
  return { kind: "ok", reg: parseRegistry(text) };
}

/** Carly's READ-ONLY load (advisory): the parsed registry, or an empty one when absent/unknown. For a hard switchboard decision,
 *  prefer readRegistryResult so an UNKNOWN is distinguished from a genuinely empty registry. */
export function readRegistry(home?: string): ProjectsRegistry {
  const r = readRegistryResult(home);
  return r.kind === "ok" ? r.reg : { projects: Object.create(null) as Record<string, ProjectEntry> };
}

/** Carly's switchboard lookup: the on-disk entry for `name`, or null. Read-only. */
export function lookupProjectOnDisk(home: string | undefined, name: string): ProjectEntry | null {
  return lookupProject(readRegistry(home), name);
}

export type RegistryFacts = {
  members: RosterMember[];
  coordinatorSid: string | null;
  fleetSnapshot: string;
  durableRoot: string;
};

/** PURE: assemble the freshly-generated entries from gathered facts. Locate the coordinator roster member by the resolved sid
 *  (member durable id or display title). DS-REG-ROSTER: if it cannot be LOCATED (offline + not in the snapshot, or the roster is
 *  empty while presence still resolves), EMIT NOTHING — a blank entry would overwrite the real repo/resumeCmd; the union preserves
 *  whatever is already recorded. Otherwise seed one entry (name from the FC-7 `project` field, else "agenthop"). Deterministic. */
export function assembleProjectEntries(facts: RegistryFacts): { name: string; entry: Partial<ProjectEntry> }[] {
  const coord = facts.coordinatorSid
    ? facts.members.find((m) => m.member === facts.coordinatorSid || m.title === facts.coordinatorSid)
    : undefined;
  if (!coord) return []; // no coordinator member located ⇒ nothing to generate (preserve any existing entry)
  const name = coord.project || "agenthop";
  return [{
    name,
    entry: {
      repo: coord.cwd ?? "",
      coordinatorSid: facts.coordinatorSid ?? "",
      resumeCmd: coord.resumeCmd ?? "",
      fleetSnapshot: facts.fleetSnapshot,
      durableRoot: facts.durableRoot,
    },
  }];
}

/** Atomic write: EXCLUSIVELY create the temp (wx ⇒ our own fresh inode, never truncating/following a pre-existing temp or symlink),
 *  then rename over the target; a fault removes only OUR temp (DS-TEMP-OWN). */
function writeRegistryAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let tmp = "";
  for (let t = 0; ; t++) {
    tmp = `${file}.wtmp-${randomBytes(8).toString("hex")}`;
    try { writeFileSync(tmp, text, { flag: "wx", mode: 0o600 }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && t < 8) continue; throw e; }
  }
  try { renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* only our own temp */ } throw e; }
}

/** SWARM maintenance: regenerate projects.json from the live roster + env, merged non-destructively over the existing file. Returns
 *  what it did. DS-REG-READ: if the existing file is UNKNOWN (unreadable/corrupt), SKIP the write (keep it, report) rather than
 *  rebuild over an empty base. An absent file initializes from empty; a located coordinator seeds/updates its entry. */
export function generateRegistry(home?: string, env: NodeJS.ProcessEnv = process.env): { written: boolean; reg?: ProjectsRegistry; reason?: string } {
  const h = registryHome(home);
  const base = readRegistryResult(h);
  if (base.kind === "unknown") return { written: false, reason: `existing-registry-unreadable: ${base.reason}` };
  const existing = base.kind === "ok" ? base.reg : { projects: Object.create(null) as Record<string, ProjectEntry> };
  const members = readRosterMembers(h);
  const coordHandle = env.SWARM_COORDINATOR;
  const coordinatorSid = coordHandle ? resolveSession(coordHandle, listSessions(h)) : null;
  const facts: RegistryFacts = {
    members,
    coordinatorSid,
    fleetSnapshot: path.join(h, ".agenthop", "swarm", "fleet-snapshot.json"),
    durableRoot: path.join(h, ".agenthop"),
  };
  const reg = buildProjectsRegistry(assembleProjectEntries(facts), existing);
  writeRegistryAtomic(registryFile(h), serializeRegistry(reg));
  return { written: true, reg };
}
