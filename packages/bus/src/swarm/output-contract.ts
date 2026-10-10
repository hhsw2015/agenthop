/**
 * output-contract — the engine-mirror borrow ③ (CrewAI task.expected_output + guardrail), the DISTRIBUTED
 * reinforcement of AgentGate's EXIT-fingerprint principle: a CLAIM of delivery must attach VERIFIABLE physical
 * evidence. A dispatch/task may declare an expected output; at delivery-receipt the seam probes the filesystem
 * and classifies met / unmet / unknown. A VERIFICATION tag — never an authorization input.
 *
 * Split: a PURE core (types, flag, shape validation, verdict) + a thin best-effort IO shell (probe the fs/git/
 * inbox, present an unmet to the coordinator). DORMANT: gated behind SWARM_OUTPUT_CONTRACT (default OFF) — nothing
 * probes or stores a verdict, and it is wired into no live delivery path.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeInbox, composeInboxMsg } from "../inbox.js";

// ---- pure core (selftested) --------------------------------------------------

/** What kind of physical evidence a delivery must leave. */
export type ExpectedOutputKind = "file" | "branch" | "report" | "inbox-delivery";
export const EXPECTED_OUTPUT_KINDS: readonly ExpectedOutputKind[] = ["file", "branch", "report", "inbox-delivery"];

/** The declared output contract on a task. `ref` = the target (file path / branch name / report path / inbox
 *  sid); `check` = an optional named validator (reserved for a future richer check). */
export type ExpectedOutput = { kind: ExpectedOutputKind; ref?: string; check?: string };

/** Three-state — never a boolean. `unknown` = the probe could not tell (read error / absent probe); per FC-2 r3
 *  a read failure is NEVER asserted as `unmet`. */
export type OutputVerdict = "met" | "unmet" | "unknown";

/** Probed facts, one per kind (the IO shell fills the relevant one). true = satisfied, false = not satisfied,
 *  null/undefined = the probe errored or was not run ⇒ `unknown` (FC-2 r3: a read failure is not a verdict). */
export type OutputFacts = {
  fileExistsNonEmpty?: boolean | null;    // kind=file
  branchResolves?: boolean | null;        // kind=branch
  reportPresentWithSha?: boolean | null;  // kind=report
  inboxDelivered?: boolean | null;        // kind=inbox-delivery
};

export function outputContractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SWARM_OUTPUT_CONTRACT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function isExpectedOutputKind(v: unknown): v is ExpectedOutputKind {
  return typeof v === "string" && (EXPECTED_OUTPUT_KINDS as readonly string[]).includes(v);
}

/** Validate an ExpectedOutput shape from untrusted input (ledger read-side). A non-object, an invalid kind, or a
 *  non-string ref/check ⇒ null (drop it). Returns a FRESH copy with only the known fields. Pure. */
export function validateExpectedOutput(v: unknown): ExpectedOutput | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isExpectedOutputKind(o.kind)) return null;
  if (o.ref !== undefined && typeof o.ref !== "string") return null;
  if (o.check !== undefined && typeof o.check !== "string") return null;
  const out: ExpectedOutput = { kind: o.kind };
  if (typeof o.ref === "string") out.ref = o.ref;
  if (typeof o.check === "string") out.check = o.check;
  return out;
}

/** PURE: classify the declared output against probed facts. met / unmet / unknown. No clock (FC-6); a null/absent
 *  probe ⇒ `unknown` (FC-2 r3), never `unmet`. */
export function verifyExpectedOutput(expected: ExpectedOutput, facts: OutputFacts): OutputVerdict {
  const probe =
    expected.kind === "file" ? facts.fileExistsNonEmpty
    : expected.kind === "branch" ? facts.branchResolves
    : expected.kind === "report" ? facts.reportPresentWithSha
    : facts.inboxDelivered; // inbox-delivery
  if (probe === true) return "met";
  if (probe === false) return "unmet";
  return "unknown";
}

// ---- IO shell (best-effort; every read error degrades to null ⇒ unknown) -----

const SHA_LINE = /\b[0-9a-f]{7,64}\b/; // a git/sha token the report must cite (evidence it reviewed a real commit)

/** Probe the filesystem for the declared evidence. Best-effort: a read error on any probe yields null (⇒ unknown,
 *  FC-2 r3 — never a false `unmet`). `ctx.repoDir` for branch rev-parse, `ctx.home` + `ctx.taskRef` for inbox. */
export function probeExpectedOutput(expected: ExpectedOutput, ctx: { repoDir?: string; home?: string; taskRef?: string } = {}): OutputFacts {
  switch (expected.kind) {
    case "file": {
      if (!expected.ref) return { fileExistsNonEmpty: null };
      try { return { fileExistsNonEmpty: existsSync(expected.ref) && statSync(expected.ref).size > 0 }; }
      catch { return { fileExistsNonEmpty: null }; }
    }
    case "branch": {
      if (!expected.ref) return { branchResolves: null };
      try { execFileSync("git", ["rev-parse", "--verify", "--quiet", expected.ref], { cwd: ctx.repoDir ?? process.cwd(), stdio: ["ignore", "ignore", "ignore"] }); return { branchResolves: true }; }
      catch (e) { return { branchResolves: (e as { status?: number }).status === 1 ? false : null }; } // exit 1 = no such rev; git missing/other = unknown
    }
    case "report": {
      if (!expected.ref) return { reportPresentWithSha: null };
      try { if (!existsSync(expected.ref)) return { reportPresentWithSha: false }; return { reportPresentWithSha: SHA_LINE.test(readFileSync(expected.ref, "utf8")) }; }
      catch { return { reportPresentWithSha: null }; }
    }
    case "inbox-delivery": {
      if (!expected.ref || !ctx.taskRef || !ctx.home) return { inboxDelivered: null };
      try {
        const dir = path.join(ctx.home, ".agenthop", "inbox", expected.ref, "processed");
        if (!existsSync(dir)) return { inboxDelivered: false };
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          try { const m = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { taskRef?: unknown }; if (m && m.taskRef === ctx.taskRef) return { inboxDelivered: true }; }
          catch { /* skip one unreadable/corrupt file, keep scanning */ }
        }
        return { inboxDelivered: false };
      } catch { return { inboxDelivered: null }; }
    }
  }
}

/**
 * S19 — present an UNMET output contract to the coordinator (dormant seam). A task CLAIMED delivery but its
 * declared evidence did not verify. Writes ONE durable-inbox card. Only call on an `unmet` verdict — an
 * `unknown` is never asserted (FC-2 r3). Not auto-wired: the delivery-receipt handler calls it when armed.
 */
export function presentUnmetToCoordinator(home: string, coordinatorId: string, taskId: string, expected: ExpectedOutput): void {
  writeInbox(home, coordinatorId, composeInboxMsg({
    from: coordinatorId,
    fromLabel: "output-contract",
    text: `task ${taskId} CLAIMED delivered but its output contract did NOT verify — kind=${expected.kind}${expected.ref ? ` ref=${expected.ref}` : ""}. A claim must attach verifiable evidence (AgentGate EXIT-fingerprint, distributed). Re-check the deliverable or halt the ticket.`,
    via: "output-contract",
    taskRef: `output-contract:${taskId}`,
    title: "output contract UNMET — decide",
  }));
}
