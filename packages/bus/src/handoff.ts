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
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const head = run(["rev-parse", "--short", "HEAD"]);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head && !branch) return undefined; // not a git repo, or git unavailable
  const status = run(["status", "--porcelain"]);
  const lines = status ? status.split("\n").filter(Boolean) : [];
  let out = `${branch && branch !== "HEAD" ? branch : "(detached)"} @ ${head ?? "?"}`;
  if (lines.length === 0) {
    out += "\nworking tree: clean";
  } else {
    const shown = lines.slice(0, STATUS_LINES).join("\n").slice(0, STATUS_CAP);
    out += `\nworking tree: ${lines.length} changed\n${shown}${lines.length > STATUS_LINES ? "\n  …" : ""}`;
  }
  return out;
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
