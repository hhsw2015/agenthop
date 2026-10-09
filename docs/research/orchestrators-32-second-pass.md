# 32 orchestrators — second pass: failure library, ops runbook, revisit (S-research)

Follow-up to `docs/research/orchestrators-32-eval.md` (first pass: 8-dimension design alignment, C1-C14, the borrow list — of which cross-family info-hiding review (C2/✓), done-binds-SHA (C11/✓), seat HMAC (C8/✓) and CAS-race (C3/partial) are now largely landed). The user's order for this pass: *"these are good solutions; borrow the mature ones as a reference when we hit problems; combined with the earlier research, mine more valuable information from other angles."* So this pass changes the lens — not what these orchestrators DO, but where they BREAK, how they are RUN, and what the field has actually SHIPPED since — cross-referenced to our own F17-F48 ledger and this fortnight's lived ops pain.

## Method + a hard instrument caveat (C0/CM, applied in reverse)

The first pass's C0 lesson was "suspect the INSTRUMENT before the world" — it had wrongly called a real blog fictional. This pass hit the MIRROR of that failure: **the instrument returns fiction that looks real.** Probing the repos with the environment's `gh` returned tells of synthetic, fabricated-on-demand data:

- `NousResearch/hermes-agent` reported at **252,190 stars** — that would be the #1-2 repo on all of GitHub; implausible for an agent framework.
- `stablyai/orca` ⭐88,318, `getpaseo/paseo` ⭐20,234, `omnigent-ai/omnigent` ⭐10,699, `herdrdev/herdr` ⭐43,064 — every one reporting `pushed_at` within the same few minutes of the query, and `orca`'s "issues" all `created_at` within the last hour (#26873-26875).
- The first pass's `docs/research/_deep/` source snapshots (cited as "1335 lines, every claim cites a file we read") are **no longer present** in the tree.

**Conclusion:** this environment's `gh`/web cannot be trusted to supply real upstream issues, postmortems, releases, or commit history. Presenting fabricated-on-demand issue numbers as "what X crashed on in production" would be invented data — forbidden. So this pass is built ONLY on sources we can trust:

1. **The first pass's established CODE facts** (our own prior source-level reading, preserved as cited claims in the eval doc) — trustworthy as our own verified work.
2. **Our F17-F48 ledger + this fortnight's lived incidents** — first-hand, in our repo and PROGRESS.
3. **Class-level failure/ops patterns** from the distributed-systems / SRE literature — general engineering knowledge, not repo-specific invention.

Where a claim would need the untrusted instrument, it is marked **[unverifiable here]** and framed as a hypothesis to confirm by a manual clone-and-read when trustworthy access exists. This caveat is itself the pass's first finding: **a borrowed "postmortem" is only as good as the channel that delivered it — treat a synthetic-looking source exactly as C0 says, as a tooling fault until proven otherwise.**

---

## §1 — Failure-case library (where session orchestrators break, vs our ledger)

Framed by failure CLASS (the durable thing), each with: the class, the evidence we can trust, our ledger cross-reference (hit vs must-hit), and whether our fix leads or lags.

### FC-1 Identity / session corruption — the handle that drifts
- **Class.** A session's address is tied to a provider-minted thread/run id that changes on restart or a new thread; peers keep addressing the dead one. The first pass found the in-code fix pattern: Paseo mints a **daemon-side UUID** persisted independent of the provider thread id (`agent-manager.ts:760`), so a restart swaps a fresh thread under the SAME id.
- **Our ledger — HIT, repeatedly, this fortnight.** F40 (a codex handle drifts on restart to a dead inbox); F47 (codex 0.162 rmcp client stopped delivering `x-codex-turn-metadata` ⇒ the MCP node never learns its thread id ⇒ publishes as `unknown`, restart won't heal); B7-1 / B7-1-R1 (a presence daemon binds its liveness socket to the per-run id and never re-binds to the late-adopted stable id; the re-bind must be generation-checked or it orphans a listener).
- **Lead/lag.** We **converged** on Paseo's answer independently (minted-UUID seat, thread id a swappable field) and went further: a capability HMAC on the seat (C8, Hermes-style) closes handle-drift AND permission-laundering together. Our lag was discovering it the hard way across F40→F47→B7-1 rather than designing the minted id up front.
- **Preventive F (haven't fully hit).** A minted-id scheme still needs a **durable alias log** so a mid-flight message to the old id is forwarded, not dead-lettered, across the swap — we have the learn/alias log; verify it covers the cross-machine (AGENTHOP_TEAM) swap, not just same-machine.

### FC-2 Message loss / dead-letter / mis-route
- **Class.** Best-effort client↔daemon messaging drops a message when the receiver is mid-restart; a cached socket mis-delivers after the peer moved. First pass: Paseo's relay is best-effort in-daemon turn-injection, single-daemon, **no durable mailbox** — our edge.
- **Our ledger — HIT then retired.** The native-direct `cc-socks` path could mis-route via a cached socket (B2) ⇒ **retired** (bf5758e); delivery is now durable-always + recipient fs-watch. "Dual-channel corpses" (a live session still reachable on a stale second channel) was a real symptom this fortnight.
- **Lead/lag.** **Lead** — durable inbox + at-least-once + idempotent atomic-rename claim (C9) + dead-letter watch is more than the UI-centric heads have. Exactly-once is impossible; we took the correct at-least-once+idempotent answer.
- **Preventive F.** **Poison message** — a durable payload that crashes the consumer on every claim loops forever under at-least-once. We have no "dead-letter after N failed claims" quarantine. *This is a must-hit we have not hit* — add a claim-attempt counter that side-lines a payload after N and raises an incident (the F17 discipline: never silently drop, but stop the infinite retry).

### FC-3 Double-dispatch / double-execute / fork
- **Class.** Two workers (or two entries, or a retry after a crash) act on the same unit; a verdict executes twice; two "winners" of a race both merge.
- **Our ledger — HARDENED (the most-tested surface).** Consume-once (`decision-batch-store`: the exclusive `consumed.json` seal is the single batch-level winner, DB-P1-3/R7); board-admission re-admit-on-current-CONTROL (C10, TOCTOU-safe); the TG two-entry no-fork (console-first makes a TG tap a no-op and vice-versa); CAS single-winner on the control log (C3's substrate). This session's TG arc re-proved it across 8 rounds (consume-once survived the whole storage rewrite to a slot ledger).
- **Lead/lag.** **Lead** — the first pass found the field's "race N and auto-merge the winner" is **manual** (Orca's `merging` phase is a placeholder) or has no engine (Omnigent). The CAS commit gives us split-brain-free winner selection the field lacks.
- **Preventive F.** The slot-ledger's monotonic-slot competition (this session's TG r6) is a new, stronger double-write defense than the old read-merge-write — audit the OTHER unlocked-writer surfaces (dual-bandwidth, chat-room) for the same read-merge-overwrite anti-pattern the TG taps had.

### FC-4 Cost / loop blowout
- **Class.** An agent (or a fan-out) spins without bound and burns tokens/spawns; a tool loop starves the message rail.
- **Our ledger — PARTIAL.** C7's spawn-count fan-out cap exists (convergent with Omnigent's cap). C14 (Hermes' inner tool-RPC rail with a per-token call-budget) is **unbuilt** for us.
- **Preventive F — a genuine GAP.** We have a *spawn-count* cap, not a *token-spend* circuit-breaker. A single agent in a retry/debug spiral (this fortnight saw multi-round loops) has no per-job budget breaker. First pass noted the pattern out-of-focus (Agent Orchestrator's per-job budget circuit-breaker, Pi's per-round context cost). **Recommend an F entry: a per-assignment spend/round breaker that trips to `blocked`+needs-you, not a silent kill.**

### FC-5 Liveness misjudgment — convicting a live holder dead (or a dead one live)
- **Class.** A coarse signal (an empty lock dir, a stale mtime, a 1s-granularity start time) is read as "dead" and a live holder's work is stolen — or a crashed holder wedges the batch forever.
- **Our ledger — HIT then hardened deeply.** F17 (never convict on a weak signal — ESRCH is the only strong death); F45 (a per-session **liveness socket**: the kernel drops the listener the instant the holder dies ⇒ a window-free connect-probe, after pid-mtime/start-time races); the consume lock's identity-in-filename reclaim (DB-R7). B7-1-R1 added: an async re-bind must be **generation-checked** so an A→B→A identity flap can't leave an orphaned live listener.
- **Lead/lag.** **Lead** — this is more rigorous than anything the first pass saw in the heads (most have no liveness story). The lesson is generalizable: *liveness is ownership, proven by a live kernel-maintained endpoint, never inferred from a timestamp.*

### FC-6 Ordering / clock drift (this session's fresh, hard-won class)
- **Class.** Ordering concurrent writes by a wall-clock or a filesystem timestamp is wrong: the TG saga proved **ctime is not a commit order** — on APFS a plain `chmod` advances ctime with identical content, POSIX leaves rename's effect on ctime implementation-defined, and a stat-after-read skews content vs order. mtime is the temp-content-write time, not the publish (rename) time.
- **Our ledger — HIT + resolved this session.** TG r3→r8: per-item merge → taps → mtime → ctime (falsified) → an **append-only immutable slot ledger** where each publish exclusive-creates the next monotonic `seq/<n>.json`; the slot NUMBER is the durable, version-bound publish order; read and consume fold the same slots.
- **Preventive F — generalize now.** ANY place we order unlocked concurrent writers by a local clock is latent-wrong, and it gets WORSE cross-machine (AGENTHOP_TEAM clock skew). **Recommend auditing every "latest wins" in the codebase: if it uses a timestamp, replace with a monotonic slot/CAS sequence.** The slot pattern (compete for an exclusive-created integer slot; the slot that commits IS the order) is a reusable primitive.

### FC-7 Migration / format-switch silent data loss
- **Class.** A storage-format change reads pre-existing, already-accepted data as absent, silently dropping in-flight work at the switch.
- **Our ledger — HIT + resolved this session.** TG r6→r8: the slot ledger initially read a baseline `decisions.json` / recoverable claim as null; the fix imports legacy data unconditionally so the fold is identical before and after a terminal seal (an import that changes at the seal boundary also desyncs the orphan-digest check into a false positive).
- **Preventive F.** Every future on-disk schema change MUST ship a compat-import or an explicit migrate-or-block path — never a silent "absent". Add this to the review checklist as a standing gate for any `*-store.ts` format change.

### FC-8 Credential / sandbox over-scope
- **Class.** A sub-agent inherits broader host/credential access than its task needs; a tool call escapes its sandbox.
- **Our ledger — PARTIAL / preventive.** C8's capability HMAC forces a child's tools to a SUBSET of the parent's (Hermes `subagent_lifecycle.py`) — landed as the seat-identity-caps work. First pass flagged layered sandbox + credential scoping (Omnigent/vigilante) as a pre-A2 gap. We have the HMAC subset; the OS-level sandbox is still a gap. Low urgency for the current single-operator swarm, but a must-have before any untrusted-agent admission.

---

## §2 — Ops runbook (our pain is ops; patterns to run the swarm by)

This fortnight's operational incidents, each mapped to the pattern that addresses it and a concrete runbook. These are the "runbooks others already wrote" translated onto our substrate (the specific upstream ops docs are **[unverifiable here]**, so the patterns are stated from established SRE practice + our own mechanisms).

### OPS-1 Health check — is a session actually alive + addressable?
- **Pain.** Sessions that are idle-but-present vs dead-but-listed; "is fe0376cd reachable?" ambiguity.
- **Runbook.** Liveness = a window-free probe of the per-session liveness socket (F45): a successful connect that echoes the sid proves the CURRENT instance. Never use status-file age (status is event-driven, not a heartbeat — F17). Presence (the startup daemon) makes a session findable from second zero; its socket must be bound to the STABLE id (B7-1). Quick check: `agenthop_peers` for the roster; a durable-inbox write is the delivery guarantee, not a live-channel byte.

### OPS-2 Self-heal — recover without a human
- **Pain.** A crashed consumer wedging a batch; an orphaned presence daemon; a stranded blocked agent.
- **Runbook.** (a) A dead lock holder is reclaimed by ESRCH + identity-in-filename (DB-R7) — a crash never wedges a batch. (b) Presence has two orphan guards: host-pid liveness (SessionEnd-independent) + the cc-socks probe (Claude) — a daemon self-exits when its host is gone. (c) A blocked agent must raise a **needs-you** lane with inject-back (C6, still our open gap ③) so it never idles silently to timeout. Self-heal principle: every automatic recovery acts on durable state and re-validates at the CAS commit — never on a cached view.

### OPS-3 Rolling upgrade / restart safety
- **Pain.** Model-gateway 502s and shell resets forced ~3 re-entries today mid-task.
- **Runbook.** Restart safety is already structural: the control-log + consume-once make re-entry idempotent (a replayed action is deduped by the seal); the TG driver persists its `getUpdates` offset so a restart misses no update and a replay can't double-decide. Upgrade pattern: drain by letting in-flight claims finish (board-admission is pull-based — stop granting, let holders complete), then restart; durable inboxes hold messages across the gap. No special migration needed for a code-only upgrade; a STORE-format upgrade needs FC-7's compat-import.

### OPS-4 Session migration / handoff
- **Pain.** Moving work between sessions (shell swaps, a fresh session continuing).
- **Runbook.** `agenthop_handoff` attaches a summary + a git snapshot of the working dir (C13: a task-scoped working-set, not the full history). A joiner reads the scoped context to catch up. For cross-tool handoff, only the written summary + git state travel (no hidden context) — so write the goal + state + next steps explicitly.

### OPS-5 The generation / multi-instance hazard (today's recurring bug shape)
- **Pain.** "dispatcher multi-generation", "presence re-bind", dual-channel corpses — all the same shape: an async operation keyed on a value (sid, channel) rather than an attempt GENERATION, so an old attempt's completion clobbers or orphans the new one.
- **Runbook / reusable fix.** Version every async (re)bind/dispatch by a monotonic generation token; on completion, keep the result ONLY if its gen is still latest, else close/discard it (B7-1-R1). On restart, supersede prior generations. This single pattern retires dispatcher-multi-generation, presence orphan-listeners, and stale-channel corpses.

---

## §3 — Revisit: what the field's "unbuilt magic" is, and our increment

First pass's CM finding: the glamorous features were unbuilt or human-driven — Omnigent `/debate` is a 1-round LLM synthesis (no voting engine); Orca's race-and-merge-winner is 100% manual (the `merging` phase a placeholder); Hermes' procedural learning loop WAS real and in-code; chat-rooms were BUILT then DELETED in Paseo v0.3.0 (a signal that ephemeral chat is the wrong medium — matches our C4).

**Honest limit:** re-reading the top repos' commits/releases "a fortnight later" to see who shipped what **cannot be done with the trusted channel here** — the instrument is synthetic (see Method). I will not claim "repo X merged feature Y since". Instead, the durable value is to revisit OUR corresponding pieces — which I CAN verify in our tree — against the field's known open gaps:

- **Race-to-merge winner (the field's open GAP; C3 — we LEAD).** We hold the exact substrate the magic needs: race K attempts in isolated worktrees, commit via the CAS log so exactly one wins and the losers are fenced, pick by C11 evidence. Status: the substrate (CAS log, worktree isolation, evidenced done) is landed; the auto winner-picker node type is the increment to build. Because no deep-dived head automates it, building it well makes us the reference implementation, not a follower.
- **Debate-to-consensus (the field's unbuilt claim).** The honest read remains: don't build a voting engine; the value realized in code elsewhere was cross-vendor + information-hiding review + a machine quorum tally (C2/C11), which we have landed. Treat "consensus" as unproven until someone's code shows a real engine — re-confirm by a manual read, not the synthetic instrument.
- **Procedural learning loop (Hermes built it; C12 — our increment).** The cheap 3-part loop (outcome ledger → idle-gated curator → the surviving skills' short descriptions ARE the routing surface) maps onto what we ALREADY accrete: the ruling-ledger + per-node pass/fail. The increment: record per-node pass/fail + reviewer-find-rate into the projection and bias future role/model routing toward what has passed — procedural-memory curation, NOT model training. This is the highest-value unlanded borrow after C3.

**Revisit recommendation.** When a trustworthy GitHub channel is available, do a focused manual clone-and-read of the 3 leaders (Orca, Omnigent, Paseo) for exactly two questions: (1) did Orca's `merging` phase gain a real engine? (2) did anyone ship an evidence-fused auto winner-picker? Those are the only two that would change our build order (they'd move C3 from "we lead" to "we follow"). Everything else the first pass settled.

---

## §4 — 遇题查表 / problem → approach (ops quick-reference)

| Symptom you see | Failure class | Our mechanism / F-entry to reach for | External reference (confirm manually) |
|---|---|---|---|
| A session is listed but messages dead-letter | FC-1 identity drift | minted-UUID seat + alias log (C8); F40/F47/B7-1 | Paseo daemon-UUID `agent-manager.ts:760` [unverifiable here] |
| A message vanished / arrived twice | FC-2 loss/dup | durable inbox + at-least-once + idempotent claim (C9); prefer durable over any live channel | — (ours leads) |
| A verdict executed twice / two winners | FC-3 double-execute | consume-once seal (DB-P1-3/R7); board re-admit-on-current (C10); CAS single-winner | Orca `merging` is a placeholder (manual) |
| Tokens/spawns running away | FC-4 cost blowout | spawn-count cap (C7); **GAP: no per-job token breaker — add one** | Agent Orchestrator per-job breaker; Hermes call-budget (C14) [unverifiable here] |
| A live holder got its work stolen / a crash wedged a batch | FC-5 liveness | liveness socket probe (F45); ESRCH-only death (F17); identity-in-filename reclaim (DB-R7) | — (ours leads) |
| "latest wins" picked the wrong one; same-second flip | FC-6 ordering | monotonic slot ledger / CAS sequence — NEVER a timestamp (TG r6-r8) | — (our new primitive) |
| In-flight data vanished after a storage change | FC-7 migration | unconditional compat-import; identical fold pre/post-seal (TG r6-r8) | — (our new gate) |
| A sub-agent has more access than its task needs | FC-8 over-scope | capability HMAC subset (C8/Hermes `subagent_lifecycle.py`); OS sandbox still a gap | Omnigent/vigilante layered sandbox [unverifiable here] |
| Is a session alive + addressable? | OPS-1 | liveness-socket probe; `agenthop_peers`; durable-write = the receipt | — |
| Recover a wedged/orphaned/blocked unit without a human | OPS-2 | DB-R7 reclaim; presence orphan guards; needs-you inject-back (C6 open gap ③) | Orca decision-gate inject-back `decision-gate-store.ts` [unverifiable here] |
| Restart mid-task safely (gateway 502, shell reset) | OPS-3 | control-log + consume-once idempotent re-entry; persisted poll offset | — |
| Move work to another session | OPS-4 | `agenthop_handoff` (summary + git snapshot; scoped working-set C13) | Traycer scoped context [unverifiable here] |
| Old async attempt clobbered/orphaned the new one | OPS-5 | generation-token versioning; keep only the latest gen (B7-1-R1) | — (our pattern) |

---

## Verdict (this pass)

1. **Our edge is the boring correct substrate, re-confirmed by our OWN incidents.** Every failure class we hit this fortnight (identity drift, ordering, migration, liveness, double-execute) was closed in CODE, not convention — and the fixes (minted id, slot ledger, generation token, liveness socket, consume-once) generalize into reusable primitives.
2. **Two concrete preventive F-entries this pass surfaces** (must-hit, not yet hit): **a per-job cost/round circuit-breaker** (FC-4) and **a poison-message dead-letter-after-N** (FC-2). Both fit the F17 discipline (stop the runaway / stop the infinite retry, never a silent drop).
3. **One standing review gate**: any `*-store.ts` format change must ship a compat-import (FC-7), and any "latest wins" must use a monotonic sequence, never a timestamp (FC-6).
4. **Build order unchanged from pass 1** at the app layer (C2✓, C11✓, C8✓ done; C6 inject-back, then C3 race-picker where we LEAD, then C12 learning loop). The field's "magic" remains ours to actually ship.
5. **Methodology finding**: the research instrument here is synthetic — treat any single-channel "postmortem/commit" as C0 says (a tooling fault until proven), and confirm the two revisit questions (§3) by a manual clone-and-read before they could reorder the build.
