# console morning-digest view (filing)

owner aad02248 · 2026-10-09 · 协调者派单(与 f32a0507 的 feat/digest-wiring 对偶,经冻结投影解耦并行)· 基线 feat/console-canvas @2cacfbb(消费者栈,见末节)· 状态:**只读视图 + 防御降级,待复审**

## What

A read-only **morning-digest** view in the console (swarm-viz), a rail entry **beside canvas**: a daily report of date + sections (昨日签收 / 并库 / 在审 / 告警 / 今日待裁). Zero backend — the console reads the generator's output file; the generator (feat/digest-wiring, f32a0507) is the dual half, decoupled via the frozen schema below.

## Schema consumed (contract for the generator — `morning-digest/v1`)

Read from `~/.agenthop/console/morning-digest/digest.json`:

```jsonc
{
  "schema": "morning-digest/v1",
  "date": "YYYY-MM-DD",
  "sections": [
    { "key": "signed-off", "title": "昨日签收", "items": [ { "text": "…", "ref": "…?" } ] },
    { "key": "merged",     "title": "并库",     "items": [ … ] },
    { "key": "in-review",  "title": "在审",     "items": [ … ] },
    { "key": "alerts",     "title": "告警",     "items": [ … ] },
    { "key": "pending-decisions", "title": "今日待裁", "items": [ … ] }
  ]
}
```

- `sections` is a generic ordered list (title + items) so the view survives the generator adding/renaming/reordering sections; `key` is optional. `item.ref` is optional (a short pointer like a SHA / taskRef, shown dimmed).
- The five v1 sections above are the expected set, but the view renders whatever well-formed sections are present (and an empty section renders as a kept lane showing "— none —", kanban-style).

## Defensive + graceful degrade (generator still in build)

Same posture as the bandwidth-gauge precedent: the generator has not landed, so the console must not depend on the file existing or being perfectly shaped.

- Exporter `parseMorningDigest` (pure, selftested): a non-object, a wrong/absent `schema`, a non-string `date`, or non-array `sections` ⇒ `null`; a malformed section (no string title) or item (no string text) is DROPPED, not fatal — a partial digest still renders what is well-formed.
- `readMorningDigest`: absent / unreadable / corrupt ⇒ `null`. The page then shows a "No morning digest yet" placeholder. Added to `/state.json` as `state.digest` (read-only; no new service — a plain file read of the generator's output).

## Where it lives (console entry layer, zero backend)

- `scripts/swarm-viz-export.ts`: `MorningDigest`/`DigestSection`/`DigestItem` types, `parseMorningDigest`, `readMorningDigest`, `digest` on the Snapshot + buildSnapshot (8 selftest assertions).
- `web/swarm-viz.html`: `viewMode "digest"`; a `digest ▸` rail button beside `canvas`; `renderDigest()` (date header + one card per section, item + optional ref, empty lane, null placeholder); CSS; wired into render()/syncViewButtons/switchView like kanban/timeline.

## Gates

- exporter selftest 54/54 (8 new digest); tsc scripts + bus = 0; JS `node --check` OK; projection selftest + swarm-projection vitest 16/16 UNCHANGED; shared-budget / canvas behavior untouched.
- Browser-verified with ego-browser (fixture server + a with-digest and a no-digest state): 6/6 — button present beside canvas, date + 4 sections + items + ref render, empty section kept, null ⇒ placeholder, switch back to canvas clean, no JS errors.

## Base-branch seam

Built **off feat/console-canvas @2cacfbb** (the canvas view family it adds a rail entry beside — canvas is not yet on main). Integrates as a stack with canvas; rebase onto main after canvas lands. The digest-wiring generator is independent (decoupled via the schema above). Local, not pushed/merged.
