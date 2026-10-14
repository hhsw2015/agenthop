/**
 * ledger-io — the ONE write primitive for the ledger db (tern-adoption line ③ B3). Builds a FRESH sqlite db from the
 * deterministic SQL text (pure core) via the `sqlite3` CLI into an O_EXCL-owned temp, then atomically renames it over
 * the destination. No top-level side effects (importable by both the CLI shell and the selftest).
 *
 * Reliability contract (§3 + infra zero-bug ruling):
 *  - CRASH-RECOVERY: a build failure before the rename leaves the PREVIOUS db intact (rename never happened) and cleans
 *    only the temp THIS call created.
 *  - RESTART-IDEMPOTENCY: same SQL + same sqlite3 binary ⇒ byte-identical db (one transaction ⇒ one change-counter bump;
 *    a FRESH 0-byte temp each run, never an append onto a stale db).
 *  - CONCURRENCY (contract: avoided-not-solved; sole writer): the atomic rename publishes a COMPLETE db, so a read-only
 *    reader (Tern) never observes a torn file. The temp is O_EXCL-claimed (a random suffix is not ownership) so a stale
 *    or foreign temp is never silently filled or truncated.
 */
import { execFileSync } from "node:child_process";
import { openSync, closeSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Write `sql` into a fresh O_EXCL-owned temp db via `sqlite3`, then atomically rename it over `dest`. A zero-length file
 * is a valid empty sqlite db, so the owned 0-byte temp is initialized by sqlite3 as it runs the script. On ANY failure
 * the temp (and only this call's temp) is removed and the error rethrown — `dest` is left untouched. `suffixGen` is a
 * test seam for forced-collision coverage; production passes neither it nor a custom `sqlite3`.
 */
export function buildAndPublish(dest: string, sql: string, sqlite3 = "sqlite3", suffixGen: () => string = () => randomBytes(8).toString("hex")): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  let tmp = "";
  // Own the temp inode (O_EXCL). On EEXIST retry a FRESH name; NEVER unlink an existing temp (it may be another's).
  for (let attempt = 0; ; attempt += 1) {
    tmp = `${dest}.tmp-${suffixGen()}`;
    try { closeSync(openSync(tmp, "wx", 0o600)); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 32) continue; throw e; }
  }
  try {
    execFileSync(sqlite3, [tmp], { input: sql, stdio: ["pipe", "ignore", "pipe"] }); // fills the owned 0-byte temp
    renameSync(tmp, dest); // atomic publish of the COMPLETE db (reader never sees a torn file)
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort: only our own temp */ }
    throw e;
  }
}
