/**
 * remote-capacity — agent-capacity for a remote herdr machine, from its probed CPU/RAM (S14 remote-herdr-view ③).
 *
 * One machine = one workspace; herdr runs N agents on it, N bounded by the machine's size. The dispatcher (future
 * board-admission) feeds work up to this cap, never oversubscribing. Conservative v1 formula (user-set):
 *   capacity = max(1, min(cores - 1, floor(memGB / 4)))
 * i.e. leave one core for herdr/system, ~4 GB per agent, always allow at least 1. Railway small tiers → 1-2.
 * Tune after measurement; this is the safe floor.
 *
 * Pure: the IO shell probes the box (`nproc`, `free`) and feeds the raw strings here. Selftested.
 */

export interface MachineSpec {
  cores: number;
  memGB: number;
}

/** capacity = max(1, min(cores-1, floor(memGB/4))). Guards non-finite/negative inputs to a safe 1. Pure. */
export function agentCapacity(spec: MachineSpec): number {
  const cores = Number.isFinite(spec.cores) ? Math.floor(spec.cores) : 0;
  const memGB = Number.isFinite(spec.memGB) ? spec.memGB : 0;
  const byCore = cores - 1;
  const byMem = Math.floor(memGB / 4);
  return Math.max(1, Math.min(byCore, byMem));
}

/** Parse `nproc` output (a bare integer line) into a core count; null when unparseable. Pure. */
export function parseNproc(raw: string): number | null {
  const m = (raw ?? "").trim().match(/^\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type FreeUnit = "b" | "k" | "m" | "g";
const UNIT_PER_GB: Record<FreeUnit, number> = { b: 1024 ** 3, k: 1024 ** 2, m: 1024, g: 1 };

/**
 * Parse total memory in GB from `free` output, reading the `Mem:` row's total (second column). The unit is EXPLICIT
 * (the probe fixes it) rather than guessed from the header — a real `free -b` does not echo `-b`, so header-sniffing
 * is unreliable. Defaults to bytes to match CAPACITY_PROBE_CMD (`free -b`). null when unparseable. Pure.
 */
export function parseFreeTotalGB(raw: string, unit: FreeUnit = "b"): number | null {
  const mem = (raw ?? "").split("\n").find((l) => /^\s*Mem:/i.test(l));
  if (!mem) return null;
  const total = mem.trim().split(/\s+/)[1];
  const n = total != null ? Number.parseInt(total, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / UNIT_PER_GB[unit];
}

/** Convenience: capacity from raw `nproc` + `free -b` probe output (bytes). null when either is unparseable. Pure. */
export function capacityFromProbe(nprocRaw: string, freeRaw: string, unit: FreeUnit = "b"): number | null {
  const cores = parseNproc(nprocRaw);
  const memGB = parseFreeTotalGB(freeRaw, unit);
  if (cores == null || memGB == null) return null;
  return agentCapacity({ cores, memGB });
}

/** The one-line probe to run on the remote box; its stdout feeds capacityFromProbe as (nproc, free -b) halves. */
export const CAPACITY_PROBE_CMD = "nproc; free -b";
