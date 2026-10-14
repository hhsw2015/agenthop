/**
 * Projects registry IO (dialog-officer M2-a, deliverable ① — the store half of projects-registry.ts). Maintains
 * `~/.agenthop/projects.json`: the SWARM generates it (from the roster snapshot + env), Carly reads it READ-ONLY. The pure
 * assembly (`assembleProjectEntries`) is unit-tested with fake facts; `generateRegistry` is the thin IO wrapper.
 *
 * Non-destructive: a regen is a UNION over the existing file (buildProjectsRegistry), so a project seeded when its coordinator was
 * up SURVIVES after it goes offline — Carly can still wake it by its resumeCmd (the switchboard case). Atomic temp+rename write.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import {
  type ProjectsRegistry,
  type ProjectEntry,
  parseRegistry,
  serializeRegistry,
  buildProjectsRegistry,
  lookupProject,
} from "./projects-registry.js";
import { readRosterMembers } from "./shell-succession.js";
import { resolveSession, listSessions } from "./task-liveness.js";
import type { RosterMember } from "./resume.js";

export function registryHome(home?: string): string { return home ?? process.env.AH_HOME ?? homedir(); }
export function registryFile(home?: string): string { return path.join(registryHome(home), ".agenthop", "projects.json"); }

/** Carly's READ-ONLY load: parse projects.json, tolerating absence/corruption (⇒ empty registry; a regen rebuilds it). The pure
 *  parse already degrades junk to empty, so this never throws on a bad file; a genuine ENOENT is simply "no projects yet". */
export function readRegistry(home?: string): ProjectsRegistry {
  let text: string;
  try { text = readFileSync(registryFile(home), "utf8"); }
  catch { return { projects: {} }; } // absent/unreadable ⇒ empty (switchboard finds nothing, never crashes)
  return parseRegistry(text);
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

/** PURE: assemble the freshly-generated entries from gathered facts. v1 (single project): locate the coordinator roster member by
 *  the resolved sid (member durable id or display title), take the project name from its FC-7 `project` field (else "agenthop"), and
 *  seed one entry — repo = the coordinator's cwd, resumeCmd = its resume command, coordinatorSid = the resolved sid. When the
 *  coordinator cannot be located (offline + not in the snapshot), the entry is blank-routed and buildProjectsRegistry drops it,
 *  preserving any previously-generated entry (non-destructive). Deterministic. */
export function assembleProjectEntries(facts: RegistryFacts): { name: string; entry: Partial<ProjectEntry> }[] {
  const coord = facts.coordinatorSid
    ? facts.members.find((m) => m.member === facts.coordinatorSid || m.title === facts.coordinatorSid)
    : undefined;
  const name = (coord && coord.project) || "agenthop";
  return [{
    name,
    entry: {
      repo: coord?.cwd ?? "",
      coordinatorSid: facts.coordinatorSid ?? "",
      resumeCmd: coord?.resumeCmd ?? "",
      fleetSnapshot: facts.fleetSnapshot,
      durableRoot: facts.durableRoot,
    },
  }];
}

/** Atomic write of the serialized registry (temp+rename; concurrent regens each land a complete file). */
function writeRegistryAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** SWARM maintenance: regenerate projects.json from the live roster + env, merged non-destructively over the existing file. Returns
 *  the written registry. FC-2: a missing roster/coordinator yields no new admissible entry (existing preserved), never a crash. */
export function generateRegistry(home?: string, env: NodeJS.ProcessEnv = process.env): ProjectsRegistry {
  const h = registryHome(home);
  const members = readRosterMembers(h);
  const coordHandle = env.SWARM_COORDINATOR;
  const coordinatorSid = coordHandle ? resolveSession(coordHandle, listSessions(h)) : null;
  const facts: RegistryFacts = {
    members,
    coordinatorSid,
    fleetSnapshot: path.join(h, ".agenthop", "swarm", "fleet-snapshot.json"),
    durableRoot: path.join(h, ".agenthop"),
  };
  const reg = buildProjectsRegistry(assembleProjectEntries(facts), readRegistry(h));
  writeRegistryAtomic(registryFile(h), serializeRegistry(reg));
  return reg;
}
