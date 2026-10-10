import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionEnabled, resolveAccountable, isResolutionLevel, RESOLUTION_LEVELS, type AttributionInput } from './attribution.js';
import { createTask, readTask, parseTask } from '../tasklog.js';

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

console.log('\nattribution self-check OK');
