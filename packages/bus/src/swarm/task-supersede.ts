/**
 * Supersede cascade (§4.2 "上游重跑的下游失效") — PURE judgment. T2. When an upstream accepted result is explicitly
 * superseded (a repair/review produced a replacement, or a human overrode it), everything that was bound to it must be
 * handled IN THE SAME CONTROL batch. This module computes the suggested ChangeBody list; it does NOT commit, and it
 * does NOT attach operation identity — the IO caller wraps each ChangeBody with { operationId, expectedEntityRevision }
 * read from the current LogState and commits them as one group-atomic batch (§4.3).
 *
 * The three downstream dispositions (§4.2):
 *  - a RUNNING attempt that never started executing (no activated binding) → ABANDONED(stale-input), no retry charge
 *    (via the task-state `revoke` transition);
 *  - a RUNNING attempt already executing → LEFT ALONE (it can't be killed; V4 rejects it at validation → ABANDONED);
 *  - a SUCCEEDED downstream → its own accepted result is cascade-superseded (recursive, DAG-bounded).
 *
 * Completion is never patched by hand: a superseded accepted makes currentAccepted recursively null (task-ready), so
 * SUCCEEDED attempts stay as audit and the cascade only needs to flip the accepted flags + abandon the un-started
 * attempts. Dedup (superseded ids + handled attempts) guarantees no entity appears twice in the batch (which
 * commitControl would reject).
 */

import { type TaskAttempt, advanceAttempt } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import type { ChangeBody } from "./control-log.js";

export type CascadeInput = {
  rootAcceptedResultId: string;
  attempts: TaskAttempt[];
  acceptedResults: AcceptedResult[];
};

/** Compute the same-batch ChangeBody list to supersede `rootAcceptedResultId` and dispose of everything bound to it
 *  (and, recursively, everything bound to a downstream whose accepted gets cascade-superseded). */
export function supersedeCascade(input: CascadeInput): ChangeBody[] {
  const { attempts, acceptedResults } = input;
  const out: ChangeBody[] = [];
  const supersededIds = new Set<string>();
  const handledAttempts = new Set<string>();
  const queue: string[] = [input.rootAcceptedResultId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (supersededIds.has(id)) continue;
    supersededIds.add(id);
    out.push({ put: "supersede", acceptedResultId: id });

    for (const a of attempts) {
      if (handledAttempts.has(a.attemptId)) continue;
      if (!a.inputBindings.some((ib) => ib.acceptedResultId === id)) continue;

      if (a.status === "RUNNING") {
        // nowSec is irrelevant to revoke; pass 0. Succeeds only when no binding is activated (§4.2 "未启动派发").
        const adv = advanceAttempt(a, { type: "revoke", reason: "stale-input" }, 0);
        if (adv.ok) {
          out.push({ put: "attempt", attempt: adv.attempt });
          handledAttempts.add(a.attemptId);
        }
        // else: already executing — leave it; V4 will reject it at validation time.
      } else if (a.status === "SUCCEEDED") {
        handledAttempts.add(a.attemptId);
        // cascade: supersede this downstream's own accepted result(s).
        for (const r of acceptedResults) {
          if (r.attemptId === a.attemptId && !supersededIds.has(r.acceptedResultId)) queue.push(r.acceptedResultId);
        }
      }
      // RETRY_WAIT / FAILED / ABANDONED referencing a superseded input: left as-is (a succession re-resolves inputs).
    }
  }
  return out;
}
