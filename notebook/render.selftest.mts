// Run: /Users/wowdd1/Dev/agenthop/node_modules/.pnpm/node_modules/.bin/tsx notebook/render.selftest.mts
// Pins the B4 render (line ③): deterministic markdown (two runs byte-identical), FC-2 three-state for BOTH sources
// (ledger db + morning-digest), null-as-"—", and digest sections presented VERBATIM (no new facts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderDigestReport } from "./render-core.js";
import { buildLedgerSql, assembleReviewRows } from "../tern/ledger-proj/ledger-core.js";
import { buildAndPublish } from "../tern/ledger-proj/ledger-io.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "tern-render-selftest-"));
const haveSqlite = (() => { try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** A sandbox home with an optional ledger db and an optional digest.json. */
function sandbox(opts: { db?: boolean; digest?: string } = {}): string {
  const home = mkdtempSync(path.join(scratch, "home-"));
  if (opts.db) {
    const sql = buildLedgerSql(
      assembleReviewRows([{ sha: "abc", item: "feat-x", seat: "s1", ts: 1700000000 }], new Map([["feat-x", 2]])),
      [{ batch: "batch-5", shas: "aaa,bbb", merged_ts: 1700000500 }],
    );
    buildAndPublish(path.join(home, ".agenthop", "carly", "ledger.db"), sql);
  }
  if (opts.digest !== undefined) {
    const d = path.join(home, ".agenthop", "console", "morning-digest");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "digest.json"), opts.digest);
  }
  return home;
}

try {
  // ── FC-2: both sources absent ⇒ stated, never fake-empty ─────────────────────────────────────────────────────────
  {
    const r = renderDigestReport(sandbox());
    t("absent db ⇒ stated", r.includes("ledger.db absent"));
    t("absent digest ⇒ stated", r.includes("digest absent"));
    t("never renders a fake table on absence", !r.includes("| item |"));
  }

  // ── digest FC-2: malformed / unrecognized-shape stated ───────────────────────────────────────────────────────────
  {
    t("digest malformed ⇒ stated", renderDigestReport(sandbox({ digest: "{not json" })).includes("digest malformed"));
    t("digest shape unrecognized ⇒ stated", renderDigestReport(sandbox({ digest: '{"schema":"x"}' })).includes("shape unrecognized"));
  }

  if (!haveSqlite) {
    console.log("SKIP db-backed render tests (no sqlite3 on PATH)");
  } else {
    const digest = '{"schema":"morning-digest/v1","date":"2026-10-14","sections":[{"title":"待你拍板","lines":["item A | pipe","multi\\nline"]}]}';
    const home = sandbox({ db: true, digest });

    // ── determinism: two renders byte-identical ────────────────────────────────────────────────────────────────────
    t("render: two calls byte-identical", renderDigestReport(home) === renderDigestReport(home));

    const r = renderDigestReport(home);
    // ── db present: rows + null-as-"—" + deterministic UTC ─────────────────────────────────────────────────────────
    t("reviews table rendered", r.includes("## Reviews (1)") && r.includes("| feat-x | s1 | abc | 2 |"));
    t("null outcome/usd shown as —", r.includes("| feat-x | s1 | abc | 2 | — | — |"));
    t("ts formatted UTC (deterministic)", r.includes("2023-11-14T22:13:20.000Z"));
    t("batches table rendered", r.includes("## Batches (1)") && r.includes("| batch-5 | aaa,bbb |"));

    // ── digest VERBATIM (no new facts) + cell safety ──────────────────────────────────────────────────────────────
    t("digest title verbatim", r.includes("### 待你拍板"));
    t("digest line is a list item (pipe safe unescaped in a list)", r.includes("- item A | pipe"));
    t("digest newline flattened to one line", r.includes("- multi line"));
    t("digest marked authoritative", r.includes("Numbers are authoritative from morning-digest"));
  }

  console.log("\nALL PASS");
} finally {
  try { execFileSync("rm", ["-rf", scratch]); } catch { /* best-effort */ }
}
