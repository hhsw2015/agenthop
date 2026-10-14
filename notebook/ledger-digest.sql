-- ledger-digest.sql — READ-ONLY review-ledger views for the Tern notebook's sqlite block (tern-adoption line ③ B4).
-- Open READ-ONLY (the sole writer is tern/ledger-proj/export.mts; §3 "Tern 的 sqlite 块只读打开"):
--   sqlite3 -readonly ~/.agenthop/carly/ledger.db < notebook/ledger-digest.sql
-- These SELECTs are the canonical views; render.mts runs the SAME SELECTs with -json to build the markdown digest, so
-- the notebook cell and the rendered table never drift. Deterministic ORDER BY (byte-stable output on rerun). This file
-- only READS — it has no INSERT/UPDATE/DELETE/DDL, so it is safe against a read-only handle.
.mode box
.headers on

-- Reviews: one row per review event. outcome/usd are v1 NULL (no structured source — honest gap, not a fabricated join).
SELECT item, seat, sha, rounds, outcome, usd, ts
FROM reviews
ORDER BY ts, item, seat, sha;

-- Batches: git-derived, one row per rehearse-batch-N (shas = feature commits merged, merged_ts = artifact/merge time).
SELECT batch, shas, merged_ts
FROM batches
ORDER BY merged_ts, batch;
