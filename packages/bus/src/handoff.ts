import { execFileSync } from "node:child_process";

/**
 * A task handoff over the bus. The sending agent authors the summary — it has its own conversation, the
 * bus does not — and the bus enriches it with an objective git snapshot of the sender's working
 * directory, then delivers it as an ordinary bus message. Like any cross-tool handoff, it can carry
 * only VISIBLE, author-provided context plus git state, never the source session's hidden internal
 * state: the receiver continues from this checkpoint, it does not inherit the sender's memory.
 *
 * This is deliberately not a controller/UI "switch the engine under one conversation" — the bus is
 * decentralized, so a handoff moves a task from one live session to another; the human/agent continues
 * in the receiving session.
 */

const SUMMARY_CAP = 12_000; // bound the checkpoint like a visible-transcript window
const NEXT_CAP = 4_000;
const STATUS_LINES = 40;
const STATUS_CAP = 4_000;

export type HandoffInput = { summary: string; next?: string };

/** A short, human-readable git snapshot of `cwd`, or undefined if it is not a git repo / git is absent. */
export function gitSnapshotText(cwd: string): string | undefined {
  // Return success separately from output: an empty-but-successful `status` (clean tree) must never be
  // conflated with a FAILED status (a failure would otherwise be misreported as "clean"). Give git a
  // generous buffer so a large-but-normal status is read rather than hitting ENOBUFS -> failure.
  const git = (args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return { ok: true, out };
    } catch {
      return { ok: false, out: "" };
    }
  };

  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return undefined; // not a git repo, or git absent

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]);
  const branchName = branch.ok && branch.out.trim() && branch.out.trim() !== "HEAD" ? branch.out.trim() : undefined;
  let headLine: string;
  if (head.ok && head.out.trim()) {
    headLine = `${branchName ?? "(detached)"} @ ${head.out.trim()}`;
  } else {
    // rev-parse HEAD failed. Only call it "no commits yet" when POSITIVELY confirmed unborn — HEAD is a
    // symbolic ref to a branch AND the repo has zero commits anywhere. A broken HEAD (e.g. a corrupt
    // branch ref) fails both checks and must not be misreported as unborn; say "unknown" instead.
    const sym = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const anyCommit = git(["rev-list", "-n", "1", "--all"]);
    if (sym.ok && sym.out.trim() && anyCommit.ok && anyCommit.out.trim() === "") {
      headLine = `${sym.out.trim()} @ (no commits yet)`;
    } else {
      headLine = "HEAD: unknown";
    }
  }

  const status = git(["status", "--porcelain"]);
  let treeLine: string;
  if (!status.ok) {
    treeLine = "working tree: unknown (git status failed)"; // never claim clean when we could not read it
  } else {
    // Strip ONLY a trailing newline — porcelain's leading status columns (e.g. " M file") are meaningful,
    // so the whole output must not be trimmed.
    const body = status.out.replace(/\n+$/, "");
    const lines = body ? body.split("\n") : [];
    if (lines.length === 0) {
      treeLine = "working tree: clean";
    } else {
      const shown = lines.slice(0, STATUS_LINES).join("\n").slice(0, STATUS_CAP);
      treeLine = `working tree: ${lines.length} changed\n${shown}${lines.length > STATUS_LINES ? "\n  …" : ""}`;
    }
  }
  return `${headLine}\n${treeLine}`;
}

/** Build the handoff message the receiver will see. `from` is the sender's handle; `cwd` is snapshotted. */
export function formatHandoff(from: string, input: HandoffInput, cwd: string): string {
  const summary = input.summary.trim().slice(0, SUMMARY_CAP);
  const next = input.next?.trim().slice(0, NEXT_CAP);
  const git = gitSnapshotText(cwd);
  const parts = [
    `[handoff from ${from}] Pick up this task and continue it. This checkpoint is the visible context only — you do not have my hidden state, so ask if something is unclear rather than assuming.`,
    "",
    "## Task",
    summary || "(no summary provided)",
  ];
  if (next) parts.push("", "## Next", next);
  if (git) parts.push("", `## Git (${cwd})`, git);
  return parts.join("\n");
}
