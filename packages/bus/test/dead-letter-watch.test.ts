import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ingestLedgerChunk, pruneDeadLetterWindow, countFreshByRoute, maxTsForRoute, routeKeyOf,
  readDeadLetterWatch, writeDeadLetterWatch, emptyDeadLetterWatch, type WindowEvent, type DeadLetterWatch,
} from "../src/swarm/delegation-observer.js";

const line = (ts: number, from: string, to: string) => `${JSON.stringify({ ts, from, to })}\n`;
const buf = (s: string) => Buffer.from(s, "utf8");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const BIG = 64 * 1024;
// default maxCarry + not-truncating, for the tests that don't exercise the cap
const ing = (carry: string, chunk: Buffer, max = BIG, trunc = false) => ingestLedgerChunk(carry, chunk, max, trunc);

describe("dead-letter incremental ingest (R1/R3 record boundary, byte/UTF-8 safe)", () => {
  test("parses complete lines, returns the trailing incomplete line as the base64 byte carry", () => {
    const r = ing("", buf(line(1000, "a", "x") + line(2000, "b", "y") + '{"ts":3000,"from":"c","to":"z"')); // last line unterminated
    expect(r.events.map((e) => e.ts)).toEqual([1000, 2000]);
    expect(unb64(r.carry)).toBe('{"ts":3000,"from":"c","to":"z"');
    expect(r.truncating).toBe(false);
  });

  test("a record split across two chunks is parsed exactly once, never half-parsed or lost", () => {
    const first = ing("", buf('{"ts":1000,"from":"a",')); // no newline yet
    expect(first.events).toEqual([]);
    expect(unb64(first.carry)).toBe('{"ts":1000,"from":"a",');
    const second = ing(first.carry, buf('"to":"x"}\n{"ts":2000,"from":"b","to":"y"}\n'));
    expect(second.events.map((e) => e.ts)).toEqual([1000, 2000]);
    expect(second.carry).toBe("");
  });

  test("a multi-byte UTF-8 char split across the read boundary is not mis-decoded", () => {
    const bytes = buf(`{"ts":1000,"from":"a","to":"x","preview":"中文"}\n`);
    const cut = bytes.length - 4; // slice through the middle of a multi-byte char (中/文 are 3 bytes each in UTF-8)
    const first = ing("", bytes.subarray(0, cut));
    expect(first.events).toEqual([]);
    const second = ing(first.carry, bytes.subarray(cut));
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.preview).toBe("中文"); // reassembled intact, not a replacement char
  });

  test("a chunk with no newline accumulates into the carry (0 events)", () => {
    const r = ing(b64("partial"), buf("-more-no-newline"));
    expect(r.events).toEqual([]);
    expect(unb64(r.carry)).toBe("partial-more-no-newline");
  });

  test("R3: an over-long no-newline line enters truncating (bounded carry), then resumes on the healthy records after it", () => {
    const over = ing("", buf("x".repeat(100)), 16, false); // 100 bytes, no newline, cap 16 ⇒ skip it
    expect(over.events).toEqual([]);
    expect(over.carry).toBe("");        // carry NOT grown — dropped
    expect(over.truncating).toBe(true);
    // next chunk ends the over-long line and carries two HEALTHY records after it
    const resume = ing(over.carry, buf(`garbage-tail\n${line(1000, "a", "x")}${line(2000, "b", "y")}`), 16, over.truncating);
    expect(resume.events.map((e) => e.ts)).toEqual([1000, 2000]); // the records after the dropped line are NOT lost (not R1 tail-cut)
    expect(resume.truncating).toBe(false);
  });
});

describe("routeKeyOf is null-safe on a malformed from/to (R1 — never throws past the cursor)", () => {
  test("a lone UTF-16 surrogate ⇒ null (diagnostic), not a URIError", () => {
    expect(routeKeyOf({ ts: 1, from: "\ud800", to: "x" })).toBeNull();      // encodeURIComponent would throw — must be caught → null
    expect(routeKeyOf({ ts: 1, from: "a", to: "\udfff" })).toBeNull();      // malformed `to` too
    expect(routeKeyOf({ ts: 1, from: "a", to: "x" })).toBe("a->x");         // the healthy case still works
    expect(routeKeyOf({ ts: 1, to: "x" })).toBeNull();                      // from-less = diagnostic
  });
});

describe("window prune + fresh count (R5 handled-through + recovery boundary)", () => {
  const win: WindowEvent[] = [
    { ts: 1000, route: "a->x" }, { ts: 2000, route: "a->x" }, { ts: 3000, route: "a->x" },
    { ts: 2500, route: "b->y" },
  ];
  test("prune drops events older than the window start", () => {
    expect(pruneDeadLetterWindow(win, 2000).map((e) => e.ts).sort()).toEqual([2000, 2500, 3000]);
  });

  test("fresh count excludes failures at/under max(handled, recovered); counts strictly newer", () => {
    expect(countFreshByRoute(win, 0, {}, {}).get("a->x")).toBe(3);                             // nothing excluded
    expect(countFreshByRoute(win, 0, { "a->x": 2000 }, {}).get("a->x")).toBe(1);               // handled watermark
    expect(countFreshByRoute(win, 0, {}, { "a->x": 3000 }).get("a->x")).toBeUndefined();       // recovery boundary excludes the whole burst (R5)
    expect(countFreshByRoute(win, 0, { "a->x": 1000 }, { "a->x": 2500 }).get("a->x")).toBe(1); // floor = max(1000,2500)=2500 ⇒ only ts=3000
    expect(countFreshByRoute(win, 0, {}, { "a->x": 3000 }).get("b->y")).toBe(1);               // other route unaffected
  });

  test("maxTsForRoute gives the watermark to set once an incident is committed", () => {
    expect(maxTsForRoute(win, "a->x")).toBe(3000);
    expect(maxTsForRoute(win, "none")).toBe(0);
  });
});

describe("dead-letter watch snapshot IO", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-dlw-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("missing ⇒ empty; write ⇒ read round-trips cursor/carry/truncating/window/handled/recovered/pending", () => {
    const f = path.join(HOME, "dlw.json");
    expect(readDeadLetterWatch(f)).toEqual(emptyDeadLetterWatch());
    const w: DeadLetterWatch = { sig: "42", offset: 2048, carry: b64('{"ts":9'), truncating: false, window: [{ ts: 9000, route: "a->x" }], handled: { "a->x": 8000 }, recovered: { "a->x": 7000 }, pending: { "b->y": 3 } };
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
