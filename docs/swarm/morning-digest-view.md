# console morning-digest view (filing)

owner aad02248 · 2026-10-09 (r2 2026-10-10) · 协调者派单(与 f32a0507 的 feat/digest-wiring 对偶,经冻结投影解耦并行)· 基线 feat/console-canvas @2cacfbb(now an ancestor of main — see末节)· 状态:**只读视图 + 防御降级,r2 契约对齐后待复审**

## What

A read-only **morning-digest** view in the console (swarm-viz), a rail entry **beside canvas**: a daily report of date + sections. Zero backend — the console reads the generator's output file; the generator (feat/digest-wiring, f32a0507) is the dual half, decoupled via the frozen schema below.

## Schema consumed — `morning-digest/v1` (AUTHORITATIVE = the generator)

The canonical shape is the generator's, not this consumer's: `packages/bus/src/swarm/morning-digest.ts` `digestProjection` / `DigestProjection` (feat/digest-wiring, r2 @7fb2fa0). This view mirrors it EXACTLY (CDV-P2-1 — a first-cut guess at `items[].text` dropped the real content, which is `lines`). Read from `~/.agenthop/console/morning-digest/digest.json`:

```jsonc
{
  "schema": "morning-digest/v1",
  "date": "YYYY-MM-DD",
  "generatedAtSec": 1900000000,
  "sections": [ { "title": "needs you", "lines": ["…already-formatted, user-facing string…"] } ]
}
```

- A section is `{ title: string, lines: string[] }` — `lines` are plain, already-user-facing strings (pointers/summaries, S18 — never inlined artifacts). NO per-item object / ref.
- The generator's sections (alerts lead): **needs you / cleared / shipped / still pending**, or a single **quiet night** section when there is nothing to report. The view stays generic (renders whatever well-formed sections are present), so the generator may add/rename/reorder.

## Defensive + graceful degrade (generator is the dual half)

Same posture as the bandwidth-gauge precedent — the console never depends on the file existing or being perfect:

- `parseMorningDigest` (pure, selftested) mirrors the generator's own validator: wrong/absent `schema`, empty/non-string `date`, or non-array `sections` ⇒ `null`; a section without a string `title` or array `lines` is DROPPED (not fatal); non-string lines are filtered. `generatedAtSec` is tolerated (missing/odd ⇒ 0) so one odd field never blanks a good brief. Unknown structure is never silently read as empty content.
- `readMorningDigest`: absent / unreadable / corrupt ⇒ `null`; the page shows a "No morning digest yet" placeholder. Added to `/state.json` as `state.digest`. Zero backend — a plain file read of the generator's output, no service.

## Where it lives (console entry layer)

- `scripts/swarm-viz-export.ts`: `MorningDigest` / `DigestSection` types, `parseMorningDigest`, `readMorningDigest`, `digest` on Snapshot + buildSnapshot (+ selftest incl a writer-shape → reader file-boundary integration case preserving all lines).
- `web/swarm-viz.html`: `viewMode "digest"`; a `digest ▸` rail button beside `canvas`; `renderDigest()` (date header + one card per section, its `lines` as a list, empty lane "— none —", null ⇒ placeholder); CSS; wired into render()/syncViewButtons/switchView. Every overlay's visibility is set BEFORE any view branch returns, so switching digest→kanban/timeline never leaves the digest layer on top (CDV-P2-2).

## Gates

- exporter selftest (incl generator-shape round-trip + file-boundary writer→reader, all lines preserved); tsc scripts + bus = 0; JS `node --check` OK; projection selftest + swarm-projection vitest 16/16 UNCHANGED; canvas / shared-budget behavior untouched.
- Browser-verified with ego-browser (producer-shape with-digest + no-digest fixtures): the rail button sits beside canvas, date + sections + lines render, an empty section is kept, null ⇒ placeholder, switching digest→kanban/timeline hides the digest layer, switch-back to canvas is clean, no JS errors.

## Base-branch seam

Built off feat/console-canvas @2cacfbb. Since then canvas was integrated — **2cacfbb is now an ancestor of main (fa4f5ac)** — so this view rebases cleanly onto main; the stack is effectively just this change atop merged canvas. The digest-wiring generator is independent (decoupled via the schema above); its r2 is in review and is the authoritative source for `morning-digest/v1`. Local, not pushed/merged.
