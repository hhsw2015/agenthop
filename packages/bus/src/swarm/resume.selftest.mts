// Selftest for the pure resume core (assembleRoster + planResume + parseSnapshot). Kept OUT of resume.ts so
// that module has no top-level side effects (msglog P1 lesson).
//   packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/resume.selftest.mts
import {
  ROSTER_FILE, assembleRoster, memberKey, parseSnapshot, planResume,
  type PeerLike, type RosterSnapshot,
} from "./resume.js";

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
  t("version + capturedAt stamped", snap.version === 1 && snap.capturedAtSec === 1000);
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

console.log("all resume selftests passed");
