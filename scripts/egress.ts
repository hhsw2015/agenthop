// egress — a one-command reader over the user-auditable egress ledger (docs/swarm/egress-ledger-brief.md; gstack borrow ②).
// Thin IO glue over the SIGNED pure core (readEgressLedger / verifyEgressChain): the ledger is RECORD-ONLY + fail-open, so this
// reader never writes, never intercepts, and shows only what was recorded (dest-HOST + byte-MAGNITUDE, never payload/keys).
//
//   egress list              one row per egress event (intent paired with its result; unpaired ⇒ "pending")
//   egress verify            walk the hash chain: OK (+ pending count) ⇒ exit 0; a crash-truncated tail ⇒ exit 0 (recoverable,
//                            non-tamper); a chain-break / gap / interior parse fault ⇒ TAMPER ⇒ exit 1
//
// AGENTHOP_EGRESS_DIR overrides the ledger dir (tests). Exit: 0 ok, 1 tamper/unexpected, 2 usage. ASCII only.
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { egressDir, readEgressLedger, readEgressRaw } from "../packages/bus/src/swarm/egress-ledger-store.js";
import { verifyEgressChain, type EgressEntry, type EgressIntent, type EgressResult } from "../packages/bus/src/swarm/egress-ledger.js";

export type Query = { mode: "list" } | { mode: "verify" } | { mode: "usage"; error?: string };

/** Classify argv (already sliced past node/script) into a query. Pure (selftested). */
export function classifyArgs(argv: readonly string[]): Query {
  const first = argv[0];
  if (first === "list") return argv.length === 1 ? { mode: "list" } : { mode: "usage", error: `list takes no args` };
  if (first === "verify") return argv.length === 1 ? { mode: "verify" } : { mode: "usage", error: `verify takes no args` };
  if (!first) return { mode: "usage" };
  return { mode: "usage", error: `unknown command ${JSON.stringify(first)}` };
}

/** Local time with offset (logs are for humans — not UTC), compact. */
function stamp(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? "+" : "-"; const oh = p(Math.floor(Math.abs(off) / 60)); const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}${om}`;
}

/** Fold the entry stream into one row per egress EVENT (intent + its result), in intent order. Pure (selftested). */
export function foldEvents(entries: readonly EgressEntry[]): string[] {
  const intents = new Map<string, EgressIntent>();
  const results = new Map<string, EgressResult>();
  const order: string[] = [];
  for (const e of entries) {
    if (e.kind === "intent") { if (!intents.has(e.eventId)) order.push(e.eventId); intents.set(e.eventId, e); }
    else results.set(e.eventId, e);
  }
  return order.map((id) => {
    const i = intents.get(id)!; const r = results.get(id);
    const res = r ? `${r.byteMagnitude} ${r.outcome}` : "pending";
    return `${stamp(i.tsSec)}  ${i.initiatorSid}  ${i.callFace}  ${i.destHost}  ${res}`;
  });
}

function main(): void {
  const q = classifyArgs(process.argv.slice(2));
  if (q.mode === "usage") {
    console.error(`${q.error ? `egress: ${q.error}\n` : ""}usage: egress list | egress verify`);
    process.exitCode = 2; return;
  }
  const dir = egressDir(homedir());

  if (q.mode === "list") {
    let entries: EgressEntry[];
    try { entries = readEgressLedger(dir); } // propagates an unreadable fault (never a false-complete list — EL-1)
    catch (e) { console.error(`egress: cannot read ledger ${dir}: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; return; }
    const rows = foldEvents(entries);
    console.log(rows.length === 0 ? "(no egress recorded)" : `time  initiator-sid  call-face  dest-host  bytes/outcome\n${rows.join("\n")}`);
    return;
  }
  // verify walks the RAW entries (corrupt ⇒ null ⇒ flagged; an unreadable/non-regular entry THROWS ⇒ reported, never a clean
  // "OK" over a shorter survivor set — EL-1). An unreadable ledger is UNKNOWN, which for an integrity check is exit 1, not 0.
  let raw: unknown[];
  try { raw = readEgressRaw(dir); }
  catch (e) { console.error(`egress: cannot verify ledger ${dir} (unreadable entry): ${e instanceof Error ? e.message : e}`); process.exitCode = 1; return; }
  const v = verifyEgressChain(raw);
  if (v.ok) {
    console.log(`OK ${v.count} entries${v.pending.length ? `, ${v.pending.length} pending (intent without result)` : ""}`);
    return;
  }
  if (v.kind === "incomplete-tail") { console.log(`OK up to seq ${v.seq - 1}; last entry incomplete (crash mid-append, recoverable): ${v.reason}`); return; }
  console.error(`TAMPER: ${v.kind} at seq ${v.seq}: ${v.reason}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
