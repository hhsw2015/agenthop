/**
 * projects-registry selftest (tsx-run). Covers deliverable ①:
 *  - pure: buildProjectsRegistry UNION (existing preserved / generated overrides / inadmissible dropped); serializeRegistry
 *    deterministic + byte-idempotent (sorted keys); parseRegistry tolerant (junk ⇒ empty); lookupProject; isAdmissible.
 *  - store: generateRegistry from a planted roster snapshot + presence ⇒ writes projects.json with the project entry; readRegistry
 *    round-trips; a NON-destructive regen preserves a manually-seeded project.
 *
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/projects-registry.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProjectsRegistry,
  serializeRegistry,
  parseRegistry,
  lookupProject,
  isAdmissible,
  type ProjectEntry,
} from "./projects-registry.js";
import {
  assembleProjectEntries,
  generateRegistry,
  readRegistry,
  registryFile,
  lookupProjectOnDisk,
  type RegistryFacts,
} from "./projects-registry-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "projreg-"));
const full = (e: Partial<ProjectEntry>): ProjectEntry => ({ repo: "", coordinatorSid: "", resumeCmd: "", fleetSnapshot: "", durableRoot: "", ...e });

// ---- pure ----
{
  t("isAdmissible: name + coordinatorSid ⇒ ok", isAdmissible("p", full({ coordinatorSid: "s1" })));
  t("isAdmissible: name + resumeCmd (offline coord) ⇒ ok", isAdmissible("p", full({ resumeCmd: "herdr resume" })));
  t("isAdmissible: name only ⇒ no", !isAdmissible("p", full({})));
  t("isAdmissible: empty name ⇒ no", !isAdmissible("", full({ coordinatorSid: "s1" })));

  const existing = { projects: { legacy: full({ coordinatorSid: "old", repo: "/legacy" }) } };
  const reg = buildProjectsRegistry([{ name: "agenthop", entry: { coordinatorSid: "c1", repo: "/a" } }], existing);
  t("merge: generated added", lookupProject(reg, "agenthop")?.coordinatorSid === "c1");
  t("merge: existing preserved (non-destructive)", lookupProject(reg, "legacy")?.coordinatorSid === "old");
  const reg2 = buildProjectsRegistry([{ name: "legacy", entry: { coordinatorSid: "new", repo: "/legacy" } }], existing);
  t("merge: generated overrides existing by name", lookupProject(reg2, "legacy")?.coordinatorSid === "new");
  const reg3 = buildProjectsRegistry([{ name: "half", entry: { repo: "/h" } }], { projects: {} });
  t("merge: inadmissible generated dropped", lookupProject(reg3, "half") === null);

  const s1 = serializeRegistry(reg);
  t("serialize: deterministic byte-idempotent", s1 === serializeRegistry(buildProjectsRegistry([{ name: "agenthop", entry: { coordinatorSid: "c1", repo: "/a" } }], existing)));
  t("serialize: keys sorted (agenthop before legacy)", s1.indexOf('"agenthop"') < s1.indexOf('"legacy"'));
  t("parse: round-trips", lookupProject(parseRegistry(s1), "agenthop")?.repo === "/a");
  t("parse: junk ⇒ empty", Object.keys(parseRegistry("not json").projects).length === 0 && Object.keys(parseRegistry('{"x":1}').projects).length === 0);
}

// ---- pure assemble ----
{
  const facts: RegistryFacts = {
    members: [
      { member: "coord-sid", tool: "claude", cwd: "/Users/x/Dev/agenthop", role: null, resumeCmd: "herdr resume coord", title: "Work-abc" } as any,
      { member: "other", tool: "codex", cwd: "/tmp", role: null } as any,
    ],
    coordinatorSid: "coord-sid",
    fleetSnapshot: "/h/.agenthop/swarm/fleet-snapshot.json",
    durableRoot: "/h/.agenthop",
  };
  const [g] = assembleProjectEntries(facts);
  t("assemble: name defaults to agenthop", g.name === "agenthop");
  t("assemble: repo = coordinator cwd, resumeCmd carried, sid set", g.entry.repo === "/Users/x/Dev/agenthop" && g.entry.resumeCmd === "herdr resume coord" && g.entry.coordinatorSid === "coord-sid");
  const none = assembleProjectEntries({ ...facts, coordinatorSid: null })[0];
  t("assemble: no coordinator ⇒ blank-routed entry (dropped on build)", none.entry.coordinatorSid === "" && none.entry.repo === "");
}

// ---- store round-trip ----
{
  const home = tmpHome();
  const coordSid = "coord-test-xyz";
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid));
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  const snap = { version: 2, capturedAtSec: 1, members: [{ member: coordSid, tool: "claude", cwd: "/Users/x/Dev/agenthop", role: null, resumeCmd: "herdr resume coord", title: "Work-abc" }] };
  writeFileSync(path.join(home, ".agenthop", "swarm", "roster-snapshot.json"), JSON.stringify(snap));
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv;

  const reg = generateRegistry(home, env);
  t("store: generate writes projects.json", readFileSync(registryFile(home), "utf8").includes("agenthop"));
  const e = lookupProjectOnDisk(home, "agenthop");
  t("store: agenthop entry has repo + coordinatorSid + resumeCmd + durableRoot + fleetSnapshot", !!e && e.repo === "/Users/x/Dev/agenthop" && e.coordinatorSid === coordSid && e.resumeCmd === "herdr resume coord" && e.durableRoot === path.join(home, ".agenthop") && e.fleetSnapshot.endsWith("fleet-snapshot.json"));

  // manually seed another project, regen ⇒ it survives (non-destructive)
  const withManual = buildProjectsRegistry([{ name: "sideproj", entry: { coordinatorSid: "side-sid", repo: "/side" } }], reg);
  writeFileSync(registryFile(home), serializeRegistry(withManual));
  generateRegistry(home, env);
  t("store: non-destructive regen preserves a manually-seeded project", lookupProjectOnDisk(home, "sideproj")?.coordinatorSid === "side-sid" && lookupProjectOnDisk(home, "agenthop")?.coordinatorSid === coordSid);

  // absent file ⇒ empty, no crash
  t("store: readRegistry on a fresh home ⇒ empty", Object.keys(readRegistry(tmpHome()).projects).length === 0);
}

console.log("all projects-registry selftests passed");
