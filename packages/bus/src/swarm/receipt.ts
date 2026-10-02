/**
 * Swarm RECEIPT contract (pure). Codex pass-2 P2-2 showed the v2 permission model was contradictory: the box
 * cannot hold a CONTROL-write token (same UID as the worker => the worker could forge coordination state), yet
 * someone must register a confirmed checkpoint. Resolution: the box publishes an immutable RECEIPT to its OWN work
 * space (which its work token can already write); the dispatcher SCANS receipts, verifies them here, and
 * CAS-advances the CONTROL record. If the push succeeds but the CONTROL write is lost, a restart re-reads the
 * receipt and recovers — the confirmed fact never lives only in the dying box's memory.
 *
 * A receipt asserts "artifact `sha` is confirmed on the remote for (task=launchId, generation, requestId)". It is
 * HONORED only for the record's CURRENT generation (output isolation / stale-worker fencing) and can only ADVANCE
 * the record (never roll a confirmed sha back). No IO here — encode/parse/verify only, so the acceptance rules are
 * unit-testable against the control state machine.
 */

import type { ControlEvent, ControlRecord } from "./control.js";
import { isCurrentGeneration } from "./control.js";

export type ReceiptKind = "milestone" | "final" | "done";

export type Receipt = {
  launchId: string;
  generation: number;
  /** Stable id for this checkpoint request; the SAME requestId retried must carry the SAME sha (idempotency). */
  requestId: string;
  /** Monotonic sequence from the box supervisor (persisted across its restarts). CONTROL advances only on
   *  seq > lastSeq, so a replayed/older receipt can NEVER roll a confirmed sha back (Codex impl-review bug 2). */
  seq: number;
  kind: ReceiptKind;
  /** The confirmed remote artifact sha (git commit). Required and non-empty — a receipt without it is meaningless. */
  sha: string;
  manifest?: string;
  /** Epoch seconds the box wrote the receipt (box clock; informational only, never used for deadlines). */
  createdAt: number;
};

/** Max serialized receipt size we will parse — a receipt is tiny; anything larger is malformed/hostile. */
const MAX_RECEIPT_BYTES = 8 * 1024;
const KINDS: ReadonlySet<string> = new Set(["milestone", "final", "done"]);
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/** Canonical JSON with a fixed key order, so the same receipt serializes byte-identically (stable dedup/compare). */
export function encodeReceipt(r: Receipt): string {
  const ordered: Receipt = {
    launchId: r.launchId,
    generation: r.generation,
    requestId: r.requestId,
    seq: r.seq,
    kind: r.kind,
    sha: r.sha,
    ...(r.manifest !== undefined ? { manifest: r.manifest } : {}),
    createdAt: r.createdAt,
  };
  return JSON.stringify(ordered);
}

/** Parse + validate a receipt. Returns null for anything malformed (a reader during a temp+rename sees null, not a throw). */
export function parseReceipt(text: string): Receipt | null {
  if (!text || text.length > MAX_RECEIPT_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.launchId !== "string" || !o.launchId) return null;
  if (typeof o.generation !== "number" || !Number.isInteger(o.generation) || o.generation < 0) return null;
  if (typeof o.requestId !== "string" || !o.requestId) return null;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 1) return null;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  if (typeof o.sha !== "string" || !SHA_RE.test(o.sha)) return null;
  if (o.manifest !== undefined && typeof o.manifest !== "string") return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  return {
    launchId: o.launchId,
    generation: o.generation,
    requestId: o.requestId,
    seq: o.seq,
    kind: o.kind as ReceiptKind,
    sha: o.sha,
    manifest: o.manifest as string | undefined,
    createdAt: o.createdAt,
  };
}

export type ReceiptCheck =
  | { accept: true }
  | { accept: false; reason: string };

/**
 * Should the dispatcher honor this receipt for this record? A receipt is accepted only when it is for THIS task,
 * the CURRENT generation (a stale worker from a superseded incarnation is fenced out), and carries a sha. Honoring
 * is separate from "does it advance the state" (see receiptToEvent) — e.g. a duplicate milestone is acceptable but
 * advances nothing.
 */
export function receiptAcceptable(record: ControlRecord, receipt: Receipt): ReceiptCheck {
  if (receipt.launchId !== record.launchId) return { accept: false, reason: "launchId mismatch" };
  if (!isCurrentGeneration(record, receipt.generation))
    return { accept: false, reason: `stale generation ${receipt.generation} != ${record.generation}` };
  return { accept: true };
}

export type ReceiptOutcome =
  | { kind: "advance"; event: ControlEvent }
  | { kind: "duplicate" } // acceptable but already applied — idempotent no-op
  | { kind: "reject"; reason: string };

/**
 * Map an accepted receipt to the CONTROL event it should drive, against the current state. Pure: the caller then
 * runs advance() under an expected-OID CAS. Enforces no-rollback (a milestone that re-asserts the already-recorded
 * sha is a duplicate) and state legality (a `final` receipt only lands once the box has reached DRAINING).
 */
export function receiptToEvent(record: ControlRecord, receipt: Receipt): ReceiptOutcome {
  const acc = receiptAcceptable(record, receipt);
  if (!acc.accept) return { kind: "reject", reason: acc.reason };

  const lastSeq = record.lastSeq ?? 0;
  // Exact replay of the already-applied checkpoint: idempotent no-op.
  const isExactReplay = receipt.seq === lastSeq && receipt.sha === record.sha;
  // Any seq <= lastSeq that is NOT the exact replay is a rollback/conflict attempt — reject, never apply.
  const isStale = receipt.seq <= lastSeq;

  switch (receipt.kind) {
    case "milestone":
      if (record.state !== "RUNNING") return { kind: "reject", reason: `milestone receipt but state is ${record.state}` };
      if (isExactReplay) return { kind: "duplicate" };
      if (isStale) return { kind: "reject", reason: `stale/rollback milestone seq ${receipt.seq} <= ${lastSeq}` };
      return { kind: "advance", event: { type: "milestone", sha: receipt.sha, seq: receipt.seq, manifest: receipt.manifest } };
    case "final":
      if (record.state === "CHECKPOINTED" && isExactReplay) return { kind: "duplicate" };
      if (record.state !== "DRAINING") return { kind: "reject", reason: `final receipt but state is ${record.state} (need DRAINING)` };
      if (isStale) return { kind: "reject", reason: `stale/rollback final seq ${receipt.seq} <= ${lastSeq}` };
      return { kind: "advance", event: { type: "checkpoint", sha: receipt.sha, seq: receipt.seq, manifest: receipt.manifest } };
    case "done":
      if (record.state === "DONE" && isExactReplay) return { kind: "duplicate" };
      if (record.state === "DONE") return { kind: "reject", reason: "conflicting done receipt" };
      if (record.state !== "RUNNING" && record.state !== "DRAINING" && record.state !== "CHECKPOINTED")
        return { kind: "reject", reason: `done receipt but state is ${record.state}` };
      if (isStale) return { kind: "reject", reason: `stale/rollback done seq ${receipt.seq} <= ${lastSeq}` };
      return { kind: "advance", event: { type: "done", sha: receipt.sha, seq: receipt.seq } };
  }
}
