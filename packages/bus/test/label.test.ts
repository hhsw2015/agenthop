import { afterEach, beforeEach, expect, test } from "vitest";
import { detectTool, sessionTitle, shortId } from "../src/label.js";

/**
 * detectTool must identify the ACTUAL host. The trap (Codex re-verification #1): a Codex daemon may be
 * running on the same machine as a Cursor/Gemini/Grok session, so daemon presence must never override
 * another tool's own env marker — it only decides between "codex" and "unknown" when nothing else matches.
 * AGENTHOP_NO_CODEX forces codexDaemonPresent() false so the fallback branch is deterministic in tests.
 */

beforeEach(() => {
  process.env.AGENTHOP_NO_CODEX = "1";
});
afterEach(() => {
  delete process.env.AGENTHOP_NO_CODEX;
});

test("explicit host markers win over a present Codex daemon", () => {
  delete process.env.AGENTHOP_NO_CODEX; // let the daemon look present if it is
  // Whether or not a real daemon is up, an explicit marker must decide the label.
  expect(detectTool({ GEMINI_CLI: "1" } as NodeJS.ProcessEnv)).toBe("gemini");
  expect(detectTool({ CURSOR_TRACE_ID: "x" } as NodeJS.ProcessEnv)).toBe("cursor");
  expect(detectTool({ GROK_CLI: "1" } as NodeJS.ProcessEnv)).toBe("grok");
  expect(detectTool({ CLAUDECODE: "1" } as NodeJS.ProcessEnv)).toBe("claude");
  expect(detectTool({ CODEX_HOME: "/x" } as NodeJS.ProcessEnv)).toBe("codex");
});

test("AGENTHOP_TOOL override beats everything", () => {
  expect(detectTool({ AGENTHOP_TOOL: "gemini", CODEX_HOME: "/x" } as NodeJS.ProcessEnv)).toBe("gemini");
});

test("no markers and no daemon is unknown, not codex", () => {
  expect(detectTool({} as NodeJS.ProcessEnv)).toBe("unknown");
});

test("sessionTitle is a readable, restart-stable handle: tool:dir-<shortSessionId>", () => {
  const env = {} as NodeJS.ProcessEnv; // no AGENTHOP_TITLE
  expect(sessionTitle("codex", "/Users/x/Work", "01a0ead5-f1f9-7dc2-b667", env)).toBe("codex:Work-01a0ead5");
  expect(sessionTitle("claude", "/Users/x/Work", "20cab0a5-b30e-4723", env)).toBe("claude:Work-20cab0a5");
  // Same dir + same short session id -> same handle across a restart; different session -> different.
  expect(sessionTitle("codex", "/a/Work", "01a0ead5-xxxx", env)).not.toBe(sessionTitle("codex", "/a/Work", "beef1234-yyyy", env));
});

test("sessionTitle falls back to tool:dir before a stableId is known, and AGENTHOP_TITLE overrides", () => {
  expect(sessionTitle("codex", "/Users/x/Work", undefined, {} as NodeJS.ProcessEnv)).toBe("codex:Work");
  expect(sessionTitle("codex", "/Users/x/Work", "01a0ead5", { AGENTHOP_TITLE: "my-name" } as NodeJS.ProcessEnv)).toBe("my-name");
});

test("shortId is the first 8 alphanumerics", () => {
  expect(shortId("01a0ead5-f1f9-7dc2")).toBe("01a0ead5");
});
