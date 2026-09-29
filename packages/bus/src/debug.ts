import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Append a line to ~/.agenthop/bus-debug.log when AGENTHOP_BUS_DEBUG is set. No-op otherwise. */
export function dbg(msg: string): void {
  if (!process.env.AGENTHOP_BUS_DEBUG) return;
  try {
    appendFileSync(path.join(homedir(), ".agenthop", "bus-debug.log"), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {
    // debugging must never break delivery
  }
}
