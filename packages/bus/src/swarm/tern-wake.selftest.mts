// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/tern-wake.selftest.mts
// Gates for the inbox-wake Tern transport + unique-claimant rule (PROGRESS #1025):
//  ① fake `tern inspect --json` fixture → sid→block parse + the exact injected command argv; the 3-row routing matrix
//    (registered tern / registered herdr / unregistered) across reachable transports.
//  ② seat-shell registration three-state + the claim decision (registered tern ⇒ herdr refused, tern allowed).
// The real two-process claim fixture lives in tern-claim-gate.selftest.mts.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ternPaneInfoForSession, ternInjectCommands, ternSpawnable, selfShell,
  readSeatShell, writeSeatShell, seatShellDir, wakeRoute, claimAllowed, type Shell,
} from "./tern-wake.js";
import { resolveWakePane, reachableTransports, inboxWakeStatus, wakeSession, type WakeDeps } from "./inbox-wake.js";

let n = 0;
const ok = (c: boolean, name: string) => { if (!c) throw new Error("FAILED: " + name); n++; console.log("ok  " + name); };
const scratch = mkdtempSync(path.join(tmpdir(), "tern-wake-selftest-"));
const SID = "aad02248-c76b-4a1a-b191-95da3f0bfb5a";
const OTHER = "90b58f9c-5bac-4318-a996-2373c179d674";

// A real-shaped `tern inspect --json` (fields as observed live 2026-10-15).
const inspect = (panes: unknown[]) => ({ sessions: [], detached: [], panes, clients: [] });
const pane = (id: number, sid: string, working: boolean | undefined, exited: unknown = null) => ({
  pane: id, program: "/bin/zsh", exited, working, quiet_ms: 1000,
  args: ["-l", "-c", `tern acp claude --resume ${sid} --mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]'`],
});

// ── ① parse ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const j = inspect([pane(101, OTHER, true), pane(102, SID, false), { pane: 103, program: "/bin/zsh", args: ["-l"], exited: null }]);
  const r = ternPaneInfoForSession(j, SID);
  ok(r !== null && r.paneId === "102" && r.state === "idle", "parse: sid → its own block, working:false ⇒ idle");
  ok(ternPaneInfoForSession(inspect([pane(102, SID, true)]), SID)?.state === "working", "parse: working:true ⇒ working (never interrupted)");
  ok(ternPaneInfoForSession(inspect([pane(102, SID, undefined)]), SID)?.state === "unknown", "parse: no working field ⇒ unknown (fail-safe, not injected)");
  ok(ternPaneInfoForSession(inspect([pane(102, SID, false, 0)]), SID) === null, "parse: exited block ignored");
  ok(ternPaneInfoForSession(inspect([pane(102, SID, false), pane(104, SID, false)]), SID) === null, "parse: two live blocks for one sid ⇒ ambiguous ⇒ null");
  ok(ternPaneInfoForSession(inspect([pane(102, `${SID}x`, false)]), SID) === null, "parse: --resume must match the WHOLE sid token (no prefix match)");
  ok(ternPaneInfoForSession(inspect([{ pane: 105, exited: null, command: `tern acp codex --resume=${SID}`, working: false }]), SID)?.paneId === "105", "parse: --resume=<sid> form + command fallback");
  ok(ternPaneInfoForSession({ nope: 1 }, SID) === null && ternPaneInfoForSession(null, SID) === null, "parse: malformed inspect JSON ⇒ null");
  ok(ternPaneInfoForSession(inspect([pane(102, SID, false)]), "") === null, "parse: empty sid ⇒ null");
}
// ── ① inject command shape ──────────────────────────────────────────────────────────────────────────────────────────
{
  const [t, e] = ternInjectCommands("102", "[唤醒:箱内有 1 件未认领]");
  ok(JSON.stringify(t) === JSON.stringify(["send", "102", "text", "[唤醒:箱内有 1 件未认领]"]), "inject: text argv = send <block> text <line> (line passed as ONE argv, no shell)");
  ok(JSON.stringify(e) === JSON.stringify(["send", "102", "keys", "Enter"]), "inject: submit argv = send <block> keys Enter");
}
// ── reachability / self-attestation ─────────────────────────────────────────────────────────────────────────────────
{
  ok(ternSpawnable({ TERN_PANE: "1" }) && ternSpawnable({ TERN_BIN: "/x/tern" }) && !ternSpawnable({}), "reach: TERN_PANE or TERN_BIN ⇒ tern reachable");
  ok(JSON.stringify(reachableTransports({ TERN_PANE: "1", HERDR_ENV: "1", HERDR_PANE_ID: "p" })) === '["tern","herdr"]', "reach: both");
  ok(reachableTransports({}).length === 0, "reach: none");
  ok(selfShell({ TERN_PANE: "1" }) === "tern" && selfShell({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }) === "herdr", "self: tern / herdr attested");
  ok(selfShell({ TERN_PANE: "1", HERDR_ENV: "1", HERDR_PANE_ID: "p" }) === "tern", "self: Tern pane launched from herdr (inherits HERDR_*) attests tern");
  ok(selfShell({}) === null && selfShell({ HERDR_ENV: "1" }) === null, "self: no evidence ⇒ null (cannot attest)");
  ok(inboxWakeStatus({ TERN_PANE: "1" }) === "on(tern)" && inboxWakeStatus({}) === "on(inert:no-transport)" && inboxWakeStatus({ SWARM_INBOX_WAKE: "0", TERN_PANE: "1" }) === "off", "status: honest per-transport string");
}
// ── ① routing matrix (registered tern / registered herdr / unregistered) × probes ───────────────────────────────────
await (async () => {
  const calls: Shell[] = [];
  const probes = (ternHit: boolean, herdrHit: boolean) => ({
    tern: async () => { calls.push("tern"); return ternHit ? { paneId: "T1", state: "idle" as const } : null; },
    herdr: async () => { calls.push("herdr"); return herdrHit ? { paneId: "w1:p4", state: "idle" as const } : null; },
  });
  const both: Shell[] = ["tern", "herdr"];
  const reg = (s: Shell) => ({ kind: "registered" as const, shell: s });

  calls.length = 0;
  let r = await resolveWakePane(wakeRoute(reg("tern")), both, probes(true, true), SID);
  ok(r?.transport === "tern" && r.paneId === "T1" && JSON.stringify(calls) === '["tern"]', "route: registered tern ⇒ Tern block only (herdr never probed, stale herdr instance never woken)");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute(reg("tern")), both, probes(false, true), SID);
  ok(r === null && JSON.stringify(calls) === '["tern"]', "route: registered tern but no Tern block ⇒ no-pane (does NOT fall back to the herdr twin)");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute(reg("herdr")), both, probes(true, true), SID);
  ok(r?.transport === "herdr" && JSON.stringify(calls) === '["herdr"]', "route: registered herdr ⇒ herdr only");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute({ kind: "absent" }), both, probes(true, true), SID);
  ok(r?.transport === "tern" && JSON.stringify(calls) === '["tern"]', "route: unregistered ⇒ Tern first and it wins when present");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute({ kind: "absent" }), both, probes(false, true), SID);
  ok(r?.transport === "herdr" && JSON.stringify(calls) === '["tern","herdr"]', "route: unregistered, no Tern block ⇒ falls through to herdr (pre-migration seats keep working)");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute({ kind: "unreadable" }), both, probes(true, false), SID);
  ok(r?.transport === "tern", "route: unreadable registration ⇒ treated as unregistered (seat not silenced)");
  calls.length = 0;
  r = await resolveWakePane(wakeRoute(reg("tern")), ["herdr"], probes(true, true), SID);
  ok(r === null && calls.length === 0, "route: registered tern but this process cannot reach Tern ⇒ no probe, no-pane");
})();
// ── wakeSession dispatches inject by transport ──────────────────────────────────────────────────────────────────────
await (async () => {
  const injected: string[] = [];
  const deps: WakeDeps = {
    now: () => 1_000_000, cooldownMs: 1, claim: () => true,
    paneInfo: async () => ({ paneId: "T1", state: "idle", transport: "tern" }),
    scan: () => ({ count: 2, oldestMtimeMs: 1 }),
    inject: async (id, text, transport) => { injected.push(`${transport}:${id}:${text}`); return true; },
  };
  ok((await wakeSession(scratch, SID, deps)) === "injected" && injected[0] === "tern:T1:[唤醒:箱内有 2 件未认领]", "wake: tern-tagged pane ⇒ inject called with transport=tern");
  const busy = { ...deps, paneInfo: async () => ({ paneId: "T1", state: "working" as const, transport: "tern" as const }) };
  injected.length = 0;
  ok((await wakeSession(scratch, SID, busy)) === "state" && injected.length === 0, "wake: Tern block working ⇒ not interrupted");
})();
// ── ② seat-shell registration three-state ───────────────────────────────────────────────────────────────────────────
{
  const h = mkdtempSync(path.join(scratch, "home-"));
  ok(readSeatShell(h, SID).kind === "absent", "seat: no file ⇒ absent");
  writeSeatShell(h, SID, "tern", 1000);
  const r = readSeatShell(h, SID);
  ok(r.kind === "registered" && r.shell === "tern", "seat: set tern ⇒ registered tern");
  writeSeatShell(h, SID, "herdr", 1001);
  const r2 = readSeatShell(h, SID);
  ok(r2.kind === "registered" && r2.shell === "herdr", "seat: re-set overwrites atomically");
  ok(!readdirSync(seatShellDir(h)).some((f) => f.includes(".tmp-")), "seat: no temp left behind");
  writeFileSync(path.join(seatShellDir(h), `${OTHER}.json`), "{garbage");
  ok(readSeatShell(h, OTHER).kind === "unreadable", "seat: malformed file ⇒ unreadable (not absent)");
  writeFileSync(path.join(seatShellDir(h), `${OTHER}.json`), JSON.stringify({ shell: "ghostty" }));
  ok(readSeatShell(h, OTHER).kind === "unreadable", "seat: unknown shell value ⇒ unreadable");
  ok(readSeatShell(h, "../etc/passwd").kind === "unreadable", "seat: path-like sid rejected");
  let threw = false; try { writeSeatShell(h, "../x", "tern", 1); } catch { threw = true; }
  ok(threw, "seat: write rejects a path-like sid");
  threw = false; try { writeSeatShell(h, SID, "zsh" as Shell, 1); } catch { threw = true; }
  ok(threw, "seat: write rejects an unknown shell");
  // reserved pid slot (presence): round-trips when given, absent when not, a bad on-disk pid is ignored (not fatal)
  writeSeatShell(h, SID, "tern", 1002, 4166);
  const rp = readSeatShell(h, SID);
  ok(rp.kind === "registered" && rp.shell === "tern" && rp.pid === 4166, "seat: pid slot round-trips");
  writeSeatShell(h, SID, "tern", 1003);
  const rn = readSeatShell(h, SID);
  ok(rn.kind === "registered" && rn.pid === undefined, "seat: no pid given ⇒ no pid field");
  writeFileSync(path.join(seatShellDir(h), `${OTHER}.json`), JSON.stringify({ shell: "tern", pid: "abc" }));
  const rb = readSeatShell(h, OTHER);
  ok(rb.kind === "registered" && rb.shell === "tern" && rb.pid === undefined, "seat: bad on-disk pid ignored, registration still honored");
  threw = false; try { writeSeatShell(h, SID, "tern", 1, -5); } catch { threw = true; }
  ok(threw, "seat: write rejects an invalid pid");
  // a foreign temp at a colliding name is never truncated (O_EXCL ownership)
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    const d = seatShellDir(h); chmodSync(d, 0o500);
    threw = false; try { writeSeatShell(h, SID, "tern", 2); } catch { threw = true; }
    chmodSync(d, 0o700);
    ok(threw && readSeatShell(h, SID).kind === "registered", "seat: write fault ⇒ throws, previous registration intact");
  }
}
// ── ② claim decision matrix ─────────────────────────────────────────────────────────────────────────────────────────
{
  const tern = { kind: "registered" as const, shell: "tern" as const };
  const herdr = { kind: "registered" as const, shell: "herdr" as const };
  ok(!claimAllowed(tern, "herdr"), "claim: registered tern, herdr instance ⇒ REFUSED (the #1025 stale twin)");
  ok(claimAllowed(tern, "tern"), "claim: registered tern, tern instance ⇒ allowed");
  ok(!claimAllowed(herdr, "tern") && claimAllowed(herdr, "herdr"), "claim: registered herdr mirrors it");
  ok(claimAllowed(tern, null), "claim: un-attestable process (e.g. codex seat MCP, no TERN_PANE/HERDR_PANE_ID) ⇒ allowed, never stranded");
  ok(claimAllowed({ kind: "absent" }, "herdr") && claimAllowed({ kind: "unreadable" }, "herdr"), "claim: unregistered / unreadable ⇒ allowed (v0 behavior)");
}

console.log(`\nall tern-wake selftests passed (${n})`);
