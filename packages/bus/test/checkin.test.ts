import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportCheckIn } from "../src/checkin.js";
import type { SelfInfo } from "../src/label.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-checkin-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const presence = (sid: string): void => { const d = path.join(HOME, ".agenthop", "presence"); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, `${sid}.pid`), "12345"); };
const self = (p: Partial<SelfInfo> = {}): SelfInfo => ({ id: "run-me", stableId: "mysid99", tool: "claude", cwd: "/x", pid: 999, title: "claude:Work-mysid99", startedAt: 111, ...p });
const inboxFiles = (sid: string): string[] => { try { return readdirSync(path.join(HOME, ".agenthop", "inbox", sid)); } catch { return []; } };

describe("startup check-in (bus-reachability §4)", () => {
  test("writes one {sid,handle,pid,startedAt} line to the coordinator's durable inbox", () => {
    presence("coordsid01");
    expect(reportCheckIn(HOME, self(), "claude:agenthop-coordsid01")).toBe("sent");
    const files = inboxFiles("coordsid01");
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(path.join(HOME, ".agenthop", "inbox", "coordsid01", files[0]!), "utf8")) as { text: string; from: string };
    expect(msg.text).toContain("[checkin]");
    expect(JSON.parse(msg.text.replace("[checkin] ", ""))).toMatchObject({ sid: "mysid99", handle: "claude:Work-mysid99", pid: 999, startedAt: 111 });
  });

  test("B5 result semantics: skip (permanent) vs retry (transient) vs sent", () => {
    presence("coordsid01");
    expect(reportCheckIn(HOME, self(), undefined)).toBe("skip");                   // not configured — permanent, no retry
    expect(reportCheckIn(HOME, self(), "")).toBe("skip");                          // blank — permanent
    expect(reportCheckIn(HOME, self(), "claude:agenthop-nosuchsid")).toBe("retry"); // coordinator not resolvable YET — retain + retry
    expect(inboxFiles("coordsid01").length).toBe(0);
    presence("mysid99");                                                           // coordinator handle resolves to OUR sid
    expect(reportCheckIn(HOME, self(), "claude:peer-mysid99")).toBe("skip");       // would be ourselves — permanent
    expect(inboxFiles("mysid99").length).toBe(0);
    // once the coordinator presence appears, the same (previously "retry") handle now SENDS — the retry obligation can clear.
    expect(reportCheckIn(HOME, self(), "claude:agenthop-coordsid01")).toBe("sent");
    expect(inboxFiles("coordsid01").length).toBe(1);
  });
});
