// migrate-coord-inbox — one-shot move of UNREAD mail from a coordinator's OLD inbox to its CURRENT one (#1032 B ②). After the
// coordinator's session id changed (fe0376cd… → c5beaa7c…), late senders left mail in the old box.
//
//   node <tsx> scripts/migrate-coord-inbox.ts --from <old-sid> [--to <new-sid>] [--dry]
//   (--to defaults to SWARM_COORDINATOR resolved via resolveCoordinatorInbox; AH_HOME overrides the home dir)
//
// Scope (frozen): ONLY top-level `<name>.json` messages in the old box. `processed/`, `.pubcred/`, quarantine, `.claim-*` (in-flight
// or stranded — recoverStaleClaims owns those) and `.wtmp-*` temps are never touched.
//
// Idempotent + crash-safe, per message: (1) re-publish into the new box through writeInbox with an idempotency key derived from the
// SOURCE FILE NAME (`mig-<name>`), so a re-run after a crash between steps publishes at most once; (2) only after the new box reports
// published/already, remove the source. A message that fails validation is left in place and reported (never dropped). Re-running
// after a full success is a no-op.
import { homedir } from "node:os";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeInbox, validInboxMsg } from "../packages/bus/src/inbox.js";
import { isValidSessionId } from "../packages/bus/src/send-fallback.js";
import { resolveCoordinatorInbox } from "../packages/bus/src/swarm/coord-inbox.js";

export type MigrateOutcome = { moved: string[]; skippedInvalid: string[]; failed: { name: string; why: string }[] };

/** Migrate unread top-level messages from `fromSid`'s box to `toSid`'s box. `dry` lists what would move without writing. */
export function migrateCoordInbox(home: string, fromSid: string, toSid: string, dry = false): MigrateOutcome {
  if (!isValidSessionId(fromSid) || !isValidSessionId(toSid)) throw new Error("invalid session id");
  if (fromSid === toSid) throw new Error("--from and --to are the same box");
  const src = path.join(home, ".agenthop", "inbox", fromSid);
  const out: MigrateOutcome = { moved: [], skippedInvalid: [], failed: [] };
  let names: string[];
  try { names = readdirSync(src); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return out; throw e; }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) { // top-level `.json` only: never `.claim-*`, dirs, or temps
    const file = path.join(src, name);
    let msg;
    try { msg = validInboxMsg(JSON.parse(readFileSync(file, "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; msg = null; } // vanished (claimed meanwhile) ⇒ not ours
    if (!msg) { out.skippedInvalid.push(name); continue; }
    if (dry) { out.moved.push(name); continue; }
    const key = `mig-${name.replace(/\.json$/, "")}`.slice(0, 120);
    let res: string;
    try { res = writeInbox(home, toSid, msg, key); } catch (e) { out.failed.push({ name, why: (e as Error).message }); continue; }
    if (res !== "published" && res !== "already") { out.failed.push({ name, why: `new box answered ${res}` }); continue; } // keep the source
    try { unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") { out.failed.push({ name, why: `published but source not removed: ${(e as Error).message}` }); continue; } }
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
  const r = migrateCoordInbox(home, fromSid!, toSid!, a.includes("--dry"));
  process.stdout.write(`${a.includes("--dry") ? "[dry] would move" : "moved"} ${r.moved.length} → ${toSid}; invalid-left ${r.skippedInvalid.length}; failed ${r.failed.length}\n`);
  for (const f of r.failed) process.stdout.write(`  failed ${f.name}: ${f.why}\n`);
  for (const n of r.skippedInvalid) process.stdout.write(`  left (invalid) ${n}\n`);
  if (r.failed.length) process.exitCode = 1;
}

if (process.argv[1] && /migrate-coord-inbox\.ts$/.test(process.argv[1])) main();
