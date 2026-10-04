/**
 * resume — one-key swarm re-launch (board: swarm-resume, author 90b58f9c). The user's pain: after a reboot
 * the whole swarm is gone and every window has to be re-opened by hand. This captures the live roster to a
 * snapshot (member x directory x CLI x role) and, on the next boot, one command relaunches each window
 * (reusing spawn.ts's Ghostty launcher), each session self-reports, and the sweep takes over.
 *
 * PURE module (msglog P1 lesson): no fs, no bus, no top-level side effects — selftests in resume.selftest.mts.
 * The two pieces of real logic live here and are tested directly: assembleRoster (who to capture) and
 * planResume (idempotency — skip windows that are already up). The IO shell (scripts/swarm-resume.ts) reads
 * the bus roster, writes/reads the snapshot file, and calls spawnAgent per member.
 *
 * Decoupled from closeout ON PURPOSE: the snapshot can be written on demand from the live bus roster, so
 * one-key resume works today. The at-closeout auto-snapshot is the SAME writer hung at the closeout seam
 * (a diff handed to that owner) — it depends on the closeout flow (board dep L2-struct), this module does not.
 */

/** A member's workstation: enough to relaunch its window exactly. role is best-effort (no structured
 *  member->role source exists yet; left null until one does). */
export interface RosterMember {
  member: string; // the durable session id (stableId) if known, else the short handle — a human label
  tool: string; // the CLI to relaunch: claude | codex | opencode | ...
  cwd: string; // the working directory the window opened in
  role: string | null; // best-effort; null when unknown
  title?: string; // short handle (e.g. "Work-20cab0a5"), for display
}

export interface RosterSnapshot {
  version: 1;
  capturedAtSec: number;
  members: RosterMember[];
}

/** Minimal structural shape of a bus peer — deliberately NOT importing resolve.ts's UnifiedPeer, so this
 *  pure module stays decoupled and cherry-pickable. The IO shell passes real peers in. */
export interface PeerLike {
  id?: string;
  stableId?: string;
  tool?: string;
  cwd?: string;
  title?: string;
  status?: string;
}

export const ROSTER_FILE = "roster-snapshot.json";

/** Normalize a directory for identity comparison: trim trailing slashes (but keep root "/"). */
function normCwd(cwd: string): string {
  const s = (cwd ?? "").trim();
  const stripped = s.replace(/\/+$/, "");
  return stripped === "" ? s : stripped;
}

/** The idempotency identity of a window: one live CLI per directory. On reboot stableIds change, so
 *  (tool, cwd) is the stable key for "this directory already has a session of this tool". */
export function memberKey(tool: string, cwd: string): string {
  return `${(tool ?? "").trim().toLowerCase()}\u0000${normCwd(cwd)}`;
}

/**
 * Capture the roster from the live bus peers. Keeps only real agent windows (a tool AND a cwd); drops the
 * observer (selfId) and any explicitly excluded ids/titles. De-duplicates by MEMBER identity, not by
 * (tool, cwd): two distinct sessions in the same directory (e.g. two swarm members both in the repo) are two
 * windows to restore, so both are kept. Pure.
 */
export function assembleRoster(
  peers: readonly PeerLike[],
  nowSec: number,
  opts: { selfId?: string; exclude?: readonly string[] } = {},
): RosterSnapshot {
  const excluded = new Set((opts.exclude ?? []).map((s) => s));
  const seen = new Set<string>();
  const members: RosterMember[] = [];
  for (const p of peers ?? []) {
    const tool = (p.tool ?? "").trim();
    const cwd = (p.cwd ?? "").trim();
    if (!tool || !cwd) continue; // not a relaunchable agent window
    if (opts.selfId && (p.id === opts.selfId || p.stableId === opts.selfId)) continue; // never capture the observer
    if ((p.id && excluded.has(p.id)) || (p.stableId && excluded.has(p.stableId)) || (p.title && excluded.has(p.title))) continue;
    const identity = p.stableId ?? p.title ?? p.id ?? `${memberKey(tool, cwd)}#${members.length}`;
    if (seen.has(identity)) continue; // the same member listed twice, not two windows
    seen.add(identity);
    members.push({ member: identity, tool, cwd, role: null, ...(p.title ? { title: p.title } : {}) });
  }
  members.sort((a, b) => (a.title ?? a.member).localeCompare(b.title ?? b.member));
  return { version: 1, capturedAtSec: Math.floor(nowSec), members };
}

/** Tolerant parse of a snapshot file. Returns null on anything malformed (a resume should degrade, not throw). */
export function parseSnapshot(text: string): RosterSnapshot | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.members)) return null;
  const members: RosterMember[] = [];
  for (const m of r.members) {
    if (!m || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm.tool !== "string" || typeof mm.cwd !== "string" || !mm.tool || !mm.cwd) continue;
    members.push({
      member: typeof mm.member === "string" ? mm.member : memberKey(mm.tool, mm.cwd),
      tool: mm.tool,
      cwd: mm.cwd,
      role: typeof mm.role === "string" ? mm.role : null,
      ...(typeof mm.title === "string" ? { title: mm.title } : {}),
    });
  }
  return {
    version: 1,
    capturedAtSec: typeof r.capturedAtSec === "number" ? r.capturedAtSec : 0,
    members,
  };
}

export interface ResumePlan {
  launch: RosterMember[]; // not currently live -> relaunch
  skip: RosterMember[]; // already live (idempotency) -> leave alone
}

/**
 * Decide what to relaunch, idempotently and robustly across a reboot. Matching is COUNT-based per (tool, cwd),
 * not by session id: ids change on reboot, so an id match would relaunch everything a second time if resume is
 * re-run after a partial launch. For each directory+CLI we relaunch (captured count - live count) windows and
 * skip the rest. Reboot: live 0 -> relaunch all. Re-run while up: live == captured -> relaunch none. Two
 * sessions captured in one dir, one live -> relaunch one. Pure.
 */
export function planResume(snapshot: RosterSnapshot, livePeers: readonly PeerLike[]): ResumePlan {
  const liveCount = new Map<string, number>();
  for (const p of livePeers ?? []) {
    if (p.tool && p.cwd) { const k = memberKey(p.tool, p.cwd); liveCount.set(k, (liveCount.get(k) ?? 0) + 1); }
  }
  const covered = new Map<string, number>(); // how many of this (tool,cwd) are already accounted for by live
  const launch: RosterMember[] = [];
  const skip: RosterMember[] = [];
  for (const m of snapshot.members) {
    const k = memberKey(m.tool, m.cwd);
    const used = covered.get(k) ?? 0;
    if (used < (liveCount.get(k) ?? 0)) { covered.set(k, used + 1); skip.push(m); } // a live window covers this one
    else launch.push(m);
  }
  return { launch, skip };
}
