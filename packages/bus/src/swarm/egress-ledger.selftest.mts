// Selftest for the egress ledger (gstack borrow ②). Pure core (chain/verify/parse/magnitude) + the IO store against a real temp
// dir, with the three review-gate fixture classes: crash-recovery, restart-idempotency, concurrency-race.
//   npx tsx packages/bus/src/swarm/egress-ledger.selftest.mts
import { mkdtempSync, writeFileSync, readdirSync, rmSync, readFileSync, symlinkSync, mkdirSync, chmodSync, lstatSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chainEntry, verifyEgressChain, parseEgressEntry, byteMagnitude, egressLedgerEnabled, type EgressEntry, type EgressBody } from "./egress-ledger.js";
import { egressDir, readEgressLedger, readEgressRaw, recordEgressIntent, recordEgressResult } from "./egress-ledger-store.js";

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
  // verify walks the RAW entries (EL-1): the truncated file is a null at the LAST position ⇒ incomplete-tail, NOT dropped-to-OK.
  const vt = verifyEgressChain(readEgressRaw(dir));
  t("crash-recovery: a truncated last entry ⇒ incomplete-tail (crash mid-append), never a TAMPER verdict", !vt.ok && vt.kind === "incomplete-tail");
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

// ── EL-1: the next seq comes from the MAX FILENAME, never a filtered survivor count. A deleted/transiently-missing interior
//    entry can NOT make an append reuse that seq (that would overwrite the next-written file); the append always extends past
//    the max filename. ──
{
  const dir = mkDir();
  const a = recordEgressIntent(dir, { destHost: "h0", callFace: "relay.post", initiatorSid: "s" }, 1000)!;
  recordEgressResult(dir, { eventId: a, byteMagnitude: "<1K", outcome: "ok" }, 1001); // seq 0,1
  const b = recordEgressIntent(dir, { destHost: "h2", callFace: "relay.post", initiatorSid: "s" }, 1002)!; // seq 2
  rmSync(path.join(dir, "000000000001.json")); // a seq-1 interior entry goes missing (deletion / transient)
  const next = recordEgressIntent(dir, { destHost: "h3", callFace: "relay.post", initiatorSid: "s" }, 1003)!; // must become seq 3, never reuse 1
  t("EL-1: append extends past the MAX filename (seq 3), never reuses a missing interior seq", readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).sort().join(",") === "000000000000.json,000000000002.json,000000000003.json");
  t("EL-1: the surviving max-seq entries still point to distinct events", a !== b && b !== next);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── EL-1: if the AUTHORITATIVE tail (max-seq file) is unreadable/corrupt or its internal seq disagrees with its filename, the
//    record is REFUSED — history is never rewritten and the corrupt tail is never overwritten. ──
{
  const dir = mkDir();
  recordEgressIntent(dir, { destHost: "h0", callFace: "relay.post", initiatorSid: "s" }, 1000); // seq 0 (the tail)
  writeFileSync(path.join(dir, "000000000000.json"), "{ corrupt json"); // the authoritative tail is now corrupt
  const refused = recordEgressIntent(dir, { destHost: "h1", callFace: "relay.post", initiatorSid: "s" }, 1001);
  t("EL-1: a corrupt authoritative tail ⇒ record refused (null)", refused === null);
  t("EL-1: the corrupt tail is NOT overwritten and no new entry is written (history untouched)", readFileSync(path.join(dir, "000000000000.json"), "utf8") === "{ corrupt json" && readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 1);
  // a tail whose internal seq disagrees with its filename is also refused (never rewrite)
  const dir2 = mkDir();
  recordEgressIntent(dir2, { destHost: "h0", callFace: "relay.post", initiatorSid: "s" }, 1000);
  const tailFp = path.join(dir2, "000000000000.json");
  writeFileSync(tailFp, JSON.stringify({ ...JSON.parse(readFileSync(tailFp, "utf8")), seq: 9 })); // filename seq 0, internal seq 9
  t("EL-1: a tail whose internal seq disagrees with its filename ⇒ refused", recordEgressIntent(dir2, { destHost: "h1", callFace: "relay.post", initiatorSid: "s" }, 1001) === null);
  rmSync(path.dirname(dir), { recursive: true, force: true });
  rmSync(path.dirname(dir2), { recursive: true, force: true });
}

// ── EL-2: the dest-host contract is enforced at WRITE with the SAME rule as the parser (bare host only). A port/scheme/path/
//    query/empty field ⇒ the record fails and NOTHING is written (no raw value echoed). ──
{
  const dir = mkDir();
  mkdirSync(dir, { recursive: true }); // a refused-at-write record never reaches appendBody's mkdir ⇒ pre-create so "nothing written" is observable
  t("EL-2 (write): a destHost with a path/query ⇒ refused", recordEgressIntent(dir, { destHost: "h/secret?token=x", callFace: "relay.post", initiatorSid: "s" }, 1000) === null);
  t("EL-2 (write): a destHost with a port ⇒ refused", recordEgressIntent(dir, { destHost: "host:8080", callFace: "relay.post", initiatorSid: "s" }, 1000) === null);
  t("EL-2 (write): a destHost with a scheme ⇒ refused", recordEgressIntent(dir, { destHost: "https://host", callFace: "relay.post", initiatorSid: "s" }, 1000) === null);
  t("EL-2 (write): an empty callFace ⇒ refused", recordEgressIntent(dir, { destHost: "host", callFace: "", initiatorSid: "s" }, 1000) === null);
  t("EL-2 (write): a refused record writes NOTHING (no half entry, no leak)", readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 0);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── EL-3: fail-OPEN never throws into the caller, and the lstat gate means a non-regular tail entry (a planted FIFO/dir) is
//    rejected WITHOUT a blocking read; a failed record emits a visible GAP line (not silent). ──
{
  const dir = mkDir();
  recordEgressIntent(dir, { destHost: "h0", callFace: "relay.post", initiatorSid: "s" }, 1000); // seq 0 (the tail)
  rmSync(path.join(dir, "000000000000.json")); mkdirSync(path.join(dir, "000000000000.json")); // the tail is now a DIRECTORY (non-regular)
  let threw = false, refused: string | null = "x";
  try { refused = recordEgressIntent(dir, { destHost: "h1", callFace: "relay.post", initiatorSid: "s" }, 1001); } catch { threw = true; }
  t("EL-3: a non-regular (directory) tail ⇒ refused via the lstat gate, NEVER throws into the caller", threw === false && refused === null);
  // GAP trace: a failed record writes a visible stderr line (fail-open is not silent)
  const origWrite = process.stderr.write.bind(process.stderr);
  let gapLine = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { gapLine += s; return true; };
  try { recordEgressIntent(dir, { destHost: "bad host", callFace: "relay.post", initiatorSid: "s" }, 1002); }
  finally { (process.stderr as unknown as { write: typeof origWrite }).write = origWrite; }
  t("EL-3: a failed record emits a visible GAP line on stderr (not silent)", /record failed/.test(gapLine));
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── EL-4: the append lock is the single-flight FILE lock, which RECLAIMS a dead holder (no permanent disable). A stale
//    .append.lock left by a crashed writer (dead pid) does not wedge the ledger — the next record reclaims it and succeeds. ──
{
  const dir = mkDir();
  mkdirSync(dir, { recursive: true });
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!; // a child that has already exited ⇒ a reliably-dead pid
  writeFileSync(path.join(dir, ".append.lock"), String(deadPid)); // a stale lock from a crashed writer
  const id = recordEgressIntent(dir, { destHost: "h0", callFace: "relay.post", initiatorSid: "s" }, 1000);
  t("EL-4: a stale append lock (dead holder) is reclaimed ⇒ the record still succeeds (no permanent disable)", id !== null && readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 1);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── EL-R2-1 (codex:Work r2): a LIVE but UNREADABLE append lock must NOT be reclaimed — the old file lock folded an unreadable
//    read to "" ⇒ reclaimable, so a competitor STOLE a live holder's lock ⇒ two writers ⇒ an already-confirmed record was
//    overwritten (verify still "OK"). FIX: three-state read ⇒ unreadable=UNKNOWN=HOLD. Gate: a competitor cannot succeed while
//    the live lock is unreadable; once the holder releases, appends continue. ──
{
  const dir = mkDir();
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".append.lock");
  writeFileSync(lock, String(process.pid), { mode: 0o600 }); // a LIVE holder (this very process) owns the lock
  chmodSync(lock, 0o000); // ...and it is now UNREADABLE (codex:Work's exact chmod000 reproduction)
  let readable = true; try { readFileSync(lock); } catch { readable = false; }
  if (!readable) { // skip only if this environment can still read a 0o000 file it owns (e.g. running as root)
    const refused = recordEgressIntent(dir, { destHost: "h", callFace: "relay.post", initiatorSid: "s" }, 1000);
    t("EL-R2-1: a competitor CANNOT reclaim a live-but-unreadable lock (record refused, not a silent overwrite)", refused === null && readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 0);
    unlinkSync(lock); // the original holder releases
    const after = recordEgressIntent(dir, { destHost: "h", callFace: "relay.post", initiatorSid: "s" }, 1001);
    t("EL-R2-1: once the holder releases, appends continue (no permanent disable)", after !== null && readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 1);
  } else { chmodSync(lock, 0o600); t("EL-R2-1: SKIPPED (0o000 still readable here — root?)", true); }
  try { chmodSync(lock, 0o600); } catch { /* already unlinked */ }
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

// ── EL-3 (codex:Work r2): a FIFO planted as the append lock must NOT block the record inside a plain readFileSync (which would
//    hang the caller's send forever). FIX: the lock read is O_NONBLOCK|O_NOFOLLOW + fstat-regular-gated. Gate: the record returns
//    TIMELY with a GAP (never hangs), and once the FIFO is removed the next record succeeds. ──
{
  const dir = mkDir();
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".append.lock");
  const mk = spawnSync("mkfifo", [lock], { encoding: "utf8" });
  const isFifo = mk.status === 0 && (() => { try { return lstatSync(lock).isFIFO(); } catch { return false; } })();
  if (isFifo) {
    const started = Date.now();
    const refused = recordEgressIntent(dir, { destHost: "h", callFace: "relay.post", initiatorSid: "s" }, 1000); // must NOT hang
    const elapsed = Date.now() - started;
    t("EL-3: a FIFO append lock ⇒ record returns TIMELY (no readFileSync hang) + refused", refused === null && elapsed < 2000);
    unlinkSync(lock); // remove the FIFO (the planted obstruction is gone)
    const after = recordEgressIntent(dir, { destHost: "h", callFace: "relay.post", initiatorSid: "s" }, 1001);
    t("EL-3: after the FIFO is removed, the next record succeeds (subsequent sends still work)", after !== null && readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).length === 1);
  } else { t("EL-3: SKIPPED (mkfifo unavailable on this host)", true); }
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

// ── fixture CONCURRENCY-RACE: two real child processes append GENUINELY in parallel (both spawned before either exits — the
//    earlier spawnSync+spawnSync was serial) through the shared append lock ⇒ the merged chain is contiguous + verifies + has
//    ALL events (no forked chain, no seq collision). ──
async function concurrencyRace(): Promise<void> {
  const dir = mkDir();
  const child = path.join(path.dirname(dir), "child.mts");
  const storeUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "egress-ledger-store.ts")).href;
  writeFileSync(child,
    `import { recordEgressIntent, recordEgressResult } from ${JSON.stringify(storeUrl)};\n` +
    `const dir = process.argv[2], sid = process.argv[3];\n` +
    `for (let i = 0; i < 10; i++) { const id = recordEgressIntent(dir, { destHost: "h" + i, callFace: "relay.post", initiatorSid: sid }, 1000 + i); if (id) recordEgressResult(dir, { eventId: id, byteMagnitude: "<1K", outcome: "ok" }, 2000 + i); }\n`);
  const tsx = path.join(repoRoot(), "node_modules/.bin/tsx");
  const run = (sid: string): Promise<number> => new Promise((resolve) => {
    const c = spawn(tsx, [child, dir, sid], { stdio: "inherit", timeout: 30000 });
    c.on("exit", (code) => resolve(code ?? 1));
    c.on("error", () => resolve(1));
  });
  const [s1, s2] = await Promise.all([run("sidX"), run("sidY")]); // BOTH launched before either finishes ⇒ truly concurrent
  t("concurrency-race: both child appenders exited 0", s1 === 0 && s2 === 0);
  const entries = readEgressLedger(dir);
  const v = verifyEgressChain(entries);
  const contiguous = entries.map((e) => e.seq).every((s, i) => s === i);
  t("concurrency-race: the merged chain is contiguous (no forked chain / seq collision)", contiguous);
  t("concurrency-race: the merged chain verifies (serialized by the append lock)", v.ok === true);
  t("concurrency-race: all 40 entries present (2 children x 10 events x 2 lines)", entries.length === 40);
  rmSync(path.dirname(dir), { recursive: true, force: true });
}

concurrencyRace().then(() => { console.log(`\nall egress-ledger selftests passed (${pass})`); }).catch((e) => { console.error(e); process.exit(1); });

function repoRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."); }
