import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  outputContractEnabled, isExpectedOutputKind, validateExpectedOutput, verifyExpectedOutput,
  probeExpectedOutput, presentUnmetToCoordinator, EXPECTED_OUTPUT_KINDS, type ExpectedOutput,
} from './output-contract.js';
import { createTask, readTask, parseTask } from '../tasklog.js';
import { writeInbox, claimInbox, ackInbox, composeInboxMsg } from '../inbox.js';

/** Count durable *.json cards across every inbox under <home>/.agenthop/inbox (for the S19 present assertions). */
const countCards = (home: string): number => {
  try { let n = 0; for (const d of readdirSync(join(home, ".agenthop", "inbox"), { withFileTypes: true })) if (d.isDirectory()) { try { n += readdirSync(join(home, ".agenthop", "inbox", d.name)).filter((x) => x.endsWith(".json")).length; } catch { /* unreadable box: skip */ } } return n; } catch { return 0; }
};

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

// ---------------- IO probe against a real tmp fs / git repo (OC-1..OC-5 regressions) ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    // --- file: met / empty-unmet / missing-unmet, + OC-2 (a directory is not a file) ---
    const f = join(home, "deliver.txt"); writeFileSync(f, "content");
    t('probe file: existing non-empty ⇒ met', verifyExpectedOutput({ kind: "file", ref: f }, probeExpectedOutput({ kind: "file", ref: f })) === "met");
    const empty = join(home, "empty.txt"); writeFileSync(empty, "");
    t('probe file: empty ⇒ unmet', verifyExpectedOutput({ kind: "file", ref: empty }, probeExpectedOutput({ kind: "file", ref: empty })) === "unmet");
    t('probe file: missing ⇒ unmet', verifyExpectedOutput({ kind: "file", ref: join(home, "nope") }, probeExpectedOutput({ kind: "file", ref: join(home, "nope") })) === "unmet");
    const dirAsFile = join(home, "adir"); mkdirSync(dirAsFile); writeFileSync(join(dirAsFile, "inner"), "stuff");
    t('OC-2 probe file: a directory (even non-empty) ⇒ unmet, never met', verifyExpectedOutput({ kind: "file", ref: dirAsFile }, probeExpectedOutput({ kind: "file", ref: dirAsFile })) === "unmet");

    // --- branch (real git repo): existing / bogus, + OC-3 (a tag is not a branch) ---
    const repo = join(home, "repo"); mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "x"); git("branch", "feat/present"); git("tag", "rel/tagonly");
    t('probe branch: existing ⇒ met', verifyExpectedOutput({ kind: "branch", ref: "feat/present" }, probeExpectedOutput({ kind: "branch", ref: "feat/present" }, { repoDir: repo })) === "met");
    t('probe branch: bogus ⇒ unmet', verifyExpectedOutput({ kind: "branch", ref: "no/such" }, probeExpectedOutput({ kind: "branch", ref: "no/such" }, { repoDir: repo })) === "unmet");
    t('OC-3 probe branch: a tag (not refs/heads/) ⇒ unmet, never met', verifyExpectedOutput({ kind: "branch", ref: "rel/tagonly" }, probeExpectedOutput({ kind: "branch", ref: "rel/tagonly" }, { repoDir: repo })) === "unmet");

    // --- report: a context-anchored commit citation, + OC-4 (a date / UUID is not a commit ref) ---
    const rep = join(home, "report.md"); writeFileSync(rep, "review done\nfixed SHA ddb8cda5f88fd1aeafbf5cde104393055bbe9293\n");
    t('probe report: present + labeled 40-hex sha ⇒ met', verifyExpectedOutput({ kind: "report", ref: rep }, probeExpectedOutput({ kind: "report", ref: rep })) === "met");
    const repNoSha = join(home, "nosha.md"); writeFileSync(repNoSha, "no sha here, just prose.");
    t('probe report: present, no commit ref ⇒ unmet', verifyExpectedOutput({ kind: "report", ref: repNoSha }, probeExpectedOutput({ kind: "report", ref: repNoSha })) === "unmet");
    const repDate = join(home, "date.md"); writeFileSync(repDate, "status: pending 20261011");
    t('OC-4 probe report: a bare date "20261011" (no label) ⇒ unmet', verifyExpectedOutput({ kind: "report", ref: repDate }, probeExpectedOutput({ kind: "report", ref: repDate })) === "unmet");
    const repUuid = join(home, "uuid.md"); writeFileSync(repUuid, "session 20cab0a5-b30e-4723-8399-7bc5cf78f6f7 ran");
    t('OC-4 probe report: a session UUID (no label) ⇒ unmet', verifyExpectedOutput({ kind: "report", ref: repUuid }, probeExpectedOutput({ kind: "report", ref: repUuid })) === "unmet");
    const repCn = join(home, "cn.md"); writeFileSync(repCn, "复核 固定 SHA:ddb8cda 通过");
    t('OC-4 probe report: a labeled "固定 SHA:ddb8cda" ⇒ met', verifyExpectedOutput({ kind: "report", ref: repCn }, probeExpectedOutput({ kind: "report", ref: repCn })) === "met");
    const repAt = join(home, "at.md"); writeFileSync(repAt, "基线 main @7b8e87c");
    t('OC-4 probe report: an "@7b8e87c" citation ⇒ met', verifyExpectedOutput({ kind: "report", ref: repAt }, probeExpectedOutput({ kind: "report", ref: repAt })) === "met");

    // --- inbox-delivery: processed/ archive still counts, + OC-5 (the REAL writeInbox→claim→ack lifecycle) ---
    const sid = "sid-xyz"; const pdir = join(home, ".agenthop", "inbox", sid, "processed"); mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "m.json"), JSON.stringify({ taskRef: "task-42", text: "done" }));
    t('probe inbox: processed/ has matching taskRef ⇒ met', verifyExpectedOutput({ kind: "inbox-delivery", ref: sid }, probeExpectedOutput({ kind: "inbox-delivery", ref: sid }, { home, taskRef: "task-42" })) === "met");
    t('OC-5 probe inbox: no matching taskRef ⇒ unknown, NOT unmet', verifyExpectedOutput({ kind: "inbox-delivery", ref: sid }, probeExpectedOutput({ kind: "inbox-delivery", ref: sid }, { home, taskRef: "task-99" })) === "unknown");
    // the real lifecycle: writeInbox publishes to the top level, claim renames to .claim-<pid>, ack DELETES it
    const live = "sid-live";
    writeInbox(home, live, composeInboxMsg({ from: "w", fromLabel: "worker", text: "done", via: "test", taskRef: "task-live" }));
    t('OC-5 probe inbox: just-published (top-level .json) ⇒ met', verifyExpectedOutput({ kind: "inbox-delivery", ref: live }, probeExpectedOutput({ kind: "inbox-delivery", ref: live }, { home, taskRef: "task-live" })) === "met");
    const claimed = claimInbox(home, [live], "claimer");
    t('OC-5 probe inbox: in-flight (.claim-<pid>) still ⇒ met', claimed.length === 1 && verifyExpectedOutput({ kind: "inbox-delivery", ref: live }, probeExpectedOutput({ kind: "inbox-delivery", ref: live }, { home, taskRef: "task-live" })) === "met");
    ackInbox(claimed[0].file);
    t('OC-5 probe inbox: after ack (file deleted) ⇒ unknown, NOT unmet', verifyExpectedOutput({ kind: "inbox-delivery", ref: live }, probeExpectedOutput({ kind: "inbox-delivery", ref: live }, { home, taskRef: "task-live" })) === "unknown");
    t('OC-5 probe inbox: never-sent ⇒ unknown, NOT unmet', verifyExpectedOutput({ kind: "inbox-delivery", ref: "sid-never" }, probeExpectedOutput({ kind: "inbox-delivery", ref: "sid-never" }, { home, taskRef: "task-x" })) === "unknown");

    // --- OC-1: a read fault (EACCES / not-a-repo) degrades to unknown, NEVER unmet (FC-2 r3) ---
    const notRepo = join(home, "notrepo"); mkdirSync(notRepo);
    t('OC-1 probe branch: not a git repo (git exit 128) ⇒ unknown, not unmet', verifyExpectedOutput({ kind: "branch", ref: "any" }, probeExpectedOutput({ kind: "branch", ref: "any" }, { repoDir: notRepo })) === "unknown");
    const canChmod = typeof process.getuid === "function" && process.getuid() !== 0; // root bypasses perms ⇒ EACCES unreproducible
    if (canChmod) {
      const secretDir = join(home, "secret"); mkdirSync(secretDir); const hidden = join(secretDir, "f.txt"); writeFileSync(hidden, "x"); chmodSync(secretDir, 0o000);
      try { t('OC-1 probe file: EACCES (unsearchable parent) ⇒ unknown, not unmet', verifyExpectedOutput({ kind: "file", ref: hidden }, probeExpectedOutput({ kind: "file", ref: hidden })) === "unknown"); }
      finally { chmodSync(secretDir, 0o755); }
      const lockedRep = join(home, "locked.md"); writeFileSync(lockedRep, "固定 SHA:ddb8cda\n"); chmodSync(lockedRep, 0o000);
      try { t('OC-1 probe report: EACCES (unreadable file) ⇒ unknown, not unmet', verifyExpectedOutput({ kind: "report", ref: lockedRep }, probeExpectedOutput({ kind: "report", ref: lockedRep })) === "unknown"); }
      finally { chmodSync(lockedRep, 0o644); }
      const lsid = "sid-locked"; const ldir = join(home, ".agenthop", "inbox", lsid); mkdirSync(ldir, { recursive: true });
      writeFileSync(join(ldir, "m.json"), JSON.stringify({ taskRef: "task-locked", text: "done" })); chmodSync(ldir, 0o000);
      try { t('OC-1 probe inbox: EACCES (unreadable box, a match exists) ⇒ unknown, never a false met or unmet', verifyExpectedOutput({ kind: "inbox-delivery", ref: lsid }, probeExpectedOutput({ kind: "inbox-delivery", ref: lsid }, { home, taskRef: "task-locked" })) === "unknown"); }
      finally { chmodSync(ldir, 0o755); }
    } else { t('OC-1 EACCES cases SKIPPED under root (perms unenforced)', true); }

    // --- S19 present: ONLY on unmet. An unmet writes exactly one card; an unknown (read fault) writes none (FC-2 r3 end-to-end). ---
    const beforeUnmet = countCards(home);
    presentUnmetToCoordinator(home, "coord-sid", "task-42", { kind: "file", ref: f });
    t('S19: presentUnmetToCoordinator writes one durable card', countCards(home) === beforeUnmet + 1);
    const beforeUnknown = countCards(home);
    { const v = verifyExpectedOutput({ kind: "branch", ref: "any" }, probeExpectedOutput({ kind: "branch", ref: "any" }, { repoDir: notRepo })); if (v === "unmet") presentUnmetToCoordinator(home, "coord-sid", "task-u", { kind: "branch", ref: "any" }); }
    t('FC-2 r3 end-to-end: an unknown verdict presents NO unmet card', countCards(home) === beforeUnknown);
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
