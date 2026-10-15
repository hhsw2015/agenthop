/**
 * Read a hook payload JSON from stdin — the channel Codex uses to pass {session_id, hook_event_name, …}
 * (no env, no `${var}` substitution). Resolves undefined on a TTY (manual run), timeout, EOF-without-JSON,
 * or error, so a hook can never hang or throw. Bounded read; caps the buffer against a runaway writer.
 */
export function readStdinJson(timeoutMs = 1500): Promise<Record<string, unknown> | undefined> {
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
