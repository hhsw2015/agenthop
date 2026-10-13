/**
 * F57 — IO for the content-filter-succession suggestion (read-only). The ONLY source it reads is the review-reports directory, to
 * assemble a stuck review seat's best-effort in-review checklist for the handoff letter. It writes nothing durable: the suggestion
 * is delivered through the dispatcher's existing notifyCoordinator sink (the coordinator inbox), and the per-pane consecutive-hit
 * counter is in-memory in the sweep. FC-2 three-state on the read: a fault is NEVER folded to a confident "empty".
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ReviewChecklist } from "./content-filter-succession.js";

/** The review-reports dir — same resolution as retro-store: RETRO_REVIEW_REPORTS_DIR overrides, else ~/Work/review-reports (it
 *  lives OUTSIDE the agenthop home). */
export function reviewReportsDir(homeForUser: string = homedir()): string {
  return process.env.RETRO_REVIEW_REPORTS_DIR || path.join(homeForUser, "Work", "review-reports");
}

/**
 * Best-effort in-review checklist for a review seat: the review-report dir names that carry its reviewer id. FC-2 three-state:
 * ENOENT ⇒ absent (the dir genuinely is not there); any OTHER readdir fault (EACCES/…) ⇒ unreadable (never folded to empty — the
 * letter then says "verify manually" rather than "nothing to do"). A blank reviewerId ⇒ absent (we cannot attribute a queue).
 * Over-listing (done + in-flight dirs) is deliberate and safe: the handoff letter directs the successor to verify each item's
 * current verdict and skip already-signed ones.
 */
export function readInReviewChecklist(dir: string, reviewerId: string): ReviewChecklist {
  const rid = reviewerId.trim();
  if (!rid) return { items: [], status: "absent" };
  let names: string[];
  try { names = readdirSync(dir); }
  catch (e) { return { items: [], status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  const items = names.filter((n) => !n.startsWith(".") && n.includes(rid)).sort();
  return { items, status: "read" };
}
