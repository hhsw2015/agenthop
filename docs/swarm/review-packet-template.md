# Review-packet template (swarm phase conformance review)

Reusable skeleton for the artifact a phase implementer hands to the conformance reviewer (and onward to an
adversarial re-reviewer like Codex). Sedimented from the brain-T1 pure-layer packet (`T1-pure-layer-review.md`), which
ran impl-green → conformance → adversarial zero-residual with this shape. Copy this file, fill the `{{...}}`, delete the
guidance in _italics_.

> **Why a packet, not just "tests pass".** 90 green tests only prove the observations the tests make; an adversarial
> reviewer injects the observations you didn't. The packet's job is to make the reviewer's cross-check cheap: pin the
> exact review range, map every contract clause to where it lives and what test pins it, and state the boundary so the
> reviewer doesn't chase work that is deliberately out of scope.

---

## {{Phase}} — review packet

Branch `{{branch}}`, review range `{{baseCommit}}..{{headCommit}}` _(exclude any docs-only commits from the code range;
name them separately)_. Verify:
`{{test command, e.g. pnpm --filter @agenthop/bus exec vitest run}}` → `{{N files / M tests}}` green;
`{{typecheck command}}` → 0.

**Scope proof** _(the reviewer will check this — do it for them)_: `git diff --name-status {{base}}..{{head}}` touches only
`{{expected paths}}`; it does NOT modify `{{the files this track promised not to touch, e.g. control.ts / dispatch-step.ts / launcher}}`.

## Modules / changeset

| Module | ~lines | Tests | Purpose |
|---|---|---|---|
| `{{path}}` | {{n}} | {{k}} | {{one line}} |

## Contract-clause → implementation → test map

_One row per normative clause the phase implements. Cite the frozen-doc section, the function/line, and the test that
pins it. This table IS the review — a reviewer walks it clause by clause._

| Clause (frozen §) | Implementation | Test(s) | Notes / counterexample pinned |
|---|---|---|---|
| `{{§x.y rule}}` | `{{module.fn}}` | `{{test name}}` | `{{the Codex/review counterexample this locks}}` |

## Self-check: PINNED tests lock BEHAVIOR, not implementation

_Before handing over, audit your own tests against this bar — an adversarial reviewer will._
- Assert observable outcomes (verdict/status/decision/field values, equality/inequality relations), not call order or
  internal structure.
- Digests asserted by relations (equal content ⇒ equal digest; changed content ⇒ changed digest) + at most one
  byte-literal parity case, never a specific hash.
- Each invariant that came from a review counterexample has a test that fails if the invariant breaks — list them:
  - {{invariant}} → `{{test}}`
- Loose-by-design assertions (reason substrings, category checks) are flagged as such, not mistaken for precise locks.

## Explicit boundary (NOT in this layer)

_State what is deliberately out of scope so the reviewer doesn't file it as a gap. Name the track/phase that owns it._
- `{{thing}}` → owned by `{{track/phase}}` ({{why deferred}}).

## Open self-flags (optional)

_Anything you added beyond the frozen text (a fail-fast check, a field, an interpretation of an ambiguous clause). Call
it out so the reviewer rules on it explicitly rather than discovering it._
- `{{added check/field}}` — `{{rationale}}`; reviewer please confirm in/out of bounds.

---

### Pipeline conventions that made this work (brief, for the implementer)
- Atomic commit per module; when a module is green, send the diff + test results and **continue to the next without
  waiting** — the reviewer concludes async (modules share only type deps, so rework surface is small).
- Fix a review round as one batch, each fix with its own regression test; re-report the range when green.
- If the reviewer rules against something you added, change it — don't re-argue; if you have a house-style reason
  (e.g. flat-record runtime guards over discriminated unions), state it once and let the reviewer decide.
