import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Passthrough to OmniWM's control CLI (omniwmctl), so a bus session inherits the full window-manager
 * surface — focus/move/resize windows & columns, workspaces, layouts, rules, queries — to arrange the
 * sub-agents it launches. macOS + OmniWM only; feature-detected with `ping`.
 *
 * Request/response only: the streaming subcommands (subscribe/watch) and local-only ones (completion)
 * are rejected here. This is the EXPLICIT desktop-control surface a caller drives deliberately; spawn's
 * own auto-arrange never uses it to touch anything but its own confirmed window.
 */

// One-shot top-level subcommands allowed through the passthrough.
const ALLOWED = new Set(["command", "query", "window", "workspace", "rule", "ping", "version", "help"]);
// Streaming / local-only subcommands that make no sense as a single request/response.
const REJECTED = new Set(["subscribe", "watch", "completion", "capture"]);

/** Resolve the omniwmctl binary: env override, then ~/.local/bin, common prefixes, then PATH. */
export function omniwmctlBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fixed = [
    env.AGENTHOP_OMNIWMCTL,
    path.join(homedir(), ".local", "bin", "omniwmctl"),
    "/usr/local/bin/omniwmctl",
    "/opt/homebrew/bin/omniwmctl",
  ].filter((c): c is string => !!c);
  for (const c of fixed) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "omniwmctl");
    try {
      if (existsSync(p)) return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export type Run = { code: number; stdout: string; stderr: string };

/** Run omniwmctl with a fixed argv (no shell) and a timeout. Never rejects. */
export function runOmniwmctl(bin: string, args: string[], timeoutMs = 8000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Is OmniWM reachable (binary present + IPC answering)? */
export async function omniwmReady(bin = omniwmctlBin()): Promise<boolean> {
  if (!bin) return false;
  const r = await runOmniwmctl(bin, ["ping"], 3000);
  return r.code === 0 && r.stdout.trim().toLowerCase().includes("pong");
}

/** Validation result for a passthrough argv (pure, unit-testable). */
export function checkWmArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  const sub = args[0];
  if (!sub) {
    return { ok: false, error: 'Usage: agenthop_wm <omniwmctl args>  e.g. "query windows", "command focus left", "window move-to-workspace <id> 2".' };
  }
  if (REJECTED.has(sub)) return { ok: false, error: `"${sub}" is a streaming/local subcommand and is not supported here (request/response only).` };
  if (!ALLOWED.has(sub)) return { ok: false, error: `Unsupported omniwmctl subcommand "${sub}". Allowed: ${[...ALLOWED].join(", ")}.` };
  return { ok: true };
}

export type WmResult = { ok: boolean; output: string };

/** Validate + run a one-shot omniwmctl invocation. `args` is the argv after `omniwmctl`. */
export async function omniwmctl(args: string[], bin = omniwmctlBin()): Promise<WmResult> {
  if (!bin) return { ok: false, output: "OmniWM is not available here (omniwmctl not found)." };
  const check = checkWmArgs(args);
  if (!check.ok) return { ok: false, output: check.error };
  const r = await runOmniwmctl(bin, args);
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  return { ok: r.code === 0, output: out || (r.code === 0 ? "(ok)" : `omniwmctl exited ${r.code}`) };
}

/** Split a command string into argv, honoring simple single/double quotes (for titles with spaces). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
