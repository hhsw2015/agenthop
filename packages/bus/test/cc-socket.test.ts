import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCcSocket, readCcSocket, clearCcSocket } from "../src/cc-socket.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-ccsock-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("cc-socks registry (bus-reachability §1 / F31)", () => {
  test("write -> read round-trips the socket path; missing ⇒ null; clear removes it", () => {
    expect(readCcSocket(HOME, "sid-1")).toBeNull();                 // nothing recorded yet
    writeCcSocket(HOME, "sid-1", "/tmp/cc-socks/4242.sock");
    expect(readCcSocket(HOME, "sid-1")).toBe("/tmp/cc-socks/4242.sock");
    clearCcSocket(HOME, "sid-1");
    expect(readCcSocket(HOME, "sid-1")).toBeNull();                 // gone after clear
  });

  test("record lives under presence/<sid>.cc (roster-independent, beside presence/<sid>.pid) and is overwritten atomically", () => {
    writeCcSocket(HOME, "20cab0a5", "/tmp/cc-socks/1.sock");
    writeCcSocket(HOME, "20cab0a5", "/tmp/cc-socks/2.sock");        // a restart under the same sid updates in place
    expect(readCcSocket(HOME, "20cab0a5")).toBe("/tmp/cc-socks/2.sock");
    const files = readdirSync(path.join(HOME, ".agenthop", "presence"));
    expect(files).toContain("20cab0a5.cc");
    expect(files.some((f) => f.endsWith(".tmp." + process.pid))).toBe(false); // no leftover temp
  });

  test("a weird sid is sanitized to a safe filename (never escapes the presence dir)", () => {
    writeCcSocket(HOME, "../../evil", "/tmp/cc-socks/9.sock");
    const files = readdirSync(path.join(HOME, ".agenthop", "presence"));
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith(".cc")).toBe(true);
    expect(files[0]!.includes("/")).toBe(false);
  });
});
