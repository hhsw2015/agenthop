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
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
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

// ---- IO shell (best-effort; a read fault degrades to null ⇒ unknown, NEVER a false `unmet` — FC-2 r3) ----------
//
// Every probe here must itself pass the FC-2 r3 judgment: a read it could not complete is UNKNOWN, never a negative
// verdict. The three probe discriminators below each defeat a concrete way the old loose probes mis-classified
// evidence (OC-1 swallowed read errors as `unmet`; OC-2 a dir passed `file`; OC-3 a tag passed `branch`; OC-4 a
// date/UUID passed `report`; OC-5 a normally-delivered message was judged `unmet` because ack had deleted it).

/** errno-aware stat. A path is "absent" ONLY on a CONFIRMED ENOENT; any other error ("unknown") must NOT be read as
 *  absence — a transient/EACCES fault read as absence would license a false `unmet` (OC-1 / FC-2 r3). */
function statProbe(p: string): { kind: "absent" } | { kind: "ok"; st: Stats } | { kind: "unknown" } {
  try { return { kind: "ok", st: statSync(p) }; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" }; }
}

/** OC-4: a report's commit citation must be CONTEXT-ANCHORED — a label (固定 / sha / sha256 / commit / @) immediately
 *  before a 7-64 hex token at word boundaries. A bare unlabeled hex run (a date "20261011", a session-UUID segment)
 *  is NOT a commit reference and must not pass. The repo's real citation forms ("固定 SHA:ddb8cda", "@7b8e87c",
 *  "报告SHA256: <64hex>", "fixed SHA <40hex>") all carry such a label; a date/UUID does not. */
const COMMIT_REF = /(?:固定\s*)?(?:\bsha(?:[-\s]?256)?\b|\bcommit\b|@)[:\s]*\b[0-9a-f]{7,64}\b/i;
function reportCitesCommit(txt: string): boolean { return COMMIT_REF.test(txt); }

/** Apply the same path sanitization writeInbox uses, so the inbox probe reads the SAME directory a real publish wrote. */
function inboxSid(ref: string): string { return ref.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown"; }

/** Probe the filesystem for the declared evidence. Best-effort: a read fault on any probe yields null (⇒ unknown,
 *  FC-2 r3 — never a false `unmet`). `ctx.repoDir` for the branch check, `ctx.home` + `ctx.taskRef` for the inbox. */
export function probeExpectedOutput(expected: ExpectedOutput, ctx: { repoDir?: string; home?: string; taskRef?: string } = {}): OutputFacts {
  switch (expected.kind) {
    case "file": {
      if (!expected.ref) return { fileExistsNonEmpty: null };
      const s = statProbe(expected.ref);
      if (s.kind === "unknown") return { fileExistsNonEmpty: null };   // OC-1: read fault ⇒ unknown, never unmet
      if (s.kind === "absent") return { fileExistsNonEmpty: false };   // confirmed ENOENT ⇒ unmet
      return { fileExistsNonEmpty: s.st.isFile() && s.st.size > 0 };   // OC-2: a dir (or an empty file) is NOT a delivered file
    }
    case "branch": {
      if (!expected.ref) return { branchResolves: null };
      const name = expected.ref.replace(/^refs\/heads\//, "");         // OC-3: always verify the BRANCH namespace, never a tag/commit
      try { execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: ctx.repoDir ?? process.cwd(), stdio: ["ignore", "ignore", "ignore"] }); return { branchResolves: true }; }
      catch (e) { return { branchResolves: (e as { status?: number }).status === 1 ? false : null }; } // exit 1 = no such branch; git missing/not-a-repo (128) ⇒ unknown
    }
    case "report": {
      if (!expected.ref) return { reportPresentWithSha: null };
      const s = statProbe(expected.ref);
      if (s.kind === "unknown") return { reportPresentWithSha: null }; // OC-1
      if (s.kind === "absent") return { reportPresentWithSha: false };
      if (!s.st.isFile()) return { reportPresentWithSha: false };      // a directory is not a report
      try { return { reportPresentWithSha: reportCitesCommit(readFileSync(expected.ref, "utf8")) }; } // OC-4
      catch { return { reportPresentWithSha: null }; }                 // OC-1: read fault ⇒ unknown
    }
    case "inbox-delivery": {
      if (!expected.ref || !ctx.taskRef || !ctx.home) return { inboxDelivered: null };
      // OC-5: the durable landing credential is "the message is in the box" — a top-level file (a published `.json`, or an
      // in-flight `.claim-<pid>` rename) OR a `processed/` archive. A taskRef match ⇒ met. ABSENCE is NOT proof of
      // non-delivery: ack DELETES the claimed file, so a normally delivered+consumed message leaves no trace ⇒ unknown
      // (never `unmet`; FC-2 r3 family). A read fault likewise yields no positive match ⇒ unknown, never a false unmet.
      const base = path.join(ctx.home, ".agenthop", "inbox", inboxSid(expected.ref));
      const matches = (raw: string): boolean => { try { const m = JSON.parse(raw) as { taskRef?: unknown }; return !!m && m.taskRef === ctx.taskRef; } catch { return false; } };
      const scan = (dir: string): boolean => {
        let names: string[];
        try { names = readdirSync(dir); } catch { return false; } // dir absent/unreadable ⇒ no positive match here (⇒ unknown overall, never unmet)
        for (const f of names) {
          if (!(f.endsWith(".json") || f.includes(".claim-"))) continue; // a published `.json` or an in-flight `.claim-<claimer>`
          try { if (matches(readFileSync(path.join(dir, f), "utf8"))) return true; } catch { /* one unreadable file: keep scanning */ }
        }
        return false;
      };
      const found = scan(base) || scan(path.join(base, "processed"));
      return { inboxDelivered: found ? true : null }; // OC-5: found ⇒ met; otherwise unknown (never unmet — absence is ambiguous post-ack)
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
