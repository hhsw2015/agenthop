import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, digestActions } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, readDigestProjection, readNotifiedState, markNotified, gatherDigestSources } from "../src/swarm/morning-digest-store.js";

describe("morning-digest — composeDigest (pure text, signed core)", () => {
  test("alerts lead; an empty night is an explicit quiet line, never empty", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    const txt = composeDigest({ alerts: ["blocked X"], shipped: ["merged Y"] }, "2026-10-10");
    expect(txt.indexOf("needs you")).toBeLessThan(txt.indexOf("shipped"));
    expect(txt).toContain("blocked X");
  });
});

describe("morning-digest — digestProjection (schema morning-digest/v1)", () => {
  test("sections in order (alerts lead), schema + floored generatedAtSec", () => {
    const p = digestProjection({ alerts: ["a1"], clearedReviews: ["c1"], shipped: ["s1"], pending: ["p1"] }, "2026-10-10", 1700.9);
    expect(p.schema).toBe("morning-digest/v1");
    expect(p.date).toBe("2026-10-10");
    expect(p.generatedAtSec).toBe(1700);
    expect(p.sections.map((s) => s.title)).toEqual(["needs you", "cleared", "shipped", "still pending"]);
  });
  test("all-empty ⇒ one quiet-night section; non-finite generatedAtSec ⇒ 0", () => {
    expect(digestProjection({}, "d", NaN)).toEqual({ schema: "morning-digest/v1", date: "d", generatedAtSec: 0, sections: [{ title: "quiet night", lines: ["nothing to report"] }] });
  });
});

describe("morning-digest — digestEnabled (live by default, opt-out)", () => {
  test("default ON; explicit negation OFF; other values ON", () => {
    expect(digestEnabled({})).toBe(true);
    for (const off of ["0", "false", "no", "off", "OFF"]) expect(digestEnabled({ SWARM_DIGEST: off })).toBe(false);
    for (const on of ["1", "true", "", "anything"]) expect(digestEnabled({ SWARM_DIGEST: on })).toBe(true);
  });
});

describe("morning-digest — digestActions (two independent obligations, MD-P2-1/P2-4)", () => {
  const T = "2026-10-10";
  test("before the hour (or non-finite clock) ⇒ do nothing", () => {
    expect(digestActions(T, 6, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
    expect(digestActions(T, NaN, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
  });
  test("fresh day at the hour ⇒ write + notify; both done today ⇒ nothing", () => {
    expect(digestActions(T, 7, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: true, notify: true });
    expect(digestActions(T, 9, 7, { kind: "valid", date: T }, { kind: "notified", date: T })).toEqual({ writeProjection: false, notify: false });
  });
  test("MD-P2-1 A: projection OK but notify not done ⇒ notify only (retain the notify obligation)", () => {
    expect(digestActions(T, 9, 7, { kind: "valid", date: T }, { kind: "none" })).toEqual({ writeProjection: false, notify: true });
  });
  test("MD-P2-1 B: notify done but projection absent ⇒ write only (never a second notify)", () => {
    expect(digestActions(T, 9, 7, { kind: "absent" }, { kind: "notified", date: T })).toEqual({ writeProjection: true, notify: false });
  });
  test("MD-P2-4: corrupt projection ⇒ rewrite (repair); unknown projection ⇒ rewrite (idempotent); unknown notify ⇒ never double-send", () => {
    expect(digestActions(T, 9, 7, { kind: "corrupt" }, { kind: "notified", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, { kind: "unknown" }, { kind: "notified", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, { kind: "valid", date: T }, { kind: "unknown" }).notify).toBe(false);
  });
  test("cross-day: yesterday's valid projection + notify ⇒ regenerate + renotify", () => {
    expect(digestActions("2026-10-11", 9, 7, { kind: "valid", date: T }, { kind: "notified", date: T })).toEqual({ writeProjection: true, notify: true });
  });
});

describe("morning-digest-store — projection + notify marker states", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const digestFile = (): string => path.join(HOME, ".agenthop", "console", "morning-digest", "digest.json");
  const writeDigestRaw = (s: string): void => { mkdirSync(path.dirname(digestFile()), { recursive: true }); writeFileSync(digestFile(), s); };

  test("write ⇒ readDigestProjection valid; absent ⇒ absent; corrupt (sections not an array / string) ⇒ corrupt (MD-P2-4)", () => {
    expect(readDigestProjection(HOME)).toEqual({ kind: "absent" });
    expect(writeDigestProjection(HOME, { shipped: ["m1"] }, "2026-10-10", 123)).toBe(true);
    expect(readDigestProjection(HOME)).toEqual({ kind: "valid", date: "2026-10-10" });
    writeDigestRaw(JSON.stringify({ schema: "morning-digest/v1", date: "2026-10-10", generatedAtSec: 1, sections: "oops" }));
    expect(readDigestProjection(HOME)).toEqual({ kind: "corrupt" });
    writeDigestRaw("not json{");
    expect(readDigestProjection(HOME)).toEqual({ kind: "corrupt" });
  });

  test("markNotified ⇒ readNotifiedState notified; absent ⇒ none", () => {
    expect(readNotifiedState(HOME)).toEqual({ kind: "none" });
    expect(markNotified(HOME, "2026-10-10")).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "notified", date: "2026-10-10" });
  });
});

describe("morning-digest-store — gatherDigestSources (negation-aware, unknown-safe)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): string => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); const f = path.join(d, "PROGRESS.md"); writeFileSync(f, body); return f; };

  test("MD-P2-3: awaiting/pending forms stay pending, not cleared; a positive sign-off clears", () => {
    progress([
      "- 待签收：feature-A，2 REMAIN",
      "- 尚未签收：feature-B，待复审",
      "- ✅ FC-2 签收 0 REMAIN",
      "- ⚠ blocked on gate",
      "- 已并 main batch-7",
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.pending).toEqual(["待签收：feature-A，2 REMAIN", "尚未签收：feature-B，待复审"]); // both stay pending
    expect(s.clearedReviews).toEqual(["✅ FC-2 签收 0 REMAIN"]);                                 // only the real sign-off
    expect(s.alerts).toEqual(["⚠ blocked on gate"]);
    expect(s.shipped).toEqual(["已并 main batch-7"]);
  });

  test("ENOENT (no PROGRESS yet) ⇒ empty gather (a genuine quiet night, NOT null)", () => {
    expect(gatherDigestSources(HOME)).toEqual({ alerts: [], clearedReviews: [], shipped: [], pending: [] });
  });

  test("MD-P2-2: an UNREADABLE PROGRESS ⇒ null (unknown), never a false quiet night", () => {
    const f = progress("- ⚠ blocked and unread");
    chmodSync(f, 0o000);
    expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(f, 0o600);
  });
});
