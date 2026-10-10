/**
 * grill-gate (烤问门) — the PURE pre-dispatch decision layer that sits BEFORE the T3 planner (planning-frameworks-eval
 * 头号借 "grill 门": grill-me's adversarial design-tree interrogation, self-built, zero telemetry, no upstream tool). Before
 * N agents are dispatched, the decisions a human should settle are walked ONE AT A TIME down the branches of a design tree;
 * every question carries a RECOMMENDED default so the gate can terminate without bare-waiting (R3-b 问询带默认, the same
 * "问询不裸等" invariant as task-wait.ts openQueryWait). The output is a resolved-decisions list that augments the PRD fed
 * to draftPlan (plan-draft.ts).
 *
 * Two deliberate ports of the house trust-boundary discipline:
 *   - NO silent repair (mirrors task-plan.ts loadPlan): an illegal tree — duplicate id, dangling/self/cyclic parent,
 *     a question with no recommended default, a whenAnswers value outside the parent's choice domain — rejects the WHOLE
 *     tree with a reason. A silently "fixed" question tree would extract the wrong decisions.
 *   - Defaults are REQUIRED, never fabricated (mirrors task-wait.ts R3-b): `recommended` is mandatory on every question, so
 *     resolveDecisions can ALWAYS terminate by applying defaults to the unanswered live questions — the gate never blocks
 *     dispatch waiting on a human.
 *
 * Answers are an UNTRUSTED map (GG-P2-1): every lookup reads an OWN data property only — never the prototype chain, never an
 * accessor — so a question id that collides with `constructor`/`__proto__`/`toString`/`hasOwnProperty` is NOT silently
 * "answered" by an inherited value. Tree traversal is ITERATIVE (GG-P2-2): liveness, ordering and resolution are O(n) with
 * no recursion, so an arbitrarily deep but legal chain resolves instead of overflowing the stack (there is no depth cap).
 *
 * SEAM / DORMANT-AHEAD-OF-USE (coordinator dispatch: "T3 规划器前置接缝(dormant 旗)", same discipline as SWARM_VM_CTL /
 * review-seat-autoscale / seat-identity-caps): this module is pure and self-contained. grill-gate has NO runtime caller —
 * the live T3 orchestrator that would call grillGateEnabled() → run the interactive loop (nextQuestion) → resolveDecisions →
 * foldDecisionsIntoPrd(prd, …) → draftPlan is not wired. (The manual A1 live-fire script packages/bus/scripts/t3-draft-live.ts
 * calls draftPlan DIRECTLY, not through this gate.) So grillGateEnabled defaults OFF and nothing here is on a running path —
 * the exported gate + fold ARE the seam, ready to attach when the flag is flipped.
 *
 * NON-GOAL: persistence (the IO half would durably stash a tree + answers like plan-bundle; not in this slice), the LLM
 * that AUTHORS a tree from a PRD, and the actual dispatch. This module stops at "is this a legal decision tree, which
 * question comes next, and what is the fully-resolved decision list (user answers + R3-b defaults)".
 */

export type GrillChoice = { value: string; label?: string };

export type GrillQuestion = {
  /** Unique within the tree. */
  id: string;
  /** The question put to the human. */
  prompt: string;
  /** R3-b default applied when the human does not answer this (live) question. REQUIRED — a question must not bare-wait.
   *  When `choices` is present it MUST be one of their values. */
  recommended: string;
  /** Optional constrained answer domain. When present: non-empty, unique values, and every answer (user or default) must
   *  be one of them. Absent ⇒ free-form answer. */
  choices?: GrillChoice[];
  /** Why this recommendation (grill-me: "provide your recommended answer"). Advisory, carried into the decision. */
  rationale?: string;
  /** Design-tree branch: this question is LIVE only when `parent` is itself live, answered, and its answer ∈ whenAnswers.
   *  Present iff `whenAnswers` is. A root question (no parent) is always live. */
  parent?: string;
  /** The parent answers that unlock this branch. Required iff `parent` is set; non-empty; each value must be in the
   *  parent's choice domain when the parent is constrained. */
  whenAnswers?: string[];
};

export type GrillTree = { questions: GrillQuestion[] };

/** questionId -> the human-supplied answer. Defaults are NOT stored here; resolveDecisions applies them. Treated as an
 *  UNTRUSTED map: only OWN data properties count as answers. */
export type GrillAnswers = Record<string, string>;

export type DecisionSource = "user" | "default";
export type ResolvedDecision = { id: string; prompt: string; answer: string; source: DecisionSource; rationale?: string };
export type ResolvedDecisions = { decisions: ResolvedDecision[] };

export type GrillLoad = { ok: true; tree: GrillTree } | { ok: false; reason: string };
export type GrillResolve = { ok: true; resolved: ResolvedDecisions } | { ok: false; reason: string };

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const choiceValues = (q: GrillQuestion): string[] => (q.choices ? q.choices.map((c) => c.value) : []);

/** The human's answer for `id`, read as an OWN DATA property only (GG-P2-1). Never reads the prototype chain and never
 *  invokes an accessor, so an id of `constructor`/`__proto__`/`toString`/… is unanswered unless the map carries it as its
 *  own string value. A non-string own value reads as "no answer" here (and is rejected loudly by resolveDecisions). */
function answerOf(answers: GrillAnswers, id: string): string | undefined {
  const d = Object.getOwnPropertyDescriptor(answers, id);
  return d && typeof d.value === "string" ? d.value : undefined;
}

/**
 * Trust boundary: turn untrusted JSON into a legal GrillTree or reject the WHOLE thing with a reason (no silent repair).
 * An empty questions array is legal (a no-op gate ⇒ resolveDecisions returns []).
 */
export function loadGrillTree(input: unknown): GrillLoad {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "tree must be an object" };
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return { ok: false, reason: "tree.questions must be an array" };

  const ids = new Set<string>();
  for (const [idx, raw] of questions.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: `question[${idx}] must be an object` };
    const q = raw as Partial<GrillQuestion>;
    if (!isNonEmptyString(q.id)) return { ok: false, reason: `question[${idx}].id must be a non-empty string` };
    if (ids.has(q.id)) return { ok: false, reason: `duplicate question id "${q.id}"` };
    ids.add(q.id);
    if (!isNonEmptyString(q.prompt)) return { ok: false, reason: `question "${q.id}".prompt must be a non-empty string` };
    if (!isNonEmptyString(q.recommended)) return { ok: false, reason: `question "${q.id}".recommended must be a non-empty string (问询不裸等)` };
    if (q.rationale !== undefined && typeof q.rationale !== "string") return { ok: false, reason: `question "${q.id}".rationale must be a string` };
    if (q.choices !== undefined) {
      if (!Array.isArray(q.choices) || q.choices.length === 0) return { ok: false, reason: `question "${q.id}".choices must be a non-empty array when present` };
      const seen = new Set<string>();
      for (const c of q.choices) {
        if (typeof c !== "object" || c === null || !isNonEmptyString((c as GrillChoice).value)) return { ok: false, reason: `question "${q.id}" has a choice with no value` };
        const cv = (c as GrillChoice).value;
        if (seen.has(cv)) return { ok: false, reason: `question "${q.id}" has duplicate choice value "${cv}"` };
        seen.add(cv);
        if ((c as GrillChoice).label !== undefined && typeof (c as GrillChoice).label !== "string") return { ok: false, reason: `question "${q.id}" choice "${cv}".label must be a string` };
      }
      if (!seen.has(q.recommended)) return { ok: false, reason: `question "${q.id}".recommended "${q.recommended}" is not one of its choices` };
    }
    // parent / whenAnswers must come as a pair (a branch edge), validated structurally here; cross-refs after all ids known.
    const hasParent = q.parent !== undefined;
    const hasWhen = q.whenAnswers !== undefined;
    if (hasParent !== hasWhen) return { ok: false, reason: `question "${q.id}": parent and whenAnswers must be set together` };
    if (hasParent) {
      if (!isNonEmptyString(q.parent)) return { ok: false, reason: `question "${q.id}".parent must be a non-empty string` };
      if (q.parent === q.id) return { ok: false, reason: `question "${q.id}" is its own parent` };
      if (!Array.isArray(q.whenAnswers) || q.whenAnswers.length === 0) return { ok: false, reason: `question "${q.id}".whenAnswers must be a non-empty array` };
      if (!q.whenAnswers.every((w) => isNonEmptyString(w))) return { ok: false, reason: `question "${q.id}".whenAnswers must be non-empty strings` };
    }
  }

  const byId = new Map(questions.map((q) => [(q as GrillQuestion).id, q as GrillQuestion]));
  // Cross-reference: parent exists, whenAnswers within a constrained parent's domain.
  for (const q of questions as GrillQuestion[]) {
    if (q.parent === undefined) continue;
    const parent = byId.get(q.parent);
    if (!parent) return { ok: false, reason: `question "${q.id}".parent "${q.parent}" does not exist` };
    if (parent.choices) {
      const dom = choiceValues(parent);
      const bad = q.whenAnswers!.find((w) => !dom.includes(w));
      if (bad !== undefined) return { ok: false, reason: `question "${q.id}".whenAnswers "${bad}" is not a choice of parent "${q.parent}"` };
    }
  }
  // Cycle detection — O(n) amortized (GG-P2-2: no per-node O(depth) rewalk). Follow parent pointers; a node that reaches a
  // root (or a node already proven acyclic) is safe; a node seen again on the SAME walk is a cycle.
  const safe = new Set<string>();
  for (const start of questions as GrillQuestion[]) {
    if (safe.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = start.id;
    while (cur !== undefined && !safe.has(cur)) {
      if (onPath.has(cur)) return { ok: false, reason: `cycle in question tree at "${start.id}" via "${cur}"` };
      onPath.add(cur);
      path.push(cur);
      cur = byId.get(cur)!.parent;
    }
    for (const id of path) safe.add(id);
  }
  return { ok: true, tree: { questions: questions as GrillQuestion[] } };
}

const indexById = (tree: GrillTree): Map<string, GrillQuestion> => new Map(tree.questions.map((q) => [q.id, q]));

/** Parents-before-children order via BFS from the roots — O(n), iterative (no recursion, no depth math). A question with no
 *  reachable root (only possible on a never-loaded cyclic tree) is simply omitted; a legal tree includes every question. */
function parentsFirstOrder(tree: GrillTree): GrillQuestion[] {
  const children = new Map<string, GrillQuestion[]>();
  const order: GrillQuestion[] = [];
  const queue: GrillQuestion[] = [];
  for (const q of tree.questions) {
    if (q.parent === undefined) queue.push(q);
    else { const a = children.get(q.parent) ?? []; a.push(q); children.set(q.parent, a); }
  }
  for (let head = 0; head < queue.length; head++) {
    const q = queue[head]!;
    order.push(q);
    const cs = children.get(q.id);
    if (cs) for (const c of cs) queue.push(c);
  }
  return order;
}

/** The set of LIVE question ids given a `lookup` (user answers, or resolved answers). Parents-first, O(n): a child is live
 *  iff its parent is live AND answered with a value in whenAnswers. A root is always live. */
function liveSet(order: GrillQuestion[], lookup: (id: string) => string | undefined): Set<string> {
  const live = new Set<string>();
  for (const q of order) {
    if (q.parent === undefined) { live.add(q.id); continue; }
    if (!live.has(q.parent)) continue;
    const pa = lookup(q.parent);
    if (pa !== undefined && q.whenAnswers!.includes(pa)) live.add(q.id);
  }
  return live;
}

/** The next question to ASK: the first live-by-user-answers question (tree order) the human has not yet answered, or null
 *  when the live set is fully answered (grill-me: one at a time). Drives the interactive loop. */
export function nextQuestion(tree: GrillTree, answers: GrillAnswers): GrillQuestion | null {
  const order = parentsFirstOrder(tree);
  const live = liveSet(order, (id) => answerOf(answers, id));
  for (const q of tree.questions) {
    if (live.has(q.id) && answerOf(answers, q.id) === undefined) return q;
  }
  return null;
}

/** True when there is no live question left unanswered by the human (nextQuestion === null). */
export function isGrillComplete(tree: GrillTree, answers: GrillAnswers): boolean {
  return nextQuestion(tree, answers) === null;
}

/**
 * The termination move (R3-b apply-defaults). Validates the supplied answers, then descends the tree parents-first, taking
 * the human's answer where present and the `recommended` default otherwise, computing each child's liveness against the
 * RESOLVED (possibly-defaulted) parent answer. Dead branches are omitted; a stale answer to a pruned branch is ignored
 * (not an error). With zero answers this yields the pure all-defaults resolution (问询带默认). Output is in tree order.
 *
 * Rejects (loud, no silent repair): an OWN answer key that is not a known question id, or whose value is not a string, or
 * an out-of-domain answer to a constrained question — a bad value is always a caller bug, whether or not its branch ends up
 * live. Only OWN data properties are considered (GG-P2-1): inherited/accessor keys are never answers.
 */
export function resolveDecisions(tree: GrillTree, answers: GrillAnswers): GrillResolve {
  const byId = indexById(tree);
  for (const id of Object.getOwnPropertyNames(answers)) {
    const q = byId.get(id);
    if (!q) return { ok: false, reason: `answer to unknown question id "${id}"` };
    const d = Object.getOwnPropertyDescriptor(answers, id)!;
    if (!("value" in d) || typeof d.value !== "string") return { ok: false, reason: `answer to "${id}" must be a string` };
    if (q.choices && !choiceValues(q).includes(d.value)) return { ok: false, reason: `answer "${d.value}" to "${id}" is not one of its choices` };
  }
  const order = parentsFirstOrder(tree);
  const resolved = new Map<string, string>();
  const source = new Map<string, DecisionSource>();
  for (const q of order) {
    const live = q.parent === undefined || (resolved.has(q.parent) && q.whenAnswers!.includes(resolved.get(q.parent)!));
    if (!live) continue; // dead branch (parent absent or non-unlocking) ⇒ omit
    const userAns = answerOf(answers, q.id);
    resolved.set(q.id, userAns !== undefined ? userAns : q.recommended);
    source.set(q.id, userAns !== undefined ? "user" : "default");
  }
  const decisions: ResolvedDecision[] = [];
  for (const q of tree.questions) {
    if (!resolved.has(q.id)) continue;
    decisions.push({
      id: q.id,
      prompt: q.prompt,
      answer: resolved.get(q.id)!,
      source: source.get(q.id)!,
      ...(q.rationale !== undefined ? { rationale: q.rationale } : {}),
    });
  }
  return { ok: true, resolved: { decisions } };
}

/** The dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_VM_CTL). The live T3 orchestrator runs the
 *  gate only when this is explicitly truthy. */
export function grillGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_GRILL_GATE ?? "");
}

/** Seam output: fold a resolved-decisions list into the PRD handed to draftPlan as a deterministic, human-readable
 *  appendix. Empty decisions ⇒ the PRD is returned unchanged (no stray heading). Order follows the decision list. */
export function foldDecisionsIntoPrd(prd: string, resolved: ResolvedDecisions): string {
  if (resolved.decisions.length === 0) return prd;
  const lines = resolved.decisions.map((d) => `- ${d.prompt} → ${d.answer} [${d.source}]${d.rationale ? ` (${d.rationale})` : ""}`);
  return `${prd}\n\n## Resolved decisions (grill-gate)\n${lines.join("\n")}\n`;
}
