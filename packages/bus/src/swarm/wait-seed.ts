/**
 * Wait-seed validation (team-collab §0b R2, Codex review P2-5/R3). A migrated coordinator wait-seed is EXTERNAL input, so
 * it is validated at the boundary BEFORE it ever reaches the control-log: a malformed entry (missing owner, a null array
 * element, wrong shape) must be rejected with a reason and MUST NOT abort the import of the other, valid entries — a bad
 * seed record would otherwise commit once and then crash the sweep on every tick (resolveSession on an undefined owner),
 * starving every later valid wait, and the seed can't self-heal (its revision already exists). Pure; validated from
 * `unknown` so a `null`/primitive entry is a rejection, not a thrown exception.
 */

import type { WaitRecord } from "./control-log.js";

/** Validate one seed entry (bare WaitRecord or {put:"wait",wait}). Returns the WaitRecord, or a reason string to reject. */
export function validSeedWait(raw: unknown): WaitRecord | string {
  if (raw === null || typeof raw !== "object") return "entry is not an object"; // a null/primitive element must not throw
  const r = raw as Record<string, unknown>;
  const wRaw = r.put === "wait" && r.wait ? r.wait : r; // accept a bare WaitRecord or a {put:"wait",wait} wrapper
  if (wRaw === null || typeof wRaw !== "object") return "wait is not an object";
  const w = wRaw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!str(w.waitId)) return "missing/invalid waitId";
  if (w.kind !== "wait" && w.kind !== "approval") return `bad kind ${String(w.kind)}`;
  const subj = w.subject as Record<string, unknown> | undefined;
  if (typeof subj !== "object" || subj === null || !str(subj.jobId)) return "missing subject.jobId";
  if (w.state !== "open" && w.state !== "action_pending" && w.state !== "resolved") return `bad state ${String(w.state)}`;
  if (typeof w.deadlineSec !== "number" || !Number.isFinite(w.deadlineSec)) return "missing/invalid deadlineSec";
  if (!str(w.owner)) return "missing/invalid owner";
  if (w.timeoutPolicy !== "bypass" && w.timeoutPolicy !== "escalate") return `bad timeoutPolicy ${String(w.timeoutPolicy)}`;
  return w as unknown as WaitRecord;
}
