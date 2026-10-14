// Run: /Users/wowdd1/Dev/agenthop/node_modules/.pnpm/node_modules/.bin/tsx notebook/render.selftest.mts
// Pins the B4 render (line ③) including the r2 review fixes (8c26550 → codex:Work): deterministic markdown, B4-DB-FC2
// (existing-but-unreadable ≠ absent), B4-UTC-NULL (NULL epoch ⇒ "—", real 0 ⇒ 1970), B4-DIGEST-SCHEMA (canonical
// morning-digest/v1 validation; foreign/malformed ⇒ stated, never authoritative, never crash-drops the tables), and the
// B4-DB-SNAPSHOT single-connection read. No live Tern.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderDigestReport, readLedgerSnapshot } from "./render-core.js";
import { buildLedgerSql, assembleReviewRows } from "../tern/ledger-proj/ledger-core.js";
import { buildAndPublish } from "../tern/ledger-proj/ledger-io.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "tern-render-selftest-"));
const haveSqlite = (() => { try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const digestV1 = (sections: unknown): string => JSON.stringify({ schema: "morning-digest/v1", date: "2026-10-14", generatedAtSec: 1791935890, sections });

function home(opts: { sql?: string; digest?: string } = {}): string {
  const h = mkdtempSync(path.join(scratch, "home-"));
  if (opts.sql) buildAndPublish(path.join(h, ".agenthop", "carly", "ledger.db"), opts.sql);
  if (opts.digest !== undefined) {
    const d = path.join(h, ".agenthop", "console", "morning-digest");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "digest.json"), opts.digest);
  }
  return h;
}
const normalDb = () => buildLedgerSql(
  assembleReviewRows([{ sha: "abc", item: "feat-x", seat: "s1", ts: 1700000000 }], new Map([["feat-x", 2]])),
  [{ batch: "batch-5", shas: "aaa,bbb", merged_ts: 1700000500 }],
);

try {
  // ── FC-2: both sources absent ⇒ stated, never fake-empty ─────────────────────────────────────────────────────────
  {
    const r = renderDigestReport(home());
    t("absent db ⇒ stated", r.includes("ledger.db absent"));
    t("absent digest ⇒ stated", r.includes("digest absent"));
    t("never renders a fake table on absence", !r.includes("| item |"));
  }

  // ── B4-DIGEST-SCHEMA: canonical morning-digest/v1 validation (P2-4) ──────────────────────────────────────────────
  {
    t("digest foreign schema ⇒ not authoritative", renderDigestReport(home({ digest: JSON.stringify({ schema: "foreign/v9", date: "x", generatedAtSec: 1, sections: [{ title: "t", lines: ["l"] }] }) })).includes("malformed/unsupported schema"));
    t("digest malformed json ⇒ stated", renderDigestReport(home({ digest: "{not json" })).includes("malformed/unsupported schema"));
    t("digest missing generatedAtSec ⇒ corrupt (complete-projection rule)", renderDigestReport(home({ digest: JSON.stringify({ schema: "morning-digest/v1", date: "d", sections: [] }) })).includes("malformed/unsupported schema"));
    // sections:[null] used to crash (TypeError, empty stdout) AND must not drop the ledger tables
    const rNullSec = renderDigestReport(home({ sql: haveSqlite ? normalDb() : undefined, digest: digestV1([null]) }));
    t("digest sections:[null] ⇒ stated, no crash", rNullSec.includes("malformed/unsupported schema"));
    if (haveSqlite) t("digest corrupt does NOT drop the ledger tables", rNullSec.includes("## Reviews (1)"));
    t("digest object-typed line ⇒ corrupt (not [object Object])", renderDigestReport(home({ digest: digestV1([{ title: "t", lines: [{}] }]) })).includes("malformed/unsupported schema"));
  }

  if (!haveSqlite) {
    console.log("SKIP db-backed render tests (no sqlite3 on PATH)");
  } else {
    const h = home({ sql: normalDb(), digest: digestV1([{ title: "待你拍板", lines: ["item A | pipe", "multi\nline"] }]) });

    // ── determinism ────────────────────────────────────────────────────────────────────────────────────────────────
    t("render: two calls byte-identical", renderDigestReport(h) === renderDigestReport(h));
    const r = renderDigestReport(h);
    t("reviews table rendered", r.includes("## Reviews (1)") && r.includes("| feat-x | s1 | abc | 2 |"));
    t("null outcome/usd shown as —", r.includes("| feat-x | s1 | abc | 2 | — | — |"));
    t("batches table rendered", r.includes("## Batches (1)") && r.includes("| batch-5 | aaa,bbb |"));
    t("digest valid ⇒ sections verbatim", r.includes("### 待你拍板") && r.includes("- item A | pipe") && r.includes("- multi line"));
    t("digest marked authoritative", r.includes("Numbers are authoritative from morning-digest"));

    // ── B4-UTC-NULL (P2-3): NULL epoch ⇒ "—"; REAL 0 epoch ⇒ its Unix date ──────────────────────────────────────────
    {
      const sql = "PRAGMA page_size=4096;\nBEGIN;\nCREATE TABLE reviews(sha TEXT,item TEXT,seat TEXT,rounds INT,outcome TEXT,usd REAL,ts INT);\nCREATE TABLE batches(batch TEXT,shas TEXT,merged_ts INT);\n" +
        "INSERT INTO reviews VALUES('a','nullts','s',NULL,NULL,NULL,NULL);\nINSERT INTO reviews VALUES('b','zerots','s',NULL,NULL,NULL,0);\nINSERT INTO batches VALUES('batch-1','x',NULL);\nCOMMIT;";
      const r2 = renderDigestReport(home({ sql }));
      t("NULL ts ⇒ — (not fabricated 1970)", /\| nullts \| s \| a \| — \| — \| — \| — \|/.test(r2));
      t("REAL 0 ts ⇒ 1970 epoch (positive control)", r2.includes("| zerots | s | b | — | — | — | 1970-01-01T00:00:00.000Z |"));
      t("NULL merged_ts ⇒ —", r2.includes("| batch-1 | x | — |"));
    }

    // ── B4-DB-SNAPSHOT (P2-5): reviews + batches come from ONE consistent snapshot ─────────────────────────────────
    {
      const snap = readLedgerSnapshot(path.join(h, ".agenthop", "carly", "ledger.db"));
      t("snapshot: single read returns BOTH tables", !("fault" in snap) && snap.reviews.length === 1 && snap.batches.length === 1);
    }

    // ── B4-DB-FC2 (P2-2): an existing-but-unreadable db ⇒ "unreadable", NOT "absent" ───────────────────────────────
    if (!isRoot) {
      const hu = home({ sql: normalDb() });
      const db = path.join(hu, ".agenthop", "carly", "ledger.db");
      chmodSync(db, 0o000);
      let stillReadable = true;
      try { readFileSync(db); } catch { stillReadable = false; }
      if (!stillReadable) {
        const r3 = renderDigestReport(hu);
        t("existing-but-unreadable db ⇒ unreadable (not absent)", r3.includes("ledger.db unreadable") && !r3.includes("ledger.db absent"));
      } else { console.log("skip  unreadable-db test (chmod 000 still readable here)"); }
      try { chmodSync(db, 0o600); } catch { /* restore for cleanup */ }
    } else { console.log("skip  unreadable-db test (root bypasses perms)"); }
  }

  console.log("\nALL PASS");
} finally {
  try { execFileSync("rm", ["-rf", scratch]); } catch { /* best-effort */ }
}
