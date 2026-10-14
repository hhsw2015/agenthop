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
  readRegistryResult,
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
  t("assemble: no coordinator sid (offline) ⇒ emit nothing (preserve old)", assembleProjectEntries({ ...facts, coordinatorSid: null }).length === 0);
  // DS-REG-ROSTER: sid RESOLVES but no matching roster member ⇒ emit nothing (presence resolvable != roster complete; never blank-overwrite)
  t("assemble[DS-REG-ROSTER]: sid resolves but member missing ⇒ emit nothing", assembleProjectEntries({ ...facts, members: [] }).length === 0);
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

  const g = generateRegistry(home, env);
  t("store: generate writes projects.json (written=true)", g.written === true && readFileSync(registryFile(home), "utf8").includes("agenthop"));
  const e = lookupProjectOnDisk(home, "agenthop");
  t("store: agenthop entry has repo + coordinatorSid + resumeCmd + durableRoot + fleetSnapshot", !!e && e.repo === "/Users/x/Dev/agenthop" && e.coordinatorSid === coordSid && e.resumeCmd === "herdr resume coord" && e.durableRoot === path.join(home, ".agenthop") && e.fleetSnapshot.endsWith("fleet-snapshot.json"));

  // manually seed another project, regen ⇒ it survives (non-destructive)
  const withManual = buildProjectsRegistry([{ name: "sideproj", entry: { coordinatorSid: "side-sid", repo: "/side" } }], g.reg!);
  writeFileSync(registryFile(home), serializeRegistry(withManual));
  generateRegistry(home, env);
  t("store: non-destructive regen preserves a manually-seeded project", lookupProjectOnDisk(home, "sideproj")?.coordinatorSid === "side-sid" && lookupProjectOnDisk(home, "agenthop")?.coordinatorSid === coordSid);

  // absent file ⇒ empty, no crash
  t("store: readRegistry on a fresh home ⇒ empty", Object.keys(readRegistry(tmpHome()).projects).length === 0);
}

// ---- DS-REG-READ: an UNKNOWN (corrupt/unreadable) existing registry ⇒ generate HOLDS (preserves the file), never rebuilds empty ----
{
  const home = tmpHome();
  const coordSid = "coord-read-xyz";
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid));
  mkdirSync(path.join(home, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "swarm", "roster-snapshot.json"), JSON.stringify({ version: 2, capturedAtSec: 1, members: [{ member: coordSid, tool: "claude", cwd: "/repo", role: null, resumeCmd: "cmd", title: "t" }] }));
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv;
  // corrupt existing projects.json (present but unparseable) — offline wake info the roster can't rebuild
  mkdirSync(path.dirname(registryFile(home)), { recursive: true });
  const corrupt = '{"projects": OFFLINE-WAKE-INFO not json';
  writeFileSync(registryFile(home), corrupt);
  const res = generateRegistry(home, env);
  t("DS-REG-READ: corrupt existing ⇒ generate NOT written + file byte-identical (preserved)", res.written === false && (res.reason || "").includes("unreadable") && readFileSync(registryFile(home), "utf8") === corrupt);
  t("DS-REG-READ: readRegistryResult distinguishes absent vs unknown", readRegistryResult(tmpHome()).kind === "absent" && readRegistryResult(home).kind === "unknown");
}
// ---- DS-REG-READ r3: entry-shape + leaf-type validation ⇒ a bad CARRIER is UNKNOWN (HOLD), not washed to empty + rewritten ----
{
  const mk = (json: string) => { const h = tmpHome(); mkdirSync(path.dirname(registryFile(h)), { recursive: true }); writeFileSync(registryFile(h), json); return h; };
  const kind = (json: string) => readRegistryResult(mk(json)).kind;
  t("DS-REG-READ r3: projects as ARRAY ⇒ unknown", kind('{"projects":[{"resumeCmd":"x"}]}') === "unknown");
  t("DS-REG-READ r3: entry null ⇒ unknown", kind('{"projects":{"p":null}}') === "unknown");
  t("DS-REG-READ r3: entry string ⇒ unknown", kind('{"projects":{"p":"str"}}') === "unknown");
  t("DS-REG-READ r3: entry array ⇒ unknown", kind('{"projects":{"p":[]}}') === "unknown");
  t("DS-REG-READ r3: known field wrong leaf type (object resumeCmd) ⇒ unknown", kind('{"projects":{"p":{"coordinatorSid":"s","resumeCmd":{}}}}') === "unknown");
  t("DS-REG-READ r3: empty entry {} ⇒ ok (legit)", kind('{"projects":{"p":{}}}') === "ok");
  t("DS-REG-READ r3: empty-string field + unknown extra key ⇒ ok", kind('{"projects":{"p":{"coordinatorSid":"s","resumeCmd":"","extra":"x"}}}') === "ok");
  t("DS-REG-READ r3: valid empty registry ⇒ ok", kind('{"projects":{}}') === "ok");
  // full generate chain: a bad-entry existing file ⇒ generate HOLDs (does not wash + rewrite)
  const coordSid = "coord-badentry";
  const h = mk('{"projects":{"p":{"coordinatorSid":"s","resumeCmd":{"obj":1}}}}');
  mkdirSync(path.join(h, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(h, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid));
  mkdirSync(path.join(h, ".agenthop", "swarm"), { recursive: true });
  writeFileSync(path.join(h, ".agenthop", "swarm", "roster-snapshot.json"), JSON.stringify({ version: 2, capturedAtSec: 1, members: [{ member: coordSid, tool: "claude", cwd: "/r", role: null, resumeCmd: "cmd", title: "t" }] }));
  const before = readFileSync(registryFile(h), "utf8");
  const gr = generateRegistry(h, { AH_HOME: h, SWARM_COORDINATOR: coordSid } as any);
  t("DS-REG-READ r3: bad-entry carrier ⇒ generate HOLDs + file byte-identical", gr.written === false && readFileSync(registryFile(h), "utf8") === before);
}

// ---- DS-REG-KEY: a project literally named "__proto__" survives build / serialize / parse / lookup ----
{
  const reg = buildProjectsRegistry([{ name: "__proto__", entry: { coordinatorSid: "p", repo: "/p" } }], { projects: Object.create(null) });
  t("DS-REG-KEY: __proto__ project is an own entry after build", lookupProject(reg, "__proto__")?.coordinatorSid === "p");
  const round = parseRegistry(serializeRegistry(reg));
  t("DS-REG-KEY: __proto__ survives serialize+parse", lookupProject(round, "__proto__")?.coordinatorSid === "p");
  // and a hostile JSON with its own __proto__ key does not pollute / is not silently dropped on parse
  const parsed = parseRegistry('{"projects":{"__proto__":{"coordinatorSid":"x","repo":"/x","resumeCmd":"","fleetSnapshot":"","durableRoot":""}}}');
  t("DS-REG-KEY: parse of a __proto__ JSON key ⇒ own entry, no pollution", lookupProject(parsed, "__proto__")?.coordinatorSid === "x" && (({}) as any).coordinatorSid === undefined);
}

console.log("all projects-registry selftests passed");
