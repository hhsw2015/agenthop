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
 * (herdr.selftest.mts). Below the line are thin execFile wrappers that talk to the herdr socket.
 *
 * Rev2 (first-review fixes, 16bf8c8 → this): tightened the sentinel whitelist to the current-prompt region + full
 * mechanical form (no full-screen word hits); approval envelope now a valid InboxMsg (via local); launch returns a
 * typed outcome (started/not-started/unconfirmed) so callers never blind-fall-back and double-spawn; receipts are
 * validated (no fabricated success); splitCommand preserves quoted spaced args; wait separates submit from wait.
 */

export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export const HERDR_BIN = process.env.HERDR_BIN ?? "herdr"; // set to the absolute path to avoid the stale shell alias

// ============================================================================================================
// pure core (no IO) — selftested
// ============================================================================================================

/** Spawn/resume via herdr needs the dispatcher INSIDE a herdr pane (`pane split --current` resolves the caller
 *  from HERDR_PANE_ID; the skill forbids controlling the session from outside). Pure gate. */
export function herdrSpawnable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HERDR_ENV ?? "") === "1" && !!env.HERDR_PANE_ID;
}

/** H-P2-3: herdr `agent start --kind <k>` runs the canonical executable for that kind — it cannot honor a
 *  caller's explicit binary override (AGENTHOP_SPAWN_BIN_<KIND>) or a raw allow-cmd. When one is set, the herdr
 *  backend must step aside so the Ghostty path runs exactly the requested program. Pure. */
export function hasExplicitBinary(tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = tool.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return !!env[`AGENTHOP_SPAWN_BIN_${key}`] || env.AGENTHOP_SPAWN_ALLOW_CMD === "1";
}

/** Sanitize a label into a herdr agent name: `[a-z][a-z0-9_-]{0,31}`, unique among `taken`. Pure. */
export function herdrAgentName(label: string, taken: ReadonlySet<string> = new Set()): string {
  let base = (label || "agent").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+/g, "-");
  if (!base) base = "agent";
  base = base.slice(0, 32);
  let name = base;
  for (let i = 1; taken.has(name); i++) { const suf = `-${i}`; name = base.slice(0, 32 - suf.length) + suf; }
  return name;
}

/** H-P2-4: a quote-aware tokenizer so a legal spaced arg stays ONE arg. Handles '...' and "..." segments
 *  (strip the quotes, keep internal spaces); concatenates adjacent quoted/bare runs. No shell escapes needed for
 *  our commands. Pure. e.g. `codex --config "a = 'b'" resume s` -> ["codex","--config","a = 'b'","resume","s"]. */
export function shellTokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = ""; let has = false; let i = 0;
  const s = cmd ?? "";
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") { if (has) { out.push(cur); cur = ""; has = false; } i++; continue; }
    if (ch === "'" || ch === '"') {
      const close = s.indexOf(ch, i + 1);
      if (close === -1) { cur += s.slice(i + 1); has = true; i = s.length; } // unbalanced: take the rest
      else { cur += s.slice(i + 1, close); has = true; i = close + 1; }
      continue;
    }
    cur += ch; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

/** Split a full launch/resume command into { kind, args } for `agent start <name> --kind <kind> -- <args>`.
 *  Quote-aware (H-P2-4). Returns hasUnbalanced when the command had an unterminated quote (caller should refuse
 *  herdr and use the original backend rather than launch a corrupted arg list). Pure. */
export function splitCommand(cmd: string): { kind: string; args: string[]; balanced: boolean } {
  const raw = cmd ?? "";
  const dq = (raw.match(/"/g) ?? []).length, sq = (raw.match(/'/g) ?? []).length;
  const balanced = dq % 2 === 0 && sq % 2 === 0;
  const toks = shellTokenize(raw);
  return { kind: toks[0] ?? "", args: toks.slice(1), balanced };
}

// ---- argv builders (pure) ----
export function buildPaneSplit(cwd: string): string[] {
  return ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"];
}
export function buildAgentStart(name: string, kind: string, paneId: string, args: readonly string[] = [], timeoutMs?: number): string[] {
  return ["agent", "start", name, "--kind", kind, "--pane", paneId,
    ...(timeoutMs ? ["--timeout", String(timeoutMs)] : []),
    ...(args.length ? ["--", ...args] : [])];
}
export function buildAgentSubmit(name: string, text: string): string[] { return ["agent", "prompt", name, text]; }
export function buildAgentWait(name: string, until: readonly AgentState[], timeoutMs: number): string[] {
  return ["agent", "wait", name, ...until.flatMap((s) => ["--until", s]), "--timeout", String(timeoutMs)];
}
export function buildAgentRead(name: string, source = "recent-unwrapped", lines?: number): string[] {
  return ["agent", "read", name, "--source", source, ...(lines ? ["--lines", String(lines)] : [])];
}
export function buildSendKeys(name: string, keys: readonly string[]): string[] {
  return ["agent", "send-keys", name, ...keys];
}
export function buildPaneClose(paneId: string): string[] { return ["pane", "close", paneId]; }

// ---- receipt validation (H-P2-6): never treat empty/malformed/wrong-type as success ----
export function paneIdFromSplit(json: unknown): string | null {
  const p = (json as any)?.result?.pane?.pane_id;
  return typeof p === "string" && p ? p : null;
}
/** A valid agent_started receipt for THIS name, or null. Empty/malformed/wrong-type/mismatched -> null. */
export function startedName(json: unknown, expectedName: string): string | null {
  const r = (json as any)?.result;
  if (!r || r.type !== "agent_started") return null;
  const n = r.agent?.name;
  return typeof n === "string" && n === expectedName ? n : null;
}

export type StartState = "started" | "not-started" | "unconfirmed";
// Hard error codes that prove the agent NEVER launched (safe to clean the empty pane + fall back). Anything else
// (agent_not_ready, timeouts, empty/garbled output) is UNCONFIRMED: it may already be a live agent, so we keep
// the pane/name and never re-launch (H-P2-2).
export const HARD_NOT_STARTED = new Set(["name_in_use", "name_taken", "duplicate_name", "unknown_kind", "invalid_kind", "pane_not_found", "pane_unavailable", "pane_busy", "no_such_pane"]);

/** Classify an `agent start` result into started / not-started / unconfirmed. Pure (the IO shell feeds it the
 *  parsed JSON, or null for a timeout/no-output). */
export function classifyStart(json: unknown, expectedName: string, exitFailed: boolean): { state: StartState; reason: string } {
  if (startedName(json, expectedName)) return { state: "started", reason: "valid agent_started receipt" };
  const code = (json as any)?.error?.code;
  if (typeof code === "string" && HARD_NOT_STARTED.has(code)) return { state: "not-started", reason: `hard error ${code}` };
  if (code === "agent_not_ready") return { state: "unconfirmed", reason: "agent_not_ready — may be live but blocked at startup; keep handle" };
  // a non-zero exit with an unrecognized/absent error, empty output, or a wrong receipt type: we cannot prove it
  // did NOT start -> unconfirmed, preserve the handle, never re-launch.
  return { state: "unconfirmed", reason: exitFailed ? `unrecognized failure (${code ?? "no code"})` : "no valid receipt (empty/wrong type)" };
}

// ---- stall sentinel: classify a blocked agent's CURRENT prompt into auto-clear vs escalate ----

/** H-P1-1: the active prompt is at the BOTTOM of the screen. Take the tail (after chrome-strip) so a trust
 *  question sitting in SCROLLBACK history or quoted in tool output cannot be mistaken for the current prompt. */
export function currentPromptRegion(screen: string, tailLines = 12): string {
  const lines = stripTui(screen).split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-tailLines).join("\n");
}

export interface BlockedRule {
  id: string;
  /** Matches the FULL mechanical form of this prompt in the current region — not a loose keyword. */
  match: RegExp;
  keys: string[];
  why: string;
}

/** Whitelist v1 — DELIBERATELY NARROW, dogfood-only, and matched ONLY against the current prompt region with the
 *  FULL canonical phrasing (H-P1-1). `\bhooks?\b` word-boundary excludes "webhook". Near-misses ("trust this
 *  deployment", "allow this webhook", stale/quoted trust) do NOT match and therefore escalate. */
export const WHITELIST_V1: BlockedRule[] = [
  { id: "dir-trust", match: /do you trust the files in this (folder|directory|workspace)\b/i, keys: ["Enter"], why: "directory-trust prompt (S24 silent item): the dir is ours" },
  { id: "hook-trust", match: /\b(trust|allow)\b[^\n]{0,40}\bhooks?\b[^\n]{0,20}\b(in this|for this|run|execute)\b/i, keys: ["Enter"], why: "hook-trust prompt (S24 silent item): our own hooks" },
];

export interface SentinelDecision { action: "auto-clear" | "escalate"; ruleId?: string; keys?: string[]; reason: string }

/** Decide on a blocked agent's screen. Matches the whitelist ONLY within the current prompt region, requiring the
 *  full mechanical form. Can't confirm the prompt identity -> escalate (never synthesize an answer). Pure. */
export function sentinelDecision(screen: string, whitelist: readonly BlockedRule[] = WHITELIST_V1): SentinelDecision {
  const region = currentPromptRegion(screen);
  for (const r of whitelist) {
    if (r.match.test(region)) return { action: "auto-clear", ruleId: r.id, keys: r.keys, reason: r.why };
  }
  return { action: "escalate", reason: "not a whitelisted mechanical prompt in the current region — a human decision; escalate via S19" };
}

/** H-P2-1: build the S19 approval request as a VALID InboxMsg (via:"local" — the schema accepts local/relay, not
 *  "durable-inbox"; the sentinel writes locally to the coordinator inbox). Returns {file, body} where body passes
 *  validInboxMsg. (When F38's composeInboxMsg lands, swap to it.) Pure. */
export function buildApprovalDoc(opts: {
  from: string; fromLabel: string; nowSec: number;
  member: string; screenSummary: string; options: { label: string; consequence: string }[]; recommend?: string;
}): { file: string; body: { from: string; fromLabel: string; via: "local"; ts: number; taskRef: string; title: string; text: string } } {
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
    body: { from: opts.from, fromLabel: opts.fromLabel, via: "local", ts: opts.nowSec, taskRef: "approval", title: `${opts.member} 卡点待裁`, text },
  };
}

/** Strip herdr TUI chrome from a recent-unwrapped read (input box, status/footer, spinner). Pure, best-effort. */
export function stripTui(raw: string): string {
  const drop = [
    /^\s*›\s*Ask .* to do anything\s*$/i,
    /^\s*Worked for .*$/i,
    /^\s*(GPT|Claude|Codex|claude|codex)[^\n]*·[^\n]*(Context|window|tokens)[^\n]*$/i,
    /^\s*←[^\n]*for (agents|shortcuts)[^\n]*$/i,
    /^\s*⚠[^\n]*warning[^\n]*$/i,
    /^\s*\?\s+for shortcuts\s*$/i,
  ];
  return (raw ?? "").split("\n").filter((l) => !drop.some((re) => re.test(l))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ============================================================================================================
// IO shell — thin execFile wrappers. (exercised by live/integration runs, not the selftest)
// ============================================================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const px = promisify(execFile);

/** Run herdr; NEVER throw on a normal CLI failure (exit1 + stderr JSON) — return it structured so callers can
 *  classify instead of a reject escaping past the fallback (H-P2-2). */
async function herdrRun(args: string[], timeoutMs = 45000): Promise<{ raw: string; json: any | null; exitFailed: boolean }> {
  try {
    const { stdout } = await px(HERDR_BIN, args, { timeout: timeoutMs, maxBuffer: 1 << 22 });
    let json: any = null; try { json = JSON.parse(stdout); } catch { /* read cmds are plain text */ }
    return { raw: stdout, json, exitFailed: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const body = err.stderr || err.stdout || "";
    let json: any = null; try { json = JSON.parse(body); } catch { /* not json */ }
    return { raw: body, json, exitFailed: true };
  }
}

export async function herdrServerReachable(): Promise<boolean> {
  const { raw, exitFailed } = await herdrRun(["status", "server"], 5000);
  return !exitFailed && /status:\s*running/.test(raw);
}

export async function herdrAgentStates(): Promise<{ name: string; state: AgentState }[]> {
  const { json } = await herdrRun(["agent", "list"]);
  const agents: any[] = json?.result?.agents ?? [];
  return agents.filter((a) => typeof a?.name === "string").map((a) => ({ name: a.name, state: (a.agent_status ?? "unknown") as AgentState }));
}

export interface HerdrLaunchOutcome { state: StartState; paneId?: string; name?: string; note: string }

/**
 * Launch/resume an agent as a herdr pane. Classifies the outcome (H-P2-2/6):
 *  - started: valid agent_started receipt -> caller records it.
 *  - not-started: hard error (name/kind/pane) -> we CLEAN UP the empty pane split created, caller may fall back.
 *  - unconfirmed: maybe-live (agent_not_ready/timeout/garbled) -> keep the pane/name, caller must NOT re-launch.
 * Name is uniquified against live agents to avoid the collision that would otherwise hard-fail.
 */
export async function herdrLaunch(opts: { name: string; kind: string; cwd: string; args?: readonly string[]; startTimeoutMs?: number }): Promise<HerdrLaunchOutcome> {
  const sp = await herdrRun(buildPaneSplit(opts.cwd));
  const paneId = paneIdFromSplit(sp.json);
  if (!paneId) return { state: "not-started", note: `pane split produced no pane_id${sp.exitFailed ? " (exit failed)" : ""}: ${sp.raw.slice(0, 160)}` };
  const st = await herdrRun(buildAgentStart(opts.name, opts.kind, paneId, opts.args ?? [], opts.startTimeoutMs), (opts.startTimeoutMs ?? 30000) + 5000);
  const cls = classifyStart(st.json, opts.name, st.exitFailed);
  if (cls.state === "not-started") {
    await herdrRun(buildPaneClose(paneId), 8000).catch(() => undefined); // clean the empty pane we just created
    return { state: "not-started", paneId, note: `${cls.reason}; cleaned pane ${paneId}` };
  }
  if (cls.state === "unconfirmed") return { state: "unconfirmed", paneId, name: opts.name, note: `${cls.reason}; pane ${paneId} kept (no re-launch)` };
  return { state: "started", paneId, name: opts.name, note: "agent_started" };
}

/** Close a herdr pane by id (despawn of a herdr-backed launch). */
export async function herdrPaneClose(paneId: string): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildPaneClose(paneId), 8000);
  return { ok: !r.exitFailed && !r.json?.error, note: r.exitFailed ? "pane close failed" : "closed" };
}

/**
 * Voice/ops prompt (H-P2-5/6): SUBMIT (confirmed by the agent_prompted receipt), then OPTIONALLY wait for a
 * state in a SEPARATE bounded call. `submitted` is true only with a real submit receipt — an exec timeout alone
 * never implies submission (no blind replay). On wait timeout: {submitted:true, settled:false}.
 */
export async function herdrPrompt(name: string, text: string, opts: { wait?: boolean; until?: readonly AgentState[]; waitTimeoutMs?: number } = {}): Promise<{ submitted: boolean; settled: boolean; note: string }> {
  const sub = await herdrRun(buildAgentSubmit(name, text), 15000);
  const submitted = sub.json?.result?.type === "agent_prompted";
  if (!submitted) return { submitted: false, settled: false, note: `submit unconfirmed: ${sub.json?.error?.code ?? sub.raw.slice(0, 120)}` };
  if (!opts.wait) return { submitted: true, settled: false, note: "agent_prompted" };
  const timeout = opts.waitTimeoutMs ?? 120000; // explicit, generous default — not a hidden 10s
  const w = await herdrRun(buildAgentWait(name, opts.until ?? ["idle", "done", "blocked"], timeout), timeout + 5000);
  if (w.exitFailed) return { submitted: true, settled: false, note: "submitted; wait timed out/failed (not replayed)" };
  return { submitted: true, settled: true, note: w.json?.result?.agent?.agent_status ?? "settled" };
}

export async function herdrReadClean(name: string, lines = 40): Promise<string> {
  const { raw } = await herdrRun(buildAgentRead(name, "recent-unwrapped", lines));
  return stripTui(raw);
}

export async function herdrSendKeys(name: string, keys: readonly string[]): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildSendKeys(name, [...keys]));
  return { ok: !r.exitFailed && !r.json?.error, note: r.exitFailed ? "send-keys failed" : "sent" };
}
