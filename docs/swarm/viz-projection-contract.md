# swarm-viz ↔ brain projection: the consumer contract

Date: 2026-10-03. Status: **aligned and frozen on the design side; not yet implemented.**

The authoritative schema is the design session's doc (do not duplicate it here, link it):
`/Volumes/Share/projects/dev/agenthop-wt/integration/docs/swarm/projection-schema.md`
— a non-normative companion to `brain-design.md` v3-final + `team-collab-design.md` v2-final.

This file records what swarm-viz (the consumer) agreed to, so that when the projection
actually lands (with brain §4.3 step A, in the implementation track) whoever picks up the
viz knows exactly what was negotiated. None of this is derivable from code yet — the
projection does not exist.

## What the projection gives us

`~/.agenthop/swarm/projection/` — current-state JSON, atomic per file, eventually consistent
across files (read `meta.lastAppliedSeq`, tolerate lag). We read files, never import modules,
never replay `control-log/`.

- `meta.json` — `{ schemaVersion, lastAppliedSeq, rebuiltAt }`. seq goes backwards ⇒ projection
  is rebuilding ⇒ drop the whole directory and re-read.
- `control/<launchId>.json` — the existing ControlRecord (VM lifecycle axis we already render).
- `jobs/<jobId>/plan.json` — the DAG: `nodes[].dependsOn` (edges), `kind`, `required`,
  plus `jobStatus` (running|succeeded|failed|blocked) + `jobStatusNote`.
- `jobs/<jobId>/attempts/<nodeId>.json` — `current` attempt (status enum, statusNote, `complete`,
  `role`, inputBindings, executionBindings) + `history` (last 8 + count).
- `jobs/<jobId>/results.json` — accepted / rejected+reason / candidates / peerLate count.
- `jobs/<jobId>/budget.json` — jobBudget + used; `modelUsd` is null until the CPA ledger lands.
- `members.json` — durable members only (class, visibility, reachability ok|suspected,
  activeBindings). Ephemeral VMs are NOT here; they appear only as a binding executor.

## The rules that keep the viz honest

- **Judgment-sink principle (my gap 1, the real trap).** Any judgment derived by a recursive or
  cascading rule — `complete` (= currentAccepted != null), `jobStatus`, node終败 — is computed by
  the authoritative reducer and written into the projection. The viz consumes the boolean/enum and
  **must not re-derive it**. Re-deriving `currentAccepted` in the page would disagree with the
  dispatcher and show a green node whose upstream has gone stale — the hardest lie to catch. This is
  C-1 ("don't replay the log") extended to the semantic layer.
- **`SUCCEEDED` and `complete=false` can coexist.** An attempt was accepted (status stays SUCCEEDED,
  a historical fact) but an upstream was later superseded (`complete` flips false, current validity).
  Render this explicitly as **"was green, now stale — pending rerun"**, not as plain green. This is
  the visible form of the lie the judgment-sink rule prevents.
- **Two executor kinds, one business axis.** `executionBindings[].executor` is a discriminated union:
  `{kind:"box", launchId}` → connects to `control/<launchId>.json` (the outsourced VM).
  `{kind:"member", memberId, publishKey}` → connects to `members.json` (a durable employee taking a
  task). A member has NO control record — do not look for one. `publishKey` shape is owned by C0 and
  may change; the union discriminant is the stable part.
- **R0 rendering rule (my commitment).** A DM is advisory and never advances task state; only CONTROL
  commits do. The viz must never draw a DM as if it changed acceptance/dependencies. v1 does not
  project DM/board at all.

## What the viz commits to (so the design can trust eventual consistency)

1. Attempt files are read **driven by `plan.nodes[]`**, not by globbing the directory — no attempts
   index needed.
2. Live work-status is **merged**: `members.json` (class/role/activeBindings) + bus `peers()`
   (working/idle/blocked). members.json need not carry live status; `reachability` is enough.
3. Cross-file skew is **rendered defensively**: a plan node whose attempt file has not appeared yet
   is "pending/unknown", never an error, and the viz does **not** retry-assemble a consistent cut
   (that would reimplement the barrier). A `lastAppliedSeq` regression ⇒ drop and re-read.
4. The budget bar leaves an **input slot for transport-layer cost** (`tasklog.TaskResult.costUsd`),
   which becomes `budget.json.modelUsd`'s nearest real source once P0 TASK lands.

## Layering vs the existing tasklog (schema §9)

`packages/bus/src/tasklog.ts` is the **P0 transport record** (who a unit of work was handed to, what
came back) — bus layer, not the business axis. It stays as the transport-detail layer; if the viz
renders it, it is a transport-layer footnote, never a second task axis. The business axis (attempt /
acceptance / DAG) is the projection, one source only.

## When the projection lands — the viz to-do

- Point the task river / DAG at `jobs/<jobId>/plan.json` + `attempts/` instead of my placeholder
  tasklog model. Retire the `fromControlMirror` synthetic rows and the launchId-substring matching.
- Draw the DAG from `dependsOn`; colour nodes by acceptance state; mark `required` nodes; show the
  "was green, now stale" state for `SUCCEEDED && !complete`.
- Connect each node to its executor via the union; draw handoff chains from `continuationOf`.
- Add the "company overview" layout the design suggested: members (employees, with reachability) on
  the left, the job DAG (node colour = acceptance) in the middle, outsourced VM lifecycle on the
  right, budget bar across the bottom.
