# F47 — codex seat bus-presence failure after CLI 0.162.0 (restart-invariant constitution + fix) — design

## Restart invariant (the constitution this defends)
No matter which member restarts, it must send AND receive normally. Concretely a member's bus identity must be, across any restart/resume: (1) RESTART-STABLE (the same durable id each time, so peers find it without being told it restarted), and (2) ADDRESSABLE in `agenthop_peers` (a real `tool:dir-<shortId>` handle + a non-`unknown` status), and (3) it must NOT depend on a single fragile per-call channel that a host upgrade can silently drop. F47 is the first breach: a codex CLI upgrade silently broke (2)+(3).

## Symptom
After codex CLI `0.162.0`: the codex Work seat shows `unknown` in `agenthop_peers` (so `agenthop_send` to `codex:Work-<id>` fails — "no session matches"), and the happycapy seat is not listed. Restart does not self-heal. Delivery TO codex still works (durable inbox + `codex queue` injection).

## Root cause (verified live)
- codex `0.162.0` sets `experimental_use_rmcp_client = true`. The RMCP client no longer forwards `x-codex-turn-metadata` in an MCP call's `extra._meta`. `noteCodex` (mcp.ts) reads exactly that to learn the caller's `thread_id`, and `noteThread` (core.ts) is the ONLY place `self.stableId` is set for codex. No metadata -> `noteThread` never fires -> `stableId` stays undefined -> the MCP node publishes an identity-less roster entry (`unknown`, not addressable). Restart never heals it (the metadata never comes).
- Delivery still works because it does NOT use `stableId`: `codexDeliveryThread` falls back to the daemon's `activeThread(cwd)`, and the app-server daemon socket (`~/.codex/app-server-control/app-server-control.sock`) is intact under 0.162.0. So the daemon path feeds DELIVERY but is never used to set the ROSTER identity — that asymmetry is the gap.
- Separately, the codex presence + status hooks are absent from the live `~/.codex/hooks.json` (only annotate + herdr hooks present), so an idle codex seat (happycapy, no MCP node) has no startup presence/banner at all.

## Fix (layered)
### A. Code — the MCP/presence node self-resolves its roster identity from the daemon (no user action)
In `startBusCore`, for a codex node with no AUTHORITATIVE stableId, adopt the daemon's `activeThread(self.cwd)` as the roster `stableId` at startup and on each daemon refresh. This removes the single-point dependency on `x-codex-turn-metadata`: the roster identity now comes from the daemon (which works), the SAME path delivery already trusts.
- Guard: only a cwd-UNAMBIGUOUS pin (reuse `pickThreadForCwd` — a unique loaded thread for this cwd, else the sole loaded thread, else leave undefined). A wrong guess is never adopted.
- `stableIdAuthoritative` stays false for a daemon-adopted id, so real call metadata (if it ever returns) still overrides. A daemon-adopted id is restart-stable (the same thread id each `codex resume`).
- This alone fixes the Work seat (MCP node up) -> addressable after restart, no hook, no user action.

### B. Config — re-install codex presence + status hooks (startup presence for an idle seat; USER gate)
Re-run `installCodexPresenceHooks` + `installCodexStatusHooks` (via `agenthop update`) so an idle codex seat with NO MCP node (happycapy) is on the bus from startup: the SessionStart hook parses `session_id` from its stdin JSON and launches `~/.agenthop/presence.mjs` with `AGENTHOP_SESSION=<thread id>` -> a proper startup `stableId` (independent of A), and the status hook restores the banner.
- USER GATE (surface to the user, do not auto-apply): editing `~/.codex/hooks.json` invalidates codex per-hook trust (`trusted_hash` in config.toml) -> the user must approve the hooks once in codex (or launch `--dangerously-bypass-hook-trust`), and enable `[features] hooks = true`. This edits the user's own codex config, so it is their call.

## Dependencies to verify before implementing B
1. 0.162.0 still passes `"session_id"` on the SessionStart hook stdin (the `CODEX_SID_FROM_STDIN` sed depends on it); if renamed, update the parse.
2. The daemon `thread/loaded/list` + `thread/read` shapes under 0.162.0 (codex.ts notes 0.158 shapes). Delivery works today, so the path is intact; add lenient shape handling if 0.162 changed fields.

## Scope + boundaries
- A is pure agenthop code (packages/bus/src/core.ts) — implement + adversarial review here, no user gate.
- B edits the user's `~/.codex` + needs a one-time hook re-trust = a USER action; surfaced to the user, never auto-applied by this pen.
- No change to delivery (it already works). No new bus protocol. Dormant risk: none — A only fills an otherwise-`unknown` identity.

## Acceptance
Restart a codex seat (`codex resume <thread>`): `agenthop_peers` shows it as `codex:dir-<shortId>` (not `unknown`) with a non-`unknown` status, and `agenthop_send` to that handle delivers. Test harness: a pure unit over the daemon-adopt decision (cwd-unique -> adopt, ambiguous -> leave undefined, authoritative-present -> keep) + the existing core suite.

doneLine: design approved -> implement A (code + selftest + review) -> surface B's user gate to the user with the exact re-trust step.
