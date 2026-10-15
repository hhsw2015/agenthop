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
  ternPaneInfoForSession, ternInjectCommands, ternSpawnable, selfShell, shellWords, shellTokens, paneProgramArgv, classifyTernInspect,
  seatShellFile, clearSeatShell, validSeatSid,
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
  const F = (paneId: string) => ({ kind: "found" as const, paneId, state: "idle" as const });
  const A = { kind: "absent" as const };
  const probes = (ternHit: boolean, herdrHit: boolean) => ({
    tern: async () => { calls.push("tern"); return ternHit ? F("T1") : A; },
    herdr: async () => { calls.push("herdr"); return herdrHit ? F("w1:p4") : A; },
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
  // IWT-SV-P2-2: an UNKNOWN Tern probe (CLI missing / daemon error / bad JSON) must STOP the walk — never fall back to herdr — and
  // must be reported (not silent).
  const notes: string[] = [];
  calls.length = 0;
  const brokenTern = { tern: async () => { calls.push("tern"); return { kind: "unknown" as const, reason: "ENOENT: cannot run tern" }; }, herdr: async () => { calls.push("herdr"); return F("w1:p4"); } };
  r = await resolveWakePane(wakeRoute({ kind: "absent" }), both, brokenTern, SID, (n) => notes.push(n));
  ok(r === null && JSON.stringify(calls) === '["tern"]', "route: Tern probe UNKNOWN ⇒ stops, does NOT wake the herdr twin");
  ok(notes.some((n) => /tern probe failed \(ENOENT/.test(n)), "route: the unknown reason is reported (not silent)");
  notes.length = 0;
  r = await resolveWakePane(wakeRoute(reg("tern")), ["herdr"], probes(true, true), SID, (n) => notes.push(n));
  ok(r === null && notes.some((n) => /tern transport not reachable/.test(n)), "route: registered tern but only herdr reachable ⇒ diagnosed (not silent)");
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


// ── IWT-SV-P2-1: real shell argument boundaries (quotes, comments, prompt text) ─────────────────────────────────────────
{
  const sh = (line: string) => ({ pane: 91, exited: null, working: false, program: "/bin/zsh", args: ["-l", "-c", line] });
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --resume '${SID}' --mode bypassPermissions`)]), SID)?.paneId === "91", "argv: single-quoted --resume value is matched (sh delivers it as a plain arg)");
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --resume "${SID}"`)]), SID)?.paneId === "91", "argv: double-quoted --resume value is matched");
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --resume real-sid # --resume ${SID}`)]), SID) === null, "argv: --resume inside a # comment is NOT evidence");
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --prompt 'please --resume ${SID} later' --resume other`)]), SID) === null, "argv: --resume inside a quoted prompt is NOT evidence");
  ok(ternPaneInfoForSession(inspect([sh(`echo --resume ${SID}`)]), SID) === null, "argv: a non-`tern acp` program is never a wake target");
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --resume ${SID}; echo done`)]), SID)?.paneId === "91", "argv: only the first simple command counts (; separator)");
  ok(ternPaneInfoForSession(inspect([sh(`true; tern acp claude --resume ${SID}`)]), SID) === null, "argv: a tern acp AFTER a separator is a different command");
  ok(ternPaneInfoForSession(inspect([sh(`tern acp claude --resume '${SID}`)]), SID) === null, "argv: unterminated quote ⇒ unparseable ⇒ not trusted");
  ok(JSON.stringify(shellWords(`a 'b c' "d \\"e\\"" f\\ g # h`)) === JSON.stringify(["a", "b c", 'd "e"', "f g"]), "shellWords: quotes / escapes / comment");
  ok(ternPaneInfoForSession(inspect([{ pane: 93, exited: null, working: false, program: "/usr/bin/tern", args: ["acp", "codex", "--resume", SID] }]), SID)?.paneId === "93", "argv: a direct (non -c) argv is used as-is");
}
// ── IWT-SV-P2-2: three-state classification of a tern inspect run ───────────────────────────────────────────────────────
{
  const good = JSON.stringify(inspect([pane(102, SID, false)]));
  ok(classifyTernInspect({ code: 0, stdout: good }, SID).kind === "found", "lookup: daemon answered + block ⇒ found");
  ok(classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([])) }, SID).kind === "absent", "lookup: daemon answered, no block ⇒ absent");
  ok(classifyTernInspect({ code: -1, stdout: "", error: "ENOENT: cannot run tern" }, SID).kind === "unknown", "lookup: CLI missing ⇒ unknown (not absent)");
  ok(classifyTernInspect({ code: 4, stdout: "" }, SID).kind === "unknown", "lookup: daemon exit 4 ⇒ unknown");
  ok(classifyTernInspect({ code: 0, stdout: "{not json" }, SID).kind === "unknown", "lookup: bad JSON ⇒ unknown");
  ok(classifyTernInspect({ code: 0, stdout: JSON.stringify({ sessions: [] }) }, SID).kind === "unknown", "lookup: JSON without panes[] ⇒ unknown");
}
// ── IWT-SV-P2-3: no seat-shell path can escape the seat-shell dir ───────────────────────────────────────────────────────
{
  const h = mkdtempSync(path.join(scratch, "esc-"));
  mkdirSync(path.join(h, ".agenthop", "swarm"), { recursive: true });
  const outside = path.join(h, ".agenthop", "swarm", "review-state.json");
  writeFileSync(outside, "{}");
  for (const bad of ["../review-state", "..", "../../x", "a/b", "x.json", "", "a\\b"]) {
    ok(!validSeatSid(bad), `sid: "${bad}" rejected`);
    let threw = false; try { clearSeatShell(h, bad); } catch { threw = true; }
    ok(threw, `clear: "${bad}" refused before any path is built`);
  }
  ok(readdirSync(path.join(h, ".agenthop", "swarm")).includes("review-state.json"), "clear: the outside file survives every escape attempt");
  let threw = false; try { seatShellFile(h, "../x"); } catch { threw = true; }
  ok(threw, "seatShellFile: the single path builder throws on an invalid sid");
  writeSeatShell(h, SID, "tern", 1);
  clearSeatShell(h, SID);
  ok(readSeatShell(h, SID).kind === "absent", "clear: a valid sid clears normally (positive control)");
  clearSeatShell(h, SID);
  ok(true, "clear: clearing an already-absent seat is a no-op (ENOENT = success)");
}

// ── IWT-SV-P2-1 r3: token PROVENANCE — quoted separators, newlines, non-shell `-c` (Second Voice r2 counterexamples) ─────────
{
  const zsh = (line: string, pane = 9) => ({ pane, exited: null, working: false, program: "/bin/zsh", args: ["-l", "-c", line] });
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --prompt ';' --resume ${SID}`)]), SID)?.paneId === "9", "r3: a QUOTED ';' is an argument, not a separator — the real --resume after it is found");
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --prompt safe\nprintf '%s' --resume ${SID}`)]), SID) === null, "r3: a NEWLINE ends the command — --resume on the next line is a different command");
  const nonShell = { pane: 92, exited: null, working: false, program: "/x/bin/other-program", args: ["-c", `tern acp claude --resume ${SID}`] };
  ok(ternPaneInfoForSession(inspect([nonShell]), SID) === null, "r3: a NON-shell program's -c argument is NOT unwrapped as a command");
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --prompt safe # x\n`)]), SID) === null, "r3: comment then newline ⇒ no false match");
  const t = shellTokens(`a ';' b; c\nd`)!;
  ok(JSON.stringify(t) === JSON.stringify([{ kind: "word", text: "a" }, { kind: "word", text: ";" }, { kind: "word", text: "b" }, { kind: "sep" }, { kind: "word", text: "c" }, { kind: "sep" }, { kind: "word", text: "d" }]), "r3: tokens keep provenance (quoted ';' = word, unquoted ; and newline = sep)");
}
// ── IWT-R2-P2-1: two live blocks for one sid is AMBIGUOUS, not absent — classifier → router end-to-end ────────────────────
await (async () => {
  const zsh = (pane: number) => ({ pane, exited: null, working: false, program: "/bin/zsh", args: ["-l", "-c", `tern acp claude --resume ${SID}`] });
  const two = classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(9), zsh(10)])) }, SID);
  ok(two.kind === "unknown" && /ambiguous: 2 live Tern blocks/.test((two as { reason: string }).reason), "ambiguous: two live blocks ⇒ unknown with the block ids (NOT absent)");
  const calls: string[] = [], notes: string[] = [];
  const r = await resolveWakePane(["tern", "herdr"], ["tern", "herdr"], {
    tern: async () => { calls.push("tern"); return two; },
    herdr: async () => { calls.push("herdr"); return { kind: "found" as const, paneId: "old-herdr", state: "idle" as const }; },
  }, SID, (n) => notes.push(n));
  ok(r === null && JSON.stringify(calls) === '["tern"]', "ambiguous: routing STOPS — the herdr twin is never probed or woken");
  ok(notes.some((n) => /ambiguous/.test(n)), "ambiguous: the reason is logged (not silent)");
  const one = classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(9)])) }, SID);
  ok(one.kind === "found", "control: exactly one Tern block ⇒ found (selected)");
  const none = classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([])) }, SID);
  ok(none.kind === "absent", "control: empty panes ⇒ absent (the genuine fallback is kept)");
})();

// ── IWT-ARGV r4: shell EXPANSION — text inside $(…) / backticks / "$(…)" / $VAR is not a provable argv ──────────────────────
{
  const T = SID, O = "other-sid-0002";
  const zsh = (line: string) => ({ pane: 9, exited: null, working: false, program: "/bin/zsh", args: ["-l", "-c", line] });
  const subst = `tern acp claude --resume ${O} --prompt $(printf -- --resume ${T} suffix)`;
  ok(ternPaneInfoForSession(inspect([zsh(subst)]), T) === null, "r4: --resume inside $(…) is NOT matched (real sh only passes OTHER)");
  const c = classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(subst)])) }, T);
  ok(c.kind === "unknown" && /unparseable/.test((c as { reason: string }).reason), "r4: such a block is UNKNOWN (unparseable), so routing stops — never absent→herdr");
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --resume ${O} --prompt \`printf -- --resume ${T}\``)]), T) === null, "r4: backticks ⇒ not matched");
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --resume ${O} --prompt "$(printf -- --resume ${T})"`)]), T) === null, "r4: $(…) inside double quotes ⇒ not matched");
  ok(ternPaneInfoForSession(inspect([zsh(`tern acp claude --resume ${T} --prompt '$(not run)'`)]), T)?.paneId === "9", "r4 control: a literal '$(…)' inside SINGLE quotes is plain text ⇒ still matched");
  // IWT-ARGV-UNKNOWN (r5): replaces the r4 control that locked the bug in. A variable can expand to THIS sid at run time — checked
  // against real /bin/sh with the variable set to T (a fake `tern` records the argv it actually receives).
  {
    const { execFileSync } = await import("node:child_process");
    const line = `tern acp claude --resume "$REVIEW_RESUME_SID"`;
    const delivered = execFileSync("/bin/sh", ["-c", `tern() { printf '%s\\0' "$@"; exit 0; }\n${line}`], { encoding: "utf8", env: { ...process.env, REVIEW_RESUME_SID: T } }).split("\0").slice(0, -1);
    ok(delivered.includes(T), "r5 oracle: real /bin/sh with the variable set to this sid DOES deliver --resume <this sid>");
    const c5 = classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(line)])) }, T);
    ok(c5.kind === "unknown", "r5: a `--resume $VAR` ACP block whose sid can't be proven ⇒ UNKNOWN (unprovable ≠ absent), never absent→herdr");
    const calls: string[] = [];
    const r = await resolveWakePane(["tern", "herdr"], ["tern", "herdr"], { tern: async () => { calls.push("tern"); return c5; }, herdr: async () => { calls.push("herdr"); return { kind: "found" as const, paneId: "old-herdr", state: "idle" as const }; } }, T);
    ok(r === null && JSON.stringify(calls) === '["tern"]', "r5: the route stops — the herdr twin is never probed");
  }
  ok(classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(`vim $(ls)`)])) }, T).kind === "absent", "r5 control: an unparseable pane that is NOT an ACP seat (no acp/--resume) doesn't block ⇒ absent");
  ok(classifyTernInspect({ code: 0, stdout: JSON.stringify(inspect([zsh(`tern acp claude --resume other-sid-literal`)])) }, T).kind === "absent", "r5 control: a provable ACP seat for ANOTHER sid ⇒ still absent (real absence keeps the fallback)");
  ok(shellTokens(`a $(b) c`) === null && shellTokens(`a \`b\``) === null && shellTokens(`a <(b)`) === null && shellTokens(`a '$(b)'`) !== null, "r4: tokenizer refuses expansions, keeps single-quoted literals");
}

// ── IWT-SV-P2-1 (r5): REDIRECTIONS — an unquoted redirection operator and its target are not arguments ────────────────────
// Ground truth: real /bin/sh, with the fake `tern` writing its argv to a separate fd (9) so the line's own redirection can't hide it.
{
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync: mk, readFileSync: rf, existsSync: ex } = await import("node:fs");
  const T = "audit-1234";
  const delivered = (line: string): boolean => {
    const cwd = mk(path.join(scratch, "rd-")); const rec = path.join(cwd, "argv.rec");
    try { execFileSync("/bin/sh", ["-c", `exec 9>"${rec}"\ntern() { printf '%s\\0' "$@" >&9; exit 0; }\n${line}`], { cwd, stdio: "ignore" }); } catch { /* nothing delivered */ }
    if (!ex(rec)) return false;
    const a = rf(rec, "utf8").split("\0").slice(0, -1); const i = a.indexOf("--resume");
    return a[0] === "acp" && (a.includes(`--resume=${T}`) || (i >= 0 && a[i + 1] === T));
  };
  const zsh = (line: string) => ({ pane: 9, exited: null, working: false, program: "/bin/zsh", args: ["-l", "-c", line] });
  const forms: [string, string][] = [
    [`tern acp claude > --resume=${T}`, "redirect target is a FILE NAME, not --resume (the reviewer's counterexample)"],
    [`tern acp claude 2> --resume=${T}`, "fd-prefixed redirect (2>) target is a file name"],
    [`tern acp claude >> --resume ${T}`, "append redirect consumes --resume as its target"],
    [`tern acp claude --resume ${T} > out.log`, "control: a redirect AFTER the real args keeps them"],
    [`tern acp claude --resume ${T} 2>&1`, "control: 2>&1 is not an argument"],
    [`tern acp claude < /dev/null --resume ${T}`, "control: input redirect then real args"],
    [`tern acp claude '>' --resume ${T}`, "control: a QUOTED '>' is an argument"],
  ];
  for (const [line, what] of forms) {
    const sh = delivered(line), m = ternPaneInfoForSession(inspect([zsh(line)]), T) !== null;
    ok(sh === m, `r5 redirect: ${what} — parser agrees with /bin/sh (sh=${sh}, parser=${m})`);
  }
  ok(shellTokens(`a 2> f`)!.some((t) => t.kind === "redir" && (t as { op: string }).op === "2>"), "r5 tokenizer: `2>` is one redirection token (fd digits belong to the operator)");
  ok(shellTokens(`a '2>' f`)!.every((t) => t.kind === "word"), "r5 tokenizer: a quoted '2>' stays a word");
}
console.log(`\nall tern-wake selftests passed (${n})`);
