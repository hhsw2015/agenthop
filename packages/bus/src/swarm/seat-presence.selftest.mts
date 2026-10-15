/**
 * seat-presence selftest (#1053). Pure resolver over ps fixtures shaped like the live tree (2026-10-15):
 *   tern acp claude --resume <sid>  →  node …/Tern/agents/…  →  claude --output-format stream-json … --resume=<sid>
 *   tern acp codex --resume <sid>   →  node …/@agentclientprotocol/codex-acp/dist/…  →  codex app-server
 * plus the writer's keep / replace / refuse rules.  Run: node_modules/.bin/tsx packages/bus/src/swarm/seat-presence.selftest.mts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { busMayWrite, endBusPresence, parsePs, readOrigin, removeOwnPresence, resolveAgentPid, writeBusPresence, writePresence } from "./seat-presence.js";
import { makeFileLiveness } from "./task-liveness.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const A = "90b58f9c-5bac-4318-a996-2373c179d674";
const B = "f32a0507-27bd-47d2-adea-9f30b87612ae";
const C = "01a13284-d361-74a0-a026-ad56f1fdf355";
const PS = [
  ` 2935 14473 /Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${A} --mode bypassPermissions`,
  ` 4122  2935 /Users/x/.nvm/versions/node/v20/bin/node /Users/x/Library/Application Support/Tern/agents/claude/index.js`,
  ` 4158  4122 /Users/x/.local/share/claude/versions/2.1.293 --output-format stream-json --verbose --input-format stream-json --resume=${A} --tools=default`,
  ` 4200  4158 /bin/zsh -c npm test`,
  ` 2936 14473 /Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${B}`,
  ` 4121  2936 node /x/Tern/agents/claude/index.js`,
  ` 4152  4121 claude --output-format stream-json --resume ${B}`,
  `21477 14473 /Applications/Tern.app/Contents/MacOS/tern acp codex --resume ${C}`,
  `21490 21477 /usr/local/bin/node /x/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
  `21495 21490 codex app-server`,
  `21496 21477 tail -f /tmp/codex.log`,
].join("\n");
const rows = parsePs(PS);
// the kernel's EXACT argv for each pid (what realExactArgv returns): element boundaries are real, unlike the ps text
const EXACT: Record<number, { exe: string; argv: string[] }> = {
  2935: { exe: "/Applications/Tern.app/Contents/MacOS/tern", argv: ["/Applications/Tern.app/Contents/MacOS/tern", "acp", "claude", "--resume", A] },
  4122: { exe: "/Users/x/.nvm/versions/node/v20/bin/node", argv: ["node", "/Users/x/Library/Application Support/Tern/agents/claude/index.js"] },
  4158: { exe: "/Users/x/.local/share/claude/versions/2.1.293", argv: ["claude", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", `--resume=${A}`, "--tools=default"] },
  4200: { exe: "/bin/zsh", argv: ["/bin/zsh", "-c", "npm test"] },
  2936: { exe: "/Applications/Tern.app/Contents/MacOS/tern", argv: ["tern", "acp", "claude", "--resume", B] },
  4121: { exe: "/usr/local/bin/node", argv: ["node", "/x/Tern/agents/claude/index.js"] },
  4152: { exe: "/Users/x/.local/bin/claude", argv: ["claude", "--output-format", "stream-json", "--resume", B] },
  21477: { exe: "/Applications/Tern.app/Contents/MacOS/tern", argv: ["tern", "acp", "codex", "--resume", C] },
  21490: { exe: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/x/node_modules/@agentclientprotocol/codex-acp/dist/index.js"] },
  21495: { exe: "/usr/local/bin/codex", argv: ["codex", "app-server"] },
  21496: { exe: "/usr/bin/tail", argv: ["tail", "-f", "/tmp/codex.log"] },
};
const ex = (extra: Record<number, { exe: string; argv: string[] }> = {}) => (p: number) => extra[p] ?? EXACT[p] ?? null;

t("parsePs: pid/ppid/argv", rows.length === 11 && rows[2]!.pid === 4158 && rows[2]!.ppid === 4122)
t("claude: --resume=<sid> two levels down, argv[0] a versioned native path (basename is not 'claude')", resolveAgentPid(2935, A, "claude", rows, ex()) === 4158)
t("claude: --resume <sid> as two arguments", resolveAgentPid(2936, B, "claude", rows, ex()) === 4152)
t("claude: the sid must match (another seat's root never resolves to this sid)", resolveAgentPid(2936, A, "claude", rows, ex()) === null)
t("claude: a descendant without stream-json (a shell the agent ran) is never the agent", resolveAgentPid(4158, A, "claude", rows, ex()) === null)
t("codex: the direct node child naming the codex-acp adapter; a mere 'codex' mention (tail -f) is not proof", resolveAgentPid(21477, C, "codex", rows, ex()) === 21490)
{
  const dup = parsePs(PS + `\n 4999  4122 claude --output-format stream-json --resume=${A}`);
  t("claude: TWO candidates ⇒ null (never guess)", resolveAgentPid(2935, A, "claude", dup, ex({ 4999: { exe: "/x/claude", argv: ["claude", "--output-format", "stream-json", `--resume=${A}`] } })) === null)
  const noAdapter = rows.filter((r) => r.pid !== 21490);
  t("codex: no adapter child ⇒ null", resolveAgentPid(21477, C, "codex", noAdapter, ex()) === null)
  const decoy = parsePs(PS + `\n21497 21477 node /tmp/watch-codex.js --log /tmp/codex.log`);
  t("codex: a node child that merely mentions codex is not the adapter (still exactly the adapter)", resolveAgentPid(21477, C, "codex", decoy, ex({ 21497: { exe: "/usr/local/bin/node", argv: ["node", "/tmp/watch-codex.js", "--log", "/tmp/codex.log"] } })) === 21490)
}
// ---- SP-ARGV (Chief Review): ps text does not prove argument boundaries ----
{
  // a node -e whose ONE argument contains "stream-json --resume=<sid>" — the ps text looks like the agent's flags
  const fake = parsePs(PS + `\n 4300  4122 node -e console.log("stream-json --resume=${A}")`);
  const fakeEx = ex({ 4300: { exe: "/usr/local/bin/node", argv: ["node", "-e", `console.log("stream-json --resume=${A}")`] } });
  t("SP-ARGV: a data argument that merely CONTAINS the flags is not the agent (exact argv decides; the real claude still resolves)", resolveAgentPid(2935, A, "claude", fake, fakeEx) === 4158)
  const onlyFake = parsePs(PS.split("\n").filter((l) => !l.startsWith(" 4158")).join("\n") + `\n 4300  4122 node -e console.log("stream-json --resume=${A}")`);
  t("SP-ARGV: with only the fake left ⇒ null (not the node -e)", resolveAgentPid(2935, A, "claude", onlyFake, fakeEx) === null)
  const argv0Liar = ex({ 4158: { exe: "/x/node", argv: ["node", "stream-json", `--resume=${A}`] } });
  t("SP-ARGV: argv[0] must be claude", resolveAgentPid(2935, A, "claude", rows, argv0Liar) === null)
  t("SP-ARGV: the candidate's exact argv unreadable ⇒ null (unknown, never a guess)", resolveAgentPid(2935, A, "claude", rows, (p) => (p === 4158 ? null : EXACT[p] ?? null)) === null)
  t("SP-ARGV codex: adapter path must be argv[1] of a node executable", resolveAgentPid(21477, C, "codex", rows, ex({ 21490: { exe: "/usr/local/bin/python3", argv: ["python3", "/x/node_modules/@agentclientprotocol/codex-acp/dist/index.js"] } })) === null)
}

// ---- writer ----
const home = mkdtempSync(path.join(os.tmpdir(), "sp-"));
const f = path.join(home, ".agenthop", "presence", `${A}.pid`);
const alive = (p: number) => p !== 666;
t("write: absent ⇒ wrote", writePresence(home, A, 4158, alive).state === "wrote" && readFileSync(f, "utf8") === "4158")
t("write: same live pid ⇒ kept", writePresence(home, A, 4158, alive).state === "kept")
{
  const r = writePresence(home, A, 4170, alive);
  t("write: a DIFFERENT pid already there ⇒ replaced, was reported", r.state === "wrote" && r.was === 4158 && readFileSync(f, "utf8") === "4170")
}
t("write: the resolved pid must be alive", writePresence(home, A, 666, alive).state === "refused" && readFileSync(f, "utf8") === "4170")
t("write: an invalid sid is refused before any path", writePresence(home, "../x", 4158, alive).state === "refused")
writeFileSync(f, "garbage");
t("write: an existing non-pid file ⇒ refused, NOT overwritten", writePresence(home, A, 4158, alive).state === "refused" && readFileSync(f, "utf8") === "garbage")
writeFileSync(f, "4170"); chmodSync(f, 0o000);
const ro = writePresence(home, A, 4158, alive);
chmodSync(f, 0o600);
t("write: an existing UNREADABLE file ⇒ refused (FC-2), not overwritten", ro.state === "refused" && readFileSync(f, "utf8") === "4170")
t("write: no temp files left behind", readdirSync(path.dirname(f)).every((n) => !n.includes(".tmp-")))
void mkdirSync;
// ---- SP-SESSIONEND (TS side): endBusPresence kills only a bus/legacy record, strictly parsed, under the lock ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "sp5-"));
  const pf = path.join(h, ".agenthop", "presence", `${A}.pid`);
  const of = pf.replace(/\.pid$/, ".origin");
  mkdirSync(path.dirname(pf), { recursive: true });
  const kills: number[] = [];
  const k = (p: number) => { kills.push(p); };
  writeFileSync(pf, "321"); writeFileSync(of, "origin=agent ts=1\n");
  t("END: origin=agent ⇒ held, no kill, kept", endBusPresence(h, A, k) === "held" && kills.length === 0 && existsSync(pf))
  writeFileSync(of, "origin=bus THIS-IS-NOT-A-TIMESTAMP\n");
  t("END: 'origin=bus <junk>' is unreadable (strict parse) ⇒ held", endBusPresence(h, A, k) === "held" && kills.length === 0)
  writeFileSync(of, "origin=bus ts=1\n");
  t("END: origin=bus ⇒ killed that pid, .pid and sidecar removed", endBusPresence(h, A, k) === "killed" && kills[0] === 321 && !existsSync(pf) && !existsSync(of))
  t("END: absent ⇒ absent, nothing killed", endBusPresence(h, A, k) === "absent" && kills.length === 1)
  const thrower = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  writeFileSync(pf, "322"); writeFileSync(of, "origin=bus ts=1\n");
  t("END-ERRNO: EPERM ⇒ kill-failed, .pid and sidecar KEPT", endBusPresence(h, A, thrower("EPERM")) === "kill-failed" && readFileSync(pf, "utf8") === "322" && existsSync(of))
  t("END-ERRNO: unknown error ⇒ kill-failed, kept", endBusPresence(h, A, () => { throw new Error("boom"); }) === "kill-failed" && existsSync(pf) && existsSync(of))
  t("END-ERRNO: ESRCH ⇒ already gone: killed, both removed", endBusPresence(h, A, thrower("ESRCH")) === "killed" && !existsSync(pf) && !existsSync(of))
}

// ---- #1053 r2: two writers, agent authoritative, origin in a SIDECAR (the .pid stays one number for every existing reader) ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "sp2-"));
  const pf = path.join(h, ".agenthop", "presence", `${A}.pid`);
  const live = new Set([100, 200, 300]);
  const isAlive = (p: number) => live.has(p);
  t("r2 bus: absent ⇒ the bus daemon writes its pid, origin bus", writeBusPresence(h, A, 100, isAlive) && readFileSync(pf, "utf8") === "100" && readOrigin(h, A) === "bus")
  t("r2 agent over bus: the agent write replaces a live bus record, origin agent", writePresence(h, A, 200, isAlive).state === "wrote" && readFileSync(pf, "utf8") === "200" && readOrigin(h, A) === "agent")
  t("r2 bus vs LIVE agent: the bus daemon does NOT overwrite", !writeBusPresence(h, A, 100, isAlive) && readFileSync(pf, "utf8") === "200")
  t("r2 the .pid stays ONE number: task-liveness readPid still parses it", makeFileLiveness(h).readPid(A) === 200)
  live.delete(200);
  t("r2 bus vs DEAD agent: the bus daemon replaces it", writeBusPresence(h, A, 100, isAlive) && readFileSync(pf, "utf8") === "100" && readOrigin(h, A) === "bus")
  live.add(200); writePresence(h, A, 200, isAlive);
  t("r2 agent, same pid again: kept (origin already agent)", writePresence(h, A, 200, isAlive).state === "kept")
  live.add(300);
  t("r2 agent, a DIFFERENT live pid: replaced", writePresence(h, A, 300, isAlive).state === "wrote" && readFileSync(pf, "utf8") === "300")
  removeOwnPresence(h, A, 100);
  t("r2 shutdown: a bus daemon never deletes the agent's record", readFileSync(pf, "utf8") === "300")
  writeFileSync(pf, "garbage");
  t("r2 bus vs an unparseable record: not overwritten (FC-2)", !busMayWrite(h, A, 100, isAlive) && readFileSync(pf, "utf8") === "garbage")
  writeFileSync(pf, "200"); writeFileSync(path.join(h, ".agenthop", "presence", `${A}.origin`), "origin=agent ts=1\n");
  t("r2 a bus daemon whose own pid is recorded may refresh it even if the sidecar says agent", busMayWrite(h, A, 200, isAlive))
  writeFileSync(pf, "100"); writeFileSync(path.join(h, ".agenthop", "presence", `${A}.origin`), "origin=bus ts=1\n");
  removeOwnPresence(h, A, 100);
  t("r2 shutdown: the bus daemon removes ITS record and its sidecar", !existsSync(pf) && readOrigin(h, A) === "absent")
  writeFileSync(pf, "200");
  t("r2 legacy record (no sidecar) with a live foreign pid: bus may write (absent = legacy)", busMayWrite(h, A, 100, isAlive))
  // SP-ORIGIN-UNKNOWN: a sidecar that EXISTS but is unreadable or malformed is unknown ⇒ the bus writer holds
  const of = path.join(h, ".agenthop", "presence", `${A}.origin`);
  writeFileSync(of, "origin=agnet ts=1\n");
  t("SP-ORIGIN-UNKNOWN: a malformed sidecar ⇒ unreadable, bus may NOT write over the live pid", readOrigin(h, A) === "unreadable" && !busMayWrite(h, A, 100, isAlive))
  writeFileSync(of, "origin=agent ts=1\n"); chmodSync(of, 0o000);
  const eacces = readOrigin(h, A);
  const mayEacces = busMayWrite(h, A, 100, isAlive);
  chmodSync(of, 0o600);
  t("SP-ORIGIN-UNKNOWN: an EACCES sidecar ⇒ unreadable, bus may NOT write", eacces === "unreadable" && !mayEacces)
  writeFileSync(pf, "100"); writeFileSync(of, "origin=agnet ts=1\n");
  removeOwnPresence(h, A, 100);
  t("SP-ORIGIN-UNKNOWN: shutdown with an unreadable sidecar keeps the record (might be an agent's)", existsSync(pf))
}
// ---- SP-WRITER-RACE: bus write / shutdown delete happen under the per-sid lock, re-reading .pid + .origin ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "sp3-"));
  const pf = path.join(h, ".agenthop", "presence", `${A}.pid`);
  mkdirSync(path.dirname(pf), { recursive: true });
  const lockDir = path.join(path.dirname(pf), `${A}.lockd`);
  // hold the lock as if a writer (alive: this process) were mid-publish ⇒ the bus writer must not proceed
  const holder = process.ppid; // a LIVE pid that is not ours (holder-lock reclaims our own pid and dead pids only)
  mkdirSync(lockDir); writeFileSync(path.join(lockDir, `${holder}.deadbeef0000`), "");
  writeFileSync(path.join(path.dirname(pf), `${A}.lockd.hold.${holder}.deadbeef0000`), "");
  const t0 = Date.now();
  const wrote = writeBusPresence(h, A, 777777, () => true);
  t("SP-WRITER-RACE: while a writer holds the presence lock, the bus write does NOT happen (busy ⇒ false)", !wrote && !existsSync(pf) && Date.now() - t0 >= 1500)
  writePresence(h, A, process.pid, () => true);
  t("SP-WRITER-RACE: the agent writer also waits for the lock (busy ⇒ refused, nothing written)", !existsSync(pf))
}


console.log("all seat-presence selftests passed");
