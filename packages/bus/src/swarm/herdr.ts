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
/** A proper char-by-char shell-ish scan (R2-P2-2): single quotes are literal; double quotes honor \\ and \"
 *  escapes; a backslash outside quotes escapes the next char. `balanced` is the PARSE state (ended outside any
 *  quote, no dangling escape) — not a character count. Pure. */
export function scanCommand(cmd: string): { tokens: string[]; balanced: boolean } {
  const s = cmd ?? "";
  const out: string[] = [];
  let cur = ""; let has = false; let i = 0;
  let mode: "none" | "single" | "double" = "none";
  while (i < s.length) {
    const ch = s[i]!;
    if (mode === "none") {
      if (ch === " " || ch === "\t" || ch === "\n") { if (has) { out.push(cur); cur = ""; has = false; } i++; continue; }
      if (ch === "'") { mode = "single"; has = true; i++; continue; }
      if (ch === '"') { mode = "double"; has = true; i++; continue; }
      if (ch === "\\") { if (i + 1 < s.length) { cur += s[i + 1]; has = true; i += 2; continue; } return finish(out, cur, has, false); }
      cur += ch; has = true; i++; continue;
    }
    if (mode === "single") {
      if (ch === "'") { mode = "none"; i++; continue; }
      cur += ch; i++; continue;
    }
    // double
    if (ch === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) { cur += s[i + 1]; i += 2; continue; }
    if (ch === '"') { mode = "none"; i++; continue; }
    cur += ch; i++; continue;
  }
  return finish(out, cur, has, mode === "none");
}
function finish(out: string[], cur: string, has: boolean, balanced: boolean): { tokens: string[]; balanced: boolean } {
  if (has) out.push(cur);
  return { tokens: out, balanced };
}

/** Tokens only (back-compat helper). */
export function shellTokenize(cmd: string): string[] { return scanCommand(cmd).tokens; }

/** Split a full launch/resume command into { kind, args, balanced }. Escape/quote-aware (R2-P2-2). When not
 *  balanced (unterminated quote / dangling escape) the caller must refuse herdr and use the original backend
 *  rather than launch a corrupted arg list. Pure. */
export function splitCommand(cmd: string): { kind: string; args: string[]; balanced: boolean } {
  const { tokens, balanced } = scanCommand(cmd);
  return { kind: tokens[0] ?? "", args: tokens.slice(1), balanced };
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
/** R2-P2-4: native `agent prompt --wait` (carries herdr's own activity guard) — submit + bounded settle in one. */
export function buildAgentPromptWait(name: string, text: string, timeoutMs: number): string[] {
  return ["agent", "prompt", name, text, "--wait", "--timeout", String(timeoutMs)];
}
export function buildAgentGet(name: string): string[] { return ["agent", "get", name]; }
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
/** R2-P2-5: the pane a live agent is bound to, from an `agent get` (or `agent started`) result. herdr is
 *  internally consistent — the split receipt uses result.pane.pane_id and `agent get` returns the agent with a
 *  pane_id. Defensive across the likely shapes; null when absent. Pure. */
export function agentPaneId(json: unknown): string | null {
  const r = (json as any)?.result;
  const p = r?.agent?.pane_id ?? r?.pane_id ?? r?.pane?.pane_id ?? r?.agent?.pane?.pane_id;
  return typeof p === "string" && p ? p : null;
}
/** The live agent is bound to the exact pane we launched into (no same-name reattach on another pane). Pure. */
export function paneBound(getJson: unknown, expectedPane: string): boolean {
  return !!expectedPane && agentPaneId(getJson) === expectedPane;
}

export type StartState = "started" | "not-started" | "unconfirmed";
// Hard error codes that prove the agent NEVER launched (safe to clean the empty pane + fall back). Anything else
// (agent_not_ready, timeouts, empty/garbled output) is UNCONFIRMED: it may already be a live agent, so we keep
// the pane/name and never re-launch (H-P2-2).
// Real codes from the installed herdr 0.9.3 binary (R2-P2-1 — static literal evidence: `agent_name_taken`,
// `agent_pane_not_found/busy/unavailable` exist; `name_in_use` does NOT). An unknown code stays unconfirmed.
export const HARD_NOT_STARTED = new Set(["agent_name_taken", "agent_pane_not_found", "agent_pane_busy", "agent_pane_unavailable"]);

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

// ---- R2-P2-3/4 + R13-B: submit + settle classification for herdrPrompt (3-state; never fabricate, never replay) ----
export type SubmitState = "yes" | "no" | "unknown";
// R13-B: `no` is a WHITELIST of codes that PROVE the prompt was never submitted (the target agent is absent, so
// nothing could land). timeout / agent_prompt_stalled — and any other code — can post-date a real submission, so
// they are `unknown` (may have landed -> never replay). agent_not_found is a live-confirmed literal; the set stays
// deliberately narrow until the R13 phase-2 real-machine pass archives the full `agent prompt` error taxonomy.
export const SUBMIT_REJECTED = new Set(["agent_not_found"]);
/** Classify an `agent prompt` result. agent_prompted receipt -> yes; a whitelisted "not submitted" code -> no;
 *  everything else (timeout/stalled/unknown code, exec failure, empty, wrong type) -> unknown (NEVER replay). Pure. */
export function classifySubmit(json: unknown, exitFailed: boolean): { submitted: SubmitState; reason: string } {
  if ((json as any)?.result?.type === "agent_prompted") return { submitted: "yes", reason: "agent_prompted receipt" };
  const code = (json as any)?.error?.code;
  if (typeof code === "string" && SUBMIT_REJECTED.has(code)) return { submitted: "no", reason: `rejected: ${code} (target agent absent — nothing submitted)` };
  if (typeof code === "string" && code) return { submitted: "unknown", reason: `error ${code} can post-date submission (e.g. timeout/stalled) — not replayed` };
  return { submitted: "unknown", reason: exitFailed ? "exec failed, no code (may have landed) — not replayed" : "no receipt (empty/wrong type)" };
}
// R13-B: a settle can be asserted ONLY from a VERIFIED native `--wait` receipt type together with a resolved
// status. A bare agent_status (idle/working/...) is NOT proof — `agent get` returns the same field, so a stale
// snapshot would be mistaken for a settle (reviewer). WAIT_SETTLE_TYPES is EMPTY until the R13 phase-2 real-machine
// pass archives the actual `--wait` receipt type(s); until then every settle stays unknown (settled:false).
export const WAIT_SETTLE_TYPES = new Set<string>();
/** Settle only on a verified --wait receipt TYPE + a resolved status (idle/done/blocked; never `working`). status
 *  is extracted best-effort for the human-readable note only — it is never, by itself, proof of settle. Pure. */
export function settledFrom(json: unknown, settleTypes: ReadonlySet<string> = WAIT_SETTLE_TYPES): { settled: boolean; status: string } {
  const type = (json as any)?.result?.type;
  const st = (json as any)?.result?.agent?.agent_status ?? (json as any)?.result?.agent_status;
  const status = typeof st === "string" && st ? st : "unknown";
  const settled = typeof type === "string" && settleTypes.has(type) && (["idle", "done", "blocked"] as string[]).includes(status);
  return { settled, status };
}

// ---- stall sentinel: a blocked agent is a human decision -> escalate (R2-P1-1, coordinator ruling R12) ----

export interface BlockedRule { id: string; match: RegExp; keys: string[]; why: string }

/** Whitelist v1 is EMPTY by coordinator ruling R12 (R2-P1-1). herdr 0.9.3 exposes NO structured "current pending
 *  prompt" — only a free-text screen scrape — so no text heuristic can reliably separate the live prompt from a
 *  trust question sitting in scrollback or quoted inside tool output (the four review counterexamples gamed exactly
 *  that). Rather than risk auto-answering the wrong box, every blocked agent escalates to the user (S24). Re-enable
 *  path: when herdr emits the current prompt as a structured field, matching can be restored on THAT field (never
 *  on the scrape), behind a fresh review. */
export const WHITELIST_V1: BlockedRule[] = [];

export interface SentinelDecision { action: "auto-clear" | "escalate"; ruleId?: string; keys?: string[]; reason: string }

/** v1 ALWAYS escalates (auto-clear disabled, R2-P1-1): a blocked agent is routed to the coordinator inbox as an
 *  S19 approval (buildApprovalDoc), never an auto-synthesized keypress. The screen is read only for the human's
 *  summary, never to decide. Pure. */
export function sentinelDecision(_screen: string, _whitelist: readonly BlockedRule[] = WHITELIST_V1): SentinelDecision {
  return { action: "escalate", reason: "auto-clear disabled in v1 (herdr gives no structured current-prompt signal); every blocked agent escalates to the user via S19" };
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
  // R2-P2-5: a valid agent_started receipt is not enough — prove the live agent is bound to the pane we just split
  // (herdr could attach a same-name agent on another pane). agent get -> pane_id must equal paneId; else keep the
  // handle but report unconfirmed (never re-launch, never fabricate success).
  const get = await herdrRun(buildAgentGet(opts.name), 8000);
  if (!paneBound(get.json, paneId)) {
    return { state: "unconfirmed", paneId, name: opts.name, note: `agent_started but pane bind unconfirmed (get pane=${agentPaneId(get.json) ?? "none"} != ${paneId}); kept, NOT re-launched` };
  }
  return { state: "started", paneId, name: opts.name, note: "agent_started + pane-bound" };
}

/** Close a herdr pane by id (despawn of a herdr-backed launch). */
export async function herdrPaneClose(paneId: string): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildPaneClose(paneId), 8000);
  return { ok: !r.exitFailed && !r.json?.error, note: r.exitFailed ? "pane close failed" : "closed" };
}

/**
 * Voice/ops prompt (H-P2-5/6, R2-P2-3/4). `submitted` is a THREE-state fact, never a boolean that hides doubt:
 *  - "yes": an agent_prompted receipt (or, with --wait, a real settle receipt) proves it landed.
 *  - "no": an explicit error code proves it did not.
 *  - "unknown": exec timeout / lost output / wrong type — it MAY have landed, so we never replay it.
 * With {wait:true} we use herdr's native `agent prompt --wait` (R2-P2-4: that path carries herdr's own activity
 * guard) and still validate the settle receipt — an empty/stale read is NOT "settled".
 */
export async function herdrPrompt(name: string, text: string, opts: { wait?: boolean; waitTimeoutMs?: number } = {}): Promise<{ submitted: SubmitState; settled: boolean; status?: string; note: string }> {
  if (!opts.wait) {
    const r = await herdrRun(buildAgentSubmit(name, text), 15000);
    const c = classifySubmit(r.json, r.exitFailed);
    return { submitted: c.submitted, settled: false, note: c.reason };
  }
  const timeout = opts.waitTimeoutMs ?? 120000; // explicit, generous default — not a hidden 10s
  const r = await herdrRun(buildAgentPromptWait(name, text, timeout), timeout + 5000);
  // R13-B: judge submission ONLY by a recognized receipt type (classifySubmit), never by the mere presence of an
  // agent_status — `agent get` returns that field too, so it is not proof the prompt landed. Settle likewise needs a
  // verified --wait type (currently none -> unknown). Never replay on anything short of a provable rejection.
  const c = classifySubmit(r.json, r.exitFailed);
  const s = settledFrom(r.json);
  if (c.submitted !== "yes") return { submitted: c.submitted, settled: false, status: s.status, note: c.reason };
  return { submitted: "yes", settled: s.settled, status: s.status, note: s.settled ? `settled:${s.status}` : "submitted; settle shape unverified (unknown until R13 phase-2) — not replayed" };
}

export async function herdrReadClean(name: string, lines = 40): Promise<string> {
  const { raw } = await herdrRun(buildAgentRead(name, "recent-unwrapped", lines));
  return stripTui(raw);
}

export async function herdrSendKeys(name: string, keys: readonly string[]): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildSendKeys(name, [...keys]));
  return { ok: !r.exitFailed && !r.json?.error, note: r.exitFailed ? "send-keys failed" : "sent" };
}
