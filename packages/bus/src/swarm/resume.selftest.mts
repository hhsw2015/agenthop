// Selftest for the pure resume core (assembleRoster + planResume + parseSnapshot). Kept OUT of resume.ts so
// that module has no top-level side effects (msglog P1 lesson).
//   packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/resume.selftest.mts
import {
  ROSTER_FILE, SCHEMA_VERSION, assembleRoster, memberKey, parseSnapshot, planResume, resumeCmdFor, resumeCommandForMember,
  serializeSnapshot, writeRosterSnapshot,
  type PeerLike, type RosterSnapshot,
} from "./resume.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

const t = (name: string, cond: boolean) => {
  if (!cond) throw new Error("FAILED: " + name);
  console.log("ok  " + name);
};
const peer = (over: Partial<PeerLike> = {}): PeerLike => ({ id: "run-1", stableId: "sess-1", tool: "claude", cwd: "/Users/x/Work", title: "Work-1", ...over });

// --- assembleRoster: keep real windows, drop non-agents + self + excluded; keep two members in one dir ---
{
  const snap = assembleRoster([
    peer({ stableId: "a", tool: "claude", cwd: "/Work/one", title: "one" }),
    peer({ stableId: "b", tool: "codex", cwd: "/Work/two", title: "two" }),
    peer({ stableId: "c", tool: "claude", cwd: "/Work/one", title: "sibling" }), // same dir+CLI, DIFFERENT member -> kept
    peer({ stableId: "a", tool: "claude", cwd: "/Work/one", title: "a-again" }), // SAME member id -> deduped
    peer({ stableId: "d", tool: "", cwd: "/Work/three", title: "no-tool" }), // no tool -> dropped
    peer({ stableId: "e", tool: "claude", cwd: "", title: "no-cwd" }), // no cwd -> dropped
    peer({ id: "self-run", stableId: "self", tool: "claude", cwd: "/Work/obs", title: "observer" }),
  ], 1000, { selfId: "self" });
  t("two distinct members in one dir are BOTH kept", snap.members.filter((m) => m.cwd === "/Work/one").length === 2);
  t("dedups the SAME member listed twice", snap.members.filter((m) => m.member === "a").length === 1);
  t("captures the three distinct windows", snap.members.length === 3);
  t("drops a peer with no tool", !snap.members.some((m) => m.title === "no-tool"));
  t("drops a peer with no cwd", !snap.members.some((m) => m.title === "no-cwd"));
  t("excludes self (observer)", !snap.members.some((m) => m.title === "observer"));
  t("member label prefers the durable stableId", snap.members.find((m) => m.title === "one")?.member === "a");
  t("role is best-effort null (no structured source yet)", snap.members.every((m) => m.role === null));
  t("version + capturedAt stamped (schema v2)", snap.version === 2 && snap.capturedAtSec === 1000);
  t("members sorted by handle", snap.members[0]!.title === "one");
}
{
  // exclude by id / stableId / title
  const snap = assembleRoster([
    peer({ stableId: "k", cwd: "/a", title: "keep" }),
    peer({ stableId: "x", cwd: "/b", title: "drop-by-title" }),
  ], 1, { exclude: ["drop-by-title"] });
  t("exclude list drops by title", snap.members.length === 1 && snap.members[0]!.title === "keep");
}

// --- planResume: count-based per (tool,cwd). Robust across reboot (ids change). Idempotent. ---
{
  const snap: RosterSnapshot = {
    version: 1, capturedAtSec: 1,
    members: [
      { member: "a", tool: "claude", cwd: "/Work/one", role: null, title: "one" },
      { member: "b", tool: "codex", cwd: "/Work/two", role: null, title: "two" },
      { member: "c", tool: "claude", cwd: "/Work/three", role: null, title: "three" },
    ],
  };
  // "two" is already live (same tool+cwd), even though its session id differs after a reboot -> skipped by count.
  const plan = planResume(snap, [peer({ stableId: "fresh-after-reboot", tool: "codex", cwd: "/Work/two" })]);
  t("skips a window already live by count of (tool,cwd)", plan.skip.length === 1 && plan.skip[0]!.title === "two");
  t("launches the rest", plan.launch.length === 2 && plan.launch.map((m) => m.title).sort().join(",") === "one,three");
  // nothing live -> launch all (the reboot case)
  t("nothing live -> relaunch everyone", planResume(snap, []).launch.length === 3);
  // everyone live -> launch nobody (re-run while up)
  const allLive = snap.members.map((m) => peer({ tool: m.tool, cwd: m.cwd }));
  t("everyone live -> launch nobody (idempotent re-run)", planResume(snap, allLive).launch.length === 0);
}
{
  // two members captured in ONE dir; one live -> relaunch exactly one (count-based, not all-or-nothing).
  const snap: RosterSnapshot = {
    version: 1, capturedAtSec: 1,
    members: [
      { member: "p", tool: "claude", cwd: "/repo", role: null, title: "p" },
      { member: "q", tool: "claude", cwd: "/repo", role: null, title: "q" },
    ],
  };
  const one = planResume(snap, [peer({ tool: "claude", cwd: "/repo" })]);
  t("two-in-a-dir, one live -> launch one, skip one", one.launch.length === 1 && one.skip.length === 1);
  t("two-in-a-dir, none live -> launch both", planResume(snap, []).launch.length === 2);
  t("two-in-a-dir, both live -> launch none", planResume(snap, [peer({ tool: "claude", cwd: "/repo" }), peer({ tool: "claude", cwd: "/repo" })]).launch.length === 0);
}

// --- (tool,cwd) identity normalizes trailing slash + case of tool ---
{
  t("trailing slash does not split identity", memberKey("claude", "/a/b/") === memberKey("claude", "/a/b"));
  t("tool case-insensitive", memberKey("Claude", "/a") === memberKey("claude", "/a"));
  t("root slash preserved", memberKey("claude", "/") === memberKey("claude", "/"));
}

// --- parseSnapshot: tolerant, never throws ---
{
  const good = JSON.stringify({ version: 1, capturedAtSec: 5, members: [{ member: "a", tool: "claude", cwd: "/a", role: "impl", title: "A" }] });
  const s = parseSnapshot(good)!;
  t("parses a good snapshot", s.members.length === 1 && s.members[0]!.role === "impl");
  t("bad json -> null", parseSnapshot("{ not json") === null);
  t("no members array -> null", parseSnapshot(JSON.stringify({ version: 1 })) === null);
  // skips malformed members, keeps good ones
  const mixed = parseSnapshot(JSON.stringify({ members: [{ tool: "claude", cwd: "/a" }, { tool: "codex" }, { bogus: true }] }))!;
  t("skips members missing tool/cwd, keeps the valid", mixed.members.length === 1 && mixed.members[0]!.tool === "claude");
  t("missing role defaults to null", mixed.members[0]!.role === null);
  t("file name constant", ROSTER_FILE === "roster-snapshot.json");
}

// --- degenerate inputs ---
{
  t("empty peers -> empty roster", assembleRoster([], 1).members.length === 0);
  t("undefined-ish safe", assembleRoster([{}], 1).members.length === 0);
}

// --- F36: resumeCmd (full launch command, not a bare relaunch) ---
{
  // resumeCmdFor: with live claude argv -> preserve recognized flags + --resume <sid>, source "argv"
  const r1 = resumeCmdFor("claude", "sid-1", ["/path/node", "cli.js", "--dangerously-skip-permissions", "--model", "claude-opus-5-5[1m]", "--effort", "xhigh", "--other"]);
  t("claude argv -> source argv", r1.source === "argv");
  t("claude argv preserves flags + injects --resume", r1.cmd === "claude --dangerously-skip-permissions --model claude-opus-5-5[1m] --effort xhigh --resume sid-1");
  t("argv[0] (node wrapper) is ignored, command name is the tool", r1.cmd.startsWith("claude "));
  // --model=X form also captured
  t("claude --model=form captured", resumeCmdFor("claude", "s", ["claude", "--model=opus", "--dangerously-skip-permissions"]).cmd.includes("--model=opus"));
  // bare claude (no recognized flags) -> canon template is SAFER than reproducing bareness (the F36 bug)
  const bare = resumeCmdFor("claude", "sid-2", ["claude"]);
  t("bare claude argv -> canon template (not bare)", bare.source === "template" && bare.cmd.includes("--dangerously-skip-permissions") && bare.cmd.endsWith("--resume sid-2"));
  // codex
  t("codex argv -> codex resume <sid>", resumeCmdFor("codex", "cx-1", ["codex"]).cmd === "codex resume cx-1");
  // no argv -> template, source template
  const tmpl = resumeCmdFor("claude", "sid-3");
  t("no argv -> source template", tmpl.source === "template" && tmpl.cmd === "claude --dangerously-skip-permissions --model 'claude-opus-5-5[1m]' --effort xhigh --resume sid-3");
  t("codex no argv -> template codex resume", resumeCmdFor("codex", "cx-2").cmd === "codex resume cx-2");
  t("unknown tool -> best-effort --resume", resumeCmdFor("opencode", "o-1").cmd === "opencode --resume o-1");
}
{
  // assembleRoster attaches resumeCmd: argv path vs template path, and writes schema v2
  const peers: PeerLike[] = [
    { stableId: "a", tool: "claude", cwd: "/w/one", title: "one", pid: 1, argv: ["claude", "--dangerously-skip-permissions", "--model", "m", "--effort", "xhigh"] } as PeerLike,
    { stableId: "b", tool: "codex", cwd: "/w/two", title: "two" }, // no argv -> template
  ];
  const snap = assembleRoster(peers, 1000);
  t("snapshot is schema v2", snap.version === SCHEMA_VERSION && SCHEMA_VERSION === 2);
  const one = snap.members.find((m) => m.title === "one")!;
  t("member with argv -> resumeCmd from argv + --resume <sid>", one.resumeCmdSource === "argv" && one.resumeCmd === "claude --dangerously-skip-permissions --model m --effort xhigh --resume a");
  const two = snap.members.find((m) => m.title === "two")!;
  t("member without argv -> canon template codex", two.resumeCmdSource === "template" && two.resumeCmd === "codex resume b");
}
{
  // v1 old snapshot (no resumeCmd) stays readable; resumeCommandForMember recomputes canon
  const v1 = JSON.stringify({ version: 1, capturedAtSec: 5, members: [{ member: "old-sid", tool: "claude", cwd: "/x", role: null, title: "Old" }] });
  const s = parseSnapshot(v1)!;
  t("v1 snapshot still parses", s.version === 1 && s.members.length === 1);
  t("v1 member has no resumeCmd field", s.members[0]!.resumeCmd === undefined);
  t("resumeCommandForMember recomputes canon for a v1 member", resumeCommandForMember(s.members[0]!) === "claude --dangerously-skip-permissions --model 'claude-opus-5-5[1m]' --effort xhigh --resume old-sid");
  // v2 snapshot round-trips resumeCmd + source
  const v2 = JSON.stringify({ version: 2, capturedAtSec: 9, members: [{ member: "x", tool: "codex", cwd: "/y", role: null, resumeCmd: "codex resume x", resumeCmdSource: "argv" }] });
  const s2 = parseSnapshot(v2)!;
  t("v2 snapshot preserves version + resumeCmd + source", s2.version === 2 && s2.members[0]!.resumeCmd === "codex resume x" && s2.members[0]!.resumeCmdSource === "argv");
  t("resumeCommandForMember uses the captured resumeCmd when present", resumeCommandForMember(s2.members[0]!) === "codex resume x");
}


// --- dialog-officer brief §9-2: the FIRST structured role source (SWARM_DIALOG_OFFICER → role="dialog-officer") ---
{
  const snap = assembleRoster([
    peer({ stableId: "do-sid", tool: "claude", cwd: "/Work/do", title: "DialogOfficer" }),
    peer({ stableId: "w1", tool: "codex", cwd: "/Work/w1", title: "worker" }),
  ], 1000, { dialogOfficer: "do-sid" });
  t("dialog-officer stableId gets role=dialog-officer", snap.members.find((m) => m.member === "do-sid")?.role === "dialog-officer");
  t("other members stay role=null", snap.members.find((m) => m.member === "w1")?.role === null);
  t("no dialogOfficer opt ⇒ every role null (byte-identical v1)", assembleRoster([peer({ stableId: "do-sid" })], 1000).members.every((m) => m.role === null));
  t("a blank handle names no one", assembleRoster([peer({ stableId: "do-sid" })], 1000, { dialogOfficer: "  " }).members.every((m) => m.role === null));
}

// --- project: FC-7 forward-reserve (stamped only when set; round-trips; absent on legacy) ---
{
  t("project stamped when set", assembleRoster([peer({ stableId: "a" })], 1000, { project: "proj-x" }).members[0]!.project === "proj-x");
  t("project absent when unset (legacy)", assembleRoster([peer({ stableId: "a" })], 1000).members[0]!.project === undefined);
  const rt = parseSnapshot(serializeSnapshot(assembleRoster([peer({ stableId: "a", title: "A" })], 1000, { dialogOfficer: "a", project: "proj-x" })))!;
  t("role + project round-trip through serialize→parse", rt.members[0]!.role === "dialog-officer" && rt.members[0]!.project === "proj-x");
  const legacy = parseSnapshot(JSON.stringify({ version: 2, capturedAtSec: 1, members: [{ member: "m", tool: "claude", cwd: "/x", role: "dialog-officer" }] }))!;
  t("FC-7: legacy member (no project) parses, project undefined, role kept", legacy.members[0]!.project === undefined && legacy.members[0]!.role === "dialog-officer");
}

// --- restart-idempotency: assembleRoster is deterministic (a restart re-captures the same roster) ---
{
  const mk = () => assembleRoster([peer({ stableId: "a", title: "A" }), peer({ stableId: "b", title: "B" })], 1000, { dialogOfficer: "a", project: "p" });
  t("restart: identical peers ⇒ identical roster (deterministic)", JSON.stringify(mk()) === JSON.stringify(mk()));
}

// --- roster WRITE primitive: atomic (crash-recovery / idempotency) — infra zero-bug ruling ---
{
  const home = mkdtempSync(join(tmpdir(), "roster-"));
  try {
    const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
    const snap1 = assembleRoster([peer({ stableId: "a", title: "A" })], 1000);
    writeRosterSnapshot(out, snap1);
    t("write ⇒ readback parses to the same snapshot", readFileSync(out, "utf8") === serializeSnapshot(snap1));
    const before = readFileSync(out, "utf8"); writeRosterSnapshot(out, snap1);
    t("idempotent re-write ⇒ byte-identical file", readFileSync(out, "utf8") === before);
    writeFileSync(`${out}.tmp-deadbeef`, "TORN GARBAGE{"); // a crashed writer's leftover temp (crash BEFORE rename)
    t("a leftover crash temp never corrupts the committed roster", readFileSync(out, "utf8") === before);
    const snap2 = assembleRoster([peer({ stableId: "b", title: "B" })], 2000, { dialogOfficer: "b" });
    writeRosterSnapshot(out, snap2);
    const after = parseSnapshot(readFileSync(out, "utf8"))!;
    t("last write wins, file is a COMPLETE snapshot (never torn)", after.members.length === 1 && after.members[0]!.role === "dialog-officer");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- concurrency: two real processes write the roster at once ⇒ the file is always ONE complete snapshot (any interleaving) ---
{
  const home = mkdtempSync(join(tmpdir(), "roster-cc-"));
  try {
    const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
    const mod = new URL("./resume.ts", import.meta.url).pathname;
    const tsxBin = join(dirname(new URL(import.meta.url).pathname), "..", "..", "node_modules", ".bin", "tsx");
    const child = (sid: string) => `import { writeRosterSnapshot } from "${mod}"; writeRosterSnapshot(process.env.OUT, { version: 2, capturedAtSec: 1, members: [{ member: "${sid}", tool: "claude", cwd: "/x", role: null, resumeCmd: "claude --resume ${sid}", resumeCmdSource: "template" }] });`;
    await Promise.all(["aaa", "bbb"].map((sid) => new Promise<void>((res, rej) => {
      const cp = spawn(tsxBin, ["-e", child(sid)], { env: { ...process.env, OUT: out } });
      cp.on("error", rej); cp.on("close", () => res());
    })));
    const parsed = parseSnapshot(readFileSync(out, "utf8"));
    t("concurrency: the roster file is ONE complete snapshot (parses), never torn", parsed !== null && parsed.members.length === 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log("all resume selftests passed");
