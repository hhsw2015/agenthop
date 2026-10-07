/**
 * remote-recycle — detect a recycled remote herdr machine and clean it up (S14 remote-herdr-view ②).
 *
 * One machine = one workspace (named by the machine label); herdr mounts a remote VM as a machine + workspace. When the
 * VM recycles (Railway self-destructs ~1h; `vm-ssh down` is a no-op for railway), the saved herdr machine becomes a
 * dangling entry. "Recycle = disappears": remove the machine + close its workspace.
 *
 * The hard part is NOT the removal (`herdr machine remove` is proven live, evidence/01-live-proof.md) — it is deciding
 * recycled vs a transient network blip WITHOUT false-positiving a machine that is merely briefly unreachable. So the
 * verdict needs TWO independent evidence faces (CORE iron law 4: 单信号不定罪; 两证据面; suspected≠dead):
 *   1. machineReachable — `herdr machine status` reaches the remote herdr, or not.
 *   2. vmListed         — the VM label still appears in `vm-ssh ls`, or not.
 * recycled = BOTH say gone (unreachable AND not listed). Any missing/ambiguous face ⇒ keep, never remove (fail-closed).
 *
 * Pure verdict + parsers above the line (selftested). IO sweep below (exercised by live/integration runs). The sweep
 * is additionally gated to EPHEMERAL machines (labels this flow provisioned) and defaults to DRY-RUN, so it can never
 * remove a permanent SSH box nor act without explicit opt-in.
 */

// ============================================================================================================
// Pure layer — verdict + parsers (selftested in remote-recycle.selftest.mts)
// ============================================================================================================

/** live = reachable (never touch). transient = down but VM still provisioned (net blip, keep). recycled = down AND
 *  VM gone (remove + close workspace). unknown = a face is missing/ambiguous (keep; suspected≠dead). */
export type RecycleVerdict = "live" | "transient" | "recycled" | "unknown";

export interface MachineLiveness {
  /** true=herdr reached it, false=unreachable, null=probe inconclusive. */
  machineReachable: boolean | null;
  /** true=label in `vm-ssh ls`, false=absent, null=`vm-ssh ls` unavailable. */
  vmListed: boolean | null;
}

/**
 * Two-evidence-face verdict. recycled is the ONLY removal trigger, and it requires BOTH faces to positively say gone.
 * Every other combination keeps the machine. Fail-closed by construction: a null on either face can never yield
 * recycled. Pure.
 */
export function recycleVerdict(s: MachineLiveness): RecycleVerdict {
  if (s.machineReachable === true) return "live"; // reachable: never remove, regardless of the VM list
  if (s.machineReachable === null) return "unknown"; // can't tell if it is down → keep
  // machineReachable === false (positively unreachable) below:
  if (s.vmListed === false) return "recycled"; // both faces agree: gone
  if (s.vmListed === true) return "transient"; // VM still provisioned → treat as a blip, keep
  return "unknown"; // vmListed null: only one face says down → suspected≠dead, keep
}

/** The sole action gate: remove+close ONLY on a recycled verdict. Pure. */
export function shouldRemove(v: RecycleVerdict): boolean {
  return v === "recycled";
}

export interface SavedMachine {
  id: string;
  label: string;
  host: string;
  group: string;
  enabled: boolean;
}

/**
 * Parse `herdr machine list` (plain text) rows: `<id>\t<label>\t<host>\t<group>\t<enabled|disabled>` (shape from
 * evidence/01-live-proof.md). Tolerates blank lines and short/garbled rows (skipped). Pure.
 */
export function parseMachineList(raw: string): SavedMachine[] {
  const out: SavedMachine[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    const f = t.split("\t");
    if (f.length < 5) continue; // not a machine row (e.g. a note line)
    const [id, label, host, group, state] = f;
    if (!id.trim() || !label.trim()) continue;
    out.push({ id, label, host, group, enabled: state.trim().toLowerCase() === "enabled" });
  }
  return out;
}

/** Parse `vm-ssh ls --json` (array of `{id,...}`) into the set of live VM ids/labels. Unparseable/non-array ⇒ null
 *  (signals "vm-ssh ls unavailable" to the caller, which must then keep every machine). Pure. */
export function parseVmSshIds(json: string): Set<string> | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const ids = new Set<string>();
  for (const r of v) {
    const id = (r as { id?: unknown })?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/**
 * Reachability from `herdr machine status <id>` output, as a TRI-STATE (true/false/null). null ⇒ inconclusive ⇒ the
 * verdict keeps the machine. Keyword scan on the raw text (works whether or not --json wraps it); the down-patterns are
 * checked BEFORE the up-patterns because "reachable" is a substring of "unreachable". A `unknown machine` reply means
 * the machine is not even saved (already removed) → null, caller skips it.
 *
 * NOTE (honesty): the exact reachable wording of a LIVE saved machine was not captured offline (no VM provisioned —
 * no-spend). These patterns are a best-effort set; the fail-closed design makes a wrong guess safe (it keeps, never
 * wrongly removes). Confirm/trim the wording on the next live run. Pure.
 */
export function parseReachable(raw: string): boolean | null {
  const s = (raw ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (s.includes("unknown machine")) return null; // not saved → not our concern
  if (/unreachable|unable to reach|cannot reach|not reachable|timed out|timeout|refused|no route|offline|failed|error/.test(s)) {
    return false;
  }
  if (/reachable|server is ready|\bready\b|connected|online|\bok\b|healthy|\bup\b/.test(s)) return true;
  return null;
}

/** Find the workspace_id whose label matches a machine label, from `herdr workspace list` JSON
 *  (`{result:{workspaces:[{workspace_id,label,...}]}}`). null when absent/unparseable. Pure. */
export function workspaceIdForLabel(workspaceListJson: string, label: string): string | null {
  let v: any;
  try {
    v = JSON.parse(workspaceListJson);
  } catch {
    return null;
  }
  const ws: any[] = v?.result?.workspaces ?? [];
  const hit = ws.find((w) => w?.label === label && typeof w?.workspace_id === "string");
  return hit ? hit.workspace_id : null;
}

// ============================================================================================================
// IO shell — thin execFile wrappers (exercised by live/integration runs, NOT the selftest)
// ============================================================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const px = promisify(execFile);

export const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";
export const VM_SSH_BIN = process.env.VM_SSH_BIN ?? "vm-ssh";

/** Run a CLI; NEVER throw on a normal non-zero exit — return it structured so a failure degrades to a safe "keep",
 *  never an escaping reject (mirrors herdr.ts herdrRun). */
async function run(bin: string, args: string[], timeoutMs = 20000): Promise<{ raw: string; exitFailed: boolean }> {
  try {
    const { stdout } = await px(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 22 });
    return { raw: stdout, exitFailed: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { raw: err.stderr || err.stdout || "", exitFailed: true };
  }
}

export interface SweepOutcome {
  machine: SavedMachine;
  verdict: RecycleVerdict;
  acted: boolean;
  note: string;
}

/**
 * Sweep saved herdr machines for recycled remote VMs and (optionally) clean them up.
 *
 * Safety layers, independent:
 *  - ephemeral-gated: only machines whose label is in `ephemeralLabels` (the vm-ssh VMs THIS flow provisioned) are
 *    even considered — a permanent SSH box is never touched. (The ephemeral set is the seam to ③ boot-template, which
 *    will record the vm-ssh↔machine linkage in workspace metadata; until then the caller supplies it.)
 *  - two-evidence verdict: recycleVerdict needs unreachable AND absent-from-`vm-ssh ls`.
 *  - fail-closed: if `vm-ssh ls` is unavailable, vmListed=null ⇒ every verdict is unknown ⇒ nothing removed.
 *  - dry-run default: `act` defaults to false — the sweep only REPORTS unless explicitly enabled.
 *
 * On a recycled machine with act=true: `herdr machine remove <id>` then `herdr workspace close <workspace_id>` (the
 * workspace whose label == the machine label). Removal is best-effort; a failed close still reports acted with a note.
 */
export async function sweepRecycled(opts: {
  ephemeralLabels: ReadonlySet<string>;
  act?: boolean;
}): Promise<SweepOutcome[]> {
  const act = opts.act === true;
  const ml = await run(HERDR_BIN, ["machine", "list"]);
  const machines = parseMachineList(ml.raw).filter((m) => opts.ephemeralLabels.has(m.label));
  if (machines.length === 0) return [];

  const ls = await run(VM_SSH_BIN, ["ls", "--json"], 15000);
  const vmIds = ls.exitFailed ? null : parseVmSshIds(ls.raw);

  const outcomes: SweepOutcome[] = [];
  for (const m of machines) {
    const st = await run(HERDR_BIN, ["machine", "status", m.id, "--json"], 10000);
    const machineReachable = parseReachable(st.raw);
    const vmListed = vmIds === null ? null : vmIds.has(m.label);
    const verdict = recycleVerdict({ machineReachable, vmListed });

    if (!shouldRemove(verdict) || !act) {
      outcomes.push({ machine: m, verdict, acted: false, note: act ? "kept" : "kept (dry-run)" });
      continue;
    }
    const rm = await run(HERDR_BIN, ["machine", "remove", m.id], 15000);
    const wl = await run(HERDR_BIN, ["workspace", "list"]);
    const wsId = workspaceIdForLabel(wl.raw, m.label);
    let note = rm.exitFailed ? "machine remove FAILED" : "machine removed";
    if (wsId) {
      const wc = await run(HERDR_BIN, ["workspace", "close", wsId]);
      note += wc.exitFailed ? `; workspace ${wsId} close FAILED` : `; workspace ${wsId} closed`;
    } else {
      note += "; no matching workspace";
    }
    outcomes.push({ machine: m, verdict, acted: true, note });
  }
  return outcomes;
}
