import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, digestActions, digestTextFromProjection, type ProjState } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, readDigestProjection, readNotifiedState, markNotified, clearNotified, gatherDigestSources } from "../src/swarm/morning-digest-store.js";

const validProj = (date: string): ProjState => ({ kind: "valid", date, projection: { schema: "morning-digest/v1", date, generatedAtSec: 0, sections: [] } });

describe("morning-digest — composeDigest + digestTextFromProjection (frozen body parity)", () => {
  test("alerts lead; empty ⇒ quiet line", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    expect(composeDigest({ alerts: ["blocked X"] }, "d")).toContain("blocked X");
  });
  test("digestTextFromProjection renders the SAME text composeDigest would for the same sources (MD-R2-P2-1)", () => {
    const sources = { alerts: ["a1"], shipped: ["s1", "s2"], pending: ["p1"] };
    expect(digestTextFromProjection(digestProjection(sources, "d", 0))).toBe(composeDigest(sources, "d"));
    expect(digestTextFromProjection(digestProjection({}, "d", 0))).toBe(composeDigest({}, "d")); // quiet-night parity
  });
});

describe("morning-digest — digestProjection (schema morning-digest/v1)", () => {
  test("sections in order (alerts lead); all-empty ⇒ quiet-night; non-finite generatedAtSec ⇒ 0", () => {
    const p = digestProjection({ alerts: ["a1"], clearedReviews: ["c1"], shipped: ["s1"], pending: ["p1"] }, "2026-10-10", 1700.9);
    expect(p.sections.map((s) => s.title)).toEqual(["needs you", "cleared", "shipped", "still pending"]);
    expect(p.generatedAtSec).toBe(1700);
    expect(digestProjection({}, "d", NaN)).toEqual({ schema: "morning-digest/v1", date: "d", generatedAtSec: 0, sections: [{ title: "quiet night", lines: ["nothing to report"] }] });
  });
});

describe("morning-digest — digestEnabled (live by default, opt-out)", () => {
  test("default ON; explicit negation OFF", () => {
    expect(digestEnabled({})).toBe(true);
    for (const off of ["0", "false", "no", "off"]) expect(digestEnabled({ SWARM_DIGEST: off })).toBe(false);
    expect(digestEnabled({ SWARM_DIGEST: "1" })).toBe(true);
  });
});

describe("morning-digest — digestActions (two independent obligations)", () => {
  const T = "2026-10-10";
  test("before the hour / non-finite clock ⇒ nothing", () => {
    expect(digestActions(T, 6, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
    expect(digestActions(T, NaN, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
  });
  test("fresh day ⇒ write + notify; both done ⇒ nothing", () => {
    expect(digestActions(T, 7, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: true, notify: true });
    expect(digestActions(T, 9, 7, validProj(T), { kind: "notified", date: T })).toEqual({ writeProjection: false, notify: false });
  });
  test("projection OK but not notified ⇒ notify only; notified but projection absent ⇒ write only (no second notify)", () => {
    expect(digestActions(T, 9, 7, validProj(T), { kind: "none" })).toEqual({ writeProjection: false, notify: true });
    expect(digestActions(T, 9, 7, { kind: "absent" }, { kind: "notified", date: T })).toEqual({ writeProjection: true, notify: false });
  });
  test("corrupt/unknown projection ⇒ rewrite; unknown notify marker ⇒ never double-send; cross-day ⇒ both", () => {
    expect(digestActions(T, 9, 7, { kind: "corrupt" }, { kind: "notified", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, { kind: "unknown" }, { kind: "notified", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, validProj(T), { kind: "unknown" }).notify).toBe(false); // MD-P2-1: corrupt/unreadable marker ⇒ don't re-send
    expect(digestActions("2026-10-11", 9, 7, validProj(T), { kind: "notified", date: T })).toEqual({ writeProjection: true, notify: true });
  });
});

describe("morning-digest-store — projection + notify marker (durable, MD-P2-1/P2-4)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const digestFile = (): string => path.join(HOME, ".agenthop", "console", "morning-digest", "digest.json");
  const notifiedFile = (): string => path.join(HOME, ".agenthop", "console", "morning-digest", "notified.json");
  const rawWrite = (f: string, s: string): void => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); };

  test("write ⇒ valid (carries the frozen projection body); absent ⇒ absent; corrupt ⇒ corrupt", () => {
    expect(readDigestProjection(HOME)).toEqual({ kind: "absent" });
    writeDigestProjection(HOME, { shipped: ["m1"] }, "2026-10-10", 123);
    const st = readDigestProjection(HOME);
    expect(st.kind).toBe("valid");
    expect(st.kind === "valid" && st.date).toBe("2026-10-10");
    expect(st.kind === "valid" && st.projection.sections[0]!.title).toBe("shipped"); // frozen body available to the notify
    rawWrite(digestFile(), JSON.stringify({ schema: "morning-digest/v1", date: "d", generatedAtSec: 1, sections: "oops" }));
    expect(readDigestProjection(HOME).kind).toBe("corrupt");
  });

  test("MD-P2-1: notify marker — markNotified ⇒ notified; absent ⇒ none; CORRUPT ⇒ unknown (not 'none'); clearNotified reverts", () => {
    expect(readNotifiedState(HOME)).toEqual({ kind: "none" });
    expect(markNotified(HOME, "2026-10-10")).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "notified", date: "2026-10-10" });
    clearNotified(HOME);
    expect(readNotifiedState(HOME)).toEqual({ kind: "none" }); // reverted ⇒ a later retry re-sends
    rawWrite(notifiedFile(), "not json{");
    expect(readNotifiedState(HOME)).toEqual({ kind: "unknown" }); // corrupt marker must NOT read as not-sent
  });
});

describe("morning-digest-store — gatherDigestSources (negation-aware, unknown-safe)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): string => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); const f = path.join(d, "PROGRESS.md"); writeFileSync(f, body); return f; };

  test("MD-P2-3: all 待X / 尚未 forms stay pending (regression), a positive sign-off clears", () => {
    progress([
      "- 待办：feature-A",
      "- 今日待裁：feature-B",
      "- 待处理：feature-C",
      "- 待签收：feature-D，2 REMAIN",
      "- 尚未签收：feature-E，待复审",
      "- ✅ FC-2 签收 0 REMAIN",
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.pending).toEqual(["待办：feature-A", "今日待裁：feature-B", "待处理：feature-C", "待签收：feature-D，2 REMAIN", "尚未签收：feature-E，待复审"]);
    expect(s.clearedReviews).toEqual(["✅ FC-2 签收 0 REMAIN"]); // only the real sign-off
  });

  test("ENOENT ⇒ empty gather (genuine quiet night); UNREADABLE ⇒ null (MD-P2-2)", () => {
    expect(gatherDigestSources(HOME)).toEqual({ alerts: [], clearedReviews: [], shipped: [], pending: [] });
    const f = progress("- 待办 and unread");
    chmodSync(f, 0o000);
    expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(f, 0o600);
  });
});
