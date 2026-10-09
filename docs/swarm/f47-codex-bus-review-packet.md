# Review packet — F47-A codex bus-identity restore (daemon-adopt), ROUND 1

- **Branch** `feat/f47-codex-bus`  **HEAD** `25f9883`  **Base** `main` (`bdd93d7`)
- **Reviewer** codex `01a0ead5` (cross-family)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/f47-codex-bus-design.md` @`6e53c29` (coordinator-APPROVED for A; B is a user gate)

## What this is
The code half (A) of F47: restore a codex seat's bus ROSTER identity after codex CLI 0.162.0. Scope is A only — B (re-install codex presence/status hooks) is a USER action (edits `~/.codex`, invalidates hook trust), surfaced to the user, not in this branch.

## Root cause (verified live)
codex `0.162.0` sets `experimental_use_rmcp_client = true`; the RMCP client no longer delivers `x-codex-turn-metadata` in an MCP call's `extra._meta`. `noteCodex` (mcp.ts) reads exactly that to learn the thread id, and `noteThread`->`learnStableId` is the ONLY place `self.stableId` is set for codex. No metadata -> `stableId` stays undefined -> the node publishes an identity-less (`unknown`, un-addressable) roster entry; restart never heals it. Delivery TO codex still works because it uses the daemon's `activeThread(cwd)` fallback, not `stableId` — so only the roster identity broke. The app-server daemon socket itself is intact under 0.162.0.

## The fix (A)
`startBusCore` now proactively adopts the codex thread id from the daemon as the roster `stableId`, instead of waiting for per-call metadata that never comes:
- `adoptCodexIdentity()` calls `learnStableId(codexDaemon.activeThread(self.cwd), /*authoritative*/ false)` when a codex node has no authoritative id.
- A fast initial poll (1s x up to 20, stops once an id is held) covers the ~1-2s daemon handshake; the existing 5s flush timer is the steady backstop (late daemon / thread drift).
- `activeThread(self.cwd)` is the SAME cwd-UNAMBIGUOUS resolver delivery already trusts (`pickThreadForCwd`: unique-cwd thread, else sole loaded, else undefined -> skipped).
- NON-authoritative: `learnStableId` already guards — a guess never overrides an existing id, and real call metadata (if it ever returns) upgrades it to authoritative. Restart-stable: the same thread id each `codex resume`.
- Covers BOTH the lazy MCP node and the presence daemon (both run `startBusCore`).

## Boundaries
- A is pure agenthop code (one function, `packages/bus/src/core.ts`); no user config touched, no user gate.
- The daemon-adopt path already existed on INBOUND (`handleInbound` line ~209, non-authoritative); this only makes it PROACTIVE so an idle codex seat (no inbound, no metadata) is addressable too.
- No change to delivery (already works) or to the bus protocol.

## Acceptance
Restart a codex seat (`codex resume <thread>`): within a few seconds `agenthop_peers` shows it as `codex:dir-<shortId>` (not `unknown`) and `agenthop_send` to that handle delivers. B (hooks) additionally restores the status banner for an idle seat with no MCP node (happycapy) — user-gated.

## Gates
- bus tsc 0. `codex-pick` (pickThreadForCwd, 8) + `resolve` + `bus-identity` tests pass (22) — the identity-relevant suite.
- The worktree's other bus-vitest failures are a PRE-EXISTING env baseline on `main bdd93d7` in a fresh worktree (live codex daemon / relay / real-git): 35 failing WITHOUT this change, 34 WITH it — this change adds none (net -1).

## Reviewer notes / self-flags
- cwd-ambiguity: two codex seats in the SAME cwd -> `activeThread` returns undefined -> neither is daemon-adopted (stays `unknown` until an authoritative call). Acceptable (the seats here are distinct-cwd); flag if a stronger disambiguation is wanted.
- A daemon-adopted id is a GUESS (non-authoritative) used for roster findability; delivery still locks to the authoritative/own-thread path. This matches the existing inbound-adopt semantics.
