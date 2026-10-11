import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  parseExecutorDigest, formatExecutorDigest, findTranscript, loadExecutorDigest, executorDigestEnabled, coerceSessionRef,
} from "../src/swarm/executor-digest.js";

/**
 * executor-digest (mirror-15 ②) turns a Claude Code transcript tail into {lastActivityTs, lastThreeToolCalls, lastUtterance} to
 * enrich a blocked / round-doctor alert. The parser is PURE + fail-soft: a partial first line (byte-bounded tail), a corrupt line,
 * or an unrecognised shape contributes nothing and never throws (FC-7 conservative). A session with no transcript ⇒ null ⇒ an
 * honest "no transcript" note.
 */

const L = (o: unknown): string => JSON.stringify(o);
const asst = (ts: string, content: unknown[]): string => L({ type: "assistant", timestamp: ts, message: { role: "assistant", content } });

const tmps: string[] = [];
afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } } });

// ===== parseExecutorDigest =====

test("parses ts (max) + last utterance + tool calls in order from a realistic tail", () => {
  const tail = [
    L({ type: "mode", sessionId: "x" }), // metadata, no ts/message
    asst("2026-10-11T10:00:00.000Z", [{ type: "text", text: "first thought" }, { type: "tool_use", name: "Bash", input: { command: "ls -la", description: "List files" } }]),
    L({ type: "user", timestamp: "2026-10-11T10:00:01.000Z", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    asst("2026-10-11T10:00:02.000Z", [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } }]),
    asst("2026-10-11T10:00:03.000Z", [{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }, { type: "text", text: "last words here" }]),
  ].join("\n");
  const d = parseExecutorDigest(tail);
  expect(d.lastActivityTs).toBe(Date.parse("2026-10-11T10:00:03.000Z"));
  expect(d.lastThreeToolCalls).toEqual([
    { tool: "Bash", summary: "List files" }, // description preferred over command
    { tool: "Read", summary: "/a/b.ts" },
    { tool: "Grep", summary: "foo" },
  ]);
  expect(d.lastUtterance).toBe("last words here");
});

test("keeps only the LAST three tool calls (chronological)", () => {
  const tail = ["Edit", "Bash", "Read", "Grep"].map((t, i) => asst(`2026-10-11T10:0${i}:00.000Z`, [{ type: "tool_use", name: t, input: {} }])).join("\n");
  const d = parseExecutorDigest(tail);
  expect(d.lastThreeToolCalls.map((t) => t.tool)).toEqual(["Bash", "Read", "Grep"]); // Edit dropped
});

test("fail-soft: a partial first line and a corrupt line are skipped, rest parses", () => {
  const tail = [
    '{"type":"assist',                                   // partial (byte-bounded tail head)
    "not json at all",                                   // corrupt
    asst("2026-10-11T10:00:05.000Z", [{ type: "text", text: "survived" }]),
  ].join("\n");
  const d = parseExecutorDigest(tail);
  expect(d.lastUtterance).toBe("survived");
  expect(d.lastActivityTs).toBe(Date.parse("2026-10-11T10:00:05.000Z"));
});

test("FC-7 conservative: unknown line shapes contribute nothing, never throw; empty ⇒ defaults", () => {
  expect(parseExecutorDigest("")).toEqual({ lastActivityTs: null, lastThreeToolCalls: [], lastUtterance: "" });
  expect(parseExecutorDigest(L({ type: "future-kind", weird: 1 }))).toEqual({ lastActivityTs: null, lastThreeToolCalls: [], lastUtterance: "" });
  // a message whose content is a string (not an array) yields no tool calls / utterance but no error
  expect(parseExecutorDigest(L({ type: "assistant", message: { content: "plain" } }))).toEqual({ lastActivityTs: null, lastThreeToolCalls: [], lastUtterance: "" });
});

test("tool summary falls back to a representative arg, clipped", () => {
  const long = "x".repeat(200);
  const d = parseExecutorDigest(asst("2026-10-11T10:00:00.000Z", [{ type: "tool_use", name: "Bash", input: { command: long } }]));
  expect(d.lastThreeToolCalls[0]!.tool).toBe("Bash");
  expect(d.lastThreeToolCalls[0]!.summary.length).toBeLessThanOrEqual(81); // clipped (80 + ellipsis)
});

// ===== formatExecutorDigest (ED-2 stable, ED-4 wording) =====

test("formats the triple with a STABLE absolute activity instant (ED-2); null ⇒ honest unavailable note (ED-4)", () => {
  const d = { lastActivityTs: Date.parse("2026-10-11T10:04:00.000Z"), lastThreeToolCalls: [{ tool: "Bash", summary: "List" }], lastUtterance: "hi" };
  const s = formatExecutorDigest(d);
  expect(s).toMatch(/执行器摘要/);
  expect(s).toMatch(/最后活动 2026-10-11T10:04:00\.000Z/); // absolute, not relative
  expect(s).toMatch(/Bash\(List\)/);
  expect(s).toMatch(/「hi」/);
  expect(formatExecutorDigest(d)).toBe(formatExecutorDigest(d)); // ED-2: identical state ⇒ identical text (no wall-clock)
  // ED-4: null does NOT claim "missing" — it is the merged "unavailable (missing or read failure)" wording
  expect(formatExecutorDigest(null)).toMatch(/不可用/);
  expect(formatExecutorDigest(null)).toMatch(/缺失或读取失败/);
});

test("format: unknown ts ⇒ 未知; no tools/utterance ⇒ (无)", () => {
  const s = formatExecutorDigest({ lastActivityTs: null, lastThreeToolCalls: [], lastUtterance: "" });
  expect(s).toMatch(/最后活动 未知/);
  expect(s).toMatch(/最近工具 \(无\)/);
  expect(s).toMatch(/最后发言 \(无\)/);
});

// ===== IO shell (async) =====

test("findTranscript + loadExecutorDigest: locates <sid>.jsonl under a project dir, parses it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "execdig-")); tmps.push(root);
  const proj = path.join(root, "-Users-x-Work"); mkdirSync(proj, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  writeFileSync(path.join(proj, `${sid}.jsonl`), asst("2026-10-11T10:00:09.000Z", [{ type: "text", text: "from disk" }]));
  expect(await findTranscript(sid, root)).toBe(path.join(proj, `${sid}.jsonl`));
  expect((await loadExecutorDigest(sid, root))!.lastUtterance).toBe("from disk");
});

test("loadExecutorDigest: no transcript ⇒ null (honest default); traversal sid ⇒ null", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "execdig-")); tmps.push(root);
  expect(await loadExecutorDigest("no-such-session", root)).toBeNull();   // Codex member / missing
  expect(await findTranscript("../../etc/passwd", root)).toBeNull();      // no path traversal
  expect(await loadExecutorDigest("x", "/no/such/projects/root")).toBeNull(); // IO error ⇒ fail-soft
});

test("ED-3: a non-regular entry named like the transcript (dir / FIFO) is rejected without blocking", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "execdig-")); tmps.push(root);
  const proj = path.join(root, "p"); mkdirSync(proj, { recursive: true });
  // a DIRECTORY named <sid>.jsonl ⇒ isFile() false ⇒ skipped
  const dsid = "dir-1111-2222-3333-4444-555555555555";
  mkdirSync(path.join(proj, `${dsid}.jsonl`));
  expect(await findTranscript(dsid, root)).toBeNull();
  expect(await loadExecutorDigest(dsid, root)).toBeNull();
  // a FIFO named <sid>.jsonl ⇒ rejected, and the loader returns promptly (never blocks on the open)
  const fsid = "fifo-1111-2222-3333-4444-555555555555";
  try { execSync(`mkfifo ${JSON.stringify(path.join(proj, `${fsid}.jsonl`))}`); } catch { return; } // skip if mkfifo unavailable
  const t0 = Date.now();
  expect(await loadExecutorDigest(fsid, root)).toBeNull();
  expect(Date.now() - t0).toBeLessThan(2000); // did not block the event loop on the FIFO
});

test("executorDigestEnabled: live by default (opt-out)", () => {
  expect(executorDigestEnabled(undefined)).toBe(true);
  expect(executorDigestEnabled("0")).toBe(false);
  expect(executorDigestEnabled("off")).toBe(false);
});

test("ED-5: coerceSessionRef accepts only a non-blank string — untrusted author metadata can't reach resolveSession", () => {
  expect(coerceSessionRef("claude:Work-d7f6c917")).toBe("claude:Work-d7f6c917");
  expect(coerceSessionRef("  x  ")).toBe("x");
  expect(coerceSessionRef(7 as unknown)).toBeNull();                 // a numeric author (ledger JSON) ⇒ null, never resolveSession
  expect(coerceSessionRef({ sid: "a" } as unknown)).toBeNull();      // an object author ⇒ null
  expect(coerceSessionRef("")).toBeNull();
  expect(coerceSessionRef("   ")).toBeNull();
  expect(coerceSessionRef(null)).toBeNull();
  expect(coerceSessionRef(undefined)).toBeNull();
});
