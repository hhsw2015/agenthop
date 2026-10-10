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
/** Native `agent prompt --wait` builder. DORMANT: herdrPrompt no longer uses it — in the R13 phase-2 run a codex
 *  probe's --wait returned agent_prompt_stalled on a prompt it still completed (see WAIT_SETTLE_TYPES), so we don't
 *  rely on it; its reliability for other kinds/conditions is unverified. Kept as the re-enable seam. */
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
/** S14: block until a pane emits output (or timeout). The pane id is POSITIONAL (herdr 0.9.3 has no `--pane` option — LS1).
 *  Used only as a bounded inter-sample BLOCK; new-output truth comes from a content-hash diff, not this match (LS2). One of
 *  `regex`/`match` (regex wins); neither ⇒ any output. */
export function buildPaneWaitOutput(paneId: string, opts: { regex?: string; match?: string; timeoutMs: number }): string[] {
  const pat = opts.regex !== undefined ? ["--regex", opts.regex] : opts.match !== undefined ? ["--match", opts.match] : [];
  return ["pane", "wait-output", paneId, ...pat, "--timeout", String(opts.timeoutMs)];
}
/** S14: characterize a blocked agent (safety-stop / approval box / crash). Free-text, attached to the S19 approval. */
export function buildAgentExplain(name: string): string[] { return ["agent", "explain", name]; }
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

/** F44-⑦: the pane_id bound to a session id, from an `agent list` (result.agents[]) or `pane list` (result.panes[])
 *  result — the entry whose `agent_session.value === sid`. A blocked member with NO herdr `name` (every claude agent is
 *  nameless in the list — see herdrAgentStates) cannot be read by `agent read <name>`; its screen must be read by this
 *  pane_id (herdr accepts a pane_id as the agent target — verified live: `agent explain w1:p1`). So the blocked-alert
 *  screen read maps sid → pane_id HERE instead of passing the sid as a herdr name (which yields agent_not_found).
 *  Defensive across the agents[]/panes[] shapes; null when no entry matches. Pure. */
export function paneIdForSession(listJson: unknown, sid: string): string | null {
  if (!sid) return null;
  const r = (listJson as any)?.result;
  const rows: unknown[] = Array.isArray(r?.agents) ? r.agents : Array.isArray(r?.panes) ? r.panes : [];
  for (const row of rows) {
    const rec = row as any;
    if (rec?.agent_session?.value === sid && typeof rec?.pane_id === "string" && rec.pane_id) return rec.pane_id;
  }
  return null;
}

export type StartState = "started" | "not-started" | "unconfirmed";
// Hard error codes that prove the agent NEVER launched (safe to clean the empty pane + fall back). Anything else
// (agent_not_ready, timeouts, empty/garbled output) is UNCONFIRMED: it may already be a live agent, so we keep
// the pane/name and never re-launch (H-P2-2).
// Real codes from the installed herdr 0.9.3 binary (static literal evidence; `name_in_use` does NOT exist). R13
// phase-2 real-machine runs additionally confirmed `agent_name_taken` (07: duplicate start) and
// `agent_pane_not_found` (empty-pane start) live. An unknown code stays unconfirmed.
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
// `no` is a WHITELIST of codes that PROVE the prompt was never submitted (the target agent is absent, so nothing
// could land). timeout / agent_prompt_stalled — and any other code — can post-date a real submission, so they are
// `unknown` (may have landed -> never replay). R13 phase-2 evidence confirms both ends: `agent prompt` to a missing
// agent -> agent_not_found (08, provably not submitted); `agent prompt --wait` -> agent_prompt_stalled on a prompt
// that was submitted and still completed (09->10->11, so it must stay unknown, never no). The set stays narrow.
export const SUBMIT_REJECTED = new Set(["agent_not_found"]);
/** Classify an `agent prompt` result against the STATIC installed-binary schema (R13 static contract lock; evidence
 *  herdr-b6bf97d3 .../installed-api-schema.json): the `agent_prompted` variant requires {type, agent}, and the
 *  agent (AgentInfo) requires a string `pane_id`; `name` is nullable/optional. So a valid "yes" needs the type AND
 *  a real agent object with pane_id AND — when the receipt names an agent — that name must be the one we prompted
 *  (a different name proves the receipt is for someone else). A whitelisted code -> no; everything else -> unknown
 *  (NEVER replay). R13 phase-2 real receipt (evidence 06) confirms the success shape: type=agent_prompted,
 *  agent.name populated (="probeagent") + string pane_id — so real successes DO bind by name (null-name not
 *  observed), and the positive match stays strict. Pure. */
export function classifySubmit(json: unknown, expectedName: string, exitFailed: boolean): { submitted: SubmitState; reason: string } {
  const r = (json as any)?.result;
  if (r?.type === "agent_prompted") {
    const agent = r.agent;
    if (!agent || typeof agent !== "object" || typeof agent.pane_id !== "string" || !agent.pane_id) {
      return { submitted: "unknown", reason: "agent_prompted missing the required agent/pane_id (invalid shape) — not a proven submit" };
    }
    // POSITIVE target binding (R4-P2-2): the bar is "prove this receipt is for the agent we prompted", NOT "no
    // conflicting name was seen". So submitted=yes ONLY when the receipt names the exact target; null / absent /
    // empty / non-string names are all insufficient proof -> unknown (R13: never fabricate; never downgrade to no;
    // never replay). Narrowing the schema-legal null-name case waits for the phase-2 real-receipt archive.
    if (typeof expectedName === "string" && expectedName.length > 0 && agent.name === expectedName) {
      return { submitted: "yes", reason: "agent_prompted bound to the requested target" };
    }
    return { submitted: "unknown", reason: `agent_prompted not provably bound to ${JSON.stringify(expectedName)} (receipt name=${JSON.stringify(agent.name)}) — insufficient proof` };
  }
  const code = (json as any)?.error?.code;
  if (typeof code === "string" && SUBMIT_REJECTED.has(code)) return { submitted: "no", reason: `rejected: ${code} (target agent absent — nothing submitted)` };
  if (typeof code === "string" && code) return { submitted: "unknown", reason: `error ${code} can post-date submission (e.g. timeout/stalled) — not replayed` };
  return { submitted: "unknown", reason: exitFailed ? "exec failed, no code (may have landed) — not replayed" : "no receipt (empty/wrong type)" };
}
// Settle can be asserted ONLY from a VERIFIED native `--wait` receipt type + a resolved status. A bare agent_status
// (idle/working/...) is NOT proof — `agent get` returns the same field, so a stale snapshot would be mistaken for a
// settle. R13 phase-2 run (docs/research/herdr-phase2-evidence, 09->10->11 + timing): one codex probe, confirmed
// input-ready, was given a prompt it ultimately completed (391, "Worked for 7s"), yet `--wait` returned
// `agent_prompt_stalled` at ~5.4s reporting idle. That proves the stalled receipt is NOT "not submitted" and that the
// prompt completed; it does NOT prove the whole working period went undetected, nor that NO trustworthy settle signal
// exists across herdr 0.9.3 (one probe/kind/condition; other kinds/paths unverified). We obtained no verifiable
// `--wait` settle receipt in this run, so WAIT_SETTLE_TYPES stays EMPTY and settle stays unknown — a conservative
// default, NOT a proof of absence. This set, settledFrom, and buildAgentPromptWait are the DORMANT re-enable seam:
// fill the set once a settle signal is actually verified, behind a fresh review. Not currently used by herdrPrompt.
export const WAIT_SETTLE_TYPES = new Set<string>();
/** Settle only on a verified --wait receipt TYPE + a resolved status (idle/done/blocked; never `working`). status
 *  is extracted best-effort for the human-readable note only — it is never, by itself, proof of settle. Pure.
 *  (Dormant: this run obtained no verifiable --wait settle type; integration does not rely on it — see WAIT_SETTLE_TYPES.) */
export function settledFrom(json: unknown, settleTypes: ReadonlySet<string> = WAIT_SETTLE_TYPES): { settled: boolean; status: string } {
  const type = (json as any)?.result?.type;
  const st = (json as any)?.result?.agent?.agent_status ?? (json as any)?.result?.agent_status;
  const status = typeof st === "string" && st ? st : "unknown";
  const settled = typeof type === "string" && settleTypes.has(type) && (["idle", "done", "blocked"] as string[]).includes(status);
  return { settled, status };
}

/** S14 LS3 (pure): classify an `agent wait` outcome. reached = the re-read state is a target. timeout = a POSITIVE STRUCTURED
 *  marker ONLY (error code timeout/wait_timeout, result.timed_out, or a result.type matching /timeout/) — NEVER a raw-text
 *  substring (a "socket timed out" failure or a member named "timeout-worker" is not a member-wait timeout) and NEVER inferred
 *  from near-deadline elapsed (a success can land just before the deadline). error = any failed exit with no structured timeout
 *  marker (the wait did not run; a recognized non-timeout code takes priority). A success exit whose state moved off target with
 *  NO timeout marker is `reached` (it hit a target then fell back; uncertain, but NOT a continuous-idle timeout). */
export function classifyWaitOutcome(json: unknown, _raw: string, exitFailed: boolean, state: AgentState, until: readonly AgentState[]): "reached" | "timeout" | "error" {
  if (until.includes(state)) return "reached";
  const code = (json as any)?.error?.code;
  const res = (json as any)?.result;
  // A timeout must come from a STRUCTURED marker, NEVER a raw-text substring (LS3): "socket timed out" is a connection
  // failure, and an error whose text merely names a member like "timeout-worker" is not the member's wait expiring. A
  // recognized non-timeout error code (e.g. permission_denied) therefore takes priority ⇒ error.
  if (code === "timeout" || code === "wait_timeout" || res?.timed_out === true || (typeof res?.type === "string" && /timeout/i.test(res.type))) return "timeout";
  if (exitFailed) return "error"; // any failed exit without a structured timeout marker ⇒ error (not a confirmed timeout)
  return "reached"; // success exit, state off target, no timeout marker ⇒ reached then fell back (uncertain, not timeout)
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
async function herdrRun(args: string[], timeoutMs = 45000, signal?: AbortSignal): Promise<{ raw: string; json: any | null; exitFailed: boolean }> {
  try {
    const { stdout } = await px(HERDR_BIN, args, { timeout: timeoutMs, maxBuffer: 1 << 22, ...(signal ? { signal } : {}) });
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

/** F44-⑦: resolve a session id to its herdr pane_id via `agent list` (paneIdForSession). The blocked-alert screen read uses
 *  this so a NAMELESS agent (every claude) is read by its pane (`agent read <pane_id>`) instead of by the sid-as-name
 *  (agent_not_found). null when the server is unreachable or no entry matches. */
export async function herdrPaneIdForSession(sid: string): Promise<string | null> {
  const { json } = await herdrRun(["agent", "list"]);
  return paneIdForSession(json, sid);
}

/** The pane_id AND current agent_status bound to a session id, from one `agent list` — so the inbox-wake path resolves both the
 *  inject target and the working/idle gate in a single herdr call. Mirrors paneIdForSession's defensive agents[]/panes[] shape;
 *  status defaults to "unknown" when absent. null when no row matches the sid. Pure. */
export function paneInfoForSession(listJson: unknown, sid: string): { paneId: string; state: AgentState } | null {
  if (!sid) return null;
  const r = (listJson as any)?.result;
  const rows: unknown[] = Array.isArray(r?.agents) ? r.agents : Array.isArray(r?.panes) ? r.panes : [];
  for (const row of rows) {
    const rec = row as any;
    if (rec?.agent_session?.value === sid && typeof rec?.pane_id === "string" && rec.pane_id) {
      return { paneId: rec.pane_id, state: (rec.agent_status ?? "unknown") as AgentState };
    }
  }
  return null;
}

export async function herdrPaneInfoForSession(sid: string): Promise<{ paneId: string; state: AgentState } | null> {
  const { json } = await herdrRun(["agent", "list"]);
  return paneInfoForSession(json, sid);
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
 * Voice/ops prompt. `submitted` is a THREE-state fact (yes/no/unknown), never a boolean that hides doubt.
 *
 * Phase-2 real-machine evidence (docs/research/herdr-phase2-evidence) drives the design:
 *  - Submission is confirmed ONLY by the plain `agent prompt` receipt — it reliably returns `agent_prompted` bound
 *    to the target (evidence 06).
 *  - We deliberately do NOT use `agent prompt --wait`: in the phase-2 run it returned `agent_prompt_stalled` on a
 *    prompt the codex probe still completed (evidence 09->10->11), which would turn a real success into unknown. So we
 *    don't rely on `--wait` for confirmation; its reliability for other kinds/conditions is unverified.
 *  - This run obtained no verifiable settle/working signal (WAIT_SETTLE_TYPES empty), so `settled` stays false — a
 *    conservative default, NOT a proof that no such signal exists. A caller needing settle must poll its own signal
 *    until a reliable one is verified.
 */
export async function herdrPrompt(name: string, text: string, opts: { wait?: boolean; waitTimeoutMs?: number } = {}): Promise<{ submitted: SubmitState; settled: boolean; status?: string; note: string }> {
  const r = await herdrRun(buildAgentSubmit(name, text), 15000);
  const c = classifySubmit(r.json, name, r.exitFailed);
  const settleNote = opts.wait ? " (no verifiable --wait settle obtained in the phase-2 run; integration does not use --wait — settle unknown)" : "";
  return { submitted: c.submitted, settled: false, note: c.reason + settleNote };
}

export async function herdrReadClean(name: string, lines = 40): Promise<string> {
  const { raw } = await herdrRun(buildAgentRead(name, "recent-unwrapped", lines));
  return stripTui(raw);
}

/** Like herdrReadClean but reports a FAILED read as null (LS2): a read error must NOT become fake-death "progress evidence"
 *  (hashing the error text as content). null ⇒ the caller skips the silence update this cycle; "" is a real empty screen. */
export async function herdrReadContent(name: string, lines = 40, signal?: AbortSignal): Promise<string | null> {
  const { raw, exitFailed } = await herdrRun(buildAgentRead(name, "recent-unwrapped", lines), 15000, signal);
  return exitFailed ? null : stripTui(raw);
}

export async function herdrSendKeys(name: string, keys: readonly string[]): Promise<{ ok: boolean; note: string }> {
  const r = await herdrRun(buildSendKeys(name, [...keys]));
  return { ok: !r.exitFailed && !r.json?.error, note: r.exitFailed ? "send-keys failed" : "sent" };
}

/** Current VERIFIED state of one agent (from `agent list`, the same source herdrAgentStates trusts). "unknown" if absent. */
export async function herdrAgentState(name: string, signal?: AbortSignal): Promise<AgentState> {
  const { json } = await herdrRun(["agent", "list"], 10000, signal);
  const agents: any[] = json?.result?.agents ?? [];
  const a = agents.find((x) => x?.name === name);
  return (a?.agent_status ?? "unknown") as AgentState;
}

/** Resolve an agent name to its bound pane id (for pane-level commands). null if unresolved. */
export async function herdrAgentPaneId(name: string, signal?: AbortSignal): Promise<string | null> {
  const { json } = await herdrRun(buildAgentGet(name), 10000, signal);
  return agentPaneId(json);
}

/** S14 primitive ① — BLOCK until the agent reaches one of `until` (or timeout), then report the CURRENT verified state (from
 *  agent list) AND the wait OUTCOME (LS3): `reached` = the member transitioned into `until`; `timeout` = the wait ran to its
 *  deadline with no transition (exit ok, or a timeout error code); `error` = the wait FAILED fast (e.g. permission_denied) and
 *  so did NOT actually wait — the caller must NOT treat the unchanged state as a real timeout. We trust the state read, not the
 *  wait receipt body (same discipline as WAIT_SETTLE_TYPES); only exit-success + error-code are used to split timeout vs error. */
export async function herdrWait(name: string, until: readonly AgentState[], timeoutMs: number, signal?: AbortSignal): Promise<{ state: AgentState; outcome: "reached" | "timeout" | "error" }> {
  const r = await herdrRun(buildAgentWait(name, until, timeoutMs), timeoutMs + 5000, signal); // block (receipt body only read for a timeout marker)
  const state = await herdrAgentState(name, signal);
  return { state, outcome: classifyWaitOutcome(r.json, r.raw, r.exitFailed, state, until) };
}

/** S14 primitive ② — BLOCK until the pane emits output (or timeout). "output" = the command returned before its timeout;
 *  "timeout" = no matching output within timeoutMs (the fake-death trigger); "error" = an inconclusive failure (treated as
 *  non-fake-death by the caller, never a false alert). We classify only timeout-vs-not, never parse an output receipt. */
export async function herdrWaitOutput(paneId: string, opts: { regex?: string; match?: string; timeoutMs: number }, signal?: AbortSignal): Promise<"output" | "timeout" | "error"> {
  const r = await herdrRun(buildPaneWaitOutput(paneId, opts), opts.timeoutMs + 5000, signal);
  if (!r.exitFailed) return "output";
  const code = (r.json as any)?.error?.code;
  if (code === "timeout" || code === "wait_timeout" || /tim␣?out/i.test(r.raw) || /timed? ?out/i.test(r.raw)) return "timeout";
  return "error"; // unknown failure ⇒ inconclusive (do NOT convict fake-death)
}

/** S14 primitive ④ — characterize a blocked agent; returns the cleaned free-text for the human S19 summary ("" on failure). */
export async function herdrExplain(name: string, signal?: AbortSignal): Promise<string> {
  const r = await herdrRun(buildAgentExplain(name), 15000, signal);
  if (r.exitFailed) return "";
  const txt = typeof (r.json as any)?.result?.explanation === "string" ? (r.json as any).result.explanation : r.raw;
  return stripTui(txt).slice(0, 2000);
}

/** S14 primitive ③ — inject a decision back with a receipt (replaces blind send-keys for the approval close-loop). Reuses
 *  the verified classifySubmit (3-state; never fabricate, never replay). */
export async function herdrPromptWait(name: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<{ submitted: SubmitState; note: string }> {
  const r = await herdrRun(buildAgentPromptWait(name, text, timeoutMs), timeoutMs + 5000, signal);
  const c = classifySubmit(r.json, name, r.exitFailed);
  return { submitted: c.submitted, note: c.reason };
}
