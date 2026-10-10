import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionEnabled, resolveAccountable, isResolutionLevel, RESOLUTION_LEVELS, type AttributionInput } from './attribution.js';
import { createTask, readTask, parseTask, applyResult, taskLogDir } from '../tasklog.js';

const t = (n: string, c: boolean) => { if (!c) throw new Error('FAILED: ' + n); console.log('ok  ' + n); };

// ---------------- flag (dormant default OFF) ----------------
t('attributionEnabled: default OFF, armed only by explicit truthy',
  !attributionEnabled({} as NodeJS.ProcessEnv)
  && attributionEnabled({ SWARM_ATTRIBUTION: '1' } as unknown as NodeJS.ProcessEnv)
  && attributionEnabled({ SWARM_ATTRIBUTION: 'true' } as unknown as NodeJS.ProcessEnv)
  && attributionEnabled({ SWARM_ATTRIBUTION: 'on' } as unknown as NodeJS.ProcessEnv)
  && !attributionEnabled({ SWARM_ATTRIBUTION: '0' } as unknown as NodeJS.ProcessEnv)
  && !attributionEnabled({ SWARM_ATTRIBUTION: 'off' } as unknown as NodeJS.ProcessEnv));

// ---------------- the 5-level waterfall ----------------
t('RESOLUTION_LEVELS are the five, in priority order', RESOLUTION_LEVELS.join(",") === "direct,delegated,comment-source,automation-owner,fallback");
t('isResolutionLevel: valid vs invalid', isResolutionLevel("direct") && isResolutionLevel("fallback") && !isResolutionLevel("blame") && !isResolutionLevel(7));

const full: AttributionInput = { directHuman: "u-direct", delegationOriginHuman: "u-deleg", commentSourceHuman: "u-comment", automationOwnerHuman: "u-auto", fallbackHuman: "u-fb" };
t('direct wins when present (highest priority)', JSON.stringify(resolveAccountable(full)) === JSON.stringify({ accountableHuman: "u-direct", resolutionLevel: "direct" }));
t('delegated wins when no direct', resolveAccountable({ ...full, directHuman: undefined })!.resolutionLevel === "delegated");
t('comment-source wins when no direct/delegated', resolveAccountable({ commentSourceHuman: "u-c", automationOwnerHuman: "u-a", fallbackHuman: "u-f" })!.resolutionLevel === "comment-source");
t('automation-owner wins when only it + fallback', resolveAccountable({ automationOwnerHuman: "u-a", fallbackHuman: "u-f" })!.resolutionLevel === "automation-owner");
t('fallback is the last resort', (() => { const a = resolveAccountable({ fallbackHuman: "u-f" })!; return a.resolutionLevel === "fallback" && a.accountableHuman === "u-f"; })());
t('NO level resolves ⇒ null (never invent a human)', resolveAccountable({}) === null && resolveAccountable({ directHuman: "   " }) === null);
t('whitespace-only is not a resolution; trims the winner', resolveAccountable({ directHuman: "  ", delegationOriginHuman: "  u-d  " })!.accountableHuman === "u-d" && resolveAccountable({ directHuman: "  ", delegationOriginHuman: "  u-d  " })!.resolutionLevel === "delegated");

// ---------------- FC-6: deterministic by LEVEL, never a clock ----------------
t('FC-6: resolution is deterministic (same input ⇒ identical output, no clock)', JSON.stringify(resolveAccountable(full)) === JSON.stringify(resolveAccountable(full)));
t('FC-6: a higher level ALWAYS wins regardless of order of other fields (no latest-wins)', resolveAccountable({ fallbackHuman: "z", directHuman: "a" })!.resolutionLevel === "direct");

// ---------------- tasklog integration: seam carry-through + FC-7 legacy tolerance ----------------
{
  const home = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    // seam ON path: a caller computed attribution and passes it ⇒ carried through + round-trips
    const a = resolveAccountable({ directHuman: "wowdd1" })!;
    const rec = createTask(home, { dispatchedBy: "coordinator", assignees: ["w1"], goal: "g", accountableHuman: a.accountableHuman, resolutionLevel: a.resolutionLevel })!;
    t('tasklog: createTask carries attribution fields', rec.accountableHuman === "wowdd1" && rec.resolutionLevel === "direct");
    const back = readTask(home, rec.taskId)!;
    t('tasklog: attribution round-trips through write/read', back.accountableHuman === "wowdd1" && back.resolutionLevel === "direct");

    // dormant default: createTask without attribution omits the fields (no invented data)
    const plain = createTask(home, { dispatchedBy: "coordinator", assignees: ["w1"] })!;
    t('tasklog: no attribution passed ⇒ fields absent (dormant default)', plain.accountableHuman === undefined && plain.resolutionLevel === undefined);

    // FC-7: a LEGACY record with NO attribution fields still parses fine (fields undefined, no rejection)
    const legacy = { taskId: "t-legacy-0001", dispatchedBy: "old", assignees: ["x"], state: "PENDING", createdAt: 1, updatedAt: 1, results: [] };
    const lp = parseTask(JSON.stringify(legacy));
    t('FC-7: a legacy record (no attribution fields) parses, fields undefined', !!lp && lp.accountableHuman === undefined && lp.resolutionLevel === undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ---------------- AC-1: read-side validation of the ledger attribution pair ----------------
{
  const base = { taskId: "t-ac1-0001", dispatchedBy: "d", assignees: ["w"], state: "PENDING", createdAt: 1, updatedAt: 1, results: [] };
  const p = (extra: Record<string, unknown>) => parseTask(JSON.stringify({ ...base, ...extra }));
  const dropped = (r: ReturnType<typeof parseTask>) => !!r && r.accountableHuman === undefined && r.resolutionLevel === undefined;
  t('AC-1: unknown level string ⇒ attribution dropped, base task kept', (() => { const r = p({ accountableHuman: "u", resolutionLevel: "bogus" }); return dropped(r) && r!.taskId === "t-ac1-0001"; })());
  t('AC-1: numeric level ⇒ dropped', dropped(p({ accountableHuman: "u", resolutionLevel: 7 as unknown as string })));
  t('AC-1: non-string human (object/array/null) ⇒ dropped', dropped(p({ accountableHuman: {} as unknown as string, resolutionLevel: "direct" })) && dropped(p({ accountableHuman: [] as unknown as string, resolutionLevel: "direct" })) && dropped(p({ accountableHuman: null as unknown as string, resolutionLevel: "direct" })));
  t('AC-1: empty/whitespace human ⇒ dropped', dropped(p({ accountableHuman: "   ", resolutionLevel: "direct" })));
  t('AC-1: a lone half (human without level, or level without human) ⇒ dropped', dropped(p({ accountableHuman: "u" })) && dropped(p({ resolutionLevel: "direct" })));
  t('AC-1: a COMPLETE valid pair is kept', (() => { const r = p({ accountableHuman: "wowdd1", resolutionLevel: "delegated" }); return !!r && r.accountableHuman === "wowdd1" && r.resolutionLevel === "delegated"; })());

  // real-disk regression: a corrupt record on disk → read drops the bad attribution → write-back (applyResult)
  // → re-read is clean, and the base task survived + the result applied.
  const home = mkdtempSync(join(tmpdir(), 'attr-ac1-'));
  try {
    mkdirSync(taskLogDir(home), { recursive: true });
    const badId = "t-ac1-disk-01";
    writeFileSync(join(taskLogDir(home), `${badId}.json`), JSON.stringify({ taskId: badId, dispatchedBy: "d", assignees: ["w"], state: "PENDING", createdAt: 1, updatedAt: 1, results: [], accountableHuman: { evil: 1 }, resolutionLevel: "unrecognized" }));
    const read1 = readTask(home, badId)!;
    t('AC-1 disk: readTask drops the corrupt attribution, keeps the base task', read1.accountableHuman === undefined && read1.resolutionLevel === undefined && read1.dispatchedBy === "d" && read1.assignees[0] === "w");
    applyResult(home, badId, { launchId: "w", state: "done" });
    const read2 = readTask(home, badId)!;
    t('AC-1 disk: after apply+write-back, disk is clean of the illegal attribution', read2.accountableHuman === undefined && read2.resolutionLevel === undefined && read2.results.some((x) => x.launchId === "w"));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log('\nattribution self-check OK');
