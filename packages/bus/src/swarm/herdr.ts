/**
 * herdr — an optional backend for spawn/resume + the voice direct-path + the stall sentinel (S14, author 90b58f9c).
 *
 * Why: today we relaunch agents by blind-typing a command into a new Ghostty window via osascript — no receipt,
 * no state, no way to see an agent stuck on an approval box. herdr (a terminal workspace manager for coding
 * agents) gives JSON receipts, recognized lifecycle states (idle/working/blocked/done/unknown), and send-keys.
 * When the dispatcher runs INSIDE a herdr pane and the server is reachable, we use herdr; otherwise callers fall
 * back to the existing Ghostty path. Ghostty is NOT removed — the two backends coexist.
 *
 * PURE / IO split (msglog P1 lesson): everything above the "IO shell" line is pure and selftested
 * (herdr.selftest.mts) — detection, name sanitation, command-argv builders, the blocked classifier, the S19
 * approval-doc builder. Below the line are the thin execFile wrappers that actually talk to the herdr socket.
 *
 * Verified live (0.9.3, 2026-10-06): a process OUTSIDE a pane can `agent prompt <name>` by name over the socket
 * (HERDR_ENV is a skill discipline, not a hard CLI gate); prompting a `working` agent QUEUES (agent_prompted, no
 * error); `agent read --source recent-unwrapped` carries TUI chrome (stripTui cleans it).
 */

// The binary. Default "herdr" on PATH, but the user shell has a stale `herdr-cmux` alias — callers/ops should set
// HERDR_BIN to the absolute path (~/.local/bin/herdr) to be safe. Pure default; IO reads it.
export const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";

export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

// ============================================================================================================
// pure core (no IO) — selftested
// ============================================================================================================

/** Spawn/resume via herdr needs the dispatcher INSIDE a herdr pane: `pane split --current` resolves the calling
 *  pane from HERDR_PANE_ID, and the skill forbids controlling the session from outside. Pure gate. */
export function herdrSpawnable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HERDR_ENV ?? "") === "1" && !!env.HERDR_PANE_ID;
}

/** Name-targeted control (prompt/read/send-keys a NAMED agent) works from anywhere the socket is reachable —
 *  verified: the voice broker, a plain node server outside any pane, can drive it. Server reachability is an IO
 *  check (herdrServerReachable); this pure gate only says name-targeting does not itself need HERDR_ENV. */
export const NAME_TARGETING_NEEDS_PANE = false;

/** Sanitize a label into a herdr agent name: `[a-z][a-z0-9_-]{0,31}`, unique among `taken`. Pure. */
export function herdrAgentName(label: string, taken: ReadonlySet<string> = new Set()): string {
  let base = (label || "agent").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+/g, "-");
  if (!base) base = "agent";
  base = base.slice(0, 32);
  let name = base;
  for (let i = 1; taken.has(name); i++) { const suf = `-${i}`; name = base.slice(0, 32 - suf.length) + suf; }
  return name;
}

/** Split a full launch/resume command into { kind, args } for `agent start <name> --kind <kind> -- <args>`.
 *  "claude --flag --resume X" -> {kind:"claude", args:["--flag","--resume","X"]}; "codex resume X" ->
 *  {kind:"codex", args:["resume","X"]}. Pure. (A richer shell-aware split is overkill — our commands are flag
 *  lists with no embedded quotes after shell parsing.) */
export function splitCommand(cmd: string): { kind: string; args: string[] } {
  // Strip matched surrounding shell quotes per token: the canon resume cmd quotes the model
  // ('claude-opus-5-5[1m]') for the SHELL (Ghostty runs a string), but herdr `agent start -- <args>` goes through
  // execFile with no shell, so a literal quote would corrupt the arg. Our tokens have no internal spaces, so a
  // per-token whitespace split + quote-strip is correct here (a full shell tokenizer is overkill).
  const unquote = (s: string) => (/^'.*'$/.test(s) || /^".*"$/.test(s) ? s.slice(1, -1) : s);
  const toks = (cmd ?? "").trim().split(/\s+/).filter(Boolean).map(unquote);
  return { kind: toks[0] ?? "", args: toks.slice(1) };
}

/** argv for `herdr pane split` beside the calling pane, preserving cwd, keeping the user's focus. */
export function buildPaneSplit(cwd: string): string[] {
  return ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"];
}
/** argv for `herdr agent start <name> --kind <kind> --pane <paneId> [-- <args>]`. */
export function buildAgentStart(name: string, kind: string, paneId: string, args: readonly string[] = [], timeoutMs?: number): string[] {
  return ["agent", "start", name, "--kind", kind, "--pane", paneId,
    ...(timeoutMs ? ["--timeout", String(timeoutMs)] : []),
    ...(args.length ? ["--", ...args] : [])];
}
/** argv for `herdr agent prompt <name> <text> [--wait] [--until S]... [--timeout MS]`. */
export function buildAgentPrompt(name: string, text: string, opts: { wait?: boolean; until?: readonly AgentState[]; timeoutMs?: number } = {}): string[] {
  return ["agent", "prompt", name, text,
    ...(opts.wait ? ["--wait"] : []),
    ...(opts.until ?? []).flatMap((s) => ["--until", s]),
    ...(opts.timeoutMs ? ["--timeout", String(opts.timeoutMs)] : [])];
}
/** argv for `herdr agent wait <name> [--until S]... [--timeout MS]`. */
export function buildAgentWait(name: string, until: readonly AgentState[], timeoutMs?: number): string[] {
  return ["agent", "wait", name, ...until.flatMap((s) => ["--until", s]), ...(timeoutMs ? ["--timeout", String(timeoutMs)] : [])];
}
/** argv for `herdr agent read <name> --source <source> [--lines N]`. */
export function buildAgentRead(name: string, source = "recent-unwrapped", lines?: number): string[] {
  return ["agent", "read", name, "--source", source, ...(lines ? ["--lines", String(lines)] : [])];
}
/** argv for `herdr agent send-keys <name> <key> [key...]`. */
export function buildSendKeys(name: string, keys: readonly string[]): string[] {
  return ["agent", "send-keys", name, ...keys];
}

/** Strip herdr TUI chrome from a recent-unwrapped read so a web mirror / approval summary shows only content.
 *  Drops the input box, the status/footer lines, and herdr's "Worked for Ns" spinner line. Pure, best-effort. */
export function stripTui(raw: string): string {
  const drop = [
    /^\s*›\s*Ask .* to do anything\s*$/i,
    /^\s*Worked for .*$/i,
    /^\s*(GPT|Claude|Codex|claude|codex)[^\n]*·[^\n]*(Context|window|tokens)[^\n]*$/i,
    /^\s*←[^\n]*for (agents|shortcuts)[^\n]*$/i,
    /^\s*⚠[^\n]*warning[^\n]*$/i,
    /^\s*\?\s+for shortcuts\s*$/i,
  ];
  return raw.split("\n").filter((l) => !drop.some((re) => re.test(l))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- stall sentinel: classify a blocked agent's screen into auto-clear (whitelist) vs escalate (S19) ----------

export interface BlockedRule {
  id: string; // short slug for the trace
  match: RegExp; // detects this mechanical prompt in the read-screen text
  keys: string[]; // the send-keys to clear it (the SAFE/affirmative default the user already ruled under S24)
  why: string; // human reason (goes in the trace)
}

/** Whitelist v1 — DELIBERATELY NARROW, from dogfood records only: directory-trust and hook-trust prompts, both
 *  already ruled auto-silent under S24. Anything not matching here escalates to the user. Never widen without a
 *  dogfood record + a ruling. (Patterns are conservative; a near-miss escalates rather than auto-answers.) */
export const WHITELIST_V1: BlockedRule[] = [
  { id: "dir-trust", match: /\b(do you trust|trust the files in|trust this folder|trust this directory)\b/i, keys: ["Enter"], why: "directory-trust prompt (S24 silent item): the dir is ours, trust it" },
  { id: "hook-trust", match: /\b(trust.*hooks?|allow .*hook|hook.*trust)\b/i, keys: ["Enter"], why: "hook-trust prompt (S24 silent item): our own hooks" },
];

export interface SentinelDecision {
  action: "auto-clear" | "escalate";
  ruleId?: string; // set when auto-clear
  keys?: string[]; // set when auto-clear
  reason: string;
}

/** Decide what to do with a blocked agent's screen. Whitelist match -> auto-clear with its keys; otherwise
 *  escalate. The HARD boundary lives here: outside the whitelist we NEVER synthesize an answer. Pure. */
export function sentinelDecision(screen: string, whitelist: readonly BlockedRule[] = WHITELIST_V1): SentinelDecision {
  const text = stripTui(screen);
  for (const r of whitelist) {
    if (r.match.test(text)) return { action: "auto-clear", ruleId: r.id, keys: r.keys, reason: r.why };
  }
  return { action: "escalate", reason: "not a whitelisted mechanical prompt — a human decision; escalate to the user via S19" };
}

/** Build the S19 approval request (the 7-field durable inbox message) for a non-whitelist blocked agent. Reuses
 *  the existing approval format — does NOT invent a new one. `options` each carry a consequence; `recommend` is
 *  the sentinel's suggested option (never an auto-answer). The decision always comes from the user. Pure. */
export function buildApprovalDoc(opts: {
  from: string; fromLabel: string; coordinatorId: string; nowSec: number;
  member: string; screenSummary: string; options: { label: string; consequence: string }[]; recommend?: string;
}): { file: string; body: Record<string, unknown> } {
  const text = [
    `成员 ${opts.member} 卡在一个审批/选择框(herdr 检测 blocked),非白名单,需裁决。`,
    `读屏摘要:\n${opts.screenSummary}`,
    `选项:`,
    ...opts.options.map((o) => `  - ${o.label} → ${o.consequence}`),
    opts.recommend ? `我的建议:${opts.recommend}(仅建议,裁决出自你)` : "",
    `裁决回执落我箱后,由协调者/授权调度器 send-keys 回注到该成员终端闭环。`,
  ].filter(Boolean).join("\n");
  return {
    file: `${opts.nowSec}-approval-${opts.member}-from-${opts.fromLabel}.json`,
    body: { from: opts.from, fromLabel: opts.fromLabel, via: "durable-inbox", ts: opts.nowSec, taskRef: "approval", title: `${opts.member} 卡点待裁`, text },
  };
}

// ============================================================================================================
// IO shell — thin execFile wrappers over the herdr socket. (not selftested; exercised by live/integration runs)
// ============================================================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const px = promisify(execFile);

async function herdrRun(args: string[], timeoutMs = 45000): Promise<{ raw: string; json: any | null }> {
  const { stdout } = await px(HERDR_BIN, args, { timeout: timeoutMs, maxBuffer: 1 << 22 });
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { /* read commands return plain text */ }
  return { raw: stdout, json };
}

/** Is a herdr server reachable? (Separate from the HERDR_ENV pure gate.) */
export async function herdrServerReachable(): Promise<boolean> {
  try { const { raw } = await herdrRun(["status", "server"], 5000); return /status:\s*running/.test(raw); }
  catch { return false; }
}

export interface HerdrLaunchResult { ok: boolean; paneId?: string; name: string; note: string }

/** Launch (or resume) an agent as a herdr pane: split a pane, read its id, start the agent with native args. */
export async function herdrLaunch(opts: { name: string; kind: string; cwd: string; args?: readonly string[]; startTimeoutMs?: number }): Promise<HerdrLaunchResult> {
  const sp = await herdrRun(buildPaneSplit(opts.cwd));
  const paneId: string | undefined = sp.json?.result?.pane?.pane_id;
  if (!paneId) return { ok: false, name: opts.name, note: `pane split returned no pane_id: ${sp.raw.slice(0, 200)}` };
  const st = await herdrRun(buildAgentStart(opts.name, opts.kind, paneId, opts.args ?? [], opts.startTimeoutMs), (opts.startTimeoutMs ?? 30000) + 5000);
  if (st.json?.error) return { ok: false, paneId, name: opts.name, note: `agent start: ${st.json.error.code} ${st.json.error.message ?? ""}`.trim() };
  return { ok: true, paneId, name: opts.name, note: st.json?.result?.type ?? "agent_started" };
}

/** Inject a prompt into a named agent (the voice broker's path, or ops-rescue). Queues if the agent is working. */
export async function herdrPrompt(name: string, text: string, opts: { wait?: boolean; until?: readonly AgentState[]; timeoutMs?: number } = {}): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildAgentPrompt(name, text, opts), (opts.timeoutMs ?? 0) + 10000);
  return { ok: !r.json?.error, note: r.json?.error ? `${r.json.error.code}` : (r.json?.result?.type ?? "agent_prompted") };
}

/** Read a named agent's recent output, TUI chrome stripped (for a web mirror or a blocked-screen summary). */
export async function herdrReadClean(name: string, lines = 40): Promise<string> {
  const r = await herdrRun(buildAgentRead(name, "recent-unwrapped", lines));
  return stripTui(r.raw);
}

/** Send keys into a named agent's terminal (whitelist auto-clear, or approval re-injection). */
export async function herdrSendKeys(name: string, keys: readonly string[]): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildSendKeys(name, [...keys]));
  return { ok: !r.json?.error, note: r.json?.error ? `${r.json.error.code}` : "sent" };
}

/** List live agents (for the sentinel's blocked poll) -> [{name, state}]. */
export async function herdrAgentStates(): Promise<{ name: string; state: AgentState }[]> {
  try {
    const r = await herdrRun(["agent", "list"]);
    const agents: any[] = r.json?.result?.agents ?? [];
    return agents.map((a) => ({ name: a.name, state: (a.agent_status ?? "unknown") as AgentState }));
  } catch { return []; }
}
