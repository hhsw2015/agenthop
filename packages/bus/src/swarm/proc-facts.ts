// Read-only facts about a LIVE process by pid: its executable (comm) and its working directory. Used by the inbox sentinel's
// coordinator ownership (coordinator-keys.ts). Every read is fail-soft: an unreadable fact is null (⇒ the caller does NOT
// expand ownership), never a guess.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";

/** The process's executable name (Linux /proc/<pid>/comm, else `ps -o comm=`). null when unreadable. */
export function procCommand(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { const p = `/proc/${pid}/comm`; if (existsSync(p)) return readFileSync(p, "utf8").trim() || null; } catch { /* not linux */ }
  try { return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim() || null; } catch { return null; }
}

/** The process's working directory (Linux /proc/<pid>/cwd, else lsof). null when unreadable. */
export function procCwd(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { const p = `/proc/${pid}/cwd`; if (existsSync(p)) return readlinkSync(p) || null; } catch { /* not linux */ }
  try {
    const out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 8000 });
    for (const line of out.split("\n")) if (line.startsWith("n")) return line.slice(1).trim() || null;
  } catch { /* lsof unavailable */ }
  return null;
}
