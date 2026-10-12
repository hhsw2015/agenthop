// Selftest for the pure resume core (assembleRoster + planResume + parseSnapshot). Kept OUT of resume.ts so
// that module has no top-level side effects (msglog P1 lesson).
//   packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/resume.selftest.mts
import {
  ROSTER_FILE, SCHEMA_VERSION, assembleRoster, memberKey, parseSnapshot, planResume, resumeCmdFor, resumeCommandForMember,
  serializeSnapshot, writeRosterSnapshot,
  type PeerLike, type RosterSnapshot,
} from "./resume.js";
import { resolveSession } from "./task-liveness.js"; // DOS-P2-1: the coordinator's handle→sid resolver, mirrored by the entry
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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

// --- DOS-P2-1: handle resolution mirrors the coordinator (task-liveness.resolveSession); ambiguous/unknown ⇒ no guess ---
{
  const sid = "aad02248-c76b-4a1a-b191-95da3f0bfb5a";
  const pool = [sid, "bf1199aa-0000-1111-2222-333344445555"];
  t("P2-1: a FULL session id resolves to itself", resolveSession(sid, pool) === sid);
  t("P2-1: a tool-prefixed bus handle resolves by its short-id tail", resolveSession("claude:OpenDots-aad02248", pool) === sid);
  t("P2-1: a bare short id resolves by prefix", resolveSession("aad02248", pool) === sid);
  t("P2-1: an unknown handle resolves to null (never guess)", resolveSession("claude:X-deadbeef", pool) === null);
  t("P2-1: an AMBIGUOUS short prefix resolves to null (F16)", resolveSession("claude:Y-aaa11111", ["aaa11111-0000-a", "aaa11111-9999-b"]) === null);
  // the entry resolves first, then the pure core stamps the role on the RESOLVED sid (not the raw handle)
  const resolved = resolveSession("claude:OpenDots-aad02248", pool)!;
  const snap = assembleRoster([peer({ stableId: sid, title: "DO" }), peer({ stableId: "other", title: "X" })], 1, { dialogOfficer: resolved });
  t("P2-1: core stamps dialog-officer on the resolved sid only", snap.members.find((m) => m.member === sid)?.role === "dialog-officer" && snap.members.find((m) => m.member === "other")?.role === null);
}

// --- DOS-P2-2: an atomic replace must NOT widen the target's existing mode; a new file is restrictive 0600 ---
{
  const home = mkdtempSync(join(tmpdir(), "roster-mode-"));
  try {
    const out = join(home, "roster.json");
    const snap = assembleRoster([peer({ stableId: "a" })], 1);
    writeRosterSnapshot(out, snap);
    t("P2-2: a brand-new snapshot is created 0600 (restrictive default)", (statSync(out).mode & 0o777) === 0o600);
    chmodSync(out, 0o600); writeRosterSnapshot(out, snap);
    t("P2-2: re-write preserves an existing 0600 (never widened to 0644)", (statSync(out).mode & 0o777) === 0o600);
    chmodSync(out, 0o400); writeRosterSnapshot(out, snap);
    t("P2-2: re-write preserves an existing 0400 (never widened)", (statSync(out).mode & 0o777) === 0o400);
    // P2-2 r3 (FC-2): a NON-ENOENT stat error = an existing mode we CANNOT read ⇒ fail, never widen to the 0600 default.
    // (a) EACCES: an existing 0400 file whose parent loses search permission ⇒ stat(out) → EACCES.
    const sub = join(home, "locked"); mkdirSync(sub, { recursive: true });
    const lockedOut = join(sub, "roster.json");
    writeRosterSnapshot(lockedOut, snap); chmodSync(lockedOut, 0o400);
    chmodSync(sub, 0o000); // owner loses search on the dir ⇒ stat(lockedOut) → EACCES
    let eaccesCode = ""; let threwEacces = false;
    try { statSync(lockedOut); } catch (e) { eaccesCode = (e as NodeJS.ErrnoException).code ?? ""; } // confirm the setup really yields a non-ENOENT stat error
    try { writeRosterSnapshot(lockedOut, snap); } catch { threwEacces = true; }
    chmodSync(sub, 0o700); // restore to inspect
    if (eaccesCode && eaccesCode !== "ENOENT") {
      t("P2-2 r3: an unreadable existing mode (EACCES) makes the write FAIL, never widen (FC-2)", threwEacces);
      t("P2-2 r3: the EACCES target keeps its old 0400 (not relaxed to 0600)", (statSync(lockedOut).mode & 0o777) === 0o400);
    } else {
      t("P2-2 r3: EACCES setup produced a non-ENOENT stat error (env precondition)", false); // if this fires, the perms trick didn't take (e.g. running as root)
    }
    // (b) ENOTDIR: a non-ENOENT stat error of another kind (parent is a file) must also fail — only ENOENT takes the default.
    const fileBlocker = join(home, "blocker"); writeFileSync(fileBlocker, "x");
    let threwNotdir = false;
    try { writeRosterSnapshot(join(fileBlocker, "roster.json"), snap); } catch { threwNotdir = true; }
    t("P2-2 r3: a non-ENOENT stat error (ENOTDIR) also fails (only ENOENT takes the 0600 default)", threwNotdir);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- DOS-P3-1: a failed write (rename can't replace the target) cleans up its temp — no orphan accumulation ---
{
  const home = mkdtempSync(join(tmpdir(), "roster-fail-"));
  try {
    const out = join(home, "as-a-dir");
    mkdirSync(out); // make the target a DIRECTORY ⇒ renameSync(tmp, out) throws (EISDIR/ENOTDIR)
    let threw = false;
    try { writeRosterSnapshot(out, assembleRoster([peer({ stableId: "a" })], 1)); } catch { threw = true; }
    t("P3-1: writeRosterSnapshot throws when the target cannot be replaced", threw);
    t("P3-1: the failed write leaves NO orphan temp behind (cleaned up)", readdirSync(home).filter((f) => f.startsWith("as-a-dir.tmp-")).length === 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- DOS-CORE-P1-1: temp is EXCLUSIVELY created (O_EXCL) — a colliding name is neither truncated nor unlinked ---
{
  const home = mkdtempSync(join(tmpdir(), "roster-excl-"));
  try {
    const out = join(home, "roster.json");
    writeRosterSnapshot(out, assembleRoster([peer({ stableId: "seed" })], 1)); // a committed seed
    const forced = "deadbeefdeadbeef";
    const foreignTmp = `${out}.tmp-${forced}`;
    writeFileSync(foreignTmp, "FOREIGN-INPROGRESS{"); // another writer's in-progress temp, SAME name our next write tries first
    const foreignBefore = readFileSync(foreignTmp, "utf8");
    let n = 0;
    const gen = () => (n++ < 2 ? forced : `beefcafe0${n}`); // collide TWICE on the foreign name, then yield a fresh one
    writeRosterSnapshot(out, assembleRoster([peer({ stableId: "mine" })], 2), gen);
    const committed = parseSnapshot(readFileSync(out, "utf8"));
    t("CORE-P1-1: write succeeds via a FRESH name after EEXIST retries (owns its inode)", committed !== null && committed.members[0]!.member === "mine");
    t("CORE-P1-1: a colliding foreign temp is NOT truncated (O_EXCL, not O_TRUNC)", readFileSync(foreignTmp, "utf8") === foreignBefore);
    t("CORE-P1-1: a colliding foreign temp is NOT unlinked (never delete another writer's temp)", existsSync(foreignTmp));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- DOS-P2-3: REAL-process fixtures (write interruption + new-process recovery + controlled concurrency) ---
// Each child runs the ACTUAL writeRosterSnapshot in a separate process; we verify exit status, prove the writer ENTERED
// the write path (sync marker, not a timer), read DURING the interleaving, and OWN the detached child's cleanup on EVERY
// path (success / timeout / assertion failure) — DOS-R3-P2-1.
{
  const mod = new URL("./resume.ts", import.meta.url).pathname;
  const tsxBin = join(dirname(new URL(import.meta.url).pathname), "..", "..", "node_modules", ".bin", "tsx");
  const snapLit = (sid: string) => `{ version: 2, capturedAtSec: 1, members: [{ member: ${JSON.stringify(sid)}, tool: "claude", cwd: "/x", role: null, resumeCmd: "claude --resume " + ${JSON.stringify(sid)}, resumeCmdSource: "template" }] }`;
  const read = (out: string): string | null => { try { return readFileSync(out, "utf8"); } catch { return null; } };
  const sampleOk = (txt: string | null): boolean => { if (txt === null) return true; const p = parseSnapshot(txt); return p !== null && p.members.length === 1; };
  const committedOk = (out: string): boolean => { let txt: string; try { txt = readFileSync(out, "utf8"); } catch { return false; } const p = parseSnapshot(txt); return p !== null && p.members.length === 1; };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const spawnChild = (code: string, extraEnv: Record<string, string>) => spawn(tsxBin, ["-e", code], { env: { ...process.env, ...extraEnv }, detached: true });
  const onClose = (cp: ReturnType<typeof spawn>) => new Promise<{ code: number | null; signal: string | null }>((res, rej) => { cp.on("error", rej); cp.on("close", (code, signal) => res({ code, signal })); });
  // DOS-R3-P2-1: group-kill (detached child = its own group, so -pid reaches the tsx CLI + forked runner) + a liveness probe.
  const killGroup = (cp: ReturnType<typeof spawn>) => { try { process.kill(-(cp.pid as number), "SIGKILL"); } catch { try { cp.kill("SIGKILL"); } catch { /* already gone */ } } };
  const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } }; // ESRCH ⇒ dead

  // META: the strict checker has teeth — the exact gap happycapy injected (missing/unreadable must NOT count as complete).
  {
    const absent = join(tmpdir(), `roster-absent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    t("P2-3 meta: strict committed-check REJECTS a missing file (null != complete)", committedOk(absent) === false);
    const garbageHome = mkdtempSync(join(tmpdir(), "roster-garbage-"));
    try { const g = join(garbageHome, "g.json"); writeFileSync(g, "TORN{"); t("P2-3 meta: strict committed-check REJECTS an unparseable file", committedOk(g) === false); }
    finally { rmSync(garbageHome, { recursive: true, force: true }); }
  }

  // (A) a real writer killed mid-run; it PROVABLY entered the write path (marker after its first commit); the committed
  //     roster must still EXIST + parse (strict); a NEW process then recovers. Cleanup OWNS every path (DOS-R3-P2-1).
  {
    const home = mkdtempSync(join(tmpdir(), "roster-kill-"));
    let cp: ReturnType<typeof spawn> | undefined; let exit: Promise<{ code: number | null; signal: string | null }> | undefined;
    try {
      const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
      writeRosterSnapshot(out, assembleRoster([peer({ stableId: "seed" })], 1)); // a committed baseline
      const marker = join(home, "entered-write.marker");
      const loop = `import { writeRosterSnapshot } from ${JSON.stringify(mod)}; import { writeFileSync as wf } from "node:fs"; let first = true; for (let i = 0; i < 200000; i++) { writeRosterSnapshot(process.env.OUT, ${snapLit("child")}); if (first) { wf(process.env.MARKER, "in-write"); first = false; } }`;
      cp = spawnChild(loop, { OUT: out, MARKER: marker });
      exit = onClose(cp); // record the exit Promise IMMEDIATELY after spawn (DOS-R3-P2-1)
      await new Promise<void>((r) => cp!.once("spawn", () => r()));
      let entered = false;
      for (let i = 0; i < 240 && !entered; i++) { if (existsSync(marker)) entered = true; else await sleep(25); } // up to ~6s
      killGroup(cp); // kill BEFORE asserting, so a failed assertion cannot skip cleanup
      const end = await exit; // wait for the group to actually die
      t("P2-3(A): the writer PROVABLY entered the write path before kill (sync marker, not a timer)", entered);
      t("P2-3(A): the mid-write writer was killed, not a clean exit", end.code !== 0);
      t("P2-3(A): committed roster EXISTS + is complete after a mid-write kill (strict; missing != complete)", committedOk(out));
      const rec = await onClose(spawnChild(`import { writeRosterSnapshot } from ${JSON.stringify(mod)}; writeRosterSnapshot(process.env.OUT, ${snapLit("recovered")});`, { OUT: out }));
      t("P2-3(A): a new process recovers and writes a valid roster (exit 0)", rec.code === 0 && committedOk(out) && parseSnapshot(read(out) ?? "")!.members[0]!.member === "recovered");
    } finally {
      if (cp) { killGroup(cp); try { await (exit ?? onClose(cp)); } catch { /* already closed */ } } // cleanup on success/timeout/throw
      rmSync(home, { recursive: true, force: true });
    }
  }

  // (R3) DOS-R3-P2-1 regression: a writer that NEVER enters the write path (stalls past the budget) must still be fully
  //      cleaned up — the finally group-kills + waits, leaving NO survivor and NO write (the assertion-failure path).
  {
    const home = mkdtempSync(join(tmpdir(), "roster-nevermark-"));
    const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
    let cp: ReturnType<typeof spawn> | undefined; let exit: Promise<{ code: number | null; signal: string | null }> | undefined;
    let entered = false; let pid = 0;
    try {
      const marker = join(home, "never.marker");
      // stall WELL past the (short) wait budget before any write ⇒ the marker never appears in-budget (SIGKILL interrupts the spin).
      const stall = `const t = Date.now(); while (Date.now() - t < 10000) {} import(${JSON.stringify("node:fs")}).then((fs) => fs.writeFileSync(process.env.MARKER, "late"));`;
      cp = spawnChild(stall, { OUT: out, MARKER: marker });
      exit = onClose(cp); pid = cp.pid as number;
      await new Promise<void>((r) => cp!.once("spawn", () => r()));
      for (let i = 0; i < 20 && !entered; i++) { if (existsSync(marker)) entered = true; else await sleep(25); } // ~0.5s budget
    } finally {
      if (cp) { killGroup(cp); try { await (exit ?? onClose(cp)); } catch { /* already closed */ } }
    }
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { alive = groupAlive(pid); if (alive) await sleep(25); } // let the group be reaped
    t("P2-3(R3): a stalled writer is NOT marked entered (marker never appeared in budget)", entered === false);
    t("P2-3(R3): after cleanup NO survivor remains in the writer's process group", !alive);
    t("P2-3(R3): a never-entered writer wrote nothing (no leftover/recovery snapshot)", !committedOk(out));
    rmSync(home, { recursive: true, force: true });
  }

  // (B) two real processes each write N times; a reader samples DURING the run (never torn); both exit 0. Cleanup owns the throw path.
  {
    const home = mkdtempSync(join(tmpdir(), "roster-cc-"));
    const kids: ReturnType<typeof spawn>[] = [];
    try {
      const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
      const writer = (sid: string) => `import { writeRosterSnapshot } from ${JSON.stringify(mod)}; for(let i=0;i<40;i++){ writeRosterSnapshot(process.env.OUT, ${snapLit(sid)}); }`;
      const exits = ["aaa", "bbb"].map((sid) => { const cp = spawnChild(writer(sid), { OUT: out }); kids.push(cp); return onClose(cp); });
      let settled = 0; let torn = false; let present = 0;
      exits.forEach((pr) => pr.then(() => { settled += 1; }).catch(() => { settled += 1; }));
      while (settled < 2) { const txt = read(out); if (txt !== null) { present += 1; if (!sampleOk(txt)) torn = true; } await new Promise((r) => setImmediate(r)); }
      const results = await Promise.all(exits);
      t("P2-3(B): both concurrent writers exited 0 (no crash, no non-zero)", results.every((r) => r.code === 0 && r.signal === null));
      t("P2-3(B): a reader sampling DURING the run never saw a torn/partial file", !torn && present > 0);
      t("P2-3(B): the final file is one complete snapshot", committedOk(out));
    } finally {
      for (const cp of kids) killGroup(cp); // bounded children self-exit, but guarantee no survivor on a throw (DOS-R3-P2-1 general)
      rmSync(home, { recursive: true, force: true });
    }
  }
  // (C) DOS-CORE-P1-1: two real writers FORCED to collide on the same temp suffix every round; a reader samples and one
  //     is killed — the committed snapshot is NEVER torn (O_EXCL gives each writer its own inode; no shared-inode truncation).
  {
    const home = mkdtempSync(join(tmpdir(), "roster-collide-"));
    const kids: ReturnType<typeof spawn>[] = [];
    try {
      const out = join(home, ".agenthop", "swarm", "roster-snapshot.json");
      writeRosterSnapshot(out, assembleRoster([peer({ stableId: "seed" })], 1)); // committed baseline (the never-torn anchor)
      // each iteration's FIRST temp name is the SAME forced suffix for BOTH writers ⇒ a real O_EXCL collision every round
      // (on the OLD plain-`w` code this test would publish torn 8-byte files; with O_EXCL the loser retries a fresh inode).
      const writer = (sid: string) => `import { writeRosterSnapshot } from ${JSON.stringify(mod)}; import { randomBytes } from "node:crypto"; const F = process.env.FORCE; let first = true; const gen = () => { if (first) { first = false; return F; } return randomBytes(8).toString("hex"); }; for (let i = 0; i < 4000; i++) { first = true; writeRosterSnapshot(process.env.OUT, { version: 2, capturedAtSec: i, members: [{ member: ${JSON.stringify(sid)}, tool: "claude", cwd: "/x", role: null, resumeCmd: "c", resumeCmdSource: "template" }] }, gen); }`;
      const exits = ["aaa", "bbb"].map((sid) => { const cp = spawnChild(writer(sid), { OUT: out, FORCE: "cafecafecafecafe" }); kids.push(cp); return onClose(cp); });
      let settled = 0; let torn = false; let present = 0;
      exits.forEach((pr) => pr.then(() => { settled += 1; }).catch(() => { settled += 1; }));
      await sleep(150); killGroup(kids[0]!); // interrupt one colliding writer mid-run
      while (settled < 2) { const txt = read(out); if (txt !== null) { present += 1; if (!sampleOk(txt)) torn = true; } await new Promise((r) => setImmediate(r)); }
      await Promise.all(exits.map((pr) => pr.catch(() => ({ code: null, signal: null }))));
      t("CORE-P1-1(C): forced same-suffix collision + a killed writer never produced a torn committed file", !torn && present > 0);
      t("CORE-P1-1(C): the final committed file is one complete snapshot", committedOk(out));
    } finally {
      for (const cp of kids) killGroup(cp);
      rmSync(home, { recursive: true, force: true });
    }
  }

}

console.log("all resume selftests passed");
