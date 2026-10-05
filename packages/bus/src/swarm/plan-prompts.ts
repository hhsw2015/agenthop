/**
 * T3b prompt assets (design 1d0a1ffc §2 "prompt 资产(借鉴处,重写不搬运)" + coordinator point 1) — the three
 * parameterized, VERSIONED templates the draftPlan LLM step fills. We borrow ONLY the STRUCTURAL idea from
 * claude-task-master (MIT) — parameterized JSON templates carrying a version — and rewrite the content in our terms
 * (TaskPlan / structuredChecks vs freeTextNotes / modelTier / R4). Zero task-master code, zero runtime concepts.
 *
 *   task-master is MIT-licensed (https://github.com/eyaltoledano/claude-task-master). Structural inspiration only.
 *
 * The three (≈ task-master's parse-prd / analyze-complexity / expand-task):
 *   plan-draft    -> a structured Draft from a PRD (output schema == translateDraft's Draft input; parse failure = reject)
 *   complexity    -> an independent per-task re-score (defeats the single-pass self-score bias; fills independentScore)
 *   expand-node   -> refine one node into subtasks (execution-time, when a node proves too coarse)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type PromptAsset = {
  id: string;
  version: string;
  description: string;
  system: string;
  /** Mustache-lite: {{name}} placeholders, filled by fillPrompt (a missing var throws — never send a half-filled prompt). */
  userTemplate: string;
};

const PLAN_DRAFT: PromptAsset = {
  id: "plan-draft",
  version: "2",
  description: "PRD/one-line goal -> a structured plan draft (translateDraft's input schema).",
  system:
    "You are a planning drafter for an agent swarm. Turn the requirement into a STRICT JSON draft and nothing else — no prose, no markdown fences. " +
    "The draft is machine-validated: any field out of shape is rejected, not repaired. " +
    "Split acceptance: machine-checkable criteria go in structuredChecks (each {check, args} where check is from the allowed list); " +
    "everything that needs human/expert judgement goes in freeTextNotes (it becomes a required review node, it is NOT dropped). " +
    "Never invent a check name. complexity is your honest 1-10 estimate. Do not add a design/gate node — gates are auto-prepended.",
  userTemplate:
    "Requirement (jobId={{jobId}}):\n{{prd}}\n\n" +
    "Allowed structuredCheck names (anything else is rejected): {{allowedChecks}}\n\n" +
    // S15: define every field so the model never guesses a term (each guess is a rework risk).
    "Field meanings (fill exactly these, do not rename):\n" +
    "- nodeId: a short unique id for the task within this plan.\n" +
    "- kind: the task type; use \"work\" unless it is clearly integration/synthesis/review/repair.\n" +
    "- goal: one sentence stating what the task must achieve.\n" +
    "- dependsOn: nodeIds that must finish before this task (empty if none).\n" +
    "- structuredChecks: machine-checkable acceptance, each {check, args}; check must be an allowed name above.\n" +
    "- freeTextNotes: acceptance that needs human/expert judgement (spawns a required review task).\n" +
    "- complexity: integer 1-10, your honest difficulty estimate.\n" +
    "- requiredOutputs: the artifacts the task produces; kind is patch|files|report|notes.\n" +
    "- artifactScope: output path prefixes the task's deliverables land under.\n" +
    "- sourceWriteScope: existing source path prefixes the task will MODIFY (drives ownership/risk checks).\n" +
    "- criticalPath: true ONLY if a wrong result here would block or mislead the whole job; else false.\n\n" +
    'Output exactly this JSON shape:\n' +
    '{"jobId":"{{jobId}}","tasks":[{"nodeId":"string","kind":"work|integration|synthesis|review|repair",' +
    '"goal":"string","dependsOn":["nodeId"],"structuredChecks":[{"check":"name","args":{}}],"freeTextNotes":["string"],' +
    '"complexity":1,"requiredOutputs":[{"logicalName":"string","kind":"patch|files|report|notes"}],' +
    '"artifactScope":["path/"],"sourceWriteScope":["path/"],"criticalPath":false}]}',
};

const COMPLEXITY: PromptAsset = {
  id: "complexity",
  version: "1",
  description: "Independent per-task complexity re-score (anti-bias second opinion).",
  system:
    "You independently re-score task complexity 1-10. Judge each task ALONE, ignoring any self-estimate. " +
    "Output STRICT JSON only: an array of {nodeId, independentScore}. No prose.",
  userTemplate: "Tasks to score (jobId={{jobId}}):\n{{tasks}}\n\nOutput: [{\"nodeId\":\"string\",\"independentScore\":1}]",
};

const EXPAND_NODE: PromptAsset = {
  id: "expand-node",
  version: "1",
  description: "Refine one coarse node into subtasks (execution-time).",
  system:
    "You expand ONE task into concrete subtasks. Output STRICT JSON only: an array of subtasks in the same task shape as " +
    "plan-draft (nodeId, kind, goal, dependsOn, structuredChecks, freeTextNotes, complexity, requiredOutputs, artifactScope). No prose.",
  userTemplate: "Parent node to expand (jobId={{jobId}}):\n{{node}}\n\nAllowed structuredCheck names: {{allowedChecks}}",
};

export const PROMPT_ASSETS: Readonly<Record<string, PromptAsset>> = { "plan-draft": PLAN_DRAFT, complexity: COMPLEXITY, "expand-node": EXPAND_NODE };

/** Fill {{name}} placeholders. A referenced var not in `vars` throws — a half-filled prompt is never sent. */
export function fillPrompt(asset: PromptAsset, vars: Record<string, string>): { system: string; user: string } {
  const user = asset.userTemplate.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`fillPrompt(${asset.id}@${asset.version}): missing var "${name}"`);
    return vars[name]!;
  });
  return { system: asset.system, user };
}

/** Materialize the assets as versioned JSON under dir (default ~/.agenthop/swarm/prompts) for external tools/inspection.
 *  In-process draftPlan uses PROMPT_ASSETS directly; this is the design's "进 ~/.agenthop/swarm/prompts/" side. */
export function writePromptAssets(dir?: string): string[] {
  const target = dir ?? path.join(homedir(), ".agenthop", "swarm", "prompts");
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const asset of Object.values(PROMPT_ASSETS)) {
    const file = path.join(target, `${asset.id}.json`);
    writeFileSync(file, JSON.stringify(asset, null, 2));
    written.push(file);
  }
  return written;
}
