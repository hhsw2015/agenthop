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

/**
 * Parse `vm-ssh ls --json` (array of `{id,...}`) into the set of live VM ids. The set is used as POSITIVE
 * "the VM is gone" evidence (absence ⇒ recycled), so a PARTIAL set is dangerous: a dropped row would read as a missing
 * VM and recycle a live machine (RH2). Therefore ANY malformed element (not an object, or without a non-empty string
 * `id`) ⇒ null ("list unconfirmed — keep every machine"). A legitimate empty array ⇒ empty set (trusted: no VMs). Pure.
 */
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
    if (!r || typeof r !== "object") return null; // can't confirm the list's shape ⇒ don't trust it
    const id = (r as { id?: unknown }).id;
    if (typeof id !== "string" || !id) return null; // a row without an identity ⇒ set is not complete
    ids.add(id);
  }
  return ids;
}

/** Pull a boolean reachability flag out of a parsed `machine status --json` value (top-level or array[0]). A top-level
 *  `reachable`/`online` boolean wins; null when absent/non-boolean. Pure. */
function reachableFlag(v: unknown): boolean | null {
  const o = Array.isArray(v) ? v[0] : v;
  if (!o || typeof o !== "object") return null;
  for (const k of ["reachable", "online"] as const) {
    const f = (o as Record<string, unknown>)[k];
    if (typeof f === "boolean") return f;
  }
  return null;
}

/**
 * Reachability from `herdr machine status <id>` output, as a TRI-STATE (true/false/null). false is returned ONLY on
 * EXPLICIT target-unreachable evidence; execution failures, contradictory text, and anything unrecognized return null
 * (RH1). This matters because false + VM-absent ⇒ recycled ⇒ removal: a local read error ("permission denied") or a
 * reachable JSON that merely contains the token `last_error:null` must NOT read as unreachable.
 *
 * Order: (1) a structured boolean `reachable` flag wins; (2) `unknown machine` ⇒ null (not saved); (3) EXPLICIT
 * unreachable phrases ⇒ false, EXPLICIT reachable phrases ⇒ true; (4) both present (contradictory) ⇒ null; (5) neither
 * ⇒ null. The phrase sets are specific (connection-level), never the bare words `error`/`failed`.
 *
 * NOTE (honesty): the exact live wording was not captured offline (no VM, no-spend). Fail-closed (null ⇒ keep) makes a
 * miss safe. Confirm/trim on the next live run. Pure.
 */
export function parseReachable(raw: string): boolean | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const flag = reachableFlag(JSON.parse(s));
    if (flag !== null) return flag;
  } catch {
    /* not json — fall through to text */
  }
  const low = s.toLowerCase();
  if (low.includes("unknown machine")) return null; // not saved → not our concern
  const down = /\bunreachable\b|unable to reach|cannot reach|not reachable|connection refused|\btimed out\b|no route to host|host is down|\boffline\b/.test(low);
  const up = /\breachable\b|server is ready|\bready\b|\bconnected\b|\bonline\b/.test(low);
  if (down && up) return null; // contradictory → inconclusive
  if (down) return false;
  if (up) return true;
  return null; // execution failure / unrecognized → keep
}

/**
 * Find the workspace_id whose label matches a machine label, from `herdr workspace list` JSON
 * (`{result:{workspaces:[{workspace_id,label,...}]}}`). Returns a workspace id ONLY on a UNIQUE match; an invalid
 * collection (missing / not an array, e.g. `workspaces:{}`), zero matches, or an AMBIGUOUS >1 match ⇒ null, so we never
 * close the wrong (or a business) workspace (RH5). Pure. */
export function workspaceIdForLabel(workspaceListJson: string, label: string): string | null {
  let v: any;
  try {
    v = JSON.parse(workspaceListJson);
  } catch {
    return null;
  }
  const ws = v?.result?.workspaces;
  if (!Array.isArray(ws)) return null; // {} / missing ⇒ no close (never throws)
  const hits = ws.filter((w) => w && w.label === label && typeof w.workspace_id === "string");
  return hits.length === 1 ? hits[0].workspace_id : null; // unique only; 0 or >1 ⇒ null
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
 *  - ephemeral-gated: only machines whose label is a key of `ephemeral` (the vm-ssh VMs THIS flow provisioned, each
 *    carrying its registered vmId) are even considered — a permanent SSH box is never touched. This map is the seam to
 *    ③ boot-template's linkage ledger (pass `readLinkage()` directly).
 *  - identity-correct: vm presence is checked by the registered `vmId`, NOT the herdr machine label — the two can
 *    differ, and matching the label would recycle a live machine whose VM is still listed under its real id (RH3).
 *  - two-evidence verdict: recycleVerdict needs unreachable AND absent-from-`vm-ssh ls`.
 *  - fail-closed: if `vm-ssh ls` is unavailable/unconfirmed, vmIds=null ⇒ every verdict unknown ⇒ nothing removed.
 *  - dry-run default: `act` defaults to false — the sweep only REPORTS unless explicitly enabled.
 *
 * On a recycled machine with act=true: `herdr machine remove <id>` then `herdr workspace close <workspace_id>` (the
 * UNIQUE workspace whose label == the machine label). Removal is best-effort; a failed close still reports acted.
 */
export async function sweepRecycled(opts: {
  ephemeral: Readonly<Record<string, { vmId: string }>>;
  act?: boolean;
}): Promise<SweepOutcome[]> {
  const act = opts.act === true;
  const owns = (label: string) => Object.prototype.hasOwnProperty.call(opts.ephemeral, label);
  const ml = await run(HERDR_BIN, ["machine", "list"]);
  const machines = parseMachineList(ml.raw).filter((m) => owns(m.label));
  if (machines.length === 0) return [];

  const ls = await run(VM_SSH_BIN, ["ls", "--json"], 15000);
  const vmIds = ls.exitFailed ? null : parseVmSshIds(ls.raw);

  const outcomes: SweepOutcome[] = [];
  for (const m of machines) {
    const st = await run(HERDR_BIN, ["machine", "status", m.id, "--json"], 10000);
    const machineReachable = parseReachable(st.raw);
    const vmListed = vmIds === null ? null : vmIds.has(opts.ephemeral[m.label].vmId); // match by registered vmId (RH3)
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
