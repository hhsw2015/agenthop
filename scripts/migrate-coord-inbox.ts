// migrate-coord-inbox — one-shot move of UNREAD mail from a coordinator's OLD inbox to its CURRENT one (#1032 B ②). After the
// coordinator's session id changed (fe0376cd… → c5beaa7c…), late senders left mail in the old box.
//
//   node <tsx> scripts/migrate-coord-inbox.ts --from <old-sid> [--to <new-sid>] [--dry]
//   (--to defaults to SWARM_COORDINATOR resolved via resolveCoordinatorInbox; AH_HOME overrides the home dir)
//
// Scope (frozen): ONLY top-level `<name>.json` messages in the old box. `processed/`, `.pubcred/`, quarantine and `.wtmp-*` temps are
// never touched. A `.claim-<pid>` held by a LIVE process is in flight and is left alone; one held by a DEAD pid is first returned to
// pending by the bus's own stale rule (recoverStaleClaims) and then migrated like any other unread message.
//
// Per message (r2, CIA-MIGRATION-CLAIM): (1) CLAIM it — the bus's atomic rename `<name>.json → <name>.json.claim-<our pid>`. If that
// rename fails, another consumer took it first ⇒ `contended`, not moved. Holding the claim, no other consumer can read or publish it.
// (2) Validate; an invalid message is released back to pending and reported (never dropped, never quarantined). (3) Publish into the
// new box with an idempotency key that encodes the SOURCE BOX and the FULL source file name without ambiguity (CIA-MIGRATION-KEY):
// `mig-` + sha256(fromSid + NUL + name)[0..32]. (4) Only after the new box answers published/already, remove our claim. A crash after
// (1) leaves `.claim-<dead pid>`, which the next run recovers; the key makes the re-publish "already", so no message is duplicated.
import { homedir } from "node:os";
import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { writeInbox, validInboxMsg, recoverStaleClaims } from "../packages/bus/src/inbox.js";
import { isValidSessionId } from "../packages/bus/src/send-fallback.js";
import { resolveCoordinatorInbox } from "../packages/bus/src/swarm/coord-inbox.js";

export type MigrateOutcome = { moved: string[]; skippedInvalid: string[]; contended: string[]; failed: { name: string; why: string }[] };

/** The migration's idempotency key for one source message: unambiguous over (source box, full file name), bounded length. Pure. */
export function migrationKey(fromSid: string, name: string): string {
  return `mig-${createHash("sha256").update(`${fromSid}\u0000${name}`).digest("hex").slice(0, 32)}`;
}

/** Migrate unread top-level messages from `fromSid`'s box to `toSid`'s box. `dry` lists what would move without claiming or writing.
 *  `claimer` is the claim suffix (our pid in production, so a crash leaves a claim the stale rule can recover). `afterClaim` is a
 *  test-only seam that runs inside the read→publish window. */
export function migrateCoordInbox(home: string, fromSid: string, toSid: string, dry = false, claimer: string = String(process.pid), afterClaim?: (name: string) => void): MigrateOutcome {
  if (!isValidSessionId(fromSid) || !isValidSessionId(toSid)) throw new Error("invalid session id");
  if (fromSid === toSid) throw new Error("--from and --to are the same box");
  const src = path.join(home, ".agenthop", "inbox", fromSid);
  const out: MigrateOutcome = { moved: [], skippedInvalid: [], contended: [], failed: [] };
  if (!dry) recoverStaleClaims(home, [fromSid]); // a DEAD pid's claim (incl. our own crashed run) ⇒ back to pending; a live one is left alone
  let names: string[];
  try { names = readdirSync(src); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return out; throw e; }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) { // top-level `.json` only: never `.claim-*`, dirs, or temps
    const file = path.join(src, name);
    if (dry) {
      let msg; try { msg = validInboxMsg(JSON.parse(readFileSync(file, "utf8"))); } catch { msg = null; }
      (msg ? out.moved : out.skippedInvalid).push(name);
      continue;
    }
    const claimed = `${file}.claim-${claimer}`;
    try { renameSync(file, claimed); } catch { out.contended.push(name); continue; } // another consumer took it first ⇒ not ours
    afterClaim?.(name); // TEST SEAM (undefined in production): the read→publish window where a competing consumer could act
    let msg;
    try { msg = validInboxMsg(JSON.parse(readFileSync(claimed, "utf8"))); } catch { msg = null; }
    if (!msg) { // invalid ⇒ return it to pending and report (never drop, never quarantine — frozen scope)
      try { renameSync(claimed, file); out.skippedInvalid.push(name); } catch (e) { out.failed.push({ name, why: `invalid and could not be released: ${(e as Error).message}` }); }
      continue;
    }
    let res: string;
    try { res = writeInbox(home, toSid, msg, migrationKey(fromSid, name)); }
    catch (e) { try { renameSync(claimed, file); } catch { /* the stale rule returns it after we exit */ } out.failed.push({ name, why: (e as Error).message }); continue; }
    if (res !== "published" && res !== "already") { try { renameSync(claimed, file); } catch { /* stale rule */ } out.failed.push({ name, why: `new box answered ${res}` }); continue; }
    try { unlinkSync(claimed); } catch (e) { out.failed.push({ name, why: `published but our claim not removed: ${(e as Error).message}` }); continue; }
    out.moved.push(name);
  }
  return out;
}

function main(): void {
  const a = process.argv.slice(2);
  const opt = (f: string): string | undefined => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const fail = (m: string): never => { process.stderr.write(`migrate-coord-inbox: ${m}\n`); process.exit(2); };
  const home = process.env.AH_HOME || homedir();
  const fromSid = opt("--from") ?? fail("usage: migrate-coord-inbox --from <old-sid> [--to <new-sid>] [--dry]");
  let toSid = opt("--to");
  if (!toSid) { try { toSid = resolveCoordinatorInbox(home, process.env); } catch (e) { fail((e as Error).message); } }
  const dry = a.includes("--dry");
  const r = migrateCoordInbox(home, fromSid!, toSid!, dry);
  process.stdout.write(`${dry ? "[dry] would move" : "moved"} ${r.moved.length} → ${toSid}; invalid-left ${r.skippedInvalid.length}; contended ${r.contended.length}; failed ${r.failed.length}\n`);
  for (const f of r.failed) process.stdout.write(`  failed ${f.name}: ${f.why}\n`);
  for (const n of r.skippedInvalid) process.stdout.write(`  left (invalid) ${n}\n`);
  for (const n of r.contended) process.stdout.write(`  contended (claimed by another consumer) ${n}\n`);
  if (r.failed.length) process.exitCode = 1;
}

if (process.argv[1] && /migrate-coord-inbox\.ts$/.test(process.argv[1])) main();
