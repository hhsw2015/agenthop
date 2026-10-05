import { describe, expect, test } from "vitest";
import { loadModelTierTable, normalizeModelName, resolveToCatalogId, aaIntelOf, resolveRoleModel, resolvePlannerModel, servedMatchesChosen } from "../src/swarm/model-tier.js";

// heavy-tier-binding (coordinator dispatch 2026-10-05): fail-closed resolution of a role tier to a catalog model, with a
// data-driven same-or-stronger (AA Intel) check and a {chosen, why, benchmark} selection record.

const table = loadModelTierTable();
const CATALOG = ["claude-opus-5-5", "claude-fable-5-1", "gpt-6-astra", "claude-sonnet-5-5", "claude-opus-5", "grok-4-6", "mystery-model-9000"];

describe("data table", () => {
  test("bundled model-tiers.json loads with the three roles + benchmark", () => {
    expect(table.version).toMatch(/^mtr-/);
    expect(Object.keys(table.roles).sort()).toEqual(["coding", "planning", "review"]);
    expect(table.roles.planning.recommended.map((r) => r.name)).toContain("opus 5.5");
    expect(table.roles.planning.floorAaIntel).toBe(53);
    expect(table.benchmarkScores.length).toBeGreaterThan(5);
  });
});

describe("matching helpers", () => {
  test("normalize collapses spaces/dots/case", () => {
    expect(normalizeModelName("Opus 5.5")).toBe("opus55");
    expect(normalizeModelName("claude-opus-5-5")).toBe("claudeopus55");
  });
  test("resolveToCatalogId maps display names to catalog ids", () => {
    expect(resolveToCatalogId("opus 5.5", CATALOG)).toBe("claude-opus-5-5");
    expect(resolveToCatalogId("fable 5.1", CATALOG)).toBe("claude-fable-5-1");
    expect(resolveToCatalogId("gpt 6 astra", CATALOG)).toBe("gpt-6-astra");
    expect(resolveToCatalogId("opus 5", CATALOG)).toBe("claude-opus-5"); // shortest match beats opus-5-5
    expect(resolveToCatalogId("no-such-model", CATALOG)).toBeNull();
  });
  test("aaIntelOf finds the benchmark score by name or id", () => {
    expect(aaIntelOf("claude-opus-5-5", table)).toBe(58);
    expect(aaIntelOf("sonnet 5.5", table)).toBe(56);
    expect(aaIntelOf("totally-unknown", table)).toBeUndefined();
  });
});

describe("resolvePlannerModel (fail-closed)", () => {
  test("no chosen -> strongest available recommended (opus 5.5, AA Intel 58) + xhigh reasoning", () => {
    const r = resolvePlannerModel({ catalog: CATALOG });
    expect(r.ok && r.model).toBe("claude-opus-5-5");
    expect(r.ok && r.selection.chosen).toBe("opus 5.5");
    expect(r.ok && r.selection.benchmark).toMatch(/AA Intel 58/);
    expect(r.ok && r.selection.reasoningEffort).toBe("xhigh"); // data-driven effort (user 2026-10-05)
  });
  test("no chosen, opus absent -> next recommended (fable 5.1)", () => {
    const r = resolvePlannerModel({ catalog: ["claude-fable-5-1", "gpt-6-astra", "grok-4-6"] });
    expect(r.ok && r.model).toBe("claude-fable-5-1");
  });
  test("FAIL-CLOSED: none of the planning recommended are in the catalog", () => {
    const r = resolvePlannerModel({ catalog: ["grok-4-6", "mystery-model-9000"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fail-closed/);
  });
});

describe("self-selection (same-or-stronger + triple)", () => {
  test("a recommended model chosen explicitly -> baseline, ok", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-opus-5-5" });
    expect(r.ok && r.selection.benchmark).toMatch(/recommended/);
  });
  test("a non-recommended, same-or-stronger model WITH a reason -> ok self-select", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-sonnet-5-5", why: "strong + cheaper for this run" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.model).toBe("claude-sonnet-5-5"); expect(r.selection.benchmark).toMatch(/self-select.*AA Intel 56 >= floor 53/); }
  });
  test("a non-recommended model WITHOUT a reason is rejected (triple required)", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-sonnet-5-5" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/selection reason/);
  });
  test("a WEAKER model is fail-closed even with a reason", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "grok-4-6", why: "I like it" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/floor 53/);
  });
  test("a chosen model not in the catalog is rejected", () => {
    expect(resolvePlannerModel({ catalog: CATALOG, chosen: "gpt-7-nonexistent" }).ok).toBe(false);
  });
  test("a chosen model with no benchmark cannot be verified -> rejected", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "mystery-model-9000", why: "trust me" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no AA Intel benchmark/);
  });
});

describe("servedMatchesChosen (runtime fail-closed: claimed == served)", () => {
  test("exact + version-suffix served match the chosen", () => {
    expect(servedMatchesChosen("claude-opus-5.5", "claude-opus-5.5")).toBe(true);
    expect(servedMatchesChosen("claude-opus-5.5", "claude-opus-5-5-20261001")).toBe(true);
  });
  test("a different (downgraded) served model is rejected", () => {
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-4-5")).toBe(false); // flagged silent downgrade
    expect(servedMatchesChosen("claude-opus-5-5", "gpt-6-astra")).toBe(false);
    expect(servedMatchesChosen("claude-opus-5-5", "")).toBe(false);
  });
});

describe("other roles", () => {
  test("review role resolves to its recommended (gpt 6 astra / opus 5.5)", () => {
    const r = resolveRoleModel("review", { catalog: CATALOG });
    expect(r.ok && ["gpt-6-astra", "claude-opus-5-5"]).toContain(r.ok ? r.model : "");
  });
});
