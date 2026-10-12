import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, digestActions, digestTextFromProjection, type ProjState } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, writeDigestProjectionRaw, readDigestProjection, readNotifiedState, markNotified, gatherDigestSources, archiveLegacyMigration } from "../src/swarm/morning-digest-store.js";

const validProj = (date: string): ProjState => ({ kind: "valid", date, projection: { schema: "morning-digest/v1", date, generatedAtSec: 0, sections: [] } });

describe("morning-digest — composeDigest + digestTextFromProjection (frozen body parity)", () => {
  test("action-needed leads; empty ⇒ quiet line; projection renders the SAME text as composeDigest (MD-R2-P2-1)", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    const sources = { awaitingRuling: ["r1"], doneOvernight: ["d1", "d2"], awaitingTest: ["t1"] };
    expect(digestTextFromProjection(digestProjection(sources, "d", 0))).toBe(composeDigest(sources, "d"));
    expect(digestTextFromProjection(digestProjection({}, "d", 0))).toBe(composeDigest({}, "d"));
  });
});

describe("morning-digest — digestProjection (schema morning-digest/v1, acceptance buckets)", () => {
  test("sections in action-first order; all-empty ⇒ quiet-night; non-finite generatedAtSec ⇒ 0", () => {
    const p = digestProjection({ awaitingRuling: ["r1"], anomalies: ["x1"], awaitingTest: ["t1"], doneOvernight: ["d1"] }, "2026-10-10", 1700.9);
    expect(p.sections.map((s) => s.title)).toEqual(["待你拍板", "异常", "待你验收", "昨夜完成"]);
    expect(p.generatedAtSec).toBe(1700);
    expect(digestProjection({}, "d", NaN)).toEqual({ schema: "morning-digest/v1", date: "d", generatedAtSec: 0, sections: [{ title: "quiet night", lines: ["nothing to report"] }] });
  });

  test("FC-7: an on-disk projection with LEGACY (old-schema) section titles still parses + renders generically", () => {
    // old morning-digest/v1 bodies used English titles (needs you / cleared / shipped / still pending); the consumer is
    // title-agnostic (only "quiet night" is special-cased), so a legacy projection renders unchanged.
    const legacy = { schema: "morning-digest/v1" as const, date: "2026-10-09", generatedAtSec: 0, sections: [{ title: "shipped", lines: ["old-item"] }] };
    expect(digestTextFromProjection(legacy)).toBe("morning brief — 2026-10-09\nshipped:\n  - old-item");
  });
});

describe("morning-digest — digestEnabled (live by default, opt-out)", () => {
  test("default ON; explicit negation OFF", () => {
    expect(digestEnabled({})).toBe(true);
    for (const off of ["0", "false", "no", "off"]) expect(digestEnabled({ SWARM_DIGEST: off })).toBe(false);
    expect(digestEnabled({ SWARM_DIGEST: "1" })).toBe(true);
  });
});

describe("morning-digest — digestActions (two obligations, pending/sent + unknown-safe — exactly-once surface UNCHANGED)", () => {
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
    expect(digestActions(T, 9, 7, validProj(T), { kind: "pending", date: T }).notify).toBe(true);
    expect(digestActions(T, 9, 7, validProj(T), { kind: "unknown" }).notify).toBe(false);
  });
  test("MD-P2-4: corrupt projection ⇒ rewrite (repair); MD-R2-P2-1: UNKNOWN projection ⇒ do NOT regenerate (retain)", () => {
    expect(digestActions(T, 9, 7, { kind: "corrupt" }, { kind: "sent", date: T }).writeProjection).toBe(true);
    expect(digestActions(T, 9, 7, { kind: "unknown" }, { kind: "sent", date: T })).toEqual({ writeProjection: false, notify: false });
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
    writeDigestProjection(HOME, { doneOvernight: ["m1"] }, "2026-10-10", 123);
    const st = readDigestProjection(HOME);
    expect(st.kind === "valid" && st.date).toBe("2026-10-10");
    expect(st.kind === "valid" && st.projection.sections[0]!.title).toBe("昨夜完成");
    rawWrite("digest.json", JSON.stringify({ schema: "morning-digest/v1", date: "d", generatedAtSec: 1, sections: "oops" }));
    expect(readDigestProjection(HOME).kind).toBe("corrupt");
  });

  test("MD-P2-1: two-phase marker carries the frozen body; legacy date-only ⇒ pending (FC-7, never 'sent'); corrupt ⇒ unknown", () => {
    const body = digestProjection({ doneOvernight: ["x"] }, "2026-10-10", 0);
    expect(readNotifiedState(HOME)).toEqual({ kind: "none" });
    expect(markNotified(HOME, "2026-10-10", "pending", body)).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "pending", date: "2026-10-10", body });
    expect(markNotified(HOME, "2026-10-10", "sent", body)).toBe(true);
    expect(readNotifiedState(HOME)).toEqual({ kind: "sent", date: "2026-10-10", body });
    rawWrite("notified.json", JSON.stringify({ date: "2026-10-10" }));
    expect(readNotifiedState(HOME)).toEqual({ kind: "pending", date: "2026-10-10" });
    rawWrite("notified.json", "not json{");
    expect(readNotifiedState(HOME)).toEqual({ kind: "unknown" });
  });

  test("MD-R2-P2-1: writeDigestProjectionRaw restores an EXACT frozen body over a corrupt carrier (no re-gather)", () => {
    const body = digestProjection({ anomalies: ["keepme"] }, "2026-10-10", 7);
    rawWrite("digest.json", "corrupt{");
    expect(readDigestProjection(HOME).kind).toBe("corrupt");
    expect(writeDigestProjectionRaw(HOME, body)).toBe(true);
    const st = readDigestProjection(HOME);
    expect(st.kind === "valid" && st.projection).toEqual(body);
  });
});

describe("morning-digest-store — gatherDigestSources (验收简报化: acceptance buckets, noise-dropped, unknown-safe)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): string => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); const f = path.join(d, "PROGRESS.md"); writeFileSync(f, body); return f; };
  const decDir = (): string => path.join(HOME, ".agenthop", "swarm", "console", "decisions");
  const writeDecision = (batchId: string, obj: unknown): void => { mkdirSync(decDir(), { recursive: true }); writeFileSync(path.join(decDir(), `${batchId}.json`), typeof obj === "string" ? obj : JSON.stringify(obj)); };
  const mirror = (batchId: string, items: unknown[]): unknown => ({ schema: "console-decisions/v1", generatedAtSec: 0, batch: { batchId, owner: "coord", createdAtSec: 0, items } });

  test("③ 待你拍板 comes from the console decisions mirror (structured), with hard-gate + suggestedAction annotated", () => {
    writeDecision("b1", mirror("b1", [
      { id: "i1", kind: "merge", summary: "merge feat/x", suggestedAction: "approve", hardGate: true },
      { id: "i2", kind: "spend", summary: "approve $5 VM" },
    ]));
    const s = gatherDigestSources(HOME)!;
    expect(s.awaitingRuling).toEqual(["merge feat/x [hard-gate] → approve", "approve $5 VM"]);
  });

  test("① 昨夜完成 / ② 待你验收 / ④ 异常 bucket the PROGRESS tail; ⑤ pure noise + in-flight review is DROPPED", () => {
    progress([
      "- ✅ output-contract 签收 @bc6eda1 0 REMAIN",   // ① 昨夜完成 (sign-off + sha)
      "- 已并 feat/foo merged 3feed44",                 // ① 昨夜完成 (landed + sha)
      "- 待签收：feature-D，2 REMAIN",                   // ⑤ in-flight review (待 + nonzero REMAIN) ⇒ DROP, never 昨夜完成
      "- 待复审：feature-E 送审 codex:Work",            // ⑤ inter-agent in-flight ⇒ DROP
      "- 待验收：mod /swarm 按键需你实测",               // ② 待你验收
      "- feature-G 待实测",                              // ② 待你验收
      "- ⚠ dispatcher 卡死 pid 123",                    // ④ 异常
      "- 哨兵 S19 升级：seat 失联",                       // ④ 异常
      "- 普通进度随手记一笔",                             // ⑤ pure noise ⇒ DROP
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.doneOvernight).toEqual(["✅ output-contract 签收 @bc6eda1 0 REMAIN", "已并 feat/foo merged 3feed44"]);
    expect(s.awaitingTest).toEqual(["待验收：mod /swarm 按键需你实测", "feature-G 待实测"]);
    expect(s.anomalies).toEqual(["⚠ dispatcher 卡死 pid 123", "哨兵 S19 升级：seat 失联"]);
    expect(s.awaitingRuling).toEqual([]); // no decisions dir ⇒ empty (not from a PROGRESS 待裁 grep)
  });

  test("a corrupt / malformed decision batch is surfaced as an ANOMALY (visible, non-blocking), never silently dropped", () => {
    writeDecision("good", mirror("good", [{ id: "i1", kind: "k", summary: "ok item" }]));
    writeDecision("bad1", "not json{");
    writeDecision("bad2", { schema: "console-decisions/v1", batch: { items: [{ id: "x", kind: "k" }] } }); // item missing summary
    const s = gatherDigestSources(HOME)!;
    expect(s.awaitingRuling).toEqual(["ok item"]);
    expect(s.anomalies).toEqual(expect.arrayContaining([
      expect.stringContaining("决策批 bad1"),
      expect.stringContaining("决策批 bad2"),
    ]));
  });

  test("ENOENT (no PROGRESS, no decisions) ⇒ empty gather (quiet night); PROGRESS UNREADABLE ⇒ null (MD-P2-2)", () => {
    expect(gatherDigestSources(HOME)).toEqual({ awaitingRuling: [], anomalies: [], awaitingTest: [], doneOvernight: [] });
    const f = progress("- 待验收 and unread");
    chmodSync(f, 0o000);
    if (typeof process.getuid === "function" && process.getuid() !== 0) expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(f, 0o600);
  });

  test("MD-P2-2: an UNREADABLE decisions dir ⇒ null (cannot assert no ruling pending), never a false quiet night", () => {
    writeDecision("b1", mirror("b1", [{ id: "i1", kind: "k", summary: "s" }]));
    progress("- ✅ done @abc1234");
    chmodSync(decDir(), 0o000);
    if (typeof process.getuid === "function" && process.getuid() !== 0) expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(decDir(), 0o700);
  });
});

describe("morning-digest-store — archiveLegacyMigration (MD-R7-P2-2, per-date append-only)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const migFile = (date: string): string => path.join(HOME, ".agenthop", "console", "morning-digest", "needs-migration", `${date}.json`);

  test("archives a legacy date per file, carrying the date; append-only (never modifies an existing record)", () => {
    expect(archiveLegacyMigration(HOME, "2026-10-10")).toBe(true);
    const raw = readFileSync(migFile("2026-10-10"), "utf8");
    expect(JSON.parse(raw).date).toBe("2026-10-10");
    expect(raw).toContain("2026-10-10");
    writeFileSync(migFile("2026-10-10"), JSON.stringify({ date: "2026-10-10", sentinel: "kept" }));
    expect(archiveLegacyMigration(HOME, "2026-10-10")).toBe(true);
    expect(JSON.parse(readFileSync(migFile("2026-10-10"), "utf8")).sentinel).toBe("kept");
    expect(archiveLegacyMigration(HOME, "2026-10-11")).toBe(true);
    expect(readdirSync(path.dirname(migFile("2026-10-10"))).sort()).toEqual(["2026-10-10.json", "2026-10-11.json"]);
  });

  test("a path-unsafe date is sanitized to one safe segment (no traversal)", () => {
    expect(archiveLegacyMigration(HOME, "../evil")).toBe(true);
    const dir = path.join(HOME, ".agenthop", "console", "morning-digest", "needs-migration");
    expect(readdirSync(dir).every((n) => !n.includes("/") && n.endsWith(".json"))).toBe(true);
    expect(existsSync(path.join(HOME, ".agenthop", "console", "evil.json"))).toBe(false);
  });
});
