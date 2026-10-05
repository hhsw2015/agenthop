import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ingestLedgerChunk, pruneDeadLetterWindow, countFreshByRoute, maxTsForRoute,
  readDeadLetterWatch, writeDeadLetterWatch, emptyDeadLetterWatch, type WindowEvent,
} from "../src/swarm/delegation-observer.js";

const line = (ts: number, from: string, to: string) => `${JSON.stringify({ ts, from, to })}\n`;
const buf = (s: string) => Buffer.from(s, "utf8");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

describe("dead-letter incremental ingest (R1/R3 record boundary, byte/UTF-8 safe)", () => {
  test("parses complete lines, returns the trailing incomplete line as the base64 byte carry", () => {
    const r = ingestLedgerChunk("", buf(line(1000, "a", "x") + line(2000, "b", "y") + '{"ts":3000,"from":"c","to":"z"')); // last line unterminated
    expect(r.events.map((e) => e.ts)).toEqual([1000, 2000]);
    expect(unb64(r.carry)).toBe('{"ts":3000,"from":"c","to":"z"');
  });

  test("a record split across two chunks is parsed exactly once, never half-parsed or lost", () => {
    const first = ingestLedgerChunk("", buf('{"ts":1000,"from":"a",')); // no newline yet
    expect(first.events).toEqual([]);
    expect(unb64(first.carry)).toBe('{"ts":1000,"from":"a",');
    const second = ingestLedgerChunk(first.carry, buf('"to":"x"}\n{"ts":2000,"from":"b","to":"y"}\n'));
    expect(second.events.map((e) => e.ts)).toEqual([1000, 2000]);
    expect(second.carry).toBe("");
  });

  test("a multi-byte UTF-8 char split across the read boundary is not mis-decoded", () => {
    const whole = `{"ts":1000,"from":"a","to":"x","preview":"中文"}\n`;
    const bytes = buf(whole);
    const cut = bytes.length - 4; // slice through the middle of a multi-byte char (中/文 are 3 bytes each in UTF-8)
    const first = ingestLedgerChunk("", bytes.subarray(0, cut));
    expect(first.events).toEqual([]); // no complete line + the split char stays as raw bytes in the carry
    const second = ingestLedgerChunk(first.carry, bytes.subarray(cut));
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.preview).toBe("中文"); // reassembled intact, not a replacement char
  });

  test("a chunk with no newline accumulates into the carry (0 events)", () => {
    const r = ingestLedgerChunk(b64("partial"), buf("-more-no-newline"));
    expect(r.events).toEqual([]);
    expect(unb64(r.carry)).toBe("partial-more-no-newline");
  });
});

describe("window prune + fresh count (R5 handled-through watermark)", () => {
  const win: WindowEvent[] = [
    { ts: 1000, route: "a->x" }, { ts: 2000, route: "a->x" }, { ts: 3000, route: "a->x" },
    { ts: 2500, route: "b->y" },
  ];
  test("prune drops events older than the window start", () => {
    expect(pruneDeadLetterWindow(win, 2000).map((e) => e.ts).sort()).toEqual([2000, 2500, 3000]);
  });

  test("fresh count excludes failures at/under the route's handled watermark, counts strictly newer", () => {
    // no watermark: all in-window counted
    expect(countFreshByRoute(win, 0, {}).get("a->x")).toBe(3);
    // handled through ts=2000 for a->x: only ts=3000 is fresh (R5 — the recovered-through failures don't reopen)
    expect(countFreshByRoute(win, 0, { "a->x": 2000 }).get("a->x")).toBe(1);
    // handled through the max (3000): zero fresh — the same pre-recovery burst can never reopen an episode
    expect(countFreshByRoute(win, 0, { "a->x": 3000 }).get("a->x")).toBeUndefined();
    // other route unaffected by a->x's watermark
    expect(countFreshByRoute(win, 0, { "a->x": 3000 }).get("b->y")).toBe(1);
  });

  test("maxTsForRoute gives the watermark to set once an incident is committed", () => {
    expect(maxTsForRoute(win, "a->x")).toBe(3000);
    expect(maxTsForRoute(win, "b->y")).toBe(2500);
    expect(maxTsForRoute(win, "none")).toBe(0);
  });
});

describe("dead-letter watch snapshot IO", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-dlw-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("missing ⇒ empty; write ⇒ read round-trips cursor/carry/window/handled/pending/notify", () => {
    const f = path.join(HOME, "dlw.json");
    expect(readDeadLetterWatch(f)).toEqual(emptyDeadLetterWatch());
    const w = { sig: "ino-42:100", offset: 2048, carry: '{"ts":9', window: [{ ts: 9000, route: "a->x" }], handled: { "a->x": 8000 }, pending: { "b->y": 3 }, notify: { "inc-1": { text: "boom", sent: false } } };
    writeDeadLetterWatch(f, w);
    expect(readDeadLetterWatch(f)).toEqual(w);
  });

  test("corrupt ⇒ THROWS (caller skips; never resets durable obligations to empty — R1)", () => {
    const f = path.join(HOME, "dlw.json");
    writeFileSync(f, "{ not json");
    expect(() => readDeadLetterWatch(f)).toThrow();
    writeFileSync(f, JSON.stringify({ offset: "nope" }));
    expect(() => readDeadLetterWatch(f)).toThrow();
  });
});
