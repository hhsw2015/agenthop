/**
 * roleFragments — the gstack absorption① CANDIDATE role library (org-chart × our independence), seeded into
 * `_fragments.json`. These tests pin TWO things: (1) every fragment carries the full shape the dispatch requires
 * (职责/把关门/送审物形状/来源/改编点 + maturity + 我方对应物), and (2) the key is INERT to the engine — the hard
 * boundary "不动 roleProfile 引擎". `loadFragmentLibrary` reads only instructionBlocks/skillGroups/boundaryGroups,
 * so a library WITH roleFragments must load identically to the same library WITHOUT it (FC-7 forward-reserve).
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFragmentLibrary } from "../src/swarm/role-profile.js";

const fixDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "roleprofile");
const raw = JSON.parse(readFileSync(path.join(fixDir, "_fragments.json"), "utf8")) as Record<string, unknown>;
const okv = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => { if (!r.ok) throw new Error(r.reason); return r.value; };

const REQUIRED = ["title", "maturity", "responsibilities", "gate", "reviewArtifact", "source", "adaptation", "ourEquivalent"] as const;

describe("roleFragments candidate library", () => {
  const roleFragments = raw.roleFragments as Record<string, Record<string, unknown>>;

  test("the fixture carries a roleFragments object", () => {
    expect(roleFragments && typeof roleFragments === "object" && !Array.isArray(roleFragments)).toBe(true);
    expect(Object.keys(roleFragments).length).toBeGreaterThan(0);
  });

  test("every fragment has the full dispatched shape (non-empty strings) + a valid maturity", () => {
    for (const [id, frag] of Object.entries(roleFragments)) {
      for (const f of REQUIRED) {
        expect(typeof frag[f], `${id}.${f}`).toBe("string");
        expect((frag[f] as string).length, `${id}.${f} non-empty`).toBeGreaterThan(0);
      }
      expect(["prime", "candidate"], `${id}.maturity`).toContain(frag.maturity);
    }
  });

  test("the five prime fragments are present and marked prime", () => {
    for (const id of ["cso", "designer", "release-manager", "doc-engineer", "retro"]) {
      expect(roleFragments[id], id).toBeTruthy();
      expect(roleFragments[id]!.maturity, id).toBe("prime");
    }
  });

  test("roleFragments is INERT to the engine — loading WITH it equals loading WITHOUT it (不动引擎)", () => {
    const withKey = okv(loadFragmentLibrary(raw));
    const { roleFragments: _drop, ...withoutKey } = raw;
    const withoutK = okv(loadFragmentLibrary(withoutKey));
    expect(withKey).toEqual(withoutK); // the engine never reads roleFragments ⇒ resolved library is byte-identical
    expect("roleFragments" in withKey).toBe(false); // the loaded library carries only the 3 known sections
  });
});
