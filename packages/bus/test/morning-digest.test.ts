import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, shouldGenerateDigest } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, readDigestDate, gatherDigestSources } from "../src/swarm/morning-digest-store.js";

describe("morning-digest — composeDigest (pure text, signed core)", () => {
  test("alerts lead; an empty night is an explicit quiet line, never empty", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    const txt = composeDigest({ alerts: ["blocked X"], shipped: ["merged Y"] }, "2026-10-10");
    expect(txt.indexOf("needs you")).toBeLessThan(txt.indexOf("shipped")); // alerts lead
    expect(txt).toContain("blocked X");
  });
});

describe("morning-digest — digestProjection (schema morning-digest/v1)", () => {
  test("builds sections in order (alerts lead), schema + floored generatedAtSec", () => {
    const p = digestProjection({ alerts: ["a1"], clearedReviews: ["c1"], shipped: ["s1"], pending: ["p1"] }, "2026-10-10", 1700.9);
    expect(p.schema).toBe("morning-digest/v1");
    expect(p.date).toBe("2026-10-10");
    expect(p.generatedAtSec).toBe(1700); // floored
    expect(p.sections.map((s) => s.title)).toEqual(["needs you", "cleared", "shipped", "still pending"]);
    expect(p.sections[0]!.lines).toEqual(["a1"]);
  });
  test("omits empty groups; an all-empty night yields a single quiet-night section", () => {
    const only = digestProjection({ shipped: ["s1"] }, "d", 0);
    expect(only.sections.map((s) => s.title)).toEqual(["shipped"]);
    const quiet = digestProjection({}, "d", 0);
    expect(quiet.sections).toEqual([{ title: "quiet night", lines: ["nothing to report"] }]);
  });
  test("non-finite generatedAtSec ⇒ 0", () => {
    expect(digestProjection({}, "d", NaN).generatedAtSec).toBe(0);
  });
});

describe("morning-digest — digestEnabled (live by default, opt-out)", () => {
  test("default ON; explicit negation OFF; other values ON", () => {
    expect(digestEnabled({})).toBe(true);
    for (const off of ["0", "false", "no", "off", "OFF"]) expect(digestEnabled({ SWARM_DIGEST: off })).toBe(false);
    for (const on of ["1", "true", "yes", "", "anything"]) expect(digestEnabled({ SWARM_DIGEST: on })).toBe(true);
  });
});

describe("morning-digest — shouldGenerateDigest (daily throttle, once per date)", () => {
  test("fires at/after the hour, at most once per calendar date", () => {
    expect(shouldGenerateDigest("2026-10-10", 6, 7, null)).toBe(false);   // before the hour
    expect(shouldGenerateDigest("2026-10-10", 7, 7, null)).toBe(true);    // at the hour, not yet done today
    expect(shouldGenerateDigest("2026-10-10", 9, 7, null)).toBe(true);    // after the hour
    expect(shouldGenerateDigest("2026-10-10", 9, 7, "2026-10-10")).toBe(false); // already done today (restart-safe)
    expect(shouldGenerateDigest("2026-10-11", 9, 7, "2026-10-10")).toBe(true);  // a new date ⇒ generate again
  });
  test("non-finite hour ⇒ false (no clock ⇒ no spam)", () => {
    expect(shouldGenerateDigest("d", NaN, 7, null)).toBe(false);
    expect(shouldGenerateDigest("d", 9, NaN, null)).toBe(false);
  });
});

describe("morning-digest-store — write / read / gather (fail-soft IO)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): void => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "PROGRESS.md"), body); };

  test("writeDigestProjection lands a valid morning-digest/v1 file; readDigestDate returns its date", () => {
    expect(readDigestDate(HOME)).toBeNull(); // absent ⇒ null
    expect(writeDigestProjection(HOME, { shipped: ["m1"] }, "2026-10-10", 123)).toBe(true);
    const raw = JSON.parse(readFileSync(path.join(HOME, ".agenthop", "console", "morning-digest", "digest.json"), "utf8"));
    expect(raw.schema).toBe("morning-digest/v1");
    expect(raw.date).toBe("2026-10-10");
    expect(raw.sections[0].title).toBe("shipped");
    expect(readDigestDate(HOME)).toBe("2026-10-10"); // seeds the daily throttle across a restart
  });

  test("gatherDigestSources classifies PROGRESS bullet lines by marker (first-match, bullets only)", () => {
    progress([
      "- ⚠ blocked on review gate",
      "- ✅ FC-2 签收 CLEARED 0 REMAIN",
      "- 已并 main batch-7",
      "- 送审 @abc 待签",
      "not a bullet — ignored",
      "## a header — ignored",
    ].join("\n"));
    const s = gatherDigestSources(HOME);
    expect(s.alerts).toEqual(["⚠ blocked on review gate"]);
    expect(s.clearedReviews).toEqual(["✅ FC-2 签收 CLEARED 0 REMAIN"]);
    expect(s.shipped).toEqual(["已并 main batch-7"]);
    expect(s.pending).toEqual(["送审 @abc 待签"]);
  });

  test("no PROGRESS.md ⇒ all groups empty ⇒ a valid quiet night (fail-soft)", () => {
    const s = gatherDigestSources(HOME);
    expect(s).toEqual({ alerts: [], clearedReviews: [], shipped: [], pending: [] });
    expect(digestProjection(s, "d", 0).sections).toEqual([{ title: "quiet night", lines: ["nothing to report"] }]);
  });
});
