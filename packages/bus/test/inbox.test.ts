import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ackInbox, claimInbox, releaseInbox, writeInbox } from "../src/inbox.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-inbox-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const msg = (text: string, ts: number) => ({ from: "rw-x", fromLabel: "peer", text, via: "local" as const, ts });

describe("durable inbox", () => {
  test("write -> claim returns it; ack removes it for good", () => {
    writeInbox(HOME, "s1", msg("hello", 1000));
    const c = claimInbox(HOME, ["s1"], "pidA");
    expect(c.length).toBe(1);
    expect(c[0].msg.text).toBe("hello");
    ackInbox(c[0].file);
    expect(claimInbox(HOME, ["s1"], "pidA").length).toBe(0);
  });

  test("claim is atomic: a second claimer gets nothing until the first releases", () => {
    writeInbox(HOME, "s1", msg("one", 1000));
    const a = claimInbox(HOME, ["s1"], "pidA");
    expect(a.length).toBe(1);
    expect(claimInbox(HOME, ["s1"], "pidB").length).toBe(0); // A holds it
    releaseInbox(a[0].file); // A couldn't deliver -> put it back
    const b = claimInbox(HOME, ["s1"], "pidB");
    expect(b.length).toBe(1);
    expect(b[0].msg.text).toBe("one");
  });

  test("oldest message first (persist order by ts)", () => {
    writeInbox(HOME, "s1", msg("second", 2000));
    writeInbox(HOME, "s1", msg("first", 1000));
    const c = claimInbox(HOME, ["s1"], "p");
    expect(c.map((x) => x.msg.text)).toEqual(["first", "second"]);
  });

  test("claims across multiple keys (stableId + per-run id), de-duped dirs", () => {
    writeInbox(HOME, "stable", msg("a", 1000));
    writeInbox(HOME, "runid", msg("b", 2000));
    const c = claimInbox(HOME, ["stable", "runid", "stable"], "p");
    expect(c.map((x) => x.msg.text).sort()).toEqual(["a", "b"]);
  });

  test("empty / missing inbox -> no claims, no throw", () => {
    expect(claimInbox(HOME, ["nope"], "p")).toEqual([]);
  });
});
