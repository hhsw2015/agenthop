/**
 * permission-gate-cli — the thin IO shell for the `agenthop permission-gate` subcommand (the SYNC Claude PermissionRequest hook,
 * approval-delegation ①). It only wires real dependencies into the tested, dependency-injected `runPermissionGate`
 * (swarm/approval-gate.ts); all logic lives there. Lazy-imported by bin.ts so its control-log / inbox / task-liveness imports
 * load only when this subcommand runs, not on every agenthop invocation.
 *
 * Dormant unless SWARM_APPROVAL_DELEGATE: when off (or no coordinator resolvable), it keeps ONLY the `blocked` status signal and
 * emits nothing — identical observable behavior to the async `report-status blocked` hook it replaces. The decision JSON (allow)
 * is the ONLY thing it ever writes to stdout, so it cannot corrupt a non-protocol channel.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { statusHome, writeStatusFile } from "./statusfile.js";
import { writeInbox, composeInboxMsg } from "./inbox.js";
import { resolveSession, listSessions } from "./swarm/task-liveness.js";
import { loadControlLog } from "./swarm/control-store.js";
import { liveEntities } from "./swarm/control-log.js";
import { approvalDelegateEnabled } from "./swarm/approval-delegation.js";
import { runPermissionGate, approvalInboxKey } from "./swarm/approval-gate.js";

/** Build the real deps and run the member-side gate. `startedAt` is the hook's event-time proxy (for the status seq);
 *  `readStdin` is bin.ts's shared TTY-safe hook-stdin reader. Fail-soft throughout: any IO fault degrades to "emit nothing"
 *  (the call falls to the user), never a throw and never an auto-grant. */
export async function runPermissionGateCli(startedAt: number, readStdin: () => Promise<Record<string, unknown> | undefined>): Promise<void> {
  const home = process.env.AH_HOME ?? homedir();
  const controlDir = join(home, ".agenthop", "swarm", "control-log");
  // Resolve the coordinator once (cheap same-machine scan) to address its dedicated approval key. No coordinator ⇒ nothing can
  // decide ⇒ writeApprovalRequest returns false ⇒ the gate emits nothing ⇒ user dialog. Fail-soft: a fault is "no coordinator".
  const coordHandle = process.env.SWARM_COORDINATOR?.trim();
  let coordSid: string | null = null;
  try { coordSid = coordHandle ? resolveSession(coordHandle, listSessions(home)) : null; } catch { coordSid = null; }

  await runPermissionGate({
    enabled: approvalDelegateEnabled(),
    newRequestId: () => randomUUID(), // a FRESH per-invocation flowback id (ADIO-P1-1) — never the user prompt_id, never a content hash
    readStdin,
    reportBlocked: (member) => { try { writeStatusFile(statusHome(), member, "blocked", { seq: startedAt }); } catch { /* status is best-effort */ } },
    writeApprovalRequest: (req) => {
      // Write to the coordinator's dedicated approval key (approvals:<coordSid>) the dispatcher drains — NOT the coordinator's
      // session inbox (no contention). The dispatcher polls it on its 5s sweep; a delegated decision lands in the control-log,
      // which the poll below reads back by this invocation's requestId.
      if (!coordSid) return false;
      try {
        writeInbox(home, approvalInboxKey(coordSid), composeInboxMsg({
          from: req.member, fromLabel: req.member,
          text: `[approval] ${req.tool}${req.command ? " " + req.command : ""}`.slice(0, 240),
          taskRef: "approval", title: `${req.member} permission gate`, approval: req,
        }));
        return true;
      } catch { return false; }
    },
    readDecision: (requestId) => {
      try {
        const entity = liveEntities(loadControlLog(controlDir))[`permissionDecision:${requestId}`];
        return entity && entity.put === "permissionDecision" ? entity.permissionDecision : null;
      } catch { return null; }
    },
    // AD-V1-P1-1: verify the pinned binary is a real regular file in THIS (the member's) env. lstat does NOT follow symlinks, so
    // a symlink-replacement / dangling link / directory all fail isFile() ⇒ the gate escalates. Absolute paths only; any fault ⇒ false.
    pinnedPathOk: (absPath) => { try { return absPath.startsWith("/") && lstatSync(absPath).isFile(); } catch { return false; } },
    emit: (jsonStr) => { process.stdout.write(jsonStr + "\n"); },
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
