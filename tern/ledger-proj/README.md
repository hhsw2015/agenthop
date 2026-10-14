# tern-adoption line ③ — review-ledger SQLite projection + notebook digest (B3 + B4)

Contract: `docs/swarm/tern-batch2-contracts.md` §3 (@1e0f860). Writable domain: `tern/ledger-proj/**`,
`~/.agenthop/carly/ledger.db`, `notebook/**`. Never push/merge (coordinator integrates).

## B3 — export (`tern/ledger-proj/`)
One-way JSON→SQLite export of the review ledger for Tern's read-only sqlite block. **Sole writer** = the
export script; atomic temp+rename (a reader never sees a torn db).

- `ledger-core.ts` — pure: `parseGitBatches`, `assembleReviewRows`, `buildLedgerSql` (deterministic SQL).
- `ledger-io.ts` — `buildAndPublish`: O_EXCL-owned fresh temp → `sqlite3` fills it → atomic rename.
- `export.mts` — CLI: FC-2 reads of the sources, runs git, builds, publishes.

Schema (contract-frozen):
```sql
reviews(sha TEXT, item TEXT, seat TEXT, rounds INT, outcome TEXT, usd REAL, ts INT);  -- outcome/usd v1 ALWAYS NULL
batches(batch TEXT, shas TEXT, merged_ts INT);                                        -- git-derived
```
Sources (coordinator ruling A+B):
- **reviews** ← autoscale review-queue ledger (`readReviewLedger`: item=ticket, seat, sha, ts=sentSec) +
  **rounds** ← retro `reworkRoundDist` by ticket (null when the ticket has no round record — unknown ≠ 0).
  `outcome`/`usd` = **v1 NULL** (no structured source; NOT a fabricated join). v2 candidates: outcome ←
  review-current index, usd ← tasklog account.
- **batches** ← **git-derived** (chosen over empty table): the merge/artifact subjects are a controlled
  format (structured parse, not heuristic). One row per `rehearse-batch-N`: `shas` = sorted-unique feature
  commits from `Merge … into rehearse-batch-N (… @sha)`, `merged_ts` = the `regenerate presence artifacts
  for batch-N` commit time (else latest merge). Older ad-hoc merge formats are not captured (honest scope).

Reliability: deterministic SQL (one transaction, totally-ordered rows, pinned page_size) ⇒ **rerun = byte-
identical** db; O_EXCL temp ownership; no new dependency (shells to the `sqlite3` CLI — no better-sqlite3 /
`node:sqlite`, both absent in this node build).

## B4 — notebook digest (`notebook/`)
Option 2 (coordinator ruling): a read-only SQL view + a deterministic render; the Tern notebook cell just
invokes the render, a human/Carly eyeballs the sqlite block's read-only open (non-blocking).

- `notebook/ledger-digest.sql` — canonical **read-only** SELECTs for the Tern sqlite block.
- `notebook/render-core.ts` — `renderDigestReport(home)`: reads the db read-only (`sqlite3 -readonly -json`) +
  the morning-digest artifact → deterministic markdown. Presentation only (no new facts; digest numbers
  authoritative, rendered verbatim; NULL shown as `—`). FC-2 for both sources.
- `notebook/render.mts` — thin CLI (stdout).

## Run
```sh
tsx tern/ledger-proj/export.mts                    # build ~/.agenthop/carly/ledger.db
tsx notebook/render.mts                            # print the digest (stdout)
sqlite3 -readonly ~/.agenthop/carly/ledger.db < notebook/ledger-digest.sql   # Tern sqlite block view
# selftests:
tsx tern/ledger-proj/ledger-core.selftest.mts      # 25 tests (pure core + 3 zero-bug fixture classes)
tsx notebook/render.selftest.mts                   # render determinism + FC-2 + no-new-facts
```
(Use any installed tsx, e.g. the main checkout's `node_modules/.pnpm/node_modules/.bin/tsx`.)

## Acceptance (contract §3, Option-2 amended)
- export idempotent (rerun = same bytes) — verified (3 runs + fixture).
- render two runs byte-identical — verified (fixture).
- Tern sqlite block read-only open — verified via `sqlite3 -readonly` (write rejected); GUI eyeball = user/Carly, non-blocking.
