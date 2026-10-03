// whois — the v1 acceptance stand-in for `agenthop whois <id>` (bus-identity-design.md §4, batch C).
// A thin tsx-runnable shell over the frozen pure kernel; the publish-level CLI subcommand (bin.ts, help,
// README bilingual) lands as its own batch after the implementation batch passes review.
//
//   tsx scripts/whois.ts <any id|handle|pid|prefix>
//   BUS_IDENTITY_DIR=/path tsx scripts/whois.ts <id>     # read a specific alias-log dir
//
// It reads the on-disk alias-log, folds it, and locates the entity. Liveness is PROBED now (pid), never
// read from a stored bit — identity recorded, liveness probed, two faces never merged.
import { buildProjection, identityDir, liveness, readIdentityLog, whois, type IdentityEntity, type ProbeFact } from "../packages/bus/src/bus-identity.js";

const RELAY_FRESH_SEC = 120; // a relay observe newer than this is "reported", older is "stale" (display-only).

function probeFacts(ent: IdentityEntity): ProbeFact[] {
  const now = Math.floor(Date.now() / 1000);
  const latest = ent.incarnations[ent.incarnations.length - 1];
  if (!latest) return [];
  const facts: ProbeFact[] = [];
  const probe = (pid: number): "present" | "absent" | "eperm" => {
    try { process.kill(pid, 0); return "present"; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" ? "eperm" : "absent"; }
  };
  if (latest.scope === "relay") {
    // P3-1: freshness from the recorded time, not a hardcoded "stale". Both map to suspected in the kernel
    // (a relay target is never OS-probed) — this is display-only.
    const ageSec = now - latest.lastSeenSec;
    facts.push({ target: "remote", result: ageSec <= RELAY_FRESH_SEC ? "reported" : "stale", at: now });
    return facts;
  }
  // v1 cannot verify a process birth at query time, so birthOk is left undefined — the policy then treats a
  // raw pid present/absent conservatively (suspected), never a confident alive/dead.
  if (latest.hostPid != null) facts.push({ target: "hostPid", result: probe(latest.hostPid), at: now, pid: latest.hostPid });
  if (latest.busPid != null) facts.push({ target: "busPid", result: probe(latest.busPid), at: now, pid: latest.busPid });
  return facts;
}

function render(ent: IdentityEntity, collisionOn?: string): void {
  console.log(`entity ${ent.entityId}   tool=${ent.tool ?? "?"}  cwd=${ent.cwd ?? "?"}`);
  console.log(`  identity (recorded):`);
  ent.incarnations.forEach((inc, i) => {
    const forms = inc.claims.map((c) => `${c.form}=${c.value}[${c.confidence}${c.superseded ? ",retired" : ""}]`).join(" ");
    console.log(`    n${i}: ${forms}${inc.busPid != null ? ` busPid=${inc.busPid}` : ""}${inc.hostPid != null ? ` hostPid=${inc.hostPid}` : ""} scope=${inc.scope}`);
  });
  if (ent.possibleRelated.length) console.log(`    possible-related: ${ent.possibleRelated.join(", ")}`);
  const lv = liveness(probeFacts(ent));
  console.log(`  liveness (probed now): ${lv.state} — ${lv.reason}`);
  if (collisionOn) console.log(`  collision: native ${collisionOn} is shared by multiple entities (see 'whois ${collisionOn}')`);
}

function main(): void {
  const id = process.argv[2];
  if (!id) { console.error("usage: tsx scripts/whois.ts <id|handle|pid|prefix>"); process.exit(2); }
  const home = process.env.HOME || "";
  const log = readIdentityLog(home);
  if (log.status === "error") console.error(`WARNING: alias-log in ${identityDir(home)} is unreadable (errno ${log.errorCode}) — the answer is INCOMPLETE, not "never seen"`);
  if (log.corruption.length) console.error(`WARNING: ${log.corruption.length} corrupt committed record(s) in ${identityDir(home)} — projection may be incomplete (rebuild advised)`);
  const proj = buildProjection(log.events, log.corruption, { incomplete: log.status === "error" });
  if (proj.conflicts.length) console.error(`WARNING: ${proj.conflicts.length} conflicting event id(s) rejected during replay — projection may be incomplete`);
  const res = whois(proj, id);
  if (res.kind === "not-seen") {
    const why = proj.incomplete ? "projection is incomplete (see warnings above) — this may be a read gap, not a true absence" : "no alias-log entry; identity logging may be off, or this id was never observed";
    console.log(`not seen: ${id}  (${why})`);
    return;
  }
  if (res.kind === "candidates") {
    console.log(`"${id}" matches ${res.entities.length} entities (collision / shared native) — not resolved to one:`);
    for (const e of res.entities) render(e);
    return;
  }
  if (res.kind === "pid") {
    console.log(`"${id}" matched by PID only — unverified (a pid can be reused); probe to confirm. ${res.entities.length} historical candidate(s):`);
    for (const e of res.entities) render(e);
    return;
  }
  render(res.entity, res.collisionOn);
}

main();
