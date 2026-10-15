// migrate-coord-inbox — one-shot move of UNREAD mail from a coordinator's OLD inbox to its CURRENT one (#1032 B ②). After the
// coordinator's session id changed (fe0376cd… → c5beaa7c…), late senders left mail in the old box.
//
//   node <tsx> scripts/migrate-coord-inbox.ts --from <old-sid> [--to <new-sid>] [--dry]
//   (--to defaults to SWARM_COORDINATOR resolved via resolveCoordinatorInbox; AH_HOME overrides the home dir)
//
// Scope (frozen): ONLY top-level `<name>.json` messages in the old box. `processed/`, `.pubcred/`, quarantine and `.wtmp-*` temps are
// never touched. A `.claim-<pid>` held by a LIVE process is in flight and is left alone; one held by a DEAD pid is first returned to
// pending — WITHOUT overwriting (r3): if a new message already sits at that name, the claim is kept and reported as a conflict.
//
// Per message (r2, CIA-MIGRATION-CLAIM): (1) CLAIM it — the bus's atomic rename `<name>.json → <name>.json.claim-<our pid>`. If that
// rename fails, another consumer took it first ⇒ `contended`, not moved. Holding the claim, no other consumer can read or publish it.
// (2) Validate; an invalid message is released back to pending and reported (never dropped, never quarantined). (3) Publish into the
// new box with an idempotency key that encodes the SOURCE BOX and the FULL source file name without ambiguity (CIA-MIGRATION-KEY):
// `mig-` + sha256(fromSid + NUL + name)[0..32]. (4) Only after the new box answers published/already, remove our claim. A crash after
// (1) leaves `.claim-<dead pid>`, which the next run recovers; the key makes the re-publish "already", so no message is duplicated.
import { homedir } from "node:os";
import { readdirSync, readFileSync, renameSync, unlinkSync, linkSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { writeInbox, validInboxMsg } from "../packages/bus/src/inbox.js";
import { isValidSessionId } from "../packages/bus/src/send-fallback.js";
import { resolveCoordinatorInbox } from "../packages/bus/src/swarm/coord-inbox.js";

export type MigrateOutcome = { moved: string[]; skippedInvalid: string[]; skippedNonRegular: { name: string; why: string }[]; contended: string[]; conflict: string[]; failed: { name: string; why: string }[] };

/** Release a claim WITHOUT overwriting (CIA-RELEASE-OWN): hard-link the claim back to its pending name (linkSync fails with EEXIST if
 *  another writer has meanwhile put a NEW message at that name — rename would silently replace it), then drop the claim name.
 *  "conflict" ⇒ the name is taken and we KEEP our claim, so both bodies survive. "error" carries the errno. Never throws. */
function releaseNoOverwrite(claimed: string, file: string): { kind: "released" } | { kind: "conflict" } | { kind: "error"; code: string } {
  try { linkSync(claimed, file); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code ?? "error"; return code === "EEXIST" ? { kind: "conflict" } : { kind: "error", code }; }
  try { unlinkSync(claimed); } catch { /* the pending copy exists; the leftover claim name is reclaimed by the next run */ }
  return { kind: "released" };
}

/** Is `p` a plain regular file with exactly one link (a real message)? Directories, symlinks, other types and multiply-linked files
 *  (e.g. a crash-leftover hardlinked temp) are outside the message scope (CIA-SV-P2-3). "gone" ⇒ ENOENT; "error" ⇒ any other errno. */
function regularMessageFile(p: string): { kind: "ok" } | { kind: "nonregular"; why: string } | { kind: "gone" } | { kind: "error"; code: string } {
  let st;
  try { st = lstatSync(p); } catch (e) { const code = (e as NodeJS.ErrnoException).code ?? "error"; return code === "ENOENT" ? { kind: "gone" } : { kind: "error", code }; }
  if (st.isSymbolicLink()) return { kind: "nonregular", why: "symlink" };
  if (!st.isFile()) return { kind: "nonregular", why: st.isDirectory() ? "directory" : "not a regular file" };
  if (st.nlink > 1) return { kind: "nonregular", why: `hard-linked (nlink=${st.nlink})` };
  return { kind: "ok" };
}

/** Dead-claim recovery for the OLD box, with the same no-overwrite rule (the bus core's recoverStaleClaims uses rename, which can
 *  replace a message a writer has since put at the pending name). A conflict keeps the claim; an IO error is reported as FAILED with
 *  its errno (CIA-SV-P2-2) — recovery is never silent. Non-regular claim entries are left untouched and reported. Never throws. */
function recoverDeadClaimsNoOverwrite(dir: string, out: MigrateOutcome): void {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code !== "ENOENT") out.failed.push({ name: "(old box)", why: `cannot list for recovery (${code})` }); return; }
  for (const n of names) {
    const m = n.match(/^(.+\.json)\.claim-(?:disp-)?(\d+)$/);
    if (!m) continue;
    const pid = Number(m[2]);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (alive) continue; // a LIVE holder: in flight, leave it alone
    const claimPath = path.join(dir, n);
    const t = regularMessageFile(claimPath);
    if (t.kind === "nonregular") { out.skippedNonRegular.push({ name: n, why: t.why }); continue; }
    if (t.kind === "error") { out.failed.push({ name: n, why: `recovery: cannot stat dead claim (${t.code})` }); continue; }
    if (t.kind === "gone") continue;
    const rel = releaseNoOverwrite(claimPath, path.join(dir, m[1]!));
    if (rel.kind === "conflict") out.conflict.push(m[1]!);
    else if (rel.kind === "error") out.failed.push({ name: n, why: `recovery: dead claim not returned (${rel.code}); claim kept` });
  }
}

/** The migration's idempotency key: unambiguous over (source box, full file name, MESSAGE BODY), bounded length. Including the body
 *  (CIA-RELEASE-OWN r4) means a re-run's "already" can only mean THE SAME message was already delivered: a different message that
 *  happens to reuse a file name (a dead claim A whose name a new message B took) gets its own key and is delivered too. Pure. */
/** The key for a parsed, validated message exactly as the migrator computes it (the body is the validated message's JSON). */
export function migrationKeyForMessage(fromSid: string, name: string, msg: unknown): string {
  return migrationKey(fromSid, name, JSON.stringify(msg));
}

export function migrationKey(fromSid: string, name: string, body: string): string {
  return `mig-${createHash("sha256").update(`${fromSid}\u0000${name}\u0000${body}`).digest("hex").slice(0, 32)}`;
}

/** Migrate unread top-level messages from `fromSid`'s box to `toSid`'s box. `dry` lists what would move without claiming or writing.
 *  `claimer` is the claim suffix (our pid in production, so a crash leaves a claim the stale rule can recover). `afterClaim` is a
 *  test-only seam that runs inside the read→publish window. */
export function migrateCoordInbox(home: string, fromSid: string, toSid: string, dry = false, claimer: string = String(process.pid), afterClaim?: (name: string) => void): MigrateOutcome {
  if (!isValidSessionId(fromSid) || !isValidSessionId(toSid)) throw new Error("invalid session id");
  if (fromSid === toSid) throw new Error("--from and --to are the same box");
  const src = path.join(home, ".agenthop", "inbox", fromSid);
  const out: MigrateOutcome = { moved: [], skippedInvalid: [], skippedNonRegular: [], contended: [], conflict: [], failed: [] };
  if (!dry) recoverDeadClaimsNoOverwrite(src, out); // a DEAD pid's claim ⇒ back to pending without overwriting; errors are reported
  let names: string[];
  try { names = readdirSync(src); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return out; throw e; }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) { // top-level `.json` only: never `.claim-*`, dirs, or temps
    const file = path.join(src, name);
    const kind = regularMessageFile(file); // CIA-SV-P2-3: claim ONLY a plain single-link file; never rename a directory/symlink
    if (kind.kind === "nonregular") { out.skippedNonRegular.push({ name, why: kind.why }); continue; }
    if (kind.kind === "gone") { out.contended.push(name); continue; }
    if (kind.kind === "error") { out.failed.push({ name, why: `cannot stat (${kind.code})` }); continue; }
    if (dry) {
      let msg; try { msg = validInboxMsg(JSON.parse(readFileSync(file, "utf8"))); } catch { msg = null; }
      (msg ? out.moved : out.skippedInvalid).push(name);
      continue;
    }
    const claimed = `${file}.claim-${claimer}`;
    try { renameSync(file, claimed); }
    catch (e) { // CIA-CLAIM-ERRNO: only a VANISHED source is a lost race; any other errno is a real fault
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") out.contended.push(name);
      else out.failed.push({ name, why: `claim failed (${code ?? "error"}): ${(e as Error).message}` });
      continue;
    }
    afterClaim?.(name); // TEST SEAM (undefined in production): the read→publish window where a competing consumer could act
    let msg;
    try { msg = validInboxMsg(JSON.parse(readFileSync(claimed, "utf8"))); } catch { msg = null; }
    if (!msg) { // invalid ⇒ return it to pending and report (never drop, never quarantine — frozen scope)
      const rel = releaseNoOverwrite(claimed, file);
      if (rel.kind === "released") out.skippedInvalid.push(name);
      else if (rel.kind === "conflict") out.conflict.push(name);
      else out.failed.push({ name, why: `invalid and could not be released (${rel.code})` });
      continue;
    }
    let res: string;
    try { res = writeInbox(home, toSid, msg, migrationKeyForMessage(fromSid, name, msg)); }
    catch (e) { const rel = releaseNoOverwrite(claimed, file); if (rel.kind === "conflict") out.conflict.push(name); out.failed.push({ name, why: (e as Error).message }); continue; }
    if (res !== "published" && res !== "already") { const rel = releaseNoOverwrite(claimed, file); if (rel.kind === "conflict") out.conflict.push(name); out.failed.push({ name, why: `new box answered ${res}` }); continue; }
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
  process.stdout.write(`${dry ? "[dry] would move" : "moved"} ${r.moved.length} → ${toSid}; invalid-left ${r.skippedInvalid.length}; non-regular-left ${r.skippedNonRegular.length}; contended ${r.contended.length}; conflict ${r.conflict.length}; failed ${r.failed.length}\n`);
  for (const f of r.failed) process.stdout.write(`  failed ${f.name}: ${f.why}\n`);
  for (const n of r.skippedInvalid) process.stdout.write(`  left (invalid) ${n}\n`);
  for (const x of r.skippedNonRegular) process.stdout.write(`  left (not a regular message file: ${x.why}) ${x.name}\n`);
  for (const n of r.contended) process.stdout.write(`  contended (claimed by another consumer) ${n}\n`);
  for (const n of r.conflict) process.stdout.write(`  conflict (a new message took the name; our claim kept, both bodies preserved) ${n}\n`);
  if (r.failed.length || r.conflict.length) process.exitCode = 1;
}

if (process.argv[1] && /migrate-coord-inbox\.ts$/.test(process.argv[1])) main();
