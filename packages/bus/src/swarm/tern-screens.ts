/**
 * TUI seat screen state (#1115 T1, [liveness]) — the reader side of the bridge's `screen` command.
 *
 * Each window's plugin VM can read only the panes of its own window, so each VM writes `tern-panes/screens/<vm>.json`
 * ({vm, screens: {"<pane id>": {state, rule, agent, observed_at, try, tried_at}}}). This merges those files by pane id.
 *
 * UNKNOWN rules (FC-2): a pane with no entry, an unreadable / malformed file, an entry without a usable observation, or an
 * observation older than `maxAgeSec` is "unknown" — never "idle". Two VMs reporting the same pane: the newer observation wins.
 * observed_at is the plugin's wall clock (epoch seconds); an observation dated in the future by more than `maxAgeSec` (clock
 * stepped back) is also "unknown". Pure core (`mergeScreens`) + a thin file reader.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type ScreenState = "idle" | "working" | "blocked" | "unknown";
export type ScreenEntry = {
  state: ScreenState; rule: string | null; agent: string | null; observedAt: number | null; vm: string | null;
  visibleIdle: boolean; visibleBlocker: boolean; visibleWorking: boolean; why?: string;
};

const STATES = new Set(["idle", "working", "blocked", "unknown"]);
const unknown = (why: string): ScreenEntry => ({ state: "unknown", rule: null, agent: null, observedAt: null, vm: null, visibleIdle: false, visibleBlocker: false, visibleWorking: false, why });

/** Merge per-VM file bodies (null = that file was unreadable) into pane id -> entry. Pure. */
export function mergeScreens(files: Array<{ name: string; body: string | null }>, nowSec: number, maxAgeSec: number): Map<string, ScreenEntry> {
  const out = new Map<string, ScreenEntry>();
  for (const f of files) {
    if (f.body === null) continue; // unreadable: its panes stay absent ⇒ UNKNOWN for the caller
    let d: unknown;
    try { d = JSON.parse(f.body); } catch { continue; }
    const screens = (d as { screens?: unknown } | null)?.screens;
    const vm = typeof (d as { vm?: unknown }).vm === "string" ? (d as { vm: string }).vm : null;
    if (!screens || typeof screens !== "object" || Array.isArray(screens)) continue;
    for (const [pane, raw] of Object.entries(screens as Record<string, unknown>)) {
      const e = raw as { state?: unknown; rule?: unknown; agent?: unknown; observed_at?: unknown; visible_idle?: unknown; visible_blocker?: unknown; visible_working?: unknown } | null;
      const at = typeof e?.observed_at === "number" && Number.isFinite(e.observed_at) ? e.observed_at : null;
      let entry: ScreenEntry;
      if (at === null || typeof e?.state !== "string" || !STATES.has(e.state)) entry = unknown("no observation");
      else if (nowSec - at > maxAgeSec) entry = { ...unknown(`stale (${nowSec - at}s old)`), observedAt: at, vm };
      else if (at - nowSec > maxAgeSec) entry = { ...unknown("observed in the future (clock stepped back)"), observedAt: at, vm };
      else entry = { state: e.state as ScreenState, rule: typeof e.rule === "string" ? e.rule : null, agent: typeof e.agent === "string" ? e.agent : null, observedAt: at, vm,
        visibleIdle: e.visible_idle === true, visibleBlocker: e.visible_blocker === true, visibleWorking: e.visible_working === true };
      const prev = out.get(pane);
      if (prev === undefined || (entry.observedAt ?? -Infinity) > (prev.observedAt ?? -Infinity)) out.set(pane, entry);
    }
  }
  return out;
}

/** The state of one pane: its merged entry, or UNKNOWN when no VM reports it. Pure. */
export function screenOf(merged: Map<string, ScreenEntry>, pane: number | string): ScreenEntry {
  return merged.get(String(pane)) ?? unknown("no VM reports this pane");
}

/** Read every screens/*.json under the bridge control dir. A missing dir = no files (every pane UNKNOWN). */
export function readScreens(controlDir: string, nowSec: number, maxAgeSec: number): Map<string, ScreenEntry> {
  const dir = path.join(controlDir, "screens");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { names = []; }
  return mergeScreens(names.map((name) => {
    try { return { name, body: readFileSync(path.join(dir, name), "utf8") }; } catch { return { name, body: null }; }
  }), nowSec, maxAgeSec);
}
