# agenthop tern-board — review + runbook board projection (line ① A4/A5)

A one-way **projection** of durable swarm facts into two Carly Markdown boards. Contract: `docs/swarm/tern-batch2-contracts.md` §1 (FROZEN @8ec8b6b). The board is **never a source of truth** — a human dragging a card in Tern does not write back to the swarm (v1 has no reverse sync; the generator full-rewrites both files from durable every run, so an in-Tern edit is overwritten on the next regen — the ownership discipline Carly experiment ④ surfaced).

## Data flow (strictly one-way)

```
durable facts ──▶ generator (pure projection) ──▶ ~/.agenthop/carly/review-board.md   (A4)
  • ~/.agenthop/swarm/board/<item>.<state>.<sid>.json          └▶ ~/.agenthop/carly/runbook-board.md  (A5)
  • ~/Work/review-reports/<item>-<sha>-review-<seat>/
  • ~/Work/review-reports/<item>-<sha>-dual-signoff-<seat>/
  • git merge-base --is-ancestor <sha> main
```

## Execution model — standalone `lua`, not a `tern.carly` schedule

The lane/runbook facts need `git merge-base --is-ancestor` (coordinator ruling: structural, not PROGRESS-text parsing) and file mtimes. Tern's sandboxed `tern.fs` has **neither exec nor rename/stat** (PROTOCOL.md: "tern.fs 没有 rename / O_EXCL"). So the generator runs under the **standalone Lua 5.5 interpreter** — the same one the fixture uses — where `io.popen` (git/stat), `os.rename` (atomic write) and `io.open` exist. **Tern/Carly only OPENS the produced `.md` (view).** `generate.sh` is the cron/manual invocation (`* * * * *` safe; idempotent). "A2 哨兵同款模式" is honored as the **style** (one loadable source whose pure cores a Lua fixture drives directly — no drift), not the Tern-scheduled host (which cannot run git).

## Lane mapping (coordinator-locked — all structural, zero PROGRESS parsing)

| Lane | Source |
|---|---|
| **Queued** | `swarm/board/<item>.{granted,claimed}.<sid>.json` with **no** review-report dir yet (claimed, not submitted); `done` excluded |
| **Reviewing** | a `<item>-<sha>-review-<seat>/` dir exists and the item is **not** dual-signed (latest round per item) |
| **Needs-human** | a `<item>-<sha>-dual-signoff-<seat>/` dir exists **and** its SHA is **not** in `main` ancestry (dual-voice cleared, awaiting the human merge gate) |
| **Merged** | a dual-signoff exists **and** its SHA **is** in `main` ancestry |

Card title: `<item> @<sha7> [<seat>]`. Card id: a **content-hash** (length-prefixed djb2, injective over the (item,sha,seat) tuple — a separator join would collide, the VL-1 lesson) so ids are **stable across regens**; the generator full-rewrites the file (no incremental edit ⇒ no Carly-④ id drift). Cards within a lane are sorted by id for byte-stable output.

## A5 runbook (mtime chain)

One `[RUNBOOK] batch-release <branch>` card per in-flight `rehearse-batch-*` branch, with five nested sub-checkboxes. A step ticks iff its artifact **exists** and its mtime is **strictly later than the previous ticked step** (a monotonic chain — a step can't be "done" before its predecessor). A **missing artifact ⇒ that step and every later step stay unchecked** (honest gap, never guessed). Artifact paths (coordinator-locked, in the card notes):

1. `merge-pool` → the `rehearse-batch-N` branch exists (tip commit time = the chain's first mtime)
2. `regen-presence` → `packages/bus/dist-presence/presence.mjs`
3. `gates` → `~/.agenthop/swarm/batch-gates/<branch>.json` — **a new convention: the output contract of the batch-mechanization script. This generator only READS it; v1 absence ⇒ step 3 unchecked (honest).**
4. `arch-review` → `~/Work/review-reports/batch*-dual-signoff-*.md`
5. `ff-main-install` → tip SHA is-ancestor `main` **and** `~/.local/bin/agenthop`

## Files

- `board.luau` — pure cores: `card_id`, `classify`, `runbook_steps`, `render_review_board`, `render_runbook_board`.
- `board-run.luau` — durable-name parsers (pure) + `run(deps)` (dep-injected) + `default_deps()` (the only IO: io.popen git/stat, `write_atomic` = temp + `os.rename`).
- `generate.lua` / `generate.sh` — the entrypoint (cron/manual).
- `test/board.test.lua` — 38 checks: pure cores, parsers, the 3-fixture law (idempotent byte-same / half-write-crash / concurrent single-win, real temp files + fake git-dir deps), and a cross-check against real `~/Work/review-reports`.

## Verify

```sh
lua test/board.test.lua          # 38 checks, PASS
./generate.sh                    # produce the real boards (needs git + stat; writes ~/.agenthop/carly/*.md)
```

## v1 scope / observations

- **No reverse sync.** The board is a projection; Tern-side edits are overwritten each regen.
- **Reviewing volume:** on the current fleet, `~/Work/review-reports/` is an append-only archive, so Reviewing (latest round per un-signed item) reflects **every distinct item ever reviewed without a dual-signoff** (~97 on today's data), not only this week's work. A recency filter (e.g. latest-round mtime within N days, or intersect with `swarm/board/` claimed) is a **v2 question for the coordinator** — v1 keeps the locked literal mapping rather than inventing a policy.
- **Atomicity:** `write_atomic` = temp + `os.rename` (half-write-safe); the board being a full-rewrite projection means a crash mid-write is overwritten cleanly on the next run, and two concurrent runs each rename a complete file (never interleaved).
