#!/usr/bin/env -S node --import tsx
/**
 * swarm-carly-send (dialog-officer M2-a, deliverable ②). Carly's ONE outbound command: hand a message to the swarm. A thin CLI
 * over the bus — it adds NO new delivery surface, only glue:
 *
 *   swarm-carly-send <role> <text...>
 *
 * `<role>` is a ROLE ADDRESS (never a raw sid — a sid drifts on a shell swap; a role resolves through the F40/presence layer):
 * "coordinator" → env `SWARM_COORDINATOR`, "dialog-officer" → `SWARM_DIALOG_OFFICER`, generally `SWARM_<ROLE>` (upper, `-`→`_`).
 * The handle resolves to a native sid via `resolveSession(handle, listSessions(home))` (presence-file based ⇒ reaches an OFFLINE
 * seat too). The envelope is FORCED `{from:"carly", via:"carly", intent:"report"}` (contract) and the TEXT is delivered VERBATIM —
 * Carly relays a user's words unchanged. `installInboxWake()` gives the millisecond pane ping on publish.
 *
 * FC-2 — never drop a message: if the role can't be resolved (no env handle / no live-or-offline presence / write fault), the
 * message is written to the durable fallback `~/.agenthop/carly/outbox/` (the dispatcher drains it every 60s). A queued fallback
 * is a SUCCESS (the message is durable), not an error — only a usage mistake is a non-zero exit.
 *
 * Pure helpers (classifyArgs / roleEnvVar / resolveRoleHandle) are selftested; `run` is the only side-effecting part.
 */
import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeInbox, composeInboxMsg, publishUniqueAtomic, type InboxMsg } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import { isValidSessionId } from "../packages/bus/src/send-fallback.js";
import { installInboxWake } from "../packages/bus/src/swarm/inbox-wake.js";

export type Query =
  | { kind: "send"; role: string; text: string }
  | { kind: "usage"; error?: string };

/** PURE argv → Query. `swarm-carly-send <role> <text...>`: the first token is the role, the REST (joined by space) is the verbatim
 *  text. A missing role or empty text is a usage error (exit 2). `--help`/`-h` is usage with no error (exit 0). */
export function classifyArgs(argv: readonly string[]): Query {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "usage" };
  const role = argv[0];
  if (role.startsWith("-")) return { kind: "usage", error: `unexpected flag "${role}"` };
  // DS-SEND-VERBATIM: join the (shell-split) args with a single space but do NOT mutate the result — the text is relayed byte-for
  // -byte, so leading/trailing whitespace and newlines inside a single argument are preserved. Only a COPY is trimmed to test emptiness.
  const text = argv.slice(1).join(" ");
  if (text.trim() === "") return { kind: "usage", error: "empty message text" };
  return { kind: "send", role, text };
}

/** PURE role → env var name. "coordinator" → "SWARM_COORDINATOR"; "dialog-officer" → "SWARM_DIALOG_OFFICER". Non-identifier chars
 *  (anything but [A-Za-z0-9]) collapse to "_" so a role can only ever name a SWARM_* env var (no traversal into other env). */
export function roleEnvVar(role: string): string {
  return "SWARM_" + role.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** PURE: resolve a role to its handle from env (the value of SWARM_<ROLE>), or null when unset/blank. */
export function resolveRoleHandle(role: string, env: NodeJS.ProcessEnv): string | null {
  const v = env[roleEnvVar(role)];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AH_HOME ?? env.AGENTHOP_HOME ?? homedir();
}

/** FC-2 durable fallback: persist the (undeliverable-right-now) message to ~/.agenthop/carly/outbox/ for the dispatcher to drain.
 *  DS-OUTBOX-PUBLISH: reuse the inbox's publishUniqueAtomic — an EXCLUSIVE temp (wx) linked to a UNIQUE no-overwrite name — so two
 *  fallbacks that collide on a name degrade to a fresh name, never one silently overwriting the other. Returns the published path. */
function writeOutbox(home: string, role: string, msg: InboxMsg): string {
  const dir = path.join(home, ".agenthop", "carly", "outbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return publishUniqueAtomic(dir, JSON.stringify({ to: role, msg }, null, 2) + "\n", msg.ts);
}

export function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const q = classifyArgs(argv);
  if (q.kind === "usage") {
    process.stderr.write(USAGE);
    return q.error ? 2 : 0;
  }
  const home = resolveHome(env);
  const msg = composeInboxMsg({ from: "carly", fromLabel: "carly", text: q.text, via: "carly", intent: "report" });
  installInboxWake(undefined, env); // millisecond pane ping on publish (floor is the periodic flush)

  const handle = resolveRoleHandle(q.role, env);
  const sid = handle ? resolveSession(handle, listSessions(home)) : null;
  if (sid && isValidSessionId(sid)) {
    try {
      const r = writeInbox(home, sid, msg);
      process.stdout.write(`delivered to ${q.role} (${sid}): ${r}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`write to ${q.role} (${sid}) failed: ${(e as Error).message}; queuing to outbox\n`);
    }
  }
  const file = writeOutbox(home, q.role, msg);
  process.stdout.write(`queued to carly outbox (target "${q.role}" not reachable now): ${file}\n`);
  return 0; // durably queued ⇒ success, never a dropped message
}

const USAGE = [
  "usage: swarm-carly-send <role> <text...>",
  "  <role>  coordinator | dialog-officer | <role>  (address by ROLE, resolved via SWARM_<ROLE>; never a raw sid)",
  "  <text>  the message, delivered VERBATIM; stamped {from:carly, via:carly, intent:report}",
  "",
].join("\n");

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; } })();
if (isMain) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`unexpected: ${(e as Error).message}\n`); process.exitCode = 1; }
  for (const s of [process.stdout, process.stderr]) s.on?.("error", (err: NodeJS.ErrnoException) => { if (err.code === "EPIPE") process.exit(process.exitCode ?? 0); });
}
