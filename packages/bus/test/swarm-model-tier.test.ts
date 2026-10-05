import { describe, expect, test } from "vitest";
import { loadModelTierTable, stripDateSuffix, modelEntryOf, resolveToCatalogId, aaIntelOf, resolveRoleModel, resolvePlannerModel, servedMatchesChosen, type ModelTierTable } from "../src/swarm/model-tier.js";

// heavy-tier-binding (coordinator dispatch 2026-10-05) — EXACT-identity resolution (reviewer c6b5968 root cause: no
// substring). Alias table, fail-closed, floor-checked, {chosen, why, benchmark, served} record.

const table = loadModelTierTable();
// a representative catalog: both opus-5.5 spellings, a real opus-5, a strong gpt-6-astra, sonnet-5.5, a weak grok-4-6.
const CATALOG = ["claude-opus-5-5", "claude-opus-5.5", "claude-fable-5-1", "gpt-6-astra", "claude-sonnet-5-5", "claude-opus-5", "grok-4-6"];
const withFloor = (role: "planning", floor: number): ModelTierTable => ({ ...table, roles: { ...table.roles, [role]: { ...table.roles[role], floorAaIntel: floor } } });

describe("data table (alias table)", () => {
  test("loads with roles + a models/alias table", () => {
    expect(table.version).toMatch(/^mtr-/);
    expect(Object.keys(table.roles).sort()).toEqual(["coding", "planning", "review"]);
    expect(table.roles.planning.recommended).toContain("opus 5.5");
    expect(table.roles.planning.floorAaIntel).toBe(53);
    expect(table.models.find((m) => m.id === "opus 5.5")?.aaIntel).toBe(58);
    expect(table.models.find((m) => m.id === "opus 5")?.aaIntel).toBe(51);
  });
});

describe("exact identity (no substring)", () => {
  test("stripDateSuffix strips only a 6-8 digit tail", () => {
    expect(stripDateSuffix("claude-opus-5-5-20261001")).toBe("claude-opus-5-5");
    expect(stripDateSuffix("claude-opus-5-5")).toBe("claude-opus-5-5"); // trailing -5 is not a date
    expect(stripDateSuffix("gpt-6-astra")).toBe("gpt-6-astra");
  });
  test("modelEntryOf resolves canonical, exact alias, dated alias — and NOTHING by substring", () => {
    expect(modelEntryOf("opus 5.5", table)?.id).toBe("opus 5.5");
    expect(modelEntryOf("claude-opus-5-5", table)?.id).toBe("opus 5.5");
    expect(modelEntryOf("claude-opus-5-5-20261001", table)?.id).toBe("opus 5.5");
    expect(modelEntryOf("claude-opus-5", table)?.id).toBe("opus 5"); // the real opus-5, NOT opus-5.5
    expect(modelEntryOf("claude-sonnet-5-5-mini", table)).toBeUndefined(); // unbenchmarked variant, no inheritance
    expect(modelEntryOf("claude", table)).toBeUndefined(); // bare family name
  });
  test("resolveToCatalogId / aaIntelOf are exact", () => {
    expect(resolveToCatalogId("opus 5.5", CATALOG, table)).toBe("claude-opus-5-5");
    expect(resolveToCatalogId("opus 5", CATALOG, table)).toBe("claude-opus-5");
    expect(resolveToCatalogId("no-such", CATALOG, table)).toBeNull();
    expect(aaIntelOf("claude-opus-5-5", table)).toBe(58);
    expect(aaIntelOf("claude-opus-5", table)).toBe(51);
    expect(aaIntelOf("claude-sonnet-5-5-mini", table)).toBeUndefined();
  });
});

describe("resolvePlannerModel — fail-closed + the reviewer's counterexamples", () => {
  test("full catalog -> strongest recommended (opus 5.5, AA 58) + xhigh", () => {
    const r = resolvePlannerModel({ catalog: CATALOG });
    expect(r.ok && r.model).toBe("claude-opus-5-5");
    expect(r.ok && r.selection.reasoningEffort).toBe("xhigh");
  });
  test("DEFAULT-WEAK-ONLY: catalog has only claude-opus-5 -> fail-closed (opus-5 is not opus-5.5)", () => {
    const r = resolvePlannerModel({ catalog: ["claude-opus-5"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fail-closed/);
  });
  test("DEFAULT-SKIP-WEAK-FOR-REAL-BASELINE: [claude-opus-5, gpt-6-astra] -> gpt-6-astra (never mis-selects opus-5)", () => {
    const r = resolvePlannerModel({ catalog: ["claude-opus-5", "gpt-6-astra"] });
    expect(r.ok && r.model).toBe("gpt-6-astra");
  });
  test("EXPLICIT-WEAK-AS-BASELINE: chosen=claude-opus-5 -> rejected (AA 51 < floor 53, not recommended)", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-opus-5" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/floor 53/);
  });
  test("UNBENCHMARKED-VARIANT: chosen=claude-sonnet-5-5-mini -> rejected (not benchmarked; no score inheritance)", () => {
    const r = resolvePlannerModel({ catalog: [...CATALOG, "claude-sonnet-5-5-mini"], chosen: "claude-sonnet-5-5-mini", why: "cheaper" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a benchmarked model/);
  });
  test("same-tier non-recommended self-select WITH why -> ok (not a closed whitelist)", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-sonnet-5-5", why: "strong + cheaper" });
    expect(r.ok && r.model).toBe("claude-sonnet-5-5");
    expect(r.ok && r.selection.benchmark).toMatch(/self-select.*AA Intel 56 >= floor 53/);
  });
  test("non-recommended self-select WITHOUT why -> rejected", () => {
    expect(resolvePlannerModel({ catalog: CATALOG, chosen: "claude-sonnet-5-5" }).ok).toBe(false);
  });
});

describe("dated-catalog availability (symmetric with served date tolerance)", () => {
  const dated = ["claude-opus-5-5-20261001"]; // catalog serves ONLY a dated snapshot of opus 5.5
  test("DATED-CATALOG-DEFAULT: a dated-only catalog is usable -> resolves to the actual dated id", () => {
    const r = resolvePlannerModel({ catalog: dated });
    expect(r.ok && r.model).toBe("claude-opus-5-5-20261001");
    expect(r.ok && r.selection.chosen).toBe("opus 5.5");
  });
  test("DATED-CATALOG-EXPLICIT: choosing the dated catalog id resolves it as opus 5.5", () => {
    const r = resolvePlannerModel({ catalog: dated, chosen: "claude-opus-5-5-20261001" });
    expect(r.ok && r.model).toBe("claude-opus-5-5-20261001");
  });
  test("bare alias is still preferred when both bare and dated are present", () => {
    const r = resolvePlannerModel({ catalog: ["claude-opus-5-5-20261001", "claude-opus-5-5"] });
    expect(r.ok && r.model).toBe("claude-opus-5-5");
  });
  test("a non-date variant (opus-5-5-mini) is still NOT available-as-opus-5.5", () => {
    expect(resolvePlannerModel({ catalog: ["claude-opus-5-5-mini"] }).ok).toBe(false);
  });
});

describe("P2-1: recommended branch checks the current floor (no self-contradictory success)", () => {
  test("RAISED-FLOOR-DEFAULT: floor 60, recommended all < 60 -> fail-closed", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, table: withFloor("planning", 60) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/floor 60/);
  });
  test("RAISED-FLOOR-EXPLICIT: floor 60, explicit opus 5.5 (58) -> rejected (no fake 58>=60 record)", () => {
    const r = resolvePlannerModel({ catalog: CATALOG, chosen: "claude-opus-5-5", table: withFloor("planning", 60) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/< planning floor 60/);
  });
});

describe("servedMatchesChosen — runtime fail-closed, exact identity", () => {
  test("exact + dated served match the chosen model", () => {
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-5.5")).toBe(true); // other spelling, same model
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-5-5-20261001")).toBe(true); // date suffix
  });
  test("SERVED-OLDER-VERSION / FAMILY-ONLY / MINI-VARIANT / different-family -> rejected", () => {
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-5")).toBe(false); // flagged silent downgrade
    expect(servedMatchesChosen("claude-opus-5-5", "claude")).toBe(false); // bare family
    expect(servedMatchesChosen("claude-opus-5-5", "claude-opus-5-5-mini")).toBe(false); // weaker variant
    expect(servedMatchesChosen("claude-opus-5-5", "gpt-6-astra")).toBe(false);
    expect(servedMatchesChosen("claude-opus-5-5", "")).toBe(false);
  });
});

describe("other roles", () => {
  test("review role resolves to a recommended (gpt 6 astra / opus 5.5)", () => {
    const r = resolveRoleModel("review", { catalog: CATALOG });
    expect(r.ok && ["gpt-6-astra", "claude-opus-5-5"].includes(r.ok ? r.model : "")).toBe(true);
  });
});
