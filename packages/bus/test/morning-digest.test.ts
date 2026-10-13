import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { composeDigest, digestProjection, digestEnabled, digestActions, digestTextFromProjection, type ProjState } from "../src/swarm/morning-digest.js";
import { writeDigestProjection, writeDigestProjectionRaw, readDigestProjection, readNotifiedState, markNotified, gatherDigestSources, archiveLegacyMigration } from "../src/swarm/morning-digest-store.js";
import { writeInbox, composeInboxMsg, validInboxMsg } from "../src/inbox.js";

const validProj = (date: string): ProjState => ({ kind: "valid", date, projection: { schema: "morning-digest/v1", date, generatedAtSec: 0, sections: [] } });

describe("morning-digest — composeDigest + digestTextFromProjection (frozen body parity)", () => {
  test("action-needed leads; empty ⇒ quiet line; projection renders the SAME text as composeDigest (MD-R2-P2-1)", () => {
    expect(composeDigest({}, "2026-10-10")).toBe("morning brief — 2026-10-10\n(quiet night — nothing to report)");
    const sources = { awaitingRuling: ["r1"], recentDone: ["d1", "d2"], awaitingTest: ["t1"] };
    expect(digestTextFromProjection(digestProjection(sources, "d", 0))).toBe(composeDigest(sources, "d"));
    expect(digestTextFromProjection(digestProjection({}, "d", 0))).toBe(composeDigest({}, "d"));
  });
});

describe("morning-digest — digestProjection (schema morning-digest/v1, acceptance buckets)", () => {
  test("sections in action-first order; all-empty ⇒ quiet-night; non-finite generatedAtSec ⇒ 0", () => {
    const p = digestProjection({ awaitingRuling: ["r1"], anomalies: ["x1"], awaitingTest: ["t1"], recentDone: ["d1"] }, "2026-10-10", 1700.9);
    expect(p.sections.map((s) => s.title)).toEqual(["待你拍板", "异常", "待你验收", "完成(签收/落地)"]);
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
    writeDigestProjection(HOME, { recentDone: ["m1"] }, "2026-10-10", 123);
    const st = readDigestProjection(HOME);
    expect(st.kind === "valid" && st.date).toBe("2026-10-10");
    expect(st.kind === "valid" && st.projection.sections[0]!.title).toBe("完成(签收/落地)");
    rawWrite("digest.json", JSON.stringify({ schema: "morning-digest/v1", date: "d", generatedAtSec: 1, sections: "oops" }));
    expect(readDigestProjection(HOME).kind).toBe("corrupt");
  });

  test("MD-P2-1: two-phase marker carries the frozen body; legacy date-only ⇒ pending (FC-7, never 'sent'); corrupt ⇒ unknown", () => {
    const body = digestProjection({ recentDone: ["x"] }, "2026-10-10", 0);
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

describe("morning-digest-store — gatherDigestSources (验收简报化: authoritative store + state/evidence buckets)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const progress = (body: string): string => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); const f = path.join(d, "PROGRESS.md"); writeFileSync(f, body); return f; };
  const bDir = (id: string): string => path.join(HOME, ".agenthop", "console", "decision-batches", id);
  const item = (id: string, over: Record<string, unknown> = {}): unknown => ({ id, kind: "k", summary: `s-${id}`, suggestedAction: "approve", ...over });
  const writeBatch = (id: string, items: unknown[], opts: { consumed?: boolean; raw?: string } = {}): void => {
    mkdirSync(bDir(id), { recursive: true });
    writeFileSync(path.join(bDir(id), "batch.json"), opts.raw ?? JSON.stringify({ batchId: id, owner: "coord", createdAtSec: 0, items }));
    if (opts.consumed) writeFileSync(path.join(bDir(id), "consumed.json"), JSON.stringify({ digest: "d" }));
  };

  test("MDV2-1: 待你拍板 reads the AUTHORITATIVE decision-batches store (no derived mirror); a consumed batch is skipped", () => {
    writeBatch("b1", [item("i1", { summary: "merge feat/x", suggestedAction: "approve", hardGate: true }), item("i2", { summary: "approve $5 VM", suggestedAction: "ok" })]);
    writeBatch("b2", [item("x1", { summary: "already ruled" })], { consumed: true });
    expect(gatherDigestSources(HOME)!.awaitingRuling).toEqual([
      "merge feat/x [hard-gate] → approve (b:b1 i:i1)",
      "approve $5 VM → ok (b:b1 i:i2)",
    ]);
  });

  test("MDV2-1: a CONFIRMED-empty store (ENOENT) ⇒ genuine quiet, never a false quiet from a missing derived mirror", () => {
    expect(gatherDigestSources(HOME)).toEqual({ awaitingRuling: [], anomalies: [], awaitingTest: [], recentDone: [] });
  });

  test("MDV2-2: the display cap limits OUTPUT only — the scan continues and the overflow count is visible", () => {
    writeBatch("big", Array.from({ length: 11 }, (_, i) => item(`i${i}`)));
    const ar = gatherDigestSources(HOME, 80, 8)!.awaitingRuling!;
    expect(ar.filter((l) => l.startsWith("s-i")).length).toBe(8);
    expect(ar.some((l) => /\+3 更多待你拍板/.test(l))).toBe(true);
  });

  test("MDV2-3: a malformed batch (bad JSON / empty summary / non-boolean hardGate) is a VISIBLE anomaly, never a silent empty", () => {
    writeBatch("good", [item("i1", { summary: "ok item" })]);
    writeBatch("bad1", [], { raw: "not json{" });
    writeBatch("bad2", [{ id: "x", kind: "k", summary: "", suggestedAction: "a" }]);
    writeBatch("bad3", [{ id: "y", kind: "k", summary: "s", suggestedAction: "a", hardGate: "yes" }]);
    const s = gatherDigestSources(HOME)!;
    expect(s.awaitingRuling).toEqual(["ok item → approve (b:good i:i1)"]);
    expect(s.anomalies).toEqual(expect.arrayContaining([
      expect.stringContaining("决策批 bad1"), expect.stringContaining("决策批 bad2"), expect.stringContaining("决策批 bad3"),
    ]));
  });

  test("MDV2-4: a long summary is clipped but hard-gate + suggested action + (batch,item) ref are RETAINED", () => {
    writeBatch("b", [item("i1", { summary: "x".repeat(300), suggestedAction: "merge now", hardGate: true })]);
    const line = gatherDigestSources(HOME)!.awaitingRuling![0]!;
    expect(line).toContain("[hard-gate]");
    expect(line).toContain("→ merge now");
    expect(line).toContain("(b:b i:i1)");
    expect(line).toContain("…");
  });

  test("MDV2-5: PROGRESS buckets by STATE + EVIDENCE — SHA-required 完成, negation/conditional + 哨兵-keyword + in-flight handled", () => {
    progress([
      "- ✅ output-contract 签收 @bc6eda1 0 REMAIN",
      "- 已并 feat/foo merged 3feed44",
      "- ✅ 哨兵修复已并 @8c8555a 0 REMAIN",
      "- not merged @deadbee",
      "- 未装机 @deadbee",
      "- 0 REMAIN 即合并 @deadbee",
      "- ✅ 检查结束",
      "- 待复审：sentinel 优化 @deadbee",
      "- ⚠ dispatcher 卡死 pid 123",
      "- 待验收：mod /swarm 按键需你实测",
      "- 普通进度随手记一笔",
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.recentDone).toEqual(["✅ output-contract 签收 @bc6eda1 0 REMAIN", "已并 feat/foo merged 3feed44", "✅ 哨兵修复已并 @8c8555a 0 REMAIN"]);
    expect(s.anomalies).toEqual(["⚠ dispatcher 卡死 pid 123"]);
    expect(s.awaitingTest).toEqual(["待验收：mod /swarm 按键需你实测"]);
    expect(s.awaitingRuling).toEqual([]);
  });

  test("MDV2-5 r2: multi-signal lines keep the user action / active problem; COMMIT_REF syntax (UUID out, decimal short sha in); SHA retained", () => {
    progress([
      "- ✅ mod 已并 @deadbee，待验收",                              // done + user-test ⇒ 待你验收 (action survives), NOT only 完成
      "- ✅ patch 已并 @deadbee，但仍超时",                          // done + active problem ⇒ 异常, NOT only 完成
      "- 待复审：异常报告优化 @deadbee",                            // in-flight (待复审); 异常 here is a TOPIC ⇒ DROP (not 异常)
      "- ✅ 已并 item，session=deadbeef-1234-5678-9abc-def012345678", // a UUID, no commit ref ⇒ DROP (not 完成)
      "- ✅ 已并 @1431247 0 REMAIN",                                 // an all-DECIMAL real short sha ⇒ 完成 (accepted)
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.awaitingTest).toEqual(["✅ mod 已并 @deadbee，待验收"]);
    expect(s.anomalies).toEqual(["✅ patch 已并 @deadbee，但仍超时"]);
    expect(s.recentDone).toEqual(["✅ 已并 @1431247 0 REMAIN"]);
  });

  test("MDV2-5 r3: subject-state — fix-topic vs current problem vs follow-up action (no opposite-direction regression)", () => {
    progress([
      "- \u2705 \u8d85\u65f6\u4fee\u590d\u5df2\u5e76 @deadbee 0 REMAIN",          // "超时修复已并" fix TOPIC in a clean completion ⇒ 完成 (not 异常)
      "- \u2705 \u5931\u8054\u544a\u8b66\u4fee\u590d\u5df2\u5e76 @deadbee 0 REMAIN", // "失联告警修复已并" fix topic ⇒ 完成
      "- \u2705 patch \u5df2\u5e76 @deadbee\uff0c\u4f46\u4ecd\u8d85\u65f6",       // "但仍超时" STILL-broken ⇒ 异常
      "- \u26a0 dispatcher \u5361\u6b7b\uff1b\u4fee\u590d\u8865\u4e01\u5df2\u9001\u5ba1 @deadbee", // current ⚠卡死, follow-up 送审 ⇒ 异常 (not dropped)
      "- \u5f85\u9a8c\u6536\uff1amod \u5b9e\u6d4b\u540e\u518d\u9001\u5ba1 @deadbee", // 待验收 subject, follow-up 送审 ⇒ 待你验收 (not dropped)
      "- \u5f85\u590d\u5ba1\uff1a\u5f02\u5e38\u62a5\u544a\u4f18\u5316 @deadbee",  // pure in-flight; 异常 is a TOPIC ⇒ DROP
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.recentDone).toEqual([
      "\u2705 \u8d85\u65f6\u4fee\u590d\u5df2\u5e76 @deadbee 0 REMAIN",
      "\u2705 \u5931\u8054\u544a\u8b66\u4fee\u590d\u5df2\u5e76 @deadbee 0 REMAIN",
    ]);
    expect(s.anomalies).toEqual([
      "\u2705 patch \u5df2\u5e76 @deadbee\uff0c\u4f46\u4ecd\u8d85\u65f6",
      "\u26a0 dispatcher \u5361\u6b7b\uff1b\u4fee\u590d\u8865\u4e01\u5df2\u9001\u5ba1 @deadbee",
    ]);
    expect(s.awaitingTest).toEqual(["\u5f85\u9a8c\u6536\uff1amod \u5b9e\u6d4b\u540e\u518d\u9001\u5ba1 @deadbee"]);
  });

  test("MDV2-5 r3: SHA retention checks a STANDALONE ref (not a substring of another id)", () => {
    const longBody = `\u2705 trace=deadbeef_owner ${"x".repeat(200)} \u5df2\u5e76 @deadbeef`;
    progress(`- ${longBody}`);
    const [done] = gatherDigestSources(HOME)!.recentDone!;
    // the real @deadbeef was truncated; the surviving substring "deadbeef_owner" must NOT count as the ref ⇒ append […deadbeef]
    expect(done).toContain("[\u2026deadbeef]");
  });

  test("MDV2-5 r4: subject scope — in-flight subject drops topic words; a current problem beats a trailing completion", () => {
    progress([
      "- 待复审：超时报告优化 @deadbee",               // subject=待复审 (in-flight); 超时 is a TOPIC ⇒ DROP (not 异常)
      "- 待复审：失联告警优化 @deadbee",               // same ⇒ DROP
      "- ⚠ dispatcher 当前卡死；修复补丁已并 @deadbee", // subject=⚠当前卡死 (current) ⇒ 异常 (trailing 已并 doesn't flip it)
      "- ✅ 超时修复已并 @deadbee 0 REMAIN",           // 超时修复 = fix topic in a completion ⇒ 完成
      "- ✅ mod 已并 @deadbee，待验收",                // done + user-test in one clause ⇒ 待你验收 (action survives)
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.anomalies).toEqual(["⚠ dispatcher 当前卡死；修复补丁已并 @deadbee"]);
    expect(s.recentDone).toEqual(["✅ 超时修复已并 @deadbee 0 REMAIN"]);
    expect(s.awaitingTest).toEqual(["✅ mod 已并 @deadbee，待验收"]);
    expect(s.awaitingRuling).toEqual([]); // the two 待复审 topic lines DROP (nowhere), never 异常
  });

  test("MDV2-5 r7: opening anomaly word goes through subject scope — a landed fix is 完成 (✅ not required); a bare anomaly report is 异常", () => {
    progress([
      "- 超时修复已并 @deadbee 0 REMAIN",       // opens 超时 but IS a completion subject (超时=fix object) ⇒ 完成 (no ✅ needed)
      "- 失联告警修复已并 @deadbee 0 REMAIN",   // opens 失联 but a completion subject ⇒ 完成
      "- 卡死 pid 123 待排查",                  // opens 卡死, NOT a completion (no commit ref) ⇒ 异常 (bare report still surfaces)
    ].join("\n"));
    const s = gatherDigestSources(HOME)!;
    expect(s.recentDone).toEqual([
      "超时修复已并 @deadbee 0 REMAIN",
      "失联告警修复已并 @deadbee 0 REMAIN",
    ]);
    expect(s.anomalies).toEqual(["卡死 pid 123 待排查"]);
  });

  test("MDV2-5 r4: reference boundary — a clip truncating a longer invalid id still appends the real ref (position, not re-match)", () => {
    progress(`- ✅ 已并 @deadbeef_owner ${"y".repeat(150)} 落地 @cafebabe`);
    const [done] = gatherDigestSources(HOME)!.recentDone!;
    expect(done).toContain("[…cafebabe]"); // the real @cafebabe (past the clip) is appended, not the truncated fake @deadbeef
  });

  test("MDV2-5 r2: a long completion with the SHA at the end RETAINS the SHA in the output (not truncated away)", () => {
    const longBody = `✅ ${"x".repeat(200)} 已并 @abc1234`;
    progress(`- ${longBody}`);
    const [done] = gatherDigestSources(HOME)!.recentDone!;
    expect(done).toContain("abc1234"); // evidence preserved even though the prose was clipped
    expect(done.length).toBeLessThan(longBody.length);
  });

  test("PROGRESS unreadable ⇒ null (MD-P2-2); an unreadable decision store ⇒ null (MDV2-1), never a false quiet night", () => {
    const f = progress("- ✅ done @abc123f");
    chmodSync(f, 0o000);
    if (typeof process.getuid === "function" && process.getuid() !== 0) expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(f, 0o600);
    writeBatch("b1", [item("i1")]);
    const bd = path.join(HOME, ".agenthop", "console", "decision-batches");
    chmodSync(bd, 0o000);
    if (typeof process.getuid === "function" && process.getuid() !== 0) expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(bd, 0o700);
  });
});

describe("morning-digest — infra crash-recovery / restart-idempotency (zero-bug ruling)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const seedBatch = (id: string): void => {
    const d = path.join(HOME, ".agenthop", "console", "decision-batches", id); mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "batch.json"), JSON.stringify({ batchId: id, owner: "c", createdAtSec: 0, items: [{ id: "i1", kind: "k", summary: "rule me", suggestedAction: "approve" }] }));
  };
  const seedProgress = (body: string): void => { const d = path.join(HOME, ".agenthop", "swarm"); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "PROGRESS.md"), body); };

  test("determinism: a RESTART re-gathers the SAME sources from unchanged stores (no clock/order drift)", () => {
    seedBatch("b1"); seedProgress("- \u2705 \u5df2\u5e76 @abc1234\n- \u26a0 \u5361\u6b7b");
    expect(gatherDigestSources(HOME)).toEqual(gatherDigestSources(HOME));
  });

  test("gather\u2192write\u2192RESTART(re-read) yields a VALID projection; regeneration from unchanged stores is byte-identical (idempotent)", () => {
    seedBatch("b1"); seedProgress("- \u2705 \u5df2\u5e76 @abc1234");
    const sources = gatherDigestSources(HOME)!;
    expect(writeDigestProjection(HOME, sources, "2026-10-12", 100)).toBe(true);
    const st = readDigestProjection(HOME); // a restart reads the on-disk frozen body
    expect(st.kind).toBe("valid");
    expect(digestProjection(gatherDigestSources(HOME)!, "2026-10-12", 100)).toEqual(st.kind === "valid" ? st.projection : null);
  });

  test("crash BETWEEN publish and notify: a RESTART continues the pending delivery, and once sent never re-sends (exactly-once)", () => {
    seedBatch("b1");
    const body = digestProjection(gatherDigestSources(HOME)!, "2026-10-12", 0);
    expect(markNotified(HOME, "2026-10-12", "pending", body)).toBe(true); // claimed before send, then crash
    expect(digestActions("2026-10-12", 9, 7, readDigestProjection(HOME), readNotifiedState(HOME)).notify).toBe(true);  // restart CONTINUES
    expect(markNotified(HOME, "2026-10-12", "sent", body)).toBe(true);
    expect(digestActions("2026-10-12", 9, 7, readDigestProjection(HOME), readNotifiedState(HOME)).notify).toBe(false); // restart never re-sends
  });

  test("crash mid-read of a runtime source \u21d2 unknown/retry (null), never a false quiet publish; recovers when the fault clears", () => {
    seedBatch("b1");
    const bd = path.join(HOME, ".agenthop", "console", "decision-batches");
    chmodSync(bd, 0o000);
    if (typeof process.getuid === "function" && process.getuid() !== 0) expect(gatherDigestSources(HOME)).toBeNull();
    chmodSync(bd, 0o700);
    expect(gatherDigestSources(HOME)!.awaitingRuling!.length).toBe(1);
  });
});

describe("morning-digest — MDV2-6 three-category gate: delivery exactly-once (writeInbox morning-digest-<date> key)", () => {
  // The digest DELIVERY primitive is writeInbox(home, coord, msg, `morning-digest-<date>`): its exactly-once across process
  // death / dual instance / concurrency is the publishOnce O_EXCL credential — authoritatively covered by
  // test/inbox.test.ts:476 ("writeInbox — idempotency key … exactly-once across claim/ack/restart"). These fixtures prove the
  // digest key path inherits it across a REAL process boundary.
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-digest-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const idemTag = "morning-digest-2026-10-12";
  const cards = (): number => { try { return readdirSync(path.join(HOME, ".agenthop", "inbox", "coord")).filter((n) => n.endsWith(".json")).length; } catch { return 0; } };
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const tsx = path.join(dir, "..", "node_modules", ".bin", "tsx");
  const inboxMod = path.join(dir, "..", "src", "inbox.ts");
  const coreMod = path.join(dir, "..", "src", "swarm", "morning-digest.ts");
  const storeMod = path.join(dir, "..", "src", "swarm", "morning-digest-store.ts");
  const DIGEST_CHILD = `import { digestProjection, digestTextFromProjection } from "${coreMod}"; import { writeDigestProjectionRaw, markNotified } from "${storeMod}"; import { writeInbox, composeInboxMsg } from "${inboxMod}"; const home = process.env.H, date = "2026-10-12", k = "morning-digest-"+date; const proj = digestProjection({ recentDone: ["done @abc1234"] }, date, 100); writeDigestProjectionRaw(home, proj); markNotified(home, date, "pending", proj); writeInbox(home, "coord", composeInboxMsg({ from: "d", fromLabel: "swarm-digest", text: digestTextFromProjection(proj), via: "local", taskRef: "morning-digest" }), k); process.exit(0);`;
  const CHILD = `import { writeInbox, composeInboxMsg } from "${inboxMod}"; const r = writeInbox(process.env.H, "coord", composeInboxMsg({ from: "d", fromLabel: "swarm-digest", text: "brief", via: "local", taskRef: "morning-digest" }), process.env.K); process.stdout.write(String(r));`;
  const pubChild = (): Promise<string> => new Promise((resolve, reject) => {
    const cp = spawn(tsx, ["-e", CHILD], { env: { ...process.env, H: HOME, K: idemTag } });
    let out = "", err = "";
    cp.stdout.on("data", (d) => { out += d; });
    cp.stderr.on("data", (d) => { err += d; });
    cp.on("error", reject);
    cp.on("close", (code, signal) => {
      if (code !== 0 || signal !== null) reject(new Error(`digest child failed: code=${code} signal=${signal} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`));
      else resolve(out.trim());
    });
  });

  test("① dual-instance mutex / idempotency: two deliveries of the same date ⇒ exactly ONE card (O_EXCL credential)", () => {
    const r1 = execFileSync(tsx, ["-e", CHILD], { env: { ...process.env, H: HOME, K: idemTag }, encoding: "utf8" }).trim();
    const r2 = execFileSync(tsx, ["-e", CHILD], { env: { ...process.env, H: HOME, K: idemTag }, encoding: "utf8" }).trim();
    expect(r1).toBe("published");
    expect(r2).toBe("already");   // second instance sees the durable credential ⇒ no duplicate
    expect(cards()).toBe(1);
  });

  test("② process-recovery: a child publishes then DIES before the sent-flip; a restart re-delivers ⇒ still exactly ONE card", () => {
    const r1 = execFileSync(tsx, ["-e", CHILD], { env: { ...process.env, H: HOME, K: idemTag }, encoding: "utf8" }).trim(); // process A publishes, then exits (crash before marking sent)
    expect(r1).toBe("published");
    expect(cards()).toBe(1);
    const r2 = execFileSync(tsx, ["-e", CHILD], { env: { ...process.env, H: HOME, K: idemTag }, encoding: "utf8" }).trim(); // process B (restart) re-runs the delivery
    expect(r2).toBe("already");   // credential survived A's death ⇒ no loss, no duplicate
    expect(cards()).toBe(1);
  }, 20000);

  test("③ concurrency race: two processes publish the same date CONCURRENTLY ⇒ exactly ONE card (any interleaving)", async () => {
    // Wait for BOTH children before propagating a failure, so afterEach cannot remove their home while a companion still writes.
    const settled = await Promise.allSettled([pubChild(), pubChild()]);
    const [a, b] = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    // The durable invariant is exactly one card. A loser may read the winner's newly created credential before its pending bytes
    // are written; WriteResult then returns "unknown" and retains the obligation. This is an allowed, unconfirmed outcome.
    expect([a, b], "a fresh pair must contain a successful publisher").toEqual(expect.arrayContaining(["published"]));
    for (const result of [a, b]) expect(["published", "already", "deferred", "pending", "unknown"]).toContain(result);
    expect(cards()).toBe(1);
    const card = JSON.parse(readFileSync(path.join(HOME, ".agenthop", "inbox", "coord", `${idemTag}.json`), "utf8"));
    expect(validInboxMsg(card)).toMatchObject({ from: "d", fromLabel: "swarm-digest", text: "brief", via: "local", taskRef: "morning-digest" });
  }, 20000);

  test("④ runDigest interruption-recovery: real digest sequence crashes after publish, before sent-flip; restart preserves frozen body, pending→sent, one card", () => {
    // process A runs the REAL digest delivery sequence (projection freeze → markNotified pending → writeInbox) then DIES before the
    // sent-flip (the uncommitted boundary at swarm-dispatch.ts:2065) — using the real store/core/inbox components, no production dispatcher.
    execFileSync(tsx, ["-e", DIGEST_CHILD], { env: { ...process.env, H: HOME }, encoding: "utf8" });
    const st1 = readDigestProjection(HOME);
    expect(st1.kind).toBe("valid");                                   // frozen projection body survived the crash
    const n1 = readNotifiedState(HOME);
    expect(n1.kind === "pending" && !!n1.body).toBe(true);           // pending obligation + frozen body retained (not lost, not sent)
    expect(cards()).toBe(1);                                          // the publish landed exactly once
    // process B (restart) continues the unfinished delivery
    const proj = st1.kind === "valid" ? st1.projection : null;
    const res = writeInbox(HOME, "coord", composeInboxMsg({ from: "d", fromLabel: "swarm-digest", text: digestTextFromProjection(proj!), via: "local", taskRef: "morning-digest" }), "morning-digest-" + "2026-10-12");
    expect(res).toBe("already");                                      // credential survived A's death ⇒ no duplicate
    markNotified(HOME, "2026-10-12", "sent", proj!);
    expect(readNotifiedState(HOME).kind).toBe("sent");               // obligation discharged exactly once
    expect(cards()).toBe(1);                                          // still exactly one card
  }, 20000);
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
