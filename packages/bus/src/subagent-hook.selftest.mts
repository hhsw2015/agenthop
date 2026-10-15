// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/subagent-hook.selftest.mts
// #1057 gates: a fake parent box (temp home + presence file), the three hook events, bad-sid refusals (no orphan box created),
// idempotence (a re-fired hook posts once), SKIPPED when SWARM_PARENT_SID is unset, the hook never throws, OSC 777 only on
// PermissionRequest with escape-injection stripped, and writeSessionInbox's strict rules (writeInbox unchanged).
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagentHook, planHookMessage, osc777Sequence, type HookDeps } from "./subagent-hook.js";
import { writeSessionInbox, writeInbox, SessionInboxError, composeInboxMsg, validInboxMsg } from "./inbox.js";

let n = 0;
const ok = (c: boolean, name: string) => { if (!c) throw new Error("FAILED: " + name); n++; console.log("ok  " + name); };
const scratch = mkdtempSync(path.join(tmpdir(), "subagent-hook-"));
const PARENT = "c5beaa7c-0000-4000-8000-000000000001";
const SEAT = "d7f6c917-0000-4000-8000-000000000002";
const home = (withPresence = true) => {
  const h = mkdtempSync(path.join(scratch, "h-"));
  mkdirSync(path.join(h, ".agenthop", "presence"), { recursive: true });
  if (withPresence) writeFileSync(path.join(h, ".agenthop", "presence", `${PARENT}.pid`), String(process.pid));
  return h;
};
const box = (h: string, sid: string) => path.join(h, ".agenthop", "inbox", sid);
const msgs = (h: string, sid: string) => { try { return readdirSync(box(h, sid)).filter((x) => x.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(box(h, sid), f), "utf8"))); } catch { return []; } };
const deps = (h: string, env: NodeJS.ProcessEnv, extra: Partial<HookDeps> = {}): HookDeps & { lines: string[]; osc: string[] } => {
  const lines: string[] = [], osc: string[] = [];
  return { home: h, env, nowSec: () => 1792040000, osc777: (t, b) => { osc.push(`${t}|${b}`); return "/dev/ttys999"; }, log: (l) => lines.push(l), lines, osc, ...extra };
};
const start = (id = "agent-1") => ({ hook_event_name: "SubagentStart", session_id: SEAT, agent_type: "Explore", agent_id: id });
const stop = (id = "agent-1") => ({ hook_event_name: "SubagentStop", session_id: SEAT, agent_type: "Explore", agent_id: id });
const perm = { hook_event_name: "PermissionRequest", session_id: SEAT, tool_name: "Bash" };

try {
  // ── three events → the parent's inbox ───────────────────────────────────────────────────────────────────────────────
  {
    const h = home(); const env = { SWARM_PARENT_SID: PARENT };
    const d = deps(h, env);
    ok(runSubagentHook(start(), d).kind === "posted", "start: posted");
    ok(runSubagentHook(stop(), d).kind === "posted", "stop: posted");
    ok(runSubagentHook(perm, d).kind === "posted", "permission: posted");
    const got = msgs(h, PARENT);
    ok(got.length === 3, `three events ⇒ three messages in the PARENT box (got ${got.length})`);
    ok(got.every((m) => validInboxMsg(m) !== null && m.intent === "fyi"), "every message is a valid fyi InboxMsg");
    ok(got.some((m) => /agent_type=Explore agent_id=agent-1/.test(m.text) && /start/.test(m.title)), "start message carries agent_type + agent_id");
    ok(got.some((m) => /tool=Bash/.test(m.text)), "permission message carries the tool");
    ok(!existsSync(box(h, SEAT)), "nothing is written to the seat's own box");
    ok(d.osc.length === 1 && /Bash/.test(d.osc[0]!), "OSC 777 fires on PermissionRequest only (once)");
  }
  // ── concurrent sub-agents are told apart; a re-fired hook posts once ───────────────────────────────────────────────────
  {
    const h = home(); const d = deps(h, { SWARM_PARENT_SID: PARENT });
    runSubagentHook(start("a1"), d); runSubagentHook(start("a2"), d);
    const again = runSubagentHook(start("a1"), d);
    ok(msgs(h, PARENT).length === 2, "two concurrent sub-agents (a1, a2) ⇒ two start messages");
    ok(again.kind === "posted" && (again as { result: string }).result === "already", "re-fired start for a1 ⇒ already (no duplicate)");
    const p1 = runSubagentHook(perm, d), p2 = runSubagentHook(perm, d);
    ok((p1 as { result: string }).result === "published" && (p2 as { result: string }).result === "already", "two permission requests in the SAME second collapse into one (documented ceiling)");
  }
  // ── SWARM_PARENT_SID unset ⇒ SKIPPED, nothing written, logged ──────────────────────────────────────────────────────────
  {
    const h = home(); const d = deps(h, {});
    const r = runSubagentHook(start(), d);
    ok(r.kind === "skipped" && !existsSync(path.join(h, ".agenthop", "inbox")), "parent unset ⇒ skipped, no inbox created");
    ok(d.lines.some((l) => /SKIPPED \(SWARM_PARENT_SID unset\)/.test(l)), "the skip is logged");
  }
  // ── bad parent ⇒ REFUSED, and NO orphan box is created ─────────────────────────────────────────────────────────────────
  for (const bad of ["not-a-sid", "../etc", "c5beaa7c", "approvals:c5beaa7c-0000-4000-8000-000000000001"]) {
    const h = home(); const d = deps(h, { SWARM_PARENT_SID: bad });
    const r = runSubagentHook(start(), d);
    ok(r.kind === "refused" && !existsSync(path.join(h, ".agenthop", "inbox")), `parent ${JSON.stringify(bad)} ⇒ refused, no box created`);
  }
  {
    const h = home(false); const d = deps(h, { SWARM_PARENT_SID: PARENT }); // UUID-shaped but no presence on this machine
    const r = runSubagentHook(start(), d);
    ok(r.kind === "refused" && /no presence/.test((r as { why: string }).why) && !existsSync(box(h, PARENT)), "UUID with no presence ⇒ refused, no box created");
    ok(d.lines.some((l) => /REFUSED/.test(l)), "the refusal is logged");
  }
  // ── never throws ───────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const h = home(); const d = deps(h, { SWARM_PARENT_SID: PARENT }, { log: () => { throw new Error("log down"); }, osc777: () => { throw new Error("tty gone"); } });
    let threw = false; try { runSubagentHook(perm, d); runSubagentHook(undefined, d); runSubagentHook({ hook_event_name: 42 } as never, d); } catch { threw = true; }
    ok(!threw, "a failing logger, a failing OSC writer, an empty or junk payload never make the hook throw");
    ok(runSubagentHook({ hook_event_name: "PreToolUse", session_id: SEAT }, deps(h, { SWARM_PARENT_SID: PARENT })).kind === "ignored", "an unhandled event is ignored");
  }
  // ── dedup keys + OSC sanitizing (pure) ─────────────────────────────────────────────────────────────────────────────
  {
    ok(planHookMessage(start("x9"), 1)!.key === `tui-sub-start-${SEAT.slice(0, 8)}-x9`, "key: tui-sub-<phase>-<seat8>-<agent_id>");
    ok(planHookMessage({ ...perm, tool_use_id: "tu_1" }, 1)!.key === `tui-perm-${SEAT.slice(0, 8)}-tu_1`, "key: tool_use_id used when Claude Code supplies it");
    ok(planHookMessage(perm, 1792040007)!.key === `tui-perm-${SEAT.slice(0, 8)}-1792040007`, "key: falls back to the event second");
    const seq = osc777Sequence("t", "Bash\u001b]0;evil\u0007;x");
    ok(seq.startsWith("\u001b]777;notify;t;") && seq.endsWith("\u0007") && (seq.match(/\u001b/g) ?? []).length === 1, "OSC: control chars and ';' in the body are stripped (no injected escape sequence)");
  }
  // ── writeSessionInbox strict rules; writeInbox unchanged ─────────────────────────────────────────────────────────────
  {
    const h = home();
    const m = composeInboxMsg({ from: "x", fromLabel: "x", text: "t", intent: "fyi" });
    let e: unknown; try { writeSessionInbox(h, "not-a-sid", m); } catch (x) { e = x; }
    ok(e instanceof SessionInboxError && !existsSync(box(h, "not-a-sid")), "writeSessionInbox: non-UUID ⇒ SessionInboxError, no box");
    ok(writeSessionInbox(h, PARENT, m) === "published", "writeSessionInbox: UUID + presence ⇒ published");
    ok(writeInbox(h, "approvals:c5beaa7c", m) === "published" && readdirSync(box(h, "approvals_c5beaa7c")).some((x) => x.endsWith(".json")), "writeInbox still accepts non-session keys (an approval box `approvals:<sid>`) — unchanged");
  }
  // ── bin.ts routes `hook subagent` to the small entry, never the full CLI graph (latency budget, < 200ms) ───────────────
  {
    const src = path.dirname(new URL(import.meta.url).pathname);
    const bin = readFileSync(path.join(src, "bin.ts"), "utf8");
    ok(!/^import\s/m.test(bin), "bin.ts has no top-level static import (every module loads lazily per command)");
    ok(/a\[0\] === "hook" && a\[1\] === "subagent"\) await import\("\.\/hook-entry\.js"\)/.test(bin), "bin.ts sends `hook subagent` to hook-entry.js");
    const entry = readFileSync(path.join(src, "hook-entry.ts"), "utf8");
    const deps = [...entry.matchAll(/^import .* from "(\.[^"]+)";$/gm)].map((m) => m[1]).sort();
    ok(JSON.stringify(deps) === JSON.stringify(["./stdin-json.js", "./subagent-hook.js"]), `hook-entry.ts imports only stdin-json + subagent-hook (got ${JSON.stringify(deps)})`);
    ok(!/from "\.\/cli-main\.js"|from "\.\/agenthop\.js"/.test(readFileSync(path.join(src, "subagent-hook.ts"), "utf8")), "subagent-hook.ts does not pull in the CLI");
  }
  console.log(`\nall subagent-hook selftests passed (${n})`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
