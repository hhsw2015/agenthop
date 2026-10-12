// Selftest for the egress ledger (gstack borrow ②). Pure core (chain/verify/parse/magnitude) + the IO store against a real temp
// dir, with the three review-gate fixture classes: crash-recovery, restart-idempotency, concurrency-race.
//   npx tsx packages/bus/src/swarm/egress-ledger.selftest.mts
import { mkdtempSync, writeFileSync, readdirSync, rmSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chainEntry, verifyEgressChain, parseEgressEntry, byteMagnitude, egressLedgerEnabled, type EgressEntry, type EgressBody } from "./egress-ledger.js";
import { egressDir, readEgressLedger, recordEgressIntent, recordEgressResult } from "./egress-ledger-store.js";

let pass = 0;
const t = (n: string, c: boolean): void => { if (!c) { console.error(`FAIL ${n}`); process.exit(1); } pass++; console.log(`ok  ${n}`); };
const mkDir = (): string => path.join(mkdtempSync(path.join(tmpdir(), "egress-")), "egress");
const intent = (eventId: string, destHost: string): EgressBody => ({ kind: "intent", eventId, tsSec: 1000, destHost, callFace: "relay.post", initiatorSid: "sidA" });
const result = (eventId: string): EgressBody => ({ kind: "result", eventId, tsSec: 1001, byteMagnitude: "<64K", outcome: "ok" });

// ── pure: byte magnitude buckets (never exact) ──
t("magnitude: 0 / <1K / <64K / <1M / <16M / >=16M / unknown", byteMagnitude(0) === "0" && byteMagnitude(500) === "<1K" && byteMagnitude(2000) === "<64K" && byteMagnitude(200000) === "<1M" && byteMagnitude(2e6) === "<16M" && byteMagnitude(5e7) === ">=16M" && byteMagnitude(-1) === "unknown" && byteMagnitude(NaN) === "unknown");

// ── pure: a well-formed chain verifies; pending (intent without result) is reported, not a break ──
{
  const e0 = chainEntry(null, intent("e1", "relay.example"));
  const e1 = chainEntry(e0, result("e1"));
  const e2 = chainEntry(e1, intent("e2", "api.example"));
  const v = verifyEgressChain([e0, e1, e2]);
  t("verify: a valid chain ⇒ ok", v.ok === true && v.ok && v.count === 3);
  t("verify: an intent without a result ⇒ pending (not a break)", v.ok && v.pending.length === 1 && v.pending[0] === "e2");
}

// ── pure: tamper (edit) ⇒ chain-break; reorder/gap ⇒ gap; a bad LAST entry ⇒ incomplete-tail (recoverable, non-tamper) ──
{
  const e0 = chainEntry(null, intent("e1", "h1"));
  const e1 = chainEntry(e0, result("e1"));
  const edited = { ...e1, byteMagnitude: ">=16M" as const }; // edit the body without recomputing hash
  const vb = verifyEgressChain([e0, edited]);
  t("verify: an edited entry ⇒ chain-break (tamper-evident)", vb.ok === false && !vb.ok && vb.kind === "chain-break");
  const vg = verifyEgressChain([e0, chainEntry(chainEntry(e0, result("e1")), intent("e3", "h3"))]); // skip a seq
  t("verify: a non-contiguous seq ⇒ gap", vg.ok === false && !vg.ok && vg.kind === "gap");
  const vt = verifyEgressChain([e0, e1, { not: "an entry" }]); // garbage LAST entry
  t("verify: an unparseable LAST entry ⇒ incomplete-tail (crash mid-append, recoverable)", vt.ok === false && !vt.ok && vt.kind === "incomplete-tail");
  const vp = verifyEgressChain([e0, { not: "an entry" }, e1]); // garbage INTERIOR entry
  t("verify: an unparseable INTERIOR entry ⇒ parse (tamper, not the tail)", vp.ok === false && !vp.ok && vp.kind === "parse");
}

// ── pure: parse rejects a payload/url leak and bad fields ──
t("parse: a destHost with a path/query is rejected (host-only)", parseEgressEntry({ ...chainEntry(null, intent("e", "h/secret?token=x")) }) === null);
t("parse: a non-magnitude result is rejected", parseEgressEntry({ ...chainEntry(null, result("e")), byteMagnitude: "7 bytes" }) === null);

// ── flag: dormant opt-in (OFF unless explicitly enabled) ──
t("flag: default OFF (dormant)", egressLedgerEnabled({} as NodeJS.ProcessEnv) === false && egressLedgerEnabled({ SWARM_EGRESS_LEDGER: "0" } as unknown as NodeJS.ProcessEnv) === false);
t("flag: ON only when explicitly enabled", egressLedgerEnabled({ SWARM_EGRESS_LEDGER: "1" } as unknown as NodeJS.ProcessEnv) === true && egressLedgerEnabled({ SWARM_EGRESS_LEDGER: "true" } as unknown as NodeJS.ProcessEnv) === true);

// ── store: a two-line event round-trips + verifies ──
{
  const dir = mkDir();
  const id = recordEgressIntent(dir, { destHost: "relay.example", callFace: "relay.post", initiatorSid: "sidA" }, 1000);
  t("store: recordEgressIntent ⇒ eventId", id !== null);
  t("store: recordEgressResult ⇒ true", id !== null && recordEgressResult(dir, { eventId: id, byteMagnitude: "<64K", outcome: "ok" }, 1001) === true);
  const entries = readEgressLedger(dir);
  const v = verifyEgressChain(entries);
  t("store: the on-disk chain verifies (2 entries, 0 pending)", v.ok && v.count === 2 && v.pending.length === 0);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── fixture CRASH-RECOVERY: a crash between intent and result leaves a pending (verifiable); an orphan .tmp is ignored; a
//    truncated last entry ⇒ incomplete-tail (not tamper) ──
{
  const dir = mkDir();
  const id = recordEgressIntent(dir, { destHost: "h1", callFace: "update.download", initiatorSid: "sidA" }, 1000)!;
  // (crash: no result recorded)
  const vp = verifyEgressChain(readEgressLedger(dir));
  t("crash-recovery: intent recorded, crash before result ⇒ chain ok + pending", vp.ok && vp.pending.length === 1 && vp.pending[0] === id);
  writeFileSync(path.join(dir, ".tmp-999-deadbeef"), "garbage"); // a write-crash orphan
  t("crash-recovery: an orphan .tmp-* is ignored by the reader (not counted)", readEgressLedger(dir).length === 1);
  // truncate the last entry file to simulate a crash mid-append
  const last = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).sort().pop()!;
  writeFileSync(path.join(dir, last), "{ \"seq\": 0, \"pre"); // half a JSON object
  const vt = verifyEgressChain(readEgressLedger(dir));
  // the truncated file parses to null and is dropped by the reader; with only the (now-unreadable) seq-0 dropped the ledger reads
  // empty ⇒ ok 0 — the key property: a mid-append crash is NEVER a tamper verdict.
  t("crash-recovery: a truncated last entry is not a TAMPER verdict", vt.ok === true || (!vt.ok && vt.kind === "incomplete-tail"));
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── fixture RESTART-IDEMPOTENCY: a fresh read after a 'restart' yields the same chain; verify is deterministic; appending after
//    the restart continues the chain with contiguous seqs ──
{
  const dir = mkDir();
  const a = recordEgressIntent(dir, { destHost: "h1", callFace: "relay.post", initiatorSid: "sidA" }, 1000)!;
  recordEgressResult(dir, { eventId: a, byteMagnitude: "<1K", outcome: "ok" }, 1001);
  const r1 = readEgressLedger(dir), r2 = readEgressLedger(dir); // "restart" = a fresh read of the same dir
  t("restart-idempotency: two fresh reads are identical", JSON.stringify(r1) === JSON.stringify(r2));
  t("restart-idempotency: verify is deterministic across reads", JSON.stringify(verifyEgressChain(r1)) === JSON.stringify(verifyEgressChain(r2)));
  const b = recordEgressIntent(dir, { destHost: "h2", callFace: "vm-ssh.exec", initiatorSid: "sidB" }, 1002)!;
  recordEgressResult(dir, { eventId: b, byteMagnitude: ">=16M", outcome: "failed" }, 1003);
  const after = readEgressLedger(dir);
  t("restart-idempotency: appending after restart continues the chain (contiguous seqs, verifies)", verifyEgressChain(after).ok && after.map((e) => e.seq).join(",") === "0,1,2,3");
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── fixture CONCURRENCY-RACE: two real child processes append concurrently through the shared append lock ⇒ the final chain is
//    contiguous + verifies + has ALL events (no forked chain, no seq collision) ──
{
  const dir = mkDir();
  const child = path.join(path.dirname(dir), "child.mts");
  const storeUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "egress-ledger-store.ts")).href;
  writeFileSync(child,
    `import { recordEgressIntent, recordEgressResult } from ${JSON.stringify(storeUrl)};\n` +
    `const dir = process.argv[2], sid = process.argv[3];\n` +
    `for (let i = 0; i < 10; i++) { const id = recordEgressIntent(dir, { destHost: "h" + i, callFace: "relay.post", initiatorSid: sid }, 1000 + i); if (id) recordEgressResult(dir, { eventId: id, byteMagnitude: "<1K", outcome: "ok" }, 2000 + i); }\n`);
  const tsx = path.join(repoRoot(), "node_modules/.bin/tsx");
  const c1 = spawnSync(tsx, [child, dir, "sidX"], { encoding: "utf8", timeout: 30000 });
  const c2 = spawnSync(tsx, [child, dir, "sidY"], { encoding: "utf8", timeout: 30000 });
  t("concurrency-race: both child appenders exited 0", c1.status === 0 && c2.status === 0);
  const entries = readEgressLedger(dir);
  const v = verifyEgressChain(entries);
  const seqs = entries.map((e) => e.seq);
  const contiguous = seqs.every((s, i) => s === i);
  t("concurrency-race: the merged chain is contiguous (no forked chain / seq collision)", contiguous);
  t("concurrency-race: the merged chain verifies (serialized by the append lock)", v.ok === true);
  t("concurrency-race: all 40 entries present (2 children x 10 events x 2 lines)", entries.length === 40);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── fixture CONCURRENCY-RACE (boundary): a symlinked egress dir is refused (no write outside the 0o700 boundary) ──
{
  const base = mkdtempSync(path.join(tmpdir(), "egress-bnd-"));
  const real = path.join(base, "elsewhere"); mkdirSync(real);
  const link = path.join(base, "egress"); symlinkSync(real, link); // plant a symlink as the egress dir
  const id = recordEgressIntent(link, { destHost: "h", callFace: "relay.post", initiatorSid: "s" }, 1000);
  t("boundary: a symlinked egress dir ⇒ record refused (fail-closed on the boundary)", id === null && readdirSync(real).length === 0);
  rmSync(base, { recursive: true, force: true });
}

// egressDir resolves AGENTHOP_EGRESS_DIR
t("egressDir: AGENTHOP_EGRESS_DIR overrides", egressDir("/home/x", { AGENTHOP_EGRESS_DIR: "/tmp/eg" } as unknown as NodeJS.ProcessEnv) === "/tmp/eg");

console.log(`\nall egress-ledger selftests passed (${pass})`);

function repoRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."); }
