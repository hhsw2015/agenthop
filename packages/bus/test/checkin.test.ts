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
    expect(reportCheckIn(HOME, self(), "claude:agenthop-coordsid01")).toBe(true);
    const files = inboxFiles("coordsid01");
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(path.join(HOME, ".agenthop", "inbox", "coordsid01", files[0]!), "utf8")) as { text: string; from: string };
    expect(msg.text).toContain("[checkin]");
    expect(JSON.parse(msg.text.replace("[checkin] ", ""))).toMatchObject({ sid: "mysid99", handle: "claude:Work-mysid99", pid: 999, startedAt: 111 });
  });

  test("no coordinator handle / unresolvable coordinator / self ⇒ no write (fail-soft, never to self)", () => {
    presence("coordsid01");
    expect(reportCheckIn(HOME, self(), undefined)).toBe(false);                 // not configured
    expect(reportCheckIn(HOME, self(), "")).toBe(false);                        // blank
    expect(reportCheckIn(HOME, self(), "claude:agenthop-nosuchsid")).toBe(false); // no presence file for it
    expect(inboxFiles("coordsid01").length).toBe(0);
    presence("mysid99");                                                        // coordinator handle resolves to OUR sid
    expect(reportCheckIn(HOME, self(), "claude:peer-mysid99")).toBe(false);     // would be ourselves
    expect(inboxFiles("mysid99").length).toBe(0);
  });
});
