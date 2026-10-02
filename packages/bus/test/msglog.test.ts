import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type MsgLogEntry,
  msgLogDaysPresent,
  msgLogDir,
  msgLogEnabled,
  msgLogSize,
  parseMsgLog,
  payloadLoggingEnabled,
  readMsgLog,
  readMsgLogDays,
  sanitize,
  writeMsgLog,
} from "../src/msglog.js";

// These were an in-module selftest; moved here because core.ts imports msglog.ts and the module MUST have no
// top-level side effects (a bundled single-file binary would otherwise run the selftest on startup and print to
// stdout, corrupting the MCP protocol — Codex P1).

const OFF = {} as NodeJS.ProcessEnv;
const ON = { AGENTHOP_MSGLOG: "1" } as NodeJS.ProcessEnv;
const PAY = { AGENTHOP_MSGLOG: "1", AGENTHOP_MSGLOG_PAYLOAD: "1" } as NodeJS.ProcessEnv;
const e: MsgLogEntry = { ts: 1000, from: "a", to: "b", via: "local", direction: "out", size: 5, text: "hi" };

describe("flags + sanitize", () => {
  test("logging is off by default", () => {
    expect(msgLogEnabled(OFF)).toBe(false);
    expect(writeMsgLog("/tmp/nope", e, OFF)).toBe(false);
  });
  test("payload needs its own flag", () => {
    expect(payloadLoggingEnabled(ON)).toBe(false);
    expect(payloadLoggingEnabled(PAY)).toBe(true);
  });
  test("text stripped without the payload flag, kept with it", () => {
    expect(sanitize(e, false)?.text).toBeUndefined();
    expect(sanitize(e, true)?.text).toBe("hi");
  });
  test("bad direction / empty from rejected; kind+size survive", () => {
    expect(sanitize({ ...e, direction: "sideways" as "in" }, false)).toBeUndefined();
    expect(sanitize({ ...e, from: "   " }, false)).toBeUndefined();
    expect(sanitize({ ...e, kind: " task " }, false)?.kind).toBe("task");
  });
});

describe("parse", () => {
  test("a torn last line is dropped, good lines survive", () => {
    expect(parseMsgLog(`${JSON.stringify(e)}\n{"ts":1,"from":"x"`).length).toBe(1);
  });
  test("blank lines are dropped", () => {
    expect(parseMsgLog("\n\n").length).toBe(0);
  });
  test("read of an absent journal is empty, not an error", () => {
    expect(readMsgLog("/tmp/definitely-not-here-xyz").length).toBe(0);
  });
});

describe("round-trip against a real temp dir", () => {
  let home = "";
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test("write/read honoring the flags", () => {
    home = mkdtempSync(path.join(tmpdir(), "ah-msglog-"));
    const day = Date.now();
    expect(writeMsgLog(home, { ts: day, from: "a", to: "b", via: "local", direction: "out" }, OFF)).toBe(false);
    expect(existsSync(msgLogDir(home))).toBe(false); // nothing written while off
    expect(writeMsgLog(home, { ts: day, from: "a", to: "b", via: "local", direction: "out", size: 3 }, ON)).toBe(true);
    expect(writeMsgLog(home, { ts: day + 1, from: "b", to: "a", via: "relay", direction: "in", text: "secret" }, ON)).toBe(true);
    const got = readMsgLog(home, day);
    expect(got.length).toBe(2);
    expect(got[0]!.ts > got[1]!.ts).toBe(true); // newest first
    expect(got.every((x) => x.text === undefined)).toBe(true); // body not written without the payload flag
    expect(readMsgLogDays(home, 2, day).length).toBe(2);
    expect(msgLogDaysPresent(home).length).toBe(1);
    expect(msgLogSize(home, day)).toBeGreaterThan(0);
  });
});
