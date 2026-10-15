// Tern transport for inbox-wake (the herdr transport's sibling) + the seat-shell registration the unique-claimant gate reads.
// Why (PROGRESS #1025): after the herdr→Tern migration a seat's sid can be live in BOTH shells. Wake pings only went to herdr, so the
// Tern seat was never woken while the stale herdr instance of the SAME sid was — and it started claiming the item. This module lets
// inbox-wake reach a Tern block, and records which shell OWNS a seat so the stale shell's claim is refused.
//
// Truth source = the Tern daemon (`tern inspect --json`), NEVER the agents-bridge mirror (agents.json can freeze — the advisory-mirror
// lesson). `tern ls --json` carries no agent state, but `inspect` panes[] carry `working:boolean` — that is the not-working gate.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentState } from "./herdr.js";
import { isValidSessionId } from "../send-fallback.js";

export type Shell = "tern" | "herdr";

export const TERN_BIN = process.env.TERN_BIN || "tern";

/** Tern reachable from THIS process: inside a Tern pane (TERN_PANE) or an explicit TERN_BIN. Pure. */
export function ternSpawnable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TERN_PANE || !!env.TERN_BIN;
}

/** The shell THIS process runs in, from its own env (self-attestation). Tern wins if both are set (a Tern pane launched from a herdr
 *  pane inherits HERDR_*, never the reverse). null = cannot attest (e.g. a codex seat's MCP child, which inherits neither). Pure. */
export function selfShell(env: NodeJS.ProcessEnv = process.env): Shell | null {
  if (env.TERN_PANE) return "tern";
  if ((env.HERDR_ENV ?? "") === "1" && env.HERDR_PANE_ID) return "herdr";
  return null;
}

/** One token of a shell command line: a WORD (an argument) or an unquoted command SEPARATOR. */
export type ShellToken = { kind: "word"; text: string } | { kind: "sep" };

/**
 * IWT-ARGV r6 — a deliberately SMALL, CONSERVATIVE shell grammar. We only ever need to PROVE a literal argv; we never execute the
 * line, so anything whose arguments depend on the shell's run-time behavior makes the WHOLE line unparseable (null ⇒ the classifier
 * reports unknown, never absent). Supported, and nothing else:
 *   - plain word characters                      a-z A-Z 0-9 and  _ - . / : = @ % + , ^
 *   - single quotes '…'                           literal, any characters except '
 *   - double quotes "…" with ONLY literal content  (no $ ` \ inside; those ⇒ unparseable)
 *   - backslash outside quotes escaping one char   (a literal char; a backslash-newline is a line continuation)
 *   - spaces/tabs between words; an UNQUOTED ; & | or newline ends a command (a "sep")
 *   - a # at a word start begins a comment to end of line
 * Rejected (⇒ null): every other unquoted character, notably  $ ` ( ) { } [ ] * ? ~ ! < >  — expansions, globs, tildes, history,
 * subshells, grouping and ALL redirections. Rejecting redirections outright (rather than parsing them) removes the quoted-fd ambiguity
 * (`'2'> f` vs `2> f`) instead of modelling it; a seat command line has no need for any of these. Unterminated quote ⇒ null. Pure.
 */
const WORD_CHAR = /[A-Za-z0-9_\-./:=@%+,^]/;
export function shellTokens(line: string): ShellToken[] | null {
  const out: ShellToken[] = [];
  let cur = "", inWord = false, i = 0;
  const end = () => { if (inWord) { out.push({ kind: "word", text: cur }); cur = ""; inWord = false; } };
  const sep = () => { end(); if (out.length && out[out.length - 1]!.kind !== "sep") out.push({ kind: "sep" }); };
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'") { const j = line.indexOf("'", i + 1); if (j < 0) return null; cur += line.slice(i + 1, j); inWord = true; i = j + 1; continue; }
    if (ch === '"') {
      const j = line.indexOf('"', i + 1); if (j < 0) return null;
      const body = line.slice(i + 1, j);
      if (/[$`\\]/.test(body)) return null; // only LITERAL double-quoted content is supported
      cur += body; inWord = true; i = j + 1; continue;
    }
    if (ch === "\\") {
      if (i + 1 >= line.length) return null;
      if (line[i + 1] !== "\n") { cur += line[i + 1]; inWord = true; } // backslash-newline = line continuation
      i += 2; continue;
    }
    if (ch === " " || ch === "\t") { end(); i++; continue; }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") { sep(); i++; continue; }
    if (ch === "#" && !inWord) { const nl = line.indexOf("\n", i); if (nl < 0) break; i = nl; continue; }
    if (WORD_CHAR.test(ch)) { cur += ch; inWord = true; i++; continue; }
    return null; // anything else ($ ` ( ) { } [ ] * ? ~ ! < > …) ⇒ not provably literal ⇒ unparseable
  }
  end();
  return out;
}

/** Words only (back-compat helper). null when unparseable. Pure. */
export function shellWords(line: string): string[] | null {
  const t = shellTokens(line);
  return t ? t.flatMap((x) => (x.kind === "word" ? [x.text] : [])) : null;
}

/** The shells whose `-c <line>` we unwrap (Tern launches ACP blocks as `zsh -l -c '<line>'`). Any OTHER program's `-c` argument is
 *  just an argument — never re-interpreted as a command (IWT-SV-P2-1 r3). */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** The argv of the program a pane actually runs (pure). A direct argv is used as-is (its elements are already arguments; nothing is
 *  re-split). Only when the program is a known SHELL with `-c <line>` is <line> tokenized, and only its FIRST command (up to the first
 *  unquoted separator or newline) is returned. null when the line cannot be tokenized. */
export function paneProgramArgv(rec: { program?: unknown; args?: unknown; command?: unknown }): string[] | null {
  const args = Array.isArray(rec.args) ? rec.args.map(String) : null;
  const prog = typeof rec.program === "string" ? rec.program.split("/").pop() ?? "" : "";
  const firstCommand = (line: string): string[] | null => {
    const toks = shellTokens(line);
    if (!toks) return null;
    const out: string[] = [];
    for (const t of toks) { if (t.kind === "sep") break; out.push(t.text); }
    return out;
  };
  if (args) {
    const c = args.indexOf("-c");
    if (SHELLS.has(prog) && c >= 0 && c + 1 < args.length) return firstCommand(args[c + 1]!);
    return args.length && prog ? [String(rec.program), ...args] : args; // a real argv: never re-interpret its arguments
  }
  return firstCommand(String(rec.command ?? ""));
}

/** Resolve sid → {paneId, state} from `tern inspect --json` (pure). A pane matches when it has NOT exited and the program it runs
 *  (shell-tokenized, see paneProgramArgv) is `tern acp …` with `--resume <sid>` as a real argument — text inside a quoted prompt or a
 *  comment is NOT evidence. `working:true` ⇒ "working", `false` ⇒ "idle", absent ⇒ "unknown" (still never interrupted). More than
 *  one live pane for the sid ⇒ ambiguous ⇒ null (don't guess which one to type into; delivery is already durable). */
export function ternPanesForSession(inspectJson: unknown, sid: string, unparseable: string[] = []): { paneId: string; state: AgentState }[] {
  if (!sid) return [];
  const panes = (inspectJson as { panes?: unknown })?.panes;
  if (!Array.isArray(panes)) return [];
  const hits: { paneId: string; state: AgentState }[] = [];
  for (const p of panes) {
    const rec = p as { pane?: unknown; exited?: unknown; args?: unknown; command?: unknown; working?: unknown };
    if (rec == null || (rec.pane !== 0 && !rec.pane)) continue;
    if (rec.exited !== null && rec.exited !== undefined) continue; // exited block ⇒ not a wake target
    const argv = paneProgramArgv(rec);
    if (argv === null) { // IWT-ARGV: the pane's real argv can't be proven (expansion / bad quoting)
      // IWT-ARGV-UNKNOWN (r5): "can't prove which sid" is NOT "not this sid". `tern acp claude --resume "$SID_VAR"` can resolve to THIS
      // seat at run time even though the sid never appears in the source text. So any unparseable pane that could be an ACP seat —
      // its raw text names this sid, or mentions both `acp` and `--resume` — makes the lookup unknown. A pane that shows no sign of
      // being an ACP seat (e.g. `vim $(ls)`) is unrelated and does not block.
      const raw = Array.isArray(rec.args) ? rec.args.map(String).join(" ") : String(rec.command ?? "");
      if (raw.includes(sid) || (/\bacp\b/.test(raw) && raw.includes("--resume"))) unparseable.push(String(rec.pane));
      continue;
    }
    if (argv.length < 2) continue;
    const prog = argv[0]!.split("/").pop();
    if (prog !== "tern" || argv[1] !== "acp") continue; // only an ACP seat block can be a wake target
    let found = false;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--resume" && argv[i + 1] === sid) { found = true; break; }
      if (argv[i] === `--resume=${sid}`) { found = true; break; }
    }
    if (!found) continue;
    const state: AgentState = rec.working === true ? "working" : rec.working === false ? "idle" : "unknown";
    hits.push({ paneId: String(rec.pane), state });
  }
  return hits;
}

/** The single live ACP block for the sid, or null when there is none OR more than one (don't guess which one to type into). Callers
 *  that must tell those two apart use ternPanesForSession / classifyTernInspect. Pure. */
export function ternPaneInfoForSession(inspectJson: unknown, sid: string): { paneId: string; state: AgentState } | null {
  const hits = ternPanesForSession(inspectJson, sid);
  return hits.length === 1 ? hits[0]! : null;
}

/** The exact argv pair used to wake a Tern block: type the line, then press Enter (verified working this morning). Pure. */
export function ternInjectCommands(paneId: string, text: string): [string[], string[]] {
  return [["send", paneId, "text", text], ["send", paneId, "keys", "Enter"]];
}

/** Run a tern CLI command; resolves {code, stdout, error}. `error` is set when the binary could not be spawned (ENOENT etc). Never throws. */
function ternRun(args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(TERN_BIN, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout ?? "") });
      const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (typeof e.code === "string") return resolve({ code: -1, stdout: "", error: `${e.code}: cannot run ${TERN_BIN}` }); // spawn failure
      if (e.killed) return resolve({ code: -1, stdout: "", error: "timed out" });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: String(stdout ?? "") });
    });
  });
}

/** Three-state Tern lookup (IWT-SV-P2-2, FC-2 family): `found` (one live ACP block for the sid), `absent` (the daemon answered and
 *  there is no such block — a genuine "not here"), or `unknown` (the CLI could not run, exited non-zero, or returned unparseable
 *  JSON). `unknown` is NEVER folded into `absent`: a broken probe must not make the router fall back to another shell's twin. */
export type TernLookup = { kind: "found"; paneId: string; state: AgentState } | { kind: "absent" } | { kind: "unknown"; reason: string };

/** Pure classification of one `tern inspect --json` run into the three states. */
export function classifyTernInspect(run: { code: number; stdout: string; error?: string }, sid: string): TernLookup {
  if (run.error) return { kind: "unknown", reason: run.error };
  if (run.code !== 0) return { kind: "unknown", reason: `tern inspect exited ${run.code}` };
  let json: unknown;
  try { json = JSON.parse(run.stdout); } catch { return { kind: "unknown", reason: "tern inspect returned unparseable JSON" }; }
  if (!Array.isArray((json as { panes?: unknown })?.panes)) return { kind: "unknown", reason: "tern inspect JSON has no panes[]" };
  const unparseable: string[] = [];
  const hits = ternPanesForSession(json, sid, unparseable);
  if (unparseable.length) {
    // IWT-ARGV r4: a live block mentions this sid but its command line uses a shell expansion, so whether it really runs `--resume
    // <sid>` can't be proven without executing it. Unknown ⇒ the router stops (no herdr fallback) and the reason is logged.
    return { kind: "unknown", reason: `unparseable: live Tern block(s) ${unparseable.join(", ")} may be this seat but their command line can't be proven (shell expansion) — not guessing a target` };
  }
  if (hits.length === 1) return { kind: "found", ...hits[0]! };
  if (hits.length > 1) {
    // IWT-R2-P2-1: several live blocks for one sid (a dual shell / a duplicate start) is NOT "Tern has no such seat". Report it as
    // unknown so the router STOPS — it must never fall back to the herdr twin — and the reason names the colliding blocks.
    return { kind: "unknown", reason: `ambiguous: ${hits.length} live Tern blocks for this sid (${hits.map((h) => h.paneId).join(", ")}) — not guessing a target` };
  }
  return { kind: "absent" };
}

export async function ternLookupLive(sid: string): Promise<TernLookup> {
  return classifyTernInspect(await ternRun(["inspect", "--json"]), sid);
}

/** Back-compat thin wrapper: the found pane or null (callers that need the third state use ternLookupLive). */
export async function ternPaneInfoLive(sid: string): Promise<{ paneId: string; state: AgentState } | null> {
  const r = await ternLookupLive(sid);
  return r.kind === "found" ? { paneId: r.paneId, state: r.state } : null;
}

/** Inject the wake line into a Tern block: text, then Enter. true only when BOTH sends exited 0. */
export async function ternInject(paneId: string, text: string): Promise<boolean> {
  const [typeCmd, enterCmd] = ternInjectCommands(paneId, text);
  if ((await ternRun(typeCmd)).code !== 0) return false;
  return (await ternRun(enterCmd)).code === 0;
}

// --- seat-shell registration (one file per seat: no shared read-modify-write) ---------------------------------------------------

export function seatShellDir(home: string): string { return path.join(home, ".agenthop", "swarm", "seat-shell"); }
/** A seat-shell sid must be a canonical session id (the same validator that gates durable-inbox paths) AND a single path segment —
 *  so no caller (read, write, or clear) can build a path outside the seat-shell dir. */
export function validSeatSid(sid: string): boolean {
  return isValidSessionId(sid) && sid !== "." && sid !== ".." && !sid.includes("/") && !sid.includes("\\");
}
/** The ONE way to build a seat file path. Throws on an invalid sid — callers can never reach the filesystem with an unchecked one. */
export function seatShellFile(home: string, sid: string): string {
  if (!validSeatSid(sid)) throw new Error(`invalid sid: ${sid}`);
  return path.join(seatShellDir(home), `${sid}.json`);
}
/** Clear a seat's registration (back to unregistered). Validates the sid BEFORE any path is built; ENOENT is success. */
export function clearSeatShell(home: string, sid: string): void {
  const f = seatShellFile(home, sid);
  try { unlinkSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

/** `pid` is a RESERVED slot (coordinator, 2026-10-15): tern-restore will record the seat's `tern acp` child pid here in the same step
 *  as the shell, for presence. Optional; the claim gate and wake routing do not read it. */
export type SeatShellRead = { kind: "registered"; shell: Shell; pid?: number } | { kind: "absent" } | { kind: "unreadable" };

/** Three-state read of a seat's registered shell. ENOENT ⇒ absent; a read fault / malformed / unknown value ⇒ unreadable. */
export function readSeatShell(home: string, sid: string): SeatShellRead {
  if (!validSeatSid(sid)) return { kind: "unreadable" };
  let raw: string;
  try { raw = readFileSync(seatShellFile(home, sid), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }; }
  try {
    const v = JSON.parse(raw) as { shell?: unknown; pid?: unknown };
    if (v && (v.shell === "tern" || v.shell === "herdr")) {
      const pid = Number.isSafeInteger(v.pid) && (v.pid as number) > 0 ? (v.pid as number) : undefined; // a bad pid is ignored, never fatal
      return pid === undefined ? { kind: "registered", shell: v.shell } : { kind: "registered", shell: v.shell, pid };
    }
  } catch { /* fallthrough */ }
  return { kind: "unreadable" };
}

/** Register a seat's shell: O_EXCL-owned temp written through its own fd, then an atomic rename. Throws on a bad sid/shell or IO fault. */
export function writeSeatShell(home: string, sid: string, shell: Shell, nowSec: number, pid?: number): void {
  if (!validSeatSid(sid)) throw new Error(`invalid sid: ${sid}`);
  if (shell !== "tern" && shell !== "herdr") throw new Error(`invalid shell: ${String(shell)}`);
  if (pid !== undefined && !(Number.isSafeInteger(pid) && pid > 0)) throw new Error(`invalid pid: ${String(pid)}`);
  const dir = seatShellDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = seatShellFile(home, sid);
  let tmp = "";
  let fd: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    tmp = `${dest}.tmp-${randomBytes(8).toString("hex")}`;
    try { fd = openSync(tmp, "wx", 0o600); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 32) continue; throw e; }
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ sid, shell, ...(pid !== undefined ? { pid } : {}), registeredAtSec: Math.floor(nowSec) })}\n`);
    closeSync(fd); fd = undefined;
    renameSync(tmp, dest);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
    try { unlinkSync(tmp); } catch { /* only our own temp */ }
    throw e;
  }
}

/** Which transports to try for a seat, in order. Registered ⇒ only that shell. Absent/unreadable ⇒ both, Tern first (the migration
 *  target; a Tern block that exists is the live one). Pure. */
export function wakeRoute(reg: SeatShellRead): Shell[] {
  return reg.kind === "registered" ? [reg.shell] : ["tern", "herdr"];
}

/** Unique-claimant decision. Refuse ONLY on a positive mismatch: the seat is registered to one shell and this process attests the
 *  other. An unregistered/unreadable seat, or a process that cannot attest (null), is allowed — never strand a seat's mail. Pure. */
export function claimAllowed(reg: SeatShellRead, self: Shell | null): boolean {
  if (reg.kind !== "registered" || self === null) return true;
  return reg.shell === self;
}
