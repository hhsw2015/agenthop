// whois — the v1 daily-usable tool for `agenthop whois <id...>` (bus-identity-design.md §4, batch C v1).
// A tsx-runnable shell over the frozen pure kernel; the publish-level CLI subcommand (bin.ts, help, README
// bilingual) is still its own later batch — this does NOT touch the publish surface.
//
//   tsx scripts/whois.ts <id|handle|pid|prefix> [<id> ...]   # batch: one query per argument
//   tsx scripts/whois.ts --json <id> [<id> ...]              # machine-readable (viz / scripts)
//   BUS_IDENTITY_DIR=/path tsx scripts/whois.ts <id>         # read a specific alias-log dir
//
// Three faces, never merged (§4.2): identity (recorded), reachability (roster), liveness (PROBED now vs
// INFERRED). Identity is recorded; liveness is probed at query time — a stored alive bit would just go stale.
import { buildProjection, identityDir, liveness, readIdentityLog, whois, type IdentityEntity, type ProbeFact, type Projection, type Scope, type WhoisResult } from "../packages/bus/src/bus-identity.js";

const RELAY_FRESH_SEC = 120; // a relay observe newer than this is "reported-recent", older is "stale" (inferred, not probed).

/** Live pid probes for the entity's latest incarnation. v1 has no birth to verify, so present/absent stays
 *  conservative in the kernel policy (never a confident alive/dead without a verified birth). */
export function probeFacts(ent: IdentityEntity, now = Math.floor(Date.now() / 1000)): ProbeFact[] {
  const latest = ent.incarnations[ent.incarnations.length - 1];
  if (!latest) return [];
  const facts: ProbeFact[] = [];
  const probe = (pid: number): "present" | "absent" | "eperm" => {
    try { process.kill(pid, 0); return "present"; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" ? "eperm" : "absent"; }
  };
  if (latest.scope === "relay") {
    facts.push({ target: "remote", result: now - latest.lastSeenSec <= RELAY_FRESH_SEC ? "reported" : "stale", at: now });
    return facts;
  }
  if (latest.hostPid != null) facts.push({ target: "hostPid", result: probe(latest.hostPid), at: now, pid: latest.hostPid });
  if (latest.busPid != null) facts.push({ target: "busPid", result: probe(latest.busPid), at: now, pid: latest.busPid });
  return facts;
}

/** Reachability (§4.2): the reply-to candidate = the latest incarnation's hard, non-superseded handle. v1
 *  does NOT verify it against the live roster (that wiring is a later batch); labelled honestly as recorded. */
export function replyTo(ent: IdentityEntity): { handle: string | null; scope: Scope } {
  const inc = ent.incarnations[ent.incarnations.length - 1];
  const h = inc?.claims.find((c) => c.form === "handle" && c.confidence === "hard" && !c.superseded);
  return { handle: h?.value ?? null, scope: inc?.scope ?? "local" };
}

type AliasView = { form: string; value: string; confidence: string; provenance: string; superseded: boolean; incarnation: number };
/** Structured view of one entity's three faces — the shape emitted by --json and rendered by the text view. */
export function entityView(ent: IdentityEntity, now = Math.floor(Date.now() / 1000)): {
  entityId: string; tool: string | null; cwd: string | null;
  identity: { incarnations: Array<{ index: number; run?: string; native?: string; busPid?: number; hostPid?: number; scope: Scope; lastSeenSec: number }>; aliases: AliasView[]; possibleRelated: string[] };
  reachability: { replyTo: string | null; scope: Scope; verified: false };
  liveness: ReturnType<typeof liveness> & { lastActivitySecAgo: number | null };
} {
  const aliases: AliasView[] = [];
  const incs = ent.incarnations.map((inc, index) => {
    for (const c of inc.claims) aliases.push({ form: c.form, value: c.value, confidence: c.confidence, provenance: c.provenance, superseded: !!c.superseded, incarnation: index });
    const run = inc.claims.find((c) => c.form === "run" && !c.superseded)?.value;
    const native = inc.claims.find((c) => c.form === "native" && c.confidence === "hard" && !c.superseded)?.value;
    return { index, run, native, busPid: inc.busPid, hostPid: inc.hostPid, scope: inc.scope, lastSeenSec: inc.lastSeenSec };
  });
  const latest = ent.incarnations[ent.incarnations.length - 1];
  const lv = liveness(probeFacts(ent, now));
  const r = replyTo(ent);
  return {
    entityId: ent.entityId, tool: ent.tool ?? null, cwd: ent.cwd ?? null,
    identity: { incarnations: incs, aliases, possibleRelated: ent.possibleRelated },
    reachability: { replyTo: r.handle, scope: r.scope, verified: false },
    liveness: { ...lv, lastActivitySecAgo: latest ? now - latest.lastSeenSec : null },
  };
}

function renderEntity(ent: IdentityEntity, collisionOn?: string): void {
  const v = entityView(ent);
  console.log(`entity ${v.entityId}   tool=${v.tool ?? "?"}  cwd=${v.cwd ?? "?"}`);
  console.log(`  identity (recorded):`);
  console.log(`    incarnations: ${v.identity.incarnations.map((i) => `n${i.index}(run=${i.run ?? "?"} native=${i.native ?? "?"}${i.busPid != null ? ` busPid=${i.busPid}` : ""}${i.hostPid != null ? ` hostPid=${i.hostPid}` : ""} scope=${i.scope})`).join(" → ")}`);
  console.log(`    aliases: ${v.identity.aliases.map((a) => `${a.form}=${a.value}[${a.confidence}${a.superseded ? ",retired" : ""}](${a.provenance},n${a.incarnation})`).join(" ")}`);
  if (v.identity.possibleRelated.length) console.log(`    possible-related: ${v.identity.possibleRelated.join(", ")}`);
  console.log(`  reachability (recorded; roster check not wired in v1):`);
  console.log(`    reply-to: ${v.reachability.replyTo ?? "none"}  scope=${v.reachability.scope}`);
  console.log(`  liveness (probed now): ${v.liveness.state} — ${v.liveness.reason}`);
  for (const f of v.liveness.evidence) {
    const probed = f.target === "remote" ? "[inferred: announce age]" : "[probed: kill(0), birth unverified in v1]";
    console.log(`    ${f.target}${f.pid != null ? ` ${f.pid}` : ""}: ${f.result}  ${probed}`);
  }
  console.log(`    last activity: ${v.liveness.lastActivitySecAgo == null ? "unknown" : `${v.liveness.lastActivitySecAgo}s ago`}  [inferred: recorded lastSeen, not verified output]`);
  if (collisionOn) console.log(`  collision: native ${collisionOn} is shared by multiple entities (see 'whois ${collisionOn}')`);
}

/** The result of one query, as plain data (for --json). */
export function queryJson(proj: Projection, id: string): { query: string; kind: WhoisResult["kind"]; collisionOn?: string; entities: ReturnType<typeof entityView>[]; incomplete: boolean } {
  const res = whois(proj, id);
  const ents = res.kind === "entity" ? [res.entity] : res.kind === "candidates" || res.kind === "pid" ? res.entities : [];
  return { query: id, kind: res.kind, ...(res.kind === "entity" && res.collisionOn ? { collisionOn: res.collisionOn } : {}), entities: ents.map((e) => entityView(e)), incomplete: proj.incomplete };
}

function renderResult(id: string, proj: Projection): void {
  const res = whois(proj, id);
  console.log(`# whois ${id}`);
  if (res.kind === "not-seen") {
    console.log(`not seen: ${id}  (${proj.incomplete ? "projection is incomplete (see warnings) — may be a read gap, not a true absence" : "no alias-log entry; identity logging may be off, or this id was never observed"})`);
    return;
  }
  if (res.kind === "candidates") { console.log(`"${id}" → ${res.entities.length} candidates (collision / shared native / run drift) — not resolved to one:`); for (const e of res.entities) renderEntity(e); return; }
  if (res.kind === "pid") { console.log(`"${id}" matched by PID only — unverified (a pid can be reused); probe to confirm. ${res.entities.length} historical candidate(s):`); for (const e of res.entities) renderEntity(e); return; }
  renderEntity(res.entity, res.collisionOn);
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const ids = args.filter((a) => a !== "--json");
  if (ids.length === 0) { console.error("usage: tsx scripts/whois.ts [--json] <id|handle|pid|prefix> [<id> ...]"); process.exit(2); }
  const home = process.env.HOME || "";
  const log = readIdentityLog(home);
  if (log.status === "error") console.error(`WARNING: alias-log in ${identityDir(home)} is unreadable (errno ${log.errorCode}) — answers INCOMPLETE, not "never seen"`);
  if (log.corruption.length) console.error(`WARNING: ${log.corruption.length} corrupt committed record(s) in ${identityDir(home)} — projection may be incomplete`);
  const proj = buildProjection(log.events, log.corruption, { incomplete: log.status === "error" });
  if (proj.conflicts.length) console.error(`WARNING: ${proj.conflicts.length} conflicting event id(s) rejected during replay`);
  if (json) { console.log(JSON.stringify({ results: ids.map((id) => queryJson(proj, id)) }, null, 2)); return; }
  ids.forEach((id, i) => { if (i) console.log(""); renderResult(id, proj); });
}

// CLI entry only when executed directly — importing this module for tests triggers no side effects (msglog P1).
if (process.argv[1] && /(^|\/)whois\.ts$/.test(process.argv[1])) main();
