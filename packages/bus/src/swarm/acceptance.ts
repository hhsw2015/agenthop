/**
 * Dispatcher-side acceptance guard (pure). After the git-channel pivot the dispatcher learns a box's progress by
 * observing its WORK branch, NOT by reading receipts. The raw git IO (ls-remote the tip, fetch that exact SHA, read
 * manifest.json FROM that SHA, `merge-base --is-ancestor` vs the last accepted SHA) lives in the dispatcher; this
 * module is the PURE decision over an already-observed tip, so the correctness rules Codex insisted on are
 * unit-testable:
 *   - pin a SHA and read the manifest FROM it (the caller passes both, never "manifest by branch after a tip read"),
 *   - current-generation only (a superseded incarnation's push is fenced out),
 *   - no-rollback: accept only a tip that is a DESCENDANT of the last accepted SHA (fast-forward is ancestry, not
 *     content — a commit can re-introduce an old tree, so ancestry alone is checked by the caller and asserted here),
 *   - EXPIRED recovery (#10): a newer confirmed tip observed after the VM already died updates the recovery SHA so a
 *     successor resumes from the newest confirmed work, without un-expiring the VM.
 */

import type { ControlEvent, ControlRecord } from "./control.js";
import { isCurrentGeneration } from "./control.js";
import type { Manifest } from "./manifest.js";

export type ObservedTip = {
  /** The pinned branch-tip commit SHA the dispatcher fetched. */
  sha: string;
  /** manifest.json parsed FROM that exact SHA (null if missing/invalid/oversize). */
  manifest: Manifest | null;
  /** `git merge-base --is-ancestor <lastAccepted> <sha>` — true when sha descends from the last accepted sha, OR
   *  when there is no prior accepted sha. The caller computes this; false => a non-fast-forward/rewrite, reject. */
  isDescendantOfAccepted: boolean;
};

export type Acceptance = { kind: "advance"; event: ControlEvent } | { kind: "skip"; reason: string };

/** Decide what, if anything, an observed WORK-branch tip should do to the control record. Pure. */
export function tipToEvent(record: ControlRecord, tip: ObservedTip): Acceptance {
  const m = tip.manifest;
  if (!m) return { kind: "skip", reason: "no/invalid manifest at tip" };
  if (m.launchId !== record.launchId) return { kind: "skip", reason: `launchId ${m.launchId} != ${record.launchId}` };
  if (!isCurrentGeneration(record, m.generation)) return { kind: "skip", reason: `stale generation ${m.generation} != ${record.generation}` };
  if (!tip.isDescendantOfAccepted) return { kind: "skip", reason: "tip not a descendant of last accepted sha (no-rollback)" };
  // Idempotent: we have already recorded this exact sha (sha is the single canonical confirmed checkpoint).
  if (record.sha === tip.sha) return { kind: "skip", reason: "already accepted" };

  // VM already dead, but a newer confirmed tip exists -> advance ONLY the recovery sha (Codex #10), stay EXPIRED.
  if (record.state === "EXPIRED") return { kind: "advance", event: { type: "recover_sha", sha: tip.sha } };

  switch (m.kind) {
    case "milestone":
    case "rescue":
      // Routine or best-effort snapshot: advances the confirmed sha, stays RUNNING. (A rescue is NOT a clean final;
      // it only records a recovery point.) Only valid while the box is actively running.
      if (record.state !== "RUNNING") return { kind: "skip", reason: `${m.kind} tip but record is ${record.state}` };
      return { kind: "advance", event: { type: "milestone", sha: tip.sha, manifest: m.next } };
    case "final":
      // A cooperatively-drained final tip: only accept once the dispatcher has moved the record to DRAINING for the
      // handoff. A final seen while still RUNNING means the drain barrier was not established — skip (degraded path
      // still has the sha via a prior milestone/rescue).
      if (record.state === "DRAINING") return { kind: "advance", event: { type: "checkpoint", sha: tip.sha, manifest: m.next } };
      return { kind: "skip", reason: `final tip but record is ${record.state} (need DRAINING)` };
  }
}
