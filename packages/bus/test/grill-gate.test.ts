import { describe, expect, test } from "vitest";
import {
  loadGrillTree, nextQuestion, isGrillComplete, resolveDecisions, grillGateEnabled, foldDecisionsIntoPrd,
  type GrillQuestion, type GrillTree,
} from "../src/swarm/grill-gate.js";

// A 4-node design tree: q1 forks placement; q2 (vm branch) picks a backend; q3 (local branch) is free-form; q4 is a
// grandchild under q2=railway. Covers roots, constrained + free-form, two sibling branches, and a grandchild.
const TREE: GrillTree = {
  questions: [
    { id: "q1", prompt: "Where do agents run?", choices: [{ value: "vm" }, { value: "local" }], recommended: "vm", rationale: "free box first" },
    { id: "q2", prompt: "Which VM backend?", parent: "q1", whenAnswers: ["vm"], choices: [{ value: "railway" }, { value: "gha" }], recommended: "railway" },
    { id: "q3", prompt: "Local home dir?", parent: "q1", whenAnswers: ["local"], recommended: "~/Dev" },
    { id: "q4", prompt: "Snapshot on boot?", parent: "q2", whenAnswers: ["railway"], choices: [{ value: "yes" }, { value: "no" }], recommended: "no" },
  ],
};
const load = (t: unknown): GrillTree => { const r = loadGrillTree(t); if (!r.ok) throw new Error(r.reason); return r.tree; };
const reasons = (t: unknown): string => { const r = loadGrillTree(t); return r.ok ? "" : r.reason; };

describe("grill-gate — ① loadGrillTree trust boundary (whole-reject, no silent repair)", () => {
  test("accepts a legal tree; an empty questions array is a legal no-op gate", () => {
    expect(loadGrillTree(TREE).ok).toBe(true);
    expect(loadGrillTree({ questions: [] }).ok).toBe(true);
  });
  test("rejects a non-object / missing questions", () => {
    expect(reasons(null)).toMatch(/object/);
    expect(reasons([])).toMatch(/object/);
    expect(reasons({})).toMatch(/questions/);
    expect(reasons({ questions: {} })).toMatch(/questions/);
  });
  test("rejects a bad id / duplicate id / empty prompt / missing recommended", () => {
    expect(reasons({ questions: [{ id: "", prompt: "p", recommended: "r" }] })).toMatch(/id/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "r" }, { id: "a", prompt: "p2", recommended: "r2" }] })).toMatch(/duplicate/);
    expect(reasons({ questions: [{ id: "a", prompt: "", recommended: "r" }] })).toMatch(/prompt/);
    expect(reasons({ questions: [{ id: "a", prompt: "p" }] })).toMatch(/recommended/); // 问询不裸等
  });
  test("rejects bad choices and a recommended outside the choice domain", () => {
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "x", choices: [] }] })).toMatch(/choices/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "x", choices: [{}] }] })).toMatch(/no value/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "x", choices: [{ value: "x" }, { value: "x" }] }] })).toMatch(/duplicate choice/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "z", choices: [{ value: "x" }, { value: "y" }] }] })).toMatch(/not one of its choices/);
  });
  test("rejects a half-specified branch edge (parent XOR whenAnswers), a self-parent, and a dangling parent", () => {
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "r", parent: "a" /* no whenAnswers */ }] })).toMatch(/together/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "r", whenAnswers: ["x"] /* no parent */ }] })).toMatch(/together/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "r", parent: "a", whenAnswers: ["x"] }] })).toMatch(/its own parent/);
    expect(reasons({ questions: [{ id: "a", prompt: "p", recommended: "r", parent: "ghost", whenAnswers: ["x"] }] })).toMatch(/does not exist/);
  });
  test("rejects empty / non-string whenAnswers and a value outside a constrained parent's domain", () => {
    const base: GrillQuestion = { id: "p1", prompt: "p", choices: [{ value: "x" }, { value: "y" }], recommended: "x" };
    expect(reasons({ questions: [base, { id: "c", prompt: "p", recommended: "r", parent: "p1", whenAnswers: [] }] })).toMatch(/whenAnswers/);
    expect(reasons({ questions: [base, { id: "c", prompt: "p", recommended: "r", parent: "p1", whenAnswers: [1] }] })).toMatch(/whenAnswers/);
    expect(reasons({ questions: [base, { id: "c", prompt: "p", recommended: "r", parent: "p1", whenAnswers: ["z"] }] })).toMatch(/not a choice of parent/);
    // a free-form parent (no choices) cannot be domain-checked ⇒ any whenAnswers string is accepted
    const free: GrillQuestion = { id: "p1", prompt: "p", recommended: "anything" };
    expect(loadGrillTree({ questions: [free, { id: "c", prompt: "p", recommended: "r", parent: "p1", whenAnswers: ["anything"] }] }).ok).toBe(true);
  });
  test("rejects a cycle in the parent graph", () => {
    const cyc = { questions: [
      { id: "a", prompt: "p", recommended: "r", parent: "b", whenAnswers: ["x"] },
      { id: "b", prompt: "p", recommended: "r", parent: "a", whenAnswers: ["y"] },
    ] };
    expect(reasons(cyc)).toMatch(/cycle/);
  });
});

describe("grill-gate — ② nextQuestion / isGrillComplete (one at a time, branch-gated)", () => {
  const t = load(TREE);
  test("asks the first live unanswered root, then descends the chosen branch only", () => {
    expect(nextQuestion(t, {})!.id).toBe("q1");
    expect(nextQuestion(t, { q1: "vm" })!.id).toBe("q2");      // q3 dead (local branch), q4 needs q2 first
    expect(nextQuestion(t, { q1: "vm", q2: "railway" })!.id).toBe("q4");
    expect(nextQuestion(t, { q1: "local" })!.id).toBe("q3");   // the other sibling branch
  });
  test("a non-unlocking parent answer prunes deeper questions ⇒ complete", () => {
    expect(nextQuestion(t, { q1: "vm", q2: "gha" })).toBeNull(); // q4 needs railway; q3 dead ⇒ nothing left
    expect(isGrillComplete(t, { q1: "vm", q2: "gha" })).toBe(true);
    expect(isGrillComplete(t, {})).toBe(false);
    expect(isGrillComplete(t, { q1: "vm", q2: "railway", q4: "yes" })).toBe(true);
  });
});

describe("grill-gate — ③ resolveDecisions (R3-b: user answers + defaults, dead branches pruned)", () => {
  const t = load(TREE);
  test("zero answers ⇒ the pure all-defaults resolution, descending through defaulted parents", () => {
    const r = resolveDecisions(t, {});
    expect(r.ok).toBe(true);
    const d = (r as { ok: true; resolved: { decisions: any[] } }).resolved.decisions;
    expect(d.map((x) => [x.id, x.answer, x.source])).toEqual([
      ["q1", "vm", "default"], ["q2", "railway", "default"], ["q4", "no", "default"], // q3 pruned (q1 defaulted to vm)
    ]);
  });
  test("a mix of user + default, in tree order", () => {
    const r = resolveDecisions(t, { q1: "vm", q2: "railway" });
    const d = (r as { ok: true; resolved: { decisions: any[] } }).resolved.decisions;
    expect(d.map((x) => [x.id, x.answer, x.source])).toEqual([
      ["q1", "vm", "user"], ["q2", "railway", "user"], ["q4", "no", "default"],
    ]);
  });
  test("choosing the other branch prunes the first; the pruned branch's answer is omitted, not defaulted", () => {
    const r = resolveDecisions(t, { q1: "local" });
    const d = (r as { ok: true; resolved: { decisions: any[] } }).resolved.decisions;
    expect(d.map((x) => x.id)).toEqual(["q1", "q3"]); // q2/q4 gone
    expect(d.find((x) => x.id === "q3")).toMatchObject({ answer: "~/Dev", source: "default" });
  });
  test("a stale in-domain answer to a now-dead branch is ignored (not an error, not in output)", () => {
    const r = resolveDecisions(t, { q1: "local", q2: "railway" }); // q2 is dead under q1=local
    expect(r.ok).toBe(true);
    const d = (r as { ok: true; resolved: { decisions: any[] } }).resolved.decisions;
    expect(d.map((x) => x.id)).toEqual(["q1", "q3"]);
  });
  test("carries rationale into the decision", () => {
    const d = (resolveDecisions(t, {}) as { ok: true; resolved: { decisions: any[] } }).resolved.decisions;
    expect(d.find((x) => x.id === "q1")!.rationale).toBe("free box first");
  });
  test("rejects an unknown id or an out-of-domain answer — even on a branch that ends up dead", () => {
    expect(resolveDecisions(t, { ghost: "x" }).ok).toBe(false);
    expect(resolveDecisions(t, { q1: "cloud" }).ok).toBe(false);                 // q1 domain is vm|local
    expect(resolveDecisions(t, { q1: "local", q2: "bogus" }).ok).toBe(false);    // q2 bogus invalid though q2 is dead here
  });
});

describe("grill-gate — ④ grillGateEnabled (dormant-ahead-of-use, default OFF)", () => {
  test("default OFF; truthy words ON (case-insensitive); everything else OFF", () => {
    expect(grillGateEnabled({})).toBe(false);
    expect(grillGateEnabled({ SWARM_GRILL_GATE: "" })).toBe(false);
    for (const off of ["0", "no", "off", "false", "nope"]) expect(grillGateEnabled({ SWARM_GRILL_GATE: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "YES", "On"]) expect(grillGateEnabled({ SWARM_GRILL_GATE: on })).toBe(true);
  });
});

describe("grill-gate — ⑤ foldDecisionsIntoPrd (seam output)", () => {
  const t = load(TREE);
  test("appends a deterministic decisions appendix in order; empty ⇒ PRD unchanged", () => {
    const prd = "Build the thing.";
    expect(foldDecisionsIntoPrd(prd, { decisions: [] })).toBe(prd); // no stray heading
    const resolved = (resolveDecisions(t, { q1: "vm", q2: "railway", q4: "yes" }) as { ok: true; resolved: any }).resolved;
    const out = foldDecisionsIntoPrd(prd, resolved);
    expect(out.startsWith(prd)).toBe(true);
    expect(out).toContain("## Resolved decisions (grill-gate)");
    expect(out).toContain("- Where do agents run? → vm [user] (free box first)");
    expect(out).toContain("- Snapshot on boot? → yes [user]");
    expect(out.indexOf("Where do agents run?")).toBeLessThan(out.indexOf("Snapshot on boot?")); // tree order preserved
  });
});
