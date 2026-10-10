import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  outputContractEnabled, isExpectedOutputKind, validateExpectedOutput, verifyExpectedOutput,
  probeExpectedOutput, presentUnmetToCoordinator, EXPECTED_OUTPUT_KINDS, type ExpectedOutput,
} from './output-contract.js';
import { createTask, readTask, parseTask } from '../tasklog.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };

// ---------------- flag (dormant default OFF) ----------------
t('outputContractEnabled: default OFF, armed only by explicit truthy',
  !outputContractEnabled({} as NodeJS.ProcessEnv)
  && outputContractEnabled({ SWARM_OUTPUT_CONTRACT: '1' } as unknown as NodeJS.ProcessEnv)
  && outputContractEnabled({ SWARM_OUTPUT_CONTRACT: 'on' } as unknown as NodeJS.ProcessEnv)
  && !outputContractEnabled({ SWARM_OUTPUT_CONTRACT: '0' } as unknown as NodeJS.ProcessEnv));

// ---------------- kinds + shape validation ----------------
t('EXPECTED_OUTPUT_KINDS are the four', EXPECTED_OUTPUT_KINDS.join(",") === "file,branch,report,inbox-delivery");
t('isExpectedOutputKind valid/invalid', isExpectedOutputKind("file") && isExpectedOutputKind("inbox-delivery") && !isExpectedOutputKind("socket") && !isExpectedOutputKind(7));
t('validateExpectedOutput: valid kind-only + kind/ref/check round-trip', (() => { const a = validateExpectedOutput({ kind: "file" }); const b = validateExpectedOutput({ kind: "branch", ref: "feat/x", check: "rev" }); return !!a && a.kind === "file" && a.ref === undefined && !!b && b.ref === "feat/x" && b.check === "rev"; })());
t('validateExpectedOutput: bad kind / non-string ref / non-object ⇒ null', validateExpectedOutput({ kind: "nope" }) === null && validateExpectedOutput({ kind: "file", ref: 7 }) === null && validateExpectedOutput(null) === null && validateExpectedOutput("x") === null);
t('validateExpectedOutput: strips unknown extra fields', (() => { const v = validateExpectedOutput({ kind: "file", ref: "p", junk: 1, nested: {} } as Record<string, unknown>); return !!v && Object.keys(v).sort().join(",") === "kind,ref"; })());

// ---------------- verifyExpectedOutput: three-state per kind (pure, no clock = FC-6) ----------------
const kinds: [ExpectedOutput, keyof import('./output-contract.js').OutputFacts][] = [
  [{ kind: "file" }, "fileExistsNonEmpty"], [{ kind: "branch" }, "branchResolves"],
  [{ kind: "report" }, "reportPresentWithSha"], [{ kind: "inbox-delivery" }, "inboxDelivered"],
];
for (const [exp, key] of kinds) {
  t(`verify ${exp.kind}: probe true ⇒ met`, verifyExpectedOutput(exp, { [key]: true }) === "met");
  t(`verify ${exp.kind}: probe false ⇒ unmet`, verifyExpectedOutput(exp, { [key]: false }) === "unmet");
  t(`verify ${exp.kind}: probe null/absent ⇒ unknown (FC-2 r3, never unmet)`, verifyExpectedOutput(exp, { [key]: null }) === "unknown" && verifyExpectedOutput(exp, {}) === "unknown");
}
t('FC-6: verify is deterministic, no clock', verifyExpectedOutput({ kind: "file" }, { fileExistsNonEmpty: true }) === verifyExpectedOutput({ kind: "file" }, { fileExistsNonEmpty: true }));

// ---------------- IO probe against a real tmp fs / git repo ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    // file
    const f = join(home, "deliver.txt"); writeFileSync(f, "content");
    t('probe file: existing non-empty ⇒ met', verifyExpectedOutput({ kind: "file", ref: f }, probeExpectedOutput({ kind: "file", ref: f })) === "met");
    const empty = join(home, "empty.txt"); writeFileSync(empty, "");
    t('probe file: empty ⇒ unmet', verifyExpectedOutput({ kind: "file", ref: empty }, probeExpectedOutput({ kind: "file", ref: empty })) === "unmet");
    t('probe file: missing ⇒ unmet', verifyExpectedOutput({ kind: "file", ref: join(home, "nope") }, probeExpectedOutput({ kind: "file", ref: join(home, "nope") })) === "unmet");
    // branch (real git repo)
    const repo = join(home, "repo"); mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "x"); git("branch", "feat/present");
    t('probe branch: existing ⇒ met', verifyExpectedOutput({ kind: "branch", ref: "feat/present" }, probeExpectedOutput({ kind: "branch", ref: "feat/present" }, { repoDir: repo })) === "met");
    t('probe branch: bogus ⇒ unmet', verifyExpectedOutput({ kind: "branch", ref: "no/such" }, probeExpectedOutput({ kind: "branch", ref: "no/such" }, { repoDir: repo })) === "unmet");
    // report (file + sha line)
    const rep = join(home, "report.md"); writeFileSync(rep, "review done\nfixed SHA ddb8cda5f88fd1aeafbf5cde104393055bbe9293\n");
    t('probe report: present + sha line ⇒ met', verifyExpectedOutput({ kind: "report", ref: rep }, probeExpectedOutput({ kind: "report", ref: rep })) === "met");
    const repNoSha = join(home, "nosha.md"); writeFileSync(repNoSha, "no sha here, just prose.");
    t('probe report: present, no sha ⇒ unmet', verifyExpectedOutput({ kind: "report", ref: repNoSha }, probeExpectedOutput({ kind: "report", ref: repNoSha })) === "unmet");
    // inbox-delivery (processed/ has a file with the taskRef)
    const sid = "sid-xyz"; const pdir = join(home, ".agenthop", "inbox", sid, "processed"); mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "m.json"), JSON.stringify({ taskRef: "task-42", text: "done" }));
    t('probe inbox: processed/ has matching taskRef ⇒ met', verifyExpectedOutput({ kind: "inbox-delivery", ref: sid }, probeExpectedOutput({ kind: "inbox-delivery", ref: sid }, { home, taskRef: "task-42" })) === "met");
    t('probe inbox: no matching taskRef ⇒ unmet', verifyExpectedOutput({ kind: "inbox-delivery", ref: sid }, probeExpectedOutput({ kind: "inbox-delivery", ref: sid }, { home, taskRef: "task-99" })) === "unmet");

    // S19 present on unmet: writes one durable card
    const before = (() => { try { let n = 0; for (const d of readdirSync(join(home, ".agenthop", "inbox"), { withFileTypes: true })) if (d.isDirectory()) n += readdirSync(join(home, ".agenthop", "inbox", d.name)).filter((x) => x.endsWith(".json")).length; return n; } catch { return 0; } })();
    presentUnmetToCoordinator(home, "coord-sid", "task-42", { kind: "file", ref: f });
    const after = (() => { let n = 0; for (const d of readdirSync(join(home, ".agenthop", "inbox"), { withFileTypes: true })) if (d.isDirectory()) n += readdirSync(join(home, ".agenthop", "inbox", d.name)).filter((x) => x.endsWith(".json")).length; return n; })();
    t('S19: presentUnmetToCoordinator writes one durable card', after === before + 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ---------------- tasklog integration: carry-through + read-side validate + FC-7 ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'oc-tl-'));
  try {
    const rec = createTask(home, { dispatchedBy: "d", assignees: ["w"], expectedOutput: { kind: "report", ref: "/r.md", junk: 1 } as ExpectedOutput })!;
    t('tasklog: createTask stores a sanitized expectedOutput (extra stripped)', !!rec.expectedOutput && rec.expectedOutput.kind === "report" && rec.expectedOutput.ref === "/r.md" && (rec.expectedOutput as Record<string, unknown>).junk === undefined);
    t('tasklog: expectedOutput round-trips', readTask(home, rec.taskId)!.expectedOutput!.kind === "report");
    const bad = createTask(home, { dispatchedBy: "d", assignees: ["w"], expectedOutput: { kind: "socket" } as unknown as ExpectedOutput })!;
    t('tasklog: a malformed expectedOutput is NOT stored', bad.expectedOutput === undefined);
    const plain = createTask(home, { dispatchedBy: "d", assignees: ["w"] })!;
    t('tasklog: no expectedOutput ⇒ field absent (dormant default)', plain.expectedOutput === undefined);
    // real-disk read-side drop of a corrupt field
    const corrupt = { taskId: "t-oc-disk-01", dispatchedBy: "d", assignees: ["w"], state: "PENDING", createdAt: 1, updatedAt: 1, results: [], expectedOutput: { kind: "bogus", ref: 7 } };
    const rp = parseTask(JSON.stringify(corrupt));
    t('read-side: corrupt expectedOutput dropped, base task kept', !!rp && rp.expectedOutput === undefined && rp.dispatchedBy === "d");
    // FC-7: legacy record (no field) parses
    const legacy = { taskId: "t-oc-legacy", dispatchedBy: "old", assignees: ["x"], state: "PENDING", createdAt: 1, updatedAt: 1, results: [] };
    t('FC-7: legacy record parses, expectedOutput undefined', (() => { const l = parseTask(JSON.stringify(legacy)); return !!l && l.expectedOutput === undefined; })());
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log('\noutput-contract self-check OK');
