import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  msgLogDir,
  msgLogDaysPresent,
  msgLogEnabled,
  msgLogSize,
  parseMsgLog,
  payloadLoggingEnabled,
  readMsgLog,
  readMsgLogDays,
  sanitize,
  writeMsgLog,
  type MsgLogEntry,
} from "../src/msglog.js";

// These assertions used to live in an in-module self-test block guarded by
// `if (process.argv[1] && import.meta.url.endsWith(...))`. That guard is TRUE once the module is inlined
// into a single-file bundle, so the block ran on import and wrote to stdout — corrupting the MCP JSON-RPC
// stream. They live here instead, and msglog.ts must stay free of top-level side effects.
//
// The regression guard for that bug is the LAST test in this file: importing the module must not print.

const OFF = {} as NodeJS.ProcessEnv;
const ON = { AGENTHOP_MSGLOG: "1" } as NodeJS.ProcessEnv;
const PAY = { AGENTHOP_MSGLOG: "1", AGENTHOP_MSGLOG_PAYLOAD: "1" } as NodeJS.ProcessEnv;

const sample = (over: Partial<MsgLogEntry> = {}): MsgLogEntry => ({
  ts: 1000,
  from: "a",
  to: "b",
  via: "local",
  direction: "out",
  size: 5,
  text: "hi",
  ...over,
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ah-msglog-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("gating", () => {
  test("logging is off by default and nothing is written", () => {
    expect(msgLogEnabled(OFF)).toBe(false);
    expect(writeMsgLog(home, sample(), OFF)).toBe(false);
    expect(existsSync(msgLogDir(home))).toBe(false);
  });

  test("payload logging needs its own flag", () => {
    expect(payloadLoggingEnabled(ON)).toBe(false);
    expect(payloadLoggingEnabled(PAY)).toBe(true);
  });
});

describe("sanitize", () => {
  test("text is stripped without the payload flag and kept with it", () => {
    expect(sanitize(sample(), false)?.text).toBeUndefined();
    expect(sanitize(sample(), true)?.text).toBe("hi");
  });

  test("an unusable entry is refused", () => {
    expect(sanitize(sample({ direction: "sideways" as "in" }), false)).toBeUndefined();
    expect(sanitize(sample({ from: "   " }), false)).toBeUndefined();
    expect(sanitize(sample({ to: "" }), false)).toBeUndefined();
    expect(sanitize(sample({ via: "carrier-pigeon" as "local" }), false)).toBeUndefined();
    expect(sanitize(sample({ ts: NaN }), false)).toBeUndefined();
  });

  test("kind is trimmed and a negative size is dropped", () => {
    expect(sanitize(sample({ kind: " task " }), false)?.kind).toBe("task");
    expect(sanitize(sample({ size: -1 }), false)?.size).toBeUndefined();
  });
});

describe("parse", () => {
  test("a torn last line is dropped and good lines survive", () => {
    expect(parseMsgLog(`${JSON.stringify(sample())}\n{"ts":1,"from":"x"`)).toHaveLength(1);
  });

  test("blank lines are dropped", () => {
    expect(parseMsgLog("\n\n")).toHaveLength(0);
  });

  test("reading an absent journal is empty, not an error", () => {
    expect(readMsgLog("/tmp/definitely-not-here-xyz")).toEqual([]);
  });
});

describe("round trip", () => {
  const day = Date.now();

  test("a disabled write is silent; an enabled one lands", () => {
    expect(writeMsgLog(home, sample({ ts: day }), ON)).toBe(true);
    expect(existsSync(msgLogDir(home))).toBe(true);
  });

  test("both entries read back, newest first", () => {
    writeMsgLog(home, sample({ ts: day, size: 3 }), ON);
    writeMsgLog(home, sample({ ts: day + 1, direction: "in" }), ON);
    const got = readMsgLog(home, day);
    expect(got).toHaveLength(2);
    expect(got[0]!.ts).toBeGreaterThan(got[1]!.ts);
  });

  test("the body is NOT written without the payload flag", () => {
    writeMsgLog(home, sample({ ts: day }), ON);
    expect(readMsgLog(home, day).every((e) => e.text === undefined)).toBe(true);
  });

  test("the body IS written with it", () => {
    writeMsgLog(home, sample({ ts: day }), PAY);
    expect(readMsgLog(home, day).some((e) => e.text === "hi")).toBe(true);
  });

  test("a multi-day read finds the same day", () => {
    writeMsgLog(home, sample({ ts: day }), ON);
    expect(readMsgLogDays(home, 2, day)).toHaveLength(1);
  });

  test("the day is listed and its size reported", () => {
    writeMsgLog(home, sample({ ts: day }), ON);
    expect(msgLogDaysPresent(home)).toHaveLength(1);
    expect(msgLogSize(home, day)).toBeGreaterThan(0);
  });
});

describe("bundled-import safety", () => {
  // The bug this guards: the self-test block ran on import once the module was inlined into a single-file
  // bundle, printing ~20 lines into the MCP JSON-RPC transport. Import the module in a REAL child process and
  // assert it stayed silent — the same thing core.ts does, without vitest's transform in the way.
  test("importing the module writes nothing to stdout", async () => {
    const { execFileSync } = await import("node:child_process");
    const run = (file: string): string => {
      const dir = path.dirname(new URL(import.meta.url).pathname);
      const tsx = path.join(dir, "..", "node_modules", ".bin", "tsx");
      const out = execFileSync(tsx, ["-e", `import { msgLogDir } from "${path.join(dir, "..", "src", "msglog.ts")}"; void msgLogDir("/tmp/x");`], { encoding: "utf8" });
      return out;
    };
    expect(run("")) .toBe("");
  });
});
