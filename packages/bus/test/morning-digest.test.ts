import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, digestActions, digestTextFromProjection, type ProjState } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, readDigestProjection, readNotifiedState, markNotified, gatherDigestSources } from "../src/swarm/morning-digest-store.js";

const validProj = (date: string): ProjState => ({ kind: "valid", date, projection: { schema: "morning-digest/v1", date, generatedAtSec: 0, sections: [] } });

describe("morning-digest — composeDigest + digestTextFromProjection (frozen body parity)", () => {
  test("alerts lead; empty ⇒ quiet line; projection renders the SAME text as composeDigest (MD-R2-P2-1)", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    const sources = { alerts: ["a1"], shipped: ["s1", "s2"], pending: ["p1"] };
    expect(digestTextFromProjection(digestProjection(sources, "d", 0))).toBe(composeDigest(sources, "d"));
    expect(digestTextFromProjection(digestProjection({}, "d", 0))).toBe(composeDigest({}, "d"));
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

describe("morning-digest — digestActions (two obligations, pending/sent + unknown-safe)", () => {
  const T = "2026-10-10";
  test("before the hour / non-finite clock ⇒ nothing", () => {
    expect(digestActions(T, 6, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
    expect(digestActions(T, NaN, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: false, notify: false });
  });
  test("fresh day ⇒ write + notify; both confirmed today ⇒ nothing", () => {
    expect(digestActions(T, 7, 7, { kind: "absent" }, { kind: "none" })).toEqual({ writeProjection: true, notify: true });
    expect(digestActions(T, 9, 7, validProj(T), { kind: "sent", date: T })).toEqual({ writeProjection: false, notify: false });
  });
  test("projection OK but not sent ⇒ notify only; sent but projection absent ⇒ write only (no second notify)", () => {
    expect(digestActions(T, 9, 7, validProj(T), { kind: "none" })).toEqual({ writeProjection: false, notify: true });
    expect(digestActions(T, 9, 7, { kind: "absent" }, { kind: "sent", date: T })).toEqual({ writeProjection: true, notify: false });
  });
  test("MD-P2-1: a PENDING delivery is CONTINUED (notify true); an UNKNOWN marker ⇒ never re-send", () => {
    expect(digestActions(T, 9, 7, validProj(T), { kind: "pending", date: T }).notify).toBe(true);  // continue the unfinished delivery
    expect(digestActions(T, 9, 7, validProj(T), { kind: "unknown" }).notify).toBe(false);           // corrupt/unreadable marker ⇒ don't re-send
  });
  test("MD-P2-4: corrupt projection ⇒ rewrite (repair); MD-R2-P2-1: UNKNOWN projection ⇒ do NOT regenerate (retain)", () => {
    expect(digestActions(T, 9, 7, { kind: "corrupt" }, { kind: "sent", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, { kind: "unknown" }, { kind: "sent", date: T })).toEqual({ writeProjection: false, notify: false }); // unreadable ⇒ never re-gather a different body
  });
  test("cross-day ⇒ regenerate + renotify", () => {
    expect(digestActions("2026-10-11", 9, 7, validProj(T), { kind: "sent", date: T })).toEqual({ writeProjection: true, notify: true });
  });
});

describe("morning-digest-store — projection + two-phase notify marker (durable, MD-P2-1/P2-4)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const dir = (): string => path.join(HOME, ".agenthop", "console", "morning-digest");
  const rawWrite = (name: string, s: string): void => { mkdirSync(dir(), { recursive: true }); writeFileSync(path.join(dir(), name), s); };

  test("write ⇒ valid (carries frozen projection body); absent ⇒ absent; corrupt ⇒ corrupt", () => {
    expect(readDigestProjection(HOME)).toEqual({ kind: "absent" });
    writeDigestProjection(HOME, { shipped: ["m1"] }, "2026-10-10", 123);
    const st = readDigestProjection(HOME);
    expect(st.kind === "valid" && st.date).toBe("2026-10-10");
    expect(st.kind === "valid" && st.projection.sections[0]!.title).toBe("shipped");
    rawWrite("digest.json", JSON.stringify({ schema: "morning-digest/v1", date: "d", generatedAtSec: 1, sections: "oops" }));
    expect(readDigestProjection(HOME).kind).toBe("corrupt");
  });

  test("MD-P2-1: two-phase marker — none ⇒ none; pending ⇒ pending; sent ⇒ sent; legacy {date} ⇒ sent; corrupt ⇒ unknown", () => {
    expect(readNotifiedState(HOME)).toEqual({ kind: "none" });
    expect(markNotified(HOME, "2026-10-10", "pending")).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "pending", date: "2026-10-10" }); // unfinished ⇒ recovery continues
    expect(markNotified(HOME, "2026-10-10", "sent")).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "sent", date: "2026-10-10" });     // confirmed ⇒ never re-send
    rawWrite("notified.json", JSON.stringify({ date: "2026-10-10" }));                 // legacy date-only
    expect(readNotifiedState(HOME)).toEqual({ kind: "sent", date: "2026-10-10" });     // conservative: treat as sent (don't re-send)
    rawWrite("notified.json", "not json{");
    expect(readNotifiedState(HOME)).toEqual({ kind: "unknown" });                      // corrupt ⇒ must NOT read as not-sent
  });
});

describe("morning-digest-store — gatherDigestSources (negation-aware, unknown-safe)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): string => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); const f = path.join(d, "PROGRESS.md"); writeFileSync(f, body); return f; };

  test("MD-P2-3: all 待X / 尚未 forms stay pending; a positive sign-off clears", () => {
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
    expect(s.clearedReviews).toEqual(["✅ FC-2 签收 0 REMAIN"]);
  });

  test("ENOENT ⇒ empty gather (quiet night); UNREADABLE ⇒ null (MD-P2-2)", () => {
    expect(gatherDigestSources(HOME)).toEqual({ alerts: [], clearedReviews: [], shipped: [], pending: [] });
    const f = progress("- 待办 and unread");
    chmodSync(f, 0o000);
    expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(f, 0o600);
  });
});
