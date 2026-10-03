// Standalone entry for the presence daemon, run as a NON-compiled script via `bun` (or `node`) — NOT the bun --compile
// binary, which exits when it has no controlling terminal (backgrounded/detached by a SessionStart hook). A plain bun/
// node script with a ref'd keep-alive survives that, so the SessionStart hook runs this file. See presence.ts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPresence } from "./presence.js";

/** Block the current thread for ~ms (no busy spin). Used only in the short-lived bootstrap, never the daemon. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Self-daemonize into a NEW SESSION before doing anything else. The SessionStart hook runs us in the foreground, but a
// child here stays in the HOOK'S process group — which the host tears down when the hook returns: Codex (0.160) waits
// for the group (hanging a sync hook) or kills it; Claude is similar. macOS has no `setsid` binary, so we escape the
// group from here: re-spawn ourselves detached (detached:true calls setsid on POSIX → new session, new group) with fds
// detached, then exit. The grandchild is reparented to init and lives independently of the hook.
//
// RACE: detached:true sets up the child's new session asynchronously; if we exit (and the hook returns, and the host
// tears the group down) before the child has finished setsid, the child is killed mid-detach. So we HANDSHAKE: the
// daemon writes its pid file once it is up in its own session (see runPresence), and we poll for that file before
// exiting. Bounded so a child that never starts cannot hang the hook.
if (process.env.AGENTHOP_PRESENCE_DAEMONIZED !== "1") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTHOP_PRESENCE_DAEMONIZED: "1" },
  });
  child.unref();
  const pidFile = process.env.AGENTHOP_PID_FILE;
  if (pidFile) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !existsSync(pidFile)) sleepSync(50);
  } else {
    sleepSync(300); // no handshake file to poll — still give the child a moment to escape the group
  }
  process.exit(0);
}

runPresence({});
