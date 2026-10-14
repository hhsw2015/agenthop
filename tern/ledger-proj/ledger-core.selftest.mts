// Run: /Users/wowdd1/Dev/agenthop/node_modules/.pnpm/node_modules/.bin/tsx tern/ledger-proj/ledger-core.selftest.mts
// (any tsx works; node_modules is per-checkout, so point at an installed one). Pins the tern-adoption line ③ B3 ledger
// projection: the pure core (git-batch parse / review-row assembly / deterministic SQL) AND the write primitive's three
// zero-bug fixture classes (crash-recovery / restart-idempotency / concurrency-ownership), each asserting an OBSERVABLE
// TERMINAL STATE. No bus dependency — ledger-core/ledger-io are decoupled on purpose.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { assembleReviewRows, parseGitBatches, buildLedgerSql, type ReviewInput, type GitLogEntry } from "./ledger-core.js";
import { buildAndPublish } from "./ledger-io.js";
import { readReviewQueueStrict } from "./ledger-sources.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "tern-ledger-selftest-"));
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const haveSqlite = (() => { try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const q = (db: string, sql: string) => execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();

try {
  // ── PURE: parseGitBatches ───────────────────────────────────────────────────────────────────────────────────────
  {
    const log: GitLogEntry[] = [
      { commitTimeSec: 300, subject: "build(swarm): regenerate presence artifacts for batch-21 (B21-1)" },
      { commitTimeSec: 250, subject: "Merge feat/b into rehearse-batch-21 (dual-cleared @bbb2222)" },
      { commitTimeSec: 200, subject: "Merge feat/a into rehearse-batch-21 (dual-cleared @aaa1111)" },
      { commitTimeSec: 150, subject: "Merge feat/c into rehearse-batch-20 (dual-cleared @ccc3333)" },
      { commitTimeSec: 100, subject: "docs: unrelated commit, no batch" },
    ];
    const rows = parseGitBatches(log);
    t("batches: one row per batch, ascending", rows.length === 2 && rows[0]!.batch === "batch-20" && rows[1]!.batch === "batch-21");
    t("batches: shas sorted+unique joined", rows[1]!.shas === "aaa1111,bbb2222");
    t("batches: merged_ts = artifact commit time when present", rows[1]!.merged_ts === 300);
    t("batches: merged_ts falls back to latest merge when no artifact", rows[0]!.merged_ts === 150);
    t("batches: non-matching subject ignored (no empty sha entries, exactly 2 batches)", rows.every((r) => r.shas.split(",").every((s) => s.length > 0)));
  }
  { // artifact-only batch with no merge ⇒ dropped (no shas to record)
    const rows = parseGitBatches([{ commitTimeSec: 9, subject: "regenerate presence artifacts for batch-99 (B99-1)" }]);
    t("batches: artifact-only batch dropped (no shas)", rows.length === 0);
  }
  { // duplicate sha in two merge lines ⇒ deduped
    const rows = parseGitBatches([
      { commitTimeSec: 2, subject: "Merge feat/x into rehearse-batch-5 (dual-cleared @deadbee)" },
      { commitTimeSec: 1, subject: "Merge feat/x-again into rehearse-batch-5 (dual-cleared @deadbee)" },
    ]);
    t("batches: duplicate sha deduped", rows.length === 1 && rows[0]!.shas === "deadbee");
  }

  // ── PURE: assembleReviewRows ────────────────────────────────────────────────────────────────────────────────────
  {
    const recs: ReviewInput[] = [
      { sha: "s2", item: "feat-b", seat: "seatY", ts: 2000 },
      { sha: "s1", item: "feat-a", seat: "seatX", ts: 1000 },
      { sha: "s3", item: "feat-a", seat: "seatX", ts: 1000 }, // same ts/item/seat, sha tiebreak
    ];
    const rounds = new Map([["feat-a", 3]]); // feat-b absent ⇒ rounds null
    const rows = assembleReviewRows(recs, rounds);
    t("reviews: deterministic order (ts, item, seat, sha)", rows.map((r) => r.sha).join(",") === "s1,s3,s2");
    t("reviews: rounds joined by ticket", rows[0]!.rounds === 3);
    t("reviews: absent ticket ⇒ rounds null (unknown ≠ 0)", rows[2]!.rounds === null);
    t("reviews: outcome/usd always null (v1)", rows.every((r) => r.outcome === null && r.usd === null));
    t("reviews: input not mutated", recs[0]!.sha === "s2");
  }

  // ── PURE: buildLedgerSql ────────────────────────────────────────────────────────────────────────────────────────
  {
    const reviews = assembleReviewRows([{ sha: "ab", item: "it's-a-feat", seat: "s1", ts: 10 }], new Map());
    const sql1 = buildLedgerSql(reviews, [{ batch: "batch-1", shas: "x,y", merged_ts: 5 }]);
    const sql2 = buildLedgerSql(reviews, [{ batch: "batch-1", shas: "x,y", merged_ts: 5 }]);
    t("sql: deterministic (same input ⇒ same text)", sql1 === sql2);
    t("sql: null rounds/outcome/usd emitted as NULL", sql1.includes("VALUES('ab','it''s-a-feat','s1',NULL,NULL,NULL,10)"));
    t("sql: single-quote escaped", sql1.includes("it''s-a-feat"));
    t("sql: one transaction (single BEGIN/COMMIT)", (sql1.match(/BEGIN;/g) || []).length === 1 && (sql1.match(/COMMIT;/g) || []).length === 1);
    t("sql: both tables created", sql1.includes("CREATE TABLE reviews(") && sql1.includes("CREATE TABLE batches("));
  }

  // ── B3-FC2: readReviewQueueStrict (P2-1) — unreadable NEVER degrades to empty ────────────────────────────────────
  {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const qdir = () => mkdtempSync(path.join(scratch, "queue-"));
    t("queue: ENOENT dir ⇒ [] (absent, no reviews yet)", readReviewQueueStrict(path.join(scratch, "nope-does-not-exist")).length === 0);
    {
      const d = qdir();
      writeFileSync(path.join(d, "feat-a.seatX.json"), JSON.stringify({ author: "au", sha: "sha1", sentSec: 111 }));
      writeFileSync(path.join(d, "feat-b.seatY.done.json"), JSON.stringify({ author: "au", sha: "sha2", sentSec: 222 }));
      writeFileSync(path.join(d, "notes.txt"), "not a review file"); // skipped
      const rows = readReviewQueueStrict(d);
      t("queue: valid records parsed (item=ticket, seat, sha, ts), non-review skipped", rows.length === 2 && rows[0]!.item === "feat-a" && rows[0]!.seat === "seatX" && rows[0]!.sha === "sha1" && rows[0]!.ts === 111);
    }
    {
      const d = qdir();
      writeFileSync(path.join(d, "feat-c.seatZ.json"), "{ not json");
      let threw = false; try { readReviewQueueStrict(d); } catch { threw = true; }
      t("queue: malformed record JSON ⇒ throws (never silent empty)", threw);
    }
    // B3-P2 (r3): runtime SHAPE validation — JSON.parse + a TS assertion is not validation.
    {
      const throwsOn = (name: string, body: string): boolean => {
        const d = qdir(); writeFileSync(path.join(d, name), body);
        try { readReviewQueueStrict(d); return false; } catch { return true; }
      };
      t("queue: array record [] ⇒ throws (not empty-sha default)", throwsOn("feat-a.s.json", "[]"));
      t("queue: string record ⇒ throws (not empty-sha default)", throwsOn("feat-a.s.json", '"not-a-record"'));
      t("queue: non-string sha {sha:{…}} ⇒ throws (never '[object Object]')", throwsOn("feat-a.s.json", '{"sha":{"bad":true},"sentSec":1}'));
      t("queue: non-finite sentSec ⇒ throws", throwsOn("feat-a.s.json", '{"sha":"x","sentSec":"nope"}'));
      t("queue: missing sentSec ⇒ throws", throwsOn("feat-a.s.json", '{"sha":"x"}'));
      // empty sha is a LEGIT data state (review opened without a sha) — must NOT throw
      const d = qdir(); writeFileSync(path.join(d, "feat-a.s.json"), '{"sha":"","sentSec":7}');
      const rows = readReviewQueueStrict(d);
      t("queue: empty sha is legit (not corrupt)", rows.length === 1 && rows[0]!.sha === "" && rows[0]!.ts === 7);
    }
    if (!isRoot) {
      // EACCES dir ⇒ throw (not treated as absent/empty)
      const d = qdir(); chmodSync(d, 0o000);
      let readable = true; try { readdirSync(d); } catch { readable = false; }
      if (!readable) { let threw = false; try { readReviewQueueStrict(d); } catch { threw = true; } t("queue: EACCES dir ⇒ throws (not empty)", threw); }
      else console.log("skip  queue EACCES-dir test (chmod 000 still listable here)");
      try { chmodSync(d, 0o700); } catch { /* restore */ }
    } else { console.log("skip  queue EACCES-dir test (root bypasses perms)"); }
  }

  if (!haveSqlite) {
    console.log("SKIP sqlite3-backed fixtures (no sqlite3 on PATH)");
  } else {
    const sqlA = buildLedgerSql(assembleReviewRows([{ sha: "a", item: "i", seat: "s", ts: 1 }], new Map([["i", 2]])), [{ batch: "batch-1", shas: "z", merged_ts: 9 }]);
    const sqlB = buildLedgerSql(assembleReviewRows([{ sha: "b", item: "j", seat: "s", ts: 2 }], new Map()), []);

    // ── FIXTURE 1: restart-idempotency (same sql ⇒ byte-identical db; rebuild over same dest stable) ────────────────
    {
      const d = mkdtempSync(path.join(scratch, "idem-"));
      const p1 = path.join(d, "a.db"); const p2 = path.join(d, "b.db");
      buildAndPublish(p1, sqlA); buildAndPublish(p2, sqlA);
      t("fixture[idempotency]: two fresh builds byte-identical", sha(p1) === sha(p2));
      const before = sha(p1); buildAndPublish(p1, sqlA);
      t("fixture[idempotency]: rebuild over same dest byte-identical", sha(p1) === before);
      t("fixture[idempotency]: content correct", q(p1, "SELECT sha||'/'||rounds FROM reviews;") === "a/2");
    }

    // ── FIXTURE 2: crash-recovery (build failure ⇒ previous db intact, temp cleaned) ───────────────────────────────
    {
      const d = mkdtempSync(path.join(scratch, "crash-"));
      const dest = path.join(d, "ledger.db");
      buildAndPublish(dest, sqlA); const good = sha(dest);
      // (a) a SQL error mid-build must NOT replace the good db
      let threw = false;
      try { buildAndPublish(dest, "BEGIN;\nCREATE TABLE x(a);\nINSERT INTO nope VALUES(1);\nCOMMIT;"); } catch { threw = true; }
      t("fixture[crash]: bad-sql build throws", threw);
      t("fixture[crash]: previous db intact after failed build", sha(dest) === good && q(dest, "SELECT count(*) FROM reviews;") === "1");
      // (b) a missing sqlite3 binary must NOT replace the good db, and must leave no temp
      let threw2 = false;
      try { buildAndPublish(dest, sqlA, "sqlite3-does-not-exist-xyz"); } catch { threw2 = true; }
      t("fixture[crash]: missing binary throws, db intact", threw2 && sha(dest) === good);
      t("fixture[crash]: no leftover temp after failures", !readdirSync(d).some((f) => f.includes(".tmp-")));
    }

    // ── FIXTURE 2b (B3-FC2, P2-1): an UNREADABLE review-queue preserves the last good db ────────────────────────────
    // main() reads readReviewQueueStrict BEFORE buildAndPublish, so an unreadable source throws and the good db is never
    // touched — the observable terminal state is the PREVIOUS db, not an empty one.
    {
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const d = mkdtempSync(path.join(scratch, "preserve-"));
      const dest = path.join(d, "ledger.db");
      buildAndPublish(dest, sqlA); const good = sha(dest);
      const qdir = path.join(d, "review-queue"); mkdirSync(qdir); writeFileSync(path.join(qdir, "x.y.json"), "{}");
      if (!isRoot) {
        chmodSync(qdir, 0o000);
        let listable = true; try { readdirSync(qdir); } catch { listable = false; }
        if (!listable) {
          let threw = false; try { readReviewQueueStrict(qdir); } catch { threw = true; }
          // the publish step is never reached when the source throws, so the good db stays byte-for-byte
          t("fixture[preserve]: unreadable queue throws ⇒ good db untouched", threw && sha(dest) === good && q(dest, "SELECT count(*) FROM reviews;") === "1");
        } else { console.log("skip  preserve-good-db test (chmod 000 still listable here)"); }
        try { chmodSync(qdir, 0o700); } catch { /* restore */ }
      } else { console.log("skip  preserve-good-db test (root bypasses perms)"); }
    }

    // ── FIXTURE 3: concurrency-ownership (atomic replace never torn; O_EXCL temp never truncates a foreign temp) ─────
    {
      const d = mkdtempSync(path.join(scratch, "conc-"));
      const dest = path.join(d, "ledger.db");
      buildAndPublish(dest, sqlA); // old
      buildAndPublish(dest, sqlB); // new (atomic replace)
      t("fixture[concurrency]: atomic replace ⇒ dest is the COMPLETE new db", q(dest, "PRAGMA integrity_check;") === "ok" && q(dest, "SELECT sha FROM reviews;") === "b");
      t("fixture[concurrency]: no leftover temp after replace", !readdirSync(d).some((f) => f.includes(".tmp-")));
      // forced collision: a pre-existing (foreign) temp at the first suffix must be LEFT UNTOUCHED (O_EXCL ownership),
      // the build using a fresh second name — a random suffix is not ownership (atomic-write-ownership).
      const foreign = `${dest}.tmp-COLLIDE`; writeFileSync(foreign, "FOREIGN");
      const gen = (() => { const seq = ["COLLIDE", "FRESH"]; let i = 0; return () => seq[i++] ?? "x"; })();
      buildAndPublish(dest, sqlA, "sqlite3", gen);
      t("fixture[concurrency]: foreign temp not truncated/unlinked (O_EXCL)", existsSync(foreign) && readFileSync(foreign, "utf8") === "FOREIGN");
      t("fixture[concurrency]: build still published correct db at fresh name", q(dest, "SELECT sha FROM reviews;") === "a");
    }
  }

  console.log("\nALL PASS");
} finally {
  try { execFileSync("rm", ["-rf", scratch]); } catch { /* best-effort scratch cleanup */ }
}
