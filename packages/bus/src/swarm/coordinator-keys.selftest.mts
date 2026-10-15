// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/coordinator-keys.selftest.mts
// #1032-C gate: the inbox sentinel credits the COORDINATOR's legacy boxes from dispatcher-known facts (sid + live process
// tool/cwd), even when whois() is ambiguous; it must NOT over-credit (wrong tool / wrong cwd / missing fact ⇒ no expansion),
// and an ordinary member keeps the conservative whois rule (this module is only consulted for the coordinator sid).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readIdentityLog, buildProjection, whois } from "../bus-identity.js";
import { coordinatorLegacyKeys, toolFromCommand } from "./coordinator-keys.js";

let n = 0;
const ok = (c: boolean, name: string) => { if (!c) throw new Error("FAILED: " + name); n++; console.log("ok  " + name); };
const H = mkdtempSync(path.join(tmpdir(), "coord-keys-"));
const NEW = "c5beaa7c-0000-4000-8000-000000000001";
const OLD = "fe0376cd-0000-4000-8000-000000000002";
const CWD = "/repo/agenthop";
let seq = 0;
const observe = (key: string, claims: { value: string; form: string }[], tool = "claude", cwd = CWD) =>
  appendEvent(H, { v: 1, eventId: `e-${++seq}`, ts: 1000 + seq, type: "observe", incarnation: { key, scope: "local", tool, cwd, claims: claims.map((c) => ({ ...c, confidence: "hard", provenance: "same-announce" })) } } as any);

// The coordinator resumed under several runs ⇒ whois(NEW) is AMBIGUOUS (the real-world condition: 44 candidates).
for (let i = 0; i < 3; i++) observe(`run-${i}`, [{ value: `run-${i}`, form: "run" }, { value: NEW, form: "native" }]);
// The #1032-C link: the previous native's box rides as a run claim under the CURRENT native (same tool+cwd).
observe(`coord-link-${OLD.slice(0, 8)}`, [{ value: NEW, form: "native" }, { value: OLD, form: "run" }]);

const lg = readIdentityLog(H); const proj = buildProjection(lg.events, lg.corruption);
ok(whois(proj, NEW).kind !== "entity", "setup: whois(coordinator) is ambiguous (the condition that caused the false STALL)");

const keys = coordinatorLegacyKeys(proj, NEW, { tool: "claude", cwd: CWD });
ok(keys.includes(OLD), "coordinator: dispatcher-known tool+cwd ⇒ previous-native box IS credited (no false STALL)");
ok(keys.includes("run-0") && keys.includes("run-2"), "coordinator: its prior run boxes are credited too");
ok(!keys.includes(NEW), "coordinator: the direct sid is not duplicated in the legacy set (credited separately)");
ok(coordinatorLegacyKeys(proj, NEW, { tool: "codex", cwd: CWD }).length === 0, "no over-credit: wrong tool ⇒ nothing");
ok(coordinatorLegacyKeys(proj, NEW, { tool: "claude", cwd: "/elsewhere" }).length === 0, "no over-credit: wrong cwd ⇒ nothing");
ok(coordinatorLegacyKeys(proj, NEW, { tool: null, cwd: CWD }).length === 0 && coordinatorLegacyKeys(proj, NEW, { tool: "claude", cwd: null }).length === 0, "missing fact ⇒ nothing (never guess)");
ok(coordinatorLegacyKeys(proj, "", { tool: "claude", cwd: CWD }).length === 0, "empty sid ⇒ nothing");
ok(!coordinatorLegacyKeys(proj, "aad02248-0000-4000-8000-000000000003", { tool: "claude", cwd: CWD }).includes(OLD), "another session's sid never inherits the coordinator's box");

ok(toolFromCommand("claude") === "claude" && toolFromCommand("/opt/bin/codex") === "codex", "tool: executable basename");
ok(toolFromCommand("node") === null && toolFromCommand("") === null && toolFromCommand("bun") === null, "tool: anything else ⇒ unknown");
ok(toolFromCommand("claude helper") === null && toolFromCommand("/opt/x/claude helper") === null, "tool: a process named `claude helper` is NOT claude (whole basename compared, IWT-COORD-TOOL)");
ok(toolFromCommand("/usr/local/bin/codex") === "codex" && toolFromCommand("/Users/me/My Apps/claude") === "claude", "tool: exact basename matches, even under a path with spaces");

console.log(`\nall coordinator-keys selftests passed (${n})`);
