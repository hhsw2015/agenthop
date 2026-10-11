import { startAgenthop } from "./agenthop.js";
import { startBridge } from "./bridge.js";
import { runPresence } from "./presence.js";
import { setTeam } from "./team.js";
import { statusHome, writeStatusFile } from "./statusfile.js";
import { version } from "./version.js";

/**
 * The enhanced agenthop entry. It IS agenthop: it adds the bus (mcp carries the bus tools, plus a
 * `team` command) and hands every classic command straight to the upstream CLI, so create / join /
 * install / update / relay / contacts behave exactly as before. In `mcp` mode nothing may touch
 * stdout — it is the protocol.
 */

async function main(): Promise<void> {
  // Captured as early as possible: for `report-status`, this is our best proxy for the EVENT time (when
  // the hook fired), so a delayed write still carries an older seq and can't clobber a newer state.
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "team") {
    const secret = argv[1]?.trim();
    if (!secret) {
      console.error("Usage: agenthop team <secret>   (shared secret for cross-machine discovery)");
      process.exitCode = 1;
      return;
    }
    setTeam(secret);
    console.log("Team secret saved. Sessions that share it discover each other across machines.");
    return;
  }

  if (cmd === "report-status") {
    // Called by an agent's HOOKS (or by hand) to report this session's work state; the session's own
    // bus node watches ~/.agenthop/status/<key>.json and applies it. `key` = the session's native id.
    // Claude Code hooks put it in the env (CLAUDE_CODE_SESSION_ID); Codex hooks deliver the payload as
    // JSON on STDIN (field `session_id`, no env/substitution — see docs/research/codex-opencode-hooks.md).
    // Non-fatal: a hook must never break the agent, so it never throws.
    const state = argv[1]?.trim();
    if (!state || !["working", "idle", "blocked", "unknown"].includes(state)) {
      console.error("Usage: agenthop report-status <working|idle|blocked|unknown> [--session <id>] [--note <text>] [--seq <ms>]");
      process.exitCode = 1;
      return;
    }
    const rest = argv.slice(2);
    const sessionArg = valueOf(rest, "--session");
    const note = valueOf(rest, "--note");
    // The hook captures the EVENT time in its shell and passes it here (see installClaudeStatusHooks); it is
    // a far better ordering key than this process's start time, which node-startup jitter can reorder. Fall
    // back to startedAt only when absent (manual runs / no time tool) — those never race.
    const seqArg = valueOf(rest, "--seq");
    const seqNum = seqArg !== undefined ? Number(seqArg) : Number.NaN;
    // Accept only what writeStatusFile accepts (a positive safe integer) so a malformed --seq (1.5, 1e18)
    // falls back to startedAt and still writes, rather than being accepted here then silently dropped there.
    const seq = Number.isSafeInteger(seqNum) && seqNum > 0 ? seqNum : startedAt;
    let key = sessionArg || process.env.AGENTHOP_SESSION?.trim() || process.env.CLAUDE_CODE_SESSION_ID?.trim();
    if (!key) {
      const payload = await readStdinJson(); // Codex hook channel
      const sid = payload?.session_id;
      if (typeof sid === "string" && sid.trim()) key = sid.trim();
    }
    if (!key) {
      console.error("report-status: no session key (set --session, AGENTHOP_SESSION, CLAUDE_CODE_SESSION_ID, or pipe hook JSON with session_id on stdin).");
      process.exitCode = 1;
      return;
    }
    writeStatusFile(statusHome(), key, state, { text: note, seq });
    return;
  }

  if (cmd === "permission-gate") {
    // The SYNC Claude PermissionRequest hook (approval-delegation). Dormant unless SWARM_APPROVAL_DELEGATE: otherwise it keeps
    // only the `blocked` status signal and emits nothing, so the call falls to the user exactly as the async report-status hook
    // did. When on, it writes the S11 approval request to the coordinator and polls the control-log for a delegated decision,
    // emitting an allow to auto-approve with no user dialog. Lazy import so its deps load only for this subcommand; it reuses
    // bin.ts's TTY-safe readStdinJson as the hook-stdin channel. Never throws (a hook must not break the agent).
    try {
      const { runPermissionGateCli } = await import("./permission-gate-cli.js");
      await runPermissionGateCli(startedAt, readStdinJson);
    } catch { /* fail-soft: any fault ⇒ no decision emitted ⇒ user dialog */ }
    return;
  }

  if (cmd === "bus-bridge") {
    // The per-machine cross-machine gateway for plugin-based tools (OpenCode). A plugin spawns this
    // when a team is set; it exits on its own once the last session has been gone for a grace period,
    // or immediately if there is no team or a live bridge already holds the socket.
    const bridge = await startBridge({ onIdle: () => process.exit(0) });
    if (!bridge) process.exit(0);
    return; // the socket server keeps the process alive until idle-exit
  }

  if (cmd === "mcp") {
    await startAgenthop({});
    // The harness closing our input is the end; a lingering server would keep the next one's inbox.
    process.stdin.once("end", () => process.exit(0));
    process.stdin.once("close", () => process.exit(0));
    return;
  }

  if (cmd === "presence") {
    // The always-on bus node a SessionStart hook BACKGROUNDS (plain `&`, not setsid — see presence.ts), so this session
    // is on the bus from startup. It lives until SIGTERM (SessionEnd) or its orphan guard fires; it does NOT exit on
    // stdin end (unlike `mcp`) since the hook gives it stdin=/dev/null.
    runPresence({});
    return; // the bus node + keep-alive timer keep the process alive
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(`agenthop v${version} (with session bus)`);
    return;
  }

  // Everything else is classic agenthop: create / join / install / update / relay / contacts / help.
  // The CLI reads process.argv itself and self-executes on import.
  await import("@agenthop/cli/bin");
}

/** Value after `--flag` in an argv slice, or undefined. */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Read a hook payload JSON from stdin — the channel Codex uses to pass {session_id, hook_event_name, …}
 * (no env, no `${var}` substitution). Resolves undefined on a TTY (manual run), timeout, EOF-without-JSON,
 * or error, so a hook can never hang or throw. Bounded read; caps the buffer against a runaway writer.
 */
function readStdinJson(timeoutMs = 1500): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve(undefined); // nothing piped — a person at a terminal
    let data = "";
    let settled = false;
    const parse = (s: string): Record<string, unknown> | undefined => {
      try {
        const v = JSON.parse(s) as unknown;
        return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    const done = (v?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.removeAllListeners("error");
      try {
        stdin.pause();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    stdin.setEncoding("utf8");
    stdin.on("data", (c: string) => {
      data += c;
      if (data.length > 1_000_000) done(parse(data)); // cap: don't buffer a runaway stream
    });
    stdin.on("end", () => done(parse(data)));
    stdin.on("error", () => done(undefined));
  });
}

void main();
