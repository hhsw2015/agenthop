/**
 * TUI seat screen state (#1115 T1, [liveness]) — the reader side of the bridge's `screen` command.
 *
 * Each window's plugin VM can read only the panes of its own window, so each VM writes `tern-panes/screens/<vm>.json`
 * ({vm, screens: {"<pane id>": {state, rule, agent, observed_at, try, tried_at}}}). This merges those files by pane id.
 *
 * UNKNOWN rules (FC-2): a pane with no entry, an entry without a usable observation, or an observation older than `maxAgeSec`
 * is "unknown" — never "idle"; an unreadable / malformed / oversized / non-regular fresh file makes the whole read unknown. Two VMs
 * reporting the same pane: the newer observation wins; concurrent ones that disagree resolve to the most dangerous state.
 * observed_at is the plugin's wall clock (epoch seconds); an observation dated in the future by more than `maxAgeSec` (clock
 * stepped back) is also "unknown". Pure core (`mergeScreens`) + a thin file reader.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

export type ScreenState = "idle" | "working" | "blocked" | "unknown";
export type ScreenEntry = {
  state: ScreenState; rule: string | null; agent: string | null; observedAt: number | null; vm: string | null;
  visibleIdle: boolean; visibleBlocker: boolean; visibleWorking: boolean; why?: string;
};

const STATES = new Set(["idle", "working", "blocked", "unknown"]);
const unknown = (why: string): ScreenEntry => ({ state: "unknown", rule: null, agent: null, observedAt: null, vm: null, visibleIdle: false, visibleBlocker: false, visibleWorking: false, why });

/** Conservative order for observations that cannot be told apart in time: the more dangerous state wins, idle never does. */
const DANGER: Record<ScreenState, number> = { blocked: 3, working: 2, unknown: 1, idle: 0 };
/** observed_at has 1-second precision (Lua os.time), so two VMs' observations within this window are concurrent. */
export const CONCURRENT_SEC = 1;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Merge per-VM file bodies into pane id -> entry. Pure. A null body, or a body that is not {vm: string, screens: object}, means
 * that file's content is UNKNOWN — and since we cannot tell which panes it would have reported, the WHOLE merge is unknown
 * (returned with `fault`), never "the other files' view" (T1B-SV-MERGE-UNKNOWN / JSON-NULL).
 * Per pane: an entry with a usable observation (known state + numeric observed_at) is a candidate; an unusable entry
 * (bad state, missing/non-numeric observed_at, null) is a BAD observation at its observed_at, or at +∞ when it has none.
 * The newest candidate wins unless a bad observation is at least as new (⇒ unknown, no fallback to an older idle); candidates
 * within CONCURRENT_SEC of the newest that disagree resolve to the most dangerous state (blocked > working > unknown > idle).
 */
export function mergeScreensResult(files: Array<{ name: string; body: string | null }>, nowSec: number, maxAgeSec: number): { screens: Map<string, ScreenEntry>; fault?: string } {
  type Cand = { e: ScreenEntry; at: number };
  const good = new Map<string, Cand[]>();
  const badAt = new Map<string, number>();
  for (const f of files) {
    if (f.body === null) return { screens: new Map(), fault: `${f.name}: unreadable` };
    let d: unknown;
    try { d = JSON.parse(f.body); } catch { return { screens: new Map(), fault: `${f.name}: not JSON` }; }
    if (!isObj(d) || typeof d.vm !== "string" || !isObj(d.screens)) return { screens: new Map(), fault: `${f.name}: not {vm, screens}` };
    const vm = d.vm;
    for (const [pane, raw] of Object.entries(d.screens)) {
      const e = isObj(raw) ? raw : null;
      const at = typeof e?.observed_at === "number" && Number.isFinite(e.observed_at) ? e.observed_at : null;
      if (e === null || at === null || typeof e.state !== "string" || !STATES.has(e.state)) {
        badAt.set(pane, Math.max(badAt.get(pane) ?? -Infinity, at ?? Infinity));
        continue;
      }
      const entry: ScreenEntry = { state: e.state as ScreenState, rule: typeof e.rule === "string" ? e.rule : null, agent: typeof e.agent === "string" ? e.agent : null,
        observedAt: at, vm, visibleIdle: e.visible_idle === true, visibleBlocker: e.visible_blocker === true, visibleWorking: e.visible_working === true };
      good.set(pane, [...(good.get(pane) ?? []), { e: entry, at }]);
    }
  }
  const out = new Map<string, ScreenEntry>();
  for (const pane of new Set([...good.keys(), ...badAt.keys()])) {
    const cands = good.get(pane) ?? [];
    const newest = cands.reduce((m, c) => Math.max(m, c.at), -Infinity);
    const bad = badAt.get(pane);
    if (cands.length === 0 || (bad !== undefined && bad >= newest)) { out.set(pane, unknown("the newest observation is unusable (bad state or no time)")); continue; }
    const near = cands.filter((c) => newest - c.at <= CONCURRENT_SEC);
    const pick = near.reduce((a, c) => (DANGER[c.e.state] > DANGER[a.e.state] || (DANGER[c.e.state] === DANGER[a.e.state] && c.at > a.at) ? c : a));
    const conflict = near.some((c) => c.e.state !== pick.e.state);
    let entry: ScreenEntry = conflict ? { ...pick.e, why: `concurrent observations disagree (${[...new Set(near.map((c) => c.e.state))].join("/")}); most dangerous kept` } : pick.e;
    if (nowSec - newest > maxAgeSec) entry = { ...unknown(`stale (${nowSec - newest}s old)`), observedAt: newest, vm: pick.e.vm };
    else if (newest - nowSec > maxAgeSec) entry = { ...unknown("observed in the future (clock stepped back)"), observedAt: newest, vm: pick.e.vm };
    out.set(pane, entry);
  }
  return { screens: out };
}
export function mergeScreens(files: Array<{ name: string; body: string | null }>, nowSec: number, maxAgeSec: number): Map<string, ScreenEntry> {
  return mergeScreensResult(files, nowSec, maxAgeSec).screens;
}

/** The state of one pane: its merged entry, or UNKNOWN when no VM reports it. Pure. */
export function screenOf(merged: Map<string, ScreenEntry>, pane: number | string): ScreenEntry {
  return merged.get(String(pane)) ?? unknown("no VM reports this pane");
}

export const MAX_DIR_ENTRIES = 1000; // names looked at per read (old VMs' files pile up until their mtime ages out)
export const MAX_FILES = 32;         // fresh files actually read
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

export type ReadFs = {
  readdir: (dir: string) => string[];
  lstat: (p: string) => { isFile: boolean; size: number; mtimeSec: number; ino: number };
  /** open WITHOUT following links and WITHOUT blocking (O_NOFOLLOW|O_NONBLOCK), re-check it is the same regular file, read ≤ max */
  readRegular: (p: string, ino: number, max: number) => string;
};
export const realReadFs: ReadFs = {
  readdir: (dir) => readdirSync(dir),
  lstat: (p) => { const s = lstatSync(p); return { isFile: s.isFile(), size: s.size, mtimeSec: s.mtimeMs / 1000, ino: s.ino }; },
  readRegular: (p, ino, max) => {
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.ino !== ino) throw new Error("replaced between lstat and open");
      const buf = Buffer.alloc(max + 1);
      const n = readSync(fd, buf, 0, max + 1, 0);
      if (n > max) throw new Error(`more than ${max} bytes`);
      return buf.subarray(0, n).toString("utf8");
    } finally { closeSync(fd); }
  },
};

/**
 * Read screens/*.json under the bridge control dir, bounded (T1B-SV-READER-BOUNDS): at most MAX_DIR_ENTRIES names, only REGULAR
 * files (lstat, then an O_NOFOLLOW|O_NONBLOCK open re-checked by inode — a FIFO or a swapped-in link never blocks or redirects the
 * read), files older than maxAgeSec by mtime skipped unread (they cannot hold a fresh observation), at most MAX_FILES fresh files
 * of ≤ MAX_FILE_BYTES each and MAX_TOTAL_BYTES in all. Any fresh file that is not a readable regular file within bounds, or any
 * bound exceeded ⇒ the whole read is UNKNOWN (empty map + fault). A missing dir = no files (every pane UNKNOWN, no fault).
 */
export function readScreensResult(controlDir: string, nowSec: number, maxAgeSec: number, fs: ReadFs = realReadFs): { screens: Map<string, ScreenEntry>; fault?: string } {
  const dir = path.join(controlDir, "screens");
  let names: string[];
  try { names = fs.readdir(dir); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { screens: new Map() } : { screens: new Map(), fault: `screens dir unreadable (${(e as Error).message})` }; }
  if (names.length > MAX_DIR_ENTRIES) return { screens: new Map(), fault: `${names.length} entries in screens/ (> ${MAX_DIR_ENTRIES})` };
  const files: Array<{ name: string; body: string | null }> = [];
  let total = 0;
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const p = path.join(dir, name);
    let st: ReturnType<ReadFs["lstat"]>;
    try { st = fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; return { screens: new Map(), fault: `${name}: lstat failed (${(e as Error).message})` }; }
    if (st.isFile && nowSec - st.mtimeSec > maxAgeSec) continue;
    if (!st.isFile) return { screens: new Map(), fault: `${name}: not a regular file` };
    if (files.length >= MAX_FILES) return { screens: new Map(), fault: `more than ${MAX_FILES} fresh screens files` };
    if (st.size > MAX_FILE_BYTES) return { screens: new Map(), fault: `${name}: ${st.size} bytes (> ${MAX_FILE_BYTES})` };
    if (total + st.size > MAX_TOTAL_BYTES) return { screens: new Map(), fault: `screens files exceed ${MAX_TOTAL_BYTES} bytes in all` };
    let body: string;
    // T1B-READ-TOTAL-GROWTH: the read bound is what is LEFT of the total (a file may have grown since lstat), and the real bytes count
    try { body = fs.readRegular(p, st.ino, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)); } catch (e) { return { screens: new Map(), fault: `${name}: ${(e as Error).message}` }; }
    total += Buffer.byteLength(body);
    if (total > MAX_TOTAL_BYTES) return { screens: new Map(), fault: `screens files exceed ${MAX_TOTAL_BYTES} bytes in all` };
    files.push({ name, body });
  }
  return mergeScreensResult(files, nowSec, maxAgeSec);
}
export function readScreens(controlDir: string, nowSec: number, maxAgeSec: number, fs: ReadFs = realReadFs): Map<string, ScreenEntry> {
  return readScreensResult(controlDir, nowSec, maxAgeSec, fs).screens;
}
