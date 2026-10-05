import { describe, expect, test } from "vitest";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pushToHost } from "../src/push.js";

/**
 * The cc-socks delivery FRAME contract (Codex identity-display + from-mode review): a delivered bus message must stamp
 * the SENDER's REAL permission mode on from-mode (not a hardcoded "default", which made a bypass receiver gate every
 * peer message for approval), and show an email-style From -> To header so the user can see which address sent it and
 * which of their sessions received it. We run pushToHost against a throwaway unix socket and read the raw frames.
 */
describe("pushToHost cc-socks frame", () => {
  async function capture(from: string, text: string, opts: { fromMode?: string; to?: string }): Promise<string> {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), "ah-push-")), "cc.sock");
    const chunks: string[] = [];
    const server = net.createServer((s) => s.on("data", (d) => chunks.push(d.toString())));
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const prev = { sock: process.env.CLAUDE_CODE_MESSAGING_SOCKET, tok: process.env.CLAUDE_CODE_MESSAGING_TOKEN };
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = sock;
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = "tok";
    try {
      expect(await pushToHost(from, text, opts)).toBe(true);
      await new Promise((r) => setTimeout(r, 20)); // let the server's data events drain after the client FIN
    } finally {
      for (const [k, v] of [["CLAUDE_CODE_MESSAGING_SOCKET", prev.sock], ["CLAUDE_CODE_MESSAGING_TOKEN", prev.tok]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await new Promise<void>((r) => server.close(() => r()));
    }
    // Decode the JSON frames and return the cross-session-message content (unescaped), the delivered payload.
    const lines = chunks.join("").split("\n").filter(Boolean);
    const user = lines.map((l) => JSON.parse(l) as { type?: string; message?: { content?: string } }).find((m) => m.type === "user");
    return user?.message?.content ?? "";
  }

  test("stamps the sender's REAL mode on from-mode + shows From -> To email-style in the body", async () => {
    const raw = await capture("codex:Work-01a0ff49", "hello there", { fromMode: "bypassPermissions", to: "claude:Work-20cab0a5" });
    expect(raw).toContain('from="codex:Work-01a0ff49"');
    expect(raw).toContain('from-mode="bypassPermissions"'); // the real mode, NOT a hardcoded default
    expect(raw).toContain("codex:Work-01a0ff49 → claude:Work-20cab0a5"); // [bus] From -> To header in the body
    expect(raw).toContain("hello there");
  });

  test("from-mode defaults to 'default' (safe/gated) when the sender's mode is unknown", async () => {
    const raw = await capture("codex:x", "hi", { to: "claude:y" });
    expect(raw).toContain('from-mode="default"');
    expect(raw).toContain("codex:x → claude:y");
  });

  test("a non-string mode is coerced to 'default', never crashing delivery (Codex P1-05)", async () => {
    const raw = await capture("codex:x", "hi", { fromMode: 1 as unknown as string, to: "claude:y" });
    expect(raw).toContain('from-mode="default"'); // number coerced, no attr()/.replace throw -> message still delivered
    expect(raw).toContain("hi");
  });
});

describe("B7: pushToHost (codex path) is bounded — a hung queue child can't wedge flushInbox", () => {
  test("a codex child that never exits is killed at the timeout and reported as a miss (false), not awaited forever", async () => {
    // A sleeper standing in for `codex`: it ignores args and hangs, modelling a `codex queue` that connected but never exits.
    const bin = path.join(mkdtempSync(path.join(tmpdir(), "ah-push-to-")), "sleeper.sh");
    writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const prev = { sock: process.env.CLAUDE_CODE_MESSAGING_SOCKET, bin: process.env.AGENTHOP_CODEX_BIN, to: process.env.AGENTHOP_PUSH_TIMEOUT_MS };
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET; // force the codex path (no cc-socks), so opts.codexThread is used
    process.env.AGENTHOP_CODEX_BIN = bin;
    process.env.AGENTHOP_PUSH_TIMEOUT_MS = "150";
    try {
      const t0 = Date.now();
      const ok = await pushToHost("codex:x", "hi", { codexThread: "thread-1" });
      const elapsed = Date.now() - t0;
      expect(ok).toBe(false);              // bounded ⇒ a miss ⇒ flushInbox releases the claim and retries next tick
      expect(elapsed).toBeLessThan(5000);  // the 150ms timeout fired; it did NOT wait out the 30s sleep (no wedge)
    } finally {
      for (const [k, v] of [["CLAUDE_CODE_MESSAGING_SOCKET", prev.sock], ["AGENTHOP_CODEX_BIN", prev.bin], ["AGENTHOP_PUSH_TIMEOUT_MS", prev.to]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
