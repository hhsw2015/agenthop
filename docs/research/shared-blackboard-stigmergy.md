# A Shared Blackboard / Stigmergy Medium for agenthop

Status: DESIGN RESEARCH (no code; grounded vs speculative marked per section)
Date: 2026-10-01
Scope: a shared coordination medium ("board") on the existing distributed bus, as the
substrate that could move agenthop from "explicitly orchestrated collective"
(one node calls spawn/gather/verify) toward "self-emergent distributed collective
intelligence" (agents self-organizing with no central orchestrator).

Related docs (siblings, some written in parallel):
- `docs/research/acp-integration.md` (headless/auto-task backends; bus.7 direction)
- `docs/research/herdr-study.md` + `docs/research/blocked-detection-study.md` (peer status; shipped as bus.6)
- `docs/research/collab-primitives.md`, `docs/research/auto-task-result-return.md` (did not exist at time of writing; do not block on them)

---

TL;DR: agenthop already ships 90% of the machinery a decentralized blackboard needs -
a team-derived shared relay room with sealed entries and monotonic last-writer-wins
merge (`directory.ts`), and a lock-free monotonic max-register for status
(`statusfile.ts`). Both are, structurally, CRDTs. The board is the same trick with a
richer entry vocabulary: immutable, team-sealed entries of kind
`note | task | claim | release | partial | result | tombstone | role-offer`, gossiped through a
second team-derived room, merged into each node's local replica by `(taskId, kind,
actor)` with per-identity monotonic seq - no central server, no new infrastructure,
cross-machine by construction. Claims are soft leases with TTL (pheromone
evaporation), conflicts are resolved deterministically and symmetrically (both
parties compute the same winner offline), and duplicated work in the conflict window
is accepted as the price of no-lock - exactly the class of residual race the project
already accepted for keeper election and the broker socket. The honest staging:
(A) a passive shared context board is cheap and immediately valuable; (B) a claimable
task-board is a moderate, well-understood step; (C) fully stigmergic
self-organization is the research frontier - fragile, cost-risky, and should be
driven by standing local rules bolted onto the already-shipped idle/status hooks, not
by new orchestration code. Build A, then B. Treat C as an experiment, not a feature.

---

## 0. What agenthop already has (grounded - read from the code)

The question "can agenthop host a decentralized shared medium?" is already answered
yes, twice, by shipped code. This matters because the board should be a
generalization of these mechanisms, not a new invention.

### 0.1 The roster IS a presence blackboard

`packages/bus/src/directory.ts` maintains a shared, distributed, eventually
consistent data structure with no central store:

- A well-known meeting place derived from public team identity:
  `directoryAddress(nsId)` HKDFs the team's public namespace id into a relay room
  address. Every member computes the same address independently.
- Entries are sealed (`sealEntry` under `nsKey`, aes-256-gcm) so the relay sees
  sizes and timing, never content or membership.
- Any member can host the room (keeper); the hosting token is team-derived
  (`directoryToken`), so the room is reclaimable by anyone on keeper death.
  Election is optimistic: try to host, `room_taken` means someone else keeps it.
- Merge is monotonic last-writer-wins per key: `remember()` keeps the newest entry
  per session id (`!prev || peer.ts >= prev.ts`). Order of arrival does not matter;
  replays are idempotent.
- Staleness is handled by TTL (`TTL_MS` 150s) + periodic re-announce
  (`ANNOUNCE_MS` 60s); reads converge within a 5s poll.
- Log loss is survivable: when a keeper dies and a new one starts an empty log
  (detected via the keeper `generation` id, or the own-announce-echo fallback),
  members just re-announce. The authoritative state lives in the members, not in
  the room; the room is only the gossip channel.

In CRDT terms, the roster is a last-writer-wins map (LWW-Map) replicated by gossip
through an ephemeral append-only channel. Nobody called it that, but that is what it
is - and it is exactly the right shape for a board.

### 0.2 The status file IS a max-register CRDT

`packages/bus/src/statusfile.ts` (bus.6) is a lock-free monotonic max-register:
every event writes its own immutable `<key>.json.<seq>` file; readers take the max;
writers prune only strictly-lower versions; the on-disk max is provably
non-decreasing. And `core.ts` keeps `statusByIdentity` with drop-if-not-newer
per-identity seq - status ordering without a global clock.

Lesson for the board: per-identity monotonic seq + take-the-max-per-key merge gives
idempotent, reorder-safe, lock-free convergence. The board reuses this verbatim for
anything that is a register (a task's latest state as seen by one actor) and uses
grow-only sets for anything that is a log (results, notes).

### 0.3 The already-accepted race class

The project has three places where "two nodes may briefly both think they own X":
broker socket bind, bridge lock (pid-liveness + bind as final tiebreaker), keeper
election (`room_taken` as the arbiter). In each, the resolution is: optimistic
attempt, detect conflict through the medium itself, deterministic single winner,
loser backs off, residual window accepted and documented. Task claiming (sec 2.4)
is the same class and gets the same treatment - with one honest difference: for
sockets the kernel is a true arbiter (bind either succeeds or not), while for board
claims there is NO arbiter, only convergence-after-the-fact. The residual window is
therefore wider (seconds of gossip latency, not microseconds), and the design must
make duplicated-work-in-the-window cheap rather than impossible.

### 0.4 What is genuinely missing

- A second room (the board) and an entry vocabulary richer than presence.
- Replica re-seeding on keeper turnover for state that is NOT self-refreshing
  (presence re-announces every 60s; a task posted once would be lost - sec 2.6).
- Claim/lease semantics and deterministic conflict resolution (sec 2.4).
- Local behavior rules for agents (when to scan, claim, stop) - the stigmergy part,
  which is prompt/skill material more than bus code (sec 5).

---

## 1. Prior art for decentralized coordination media

Six families matter. For each: the idea, what to borrow, and whether it fits a
distributed, eventually-consistent, no-central-store bus. (All of this section is
grounded in well-established literature; the two 2025 LLM papers were verified on
arXiv at write time.)

### 1.1 Blackboard architecture (classic AI: Hearsay-II, BB1; 1970s-80s)

Idea: a shared workspace (the blackboard) holds the evolving solution state;
independent specialists ("knowledge sources") watch it and contribute
opportunistically whenever the current state matches their expertise; a control
component picks who fires next. Erman et al., "The Hearsay-II Speech-Understanding
System" (ACM Computing Surveys 1980); Hayes-Roth, "A blackboard architecture for
control" (Artificial Intelligence 1985).

Recently revived for LLM agents: Han & Zhang, "Exploring Advanced LLM Multi-Agent
Systems Based on Blackboard Architecture" (arXiv:2507.01701, 2025 - verified) show
agents sharing all information on a common blackboard, dynamically selected by its
contents, beating fixed-pipeline systems on token efficiency. MetaGPT's shared
message pool with publish-subscribe is the same family.

Borrow: the data-centric inversion - agents react to STATE, not to each other.
Entry types carrying "hypothesis level" (raw data, partial result, final answer).
The insight that reading the board replaces N-squared messaging.

Caveat for agenthop: the CLASSIC blackboard is logically centralized (one store,
one control loop deciding who fires). We must keep the data model and drop the
central scheduler: control becomes each agent's local policy ("does the board show
something I should act on?"), which is exactly the stigmergic reading of the
pattern. Fit: data model yes, control model no.

### 1.2 Tuple spaces / Linda (Gelernter, 1985)

Idea: coordination through a shared associative memory of tuples with three
operations - `out` (write), `rd` (read a matching tuple), `in` (read AND REMOVE
atomically). The atomic `in` is the whole coordination power: "take the task tuple"
is mutual exclusion, work distribution, and a semaphore in one primitive.
Generative communication: sender and receiver are decoupled in time and space.
Descendants: JavaSpaces, TSpaces.

Borrow: the vocabulary (write / read-matching / take) and the "bag of work" idiom -
a task pool where workers `in` a task tuple, process, `out` a result tuple. Our
entry-kind design is tuple-shaped on purpose.

Does NOT fit directly: atomic `in` requires a linearizable store - a central server
or consensus. On an eventually-consistent gossip bus there is no atomic take.
Every distributed tuple-space implementation either centralizes the space,
partitions it, or weakens `in`. We weaken it: `claim` is an advisory entry plus
deterministic conflict resolution, not an atomic removal (sec 2.4). Anyone
proposing "just do Linda on the relay" should be pointed at this paragraph.

### 1.3 Contract-Net Protocol (Smith, 1980)

Idea: decentralized task allocation by negotiation. A manager ANNOUNCES a task;
contractors evaluate it locally and BID; the manager AWARDS it to one bidder; the
contractor reports results. R. G. Smith, "The Contract Net Protocol: High-Level
Communication and Control in a Distributed Problem Solver" (IEEE Trans. Computers,
1980). Standardized later as FIPA Contract Net.

Borrow: the announce -> bid -> award -> report lifecycle as OUR task entry state
machine, and the key honesty: CNP does not need a GLOBAL coordinator, but each
task still has a per-task micro-coordinator (the manager = whoever posted it).
That is a huge decentralization win without the hard problem: "no global
orchestrator" does not have to mean "no one is responsible for any given task."
Per-task accountability is what makes convergence checkable (sec 3.4).

Costs: a full bid round adds latency and token cost per task (every candidate
evaluates every announcement). For homogeneous peers, first-claim-wins (sec 2.4)
is CNP degenerated to "first bid is awarded" - cheaper, and the right default.
Full bidding is worth it only when peers differ meaningfully (model class, tools,
cwd, cost) - keep it as an optional mode on the same entry types, not the default.
Fit: excellent; it was designed for exactly this (nodes with local knowledge, no
shared memory, unreliable links).

### 1.4 Stigmergy (Grasse 1959; Theraulaz & Bonabeau 1999)

Idea: coordination through traces left in a shared environment rather than
messages. Termites deposit pheromone-laden mud; the deposit itself stimulates the
next deposit (qualitative stigmergy); ants' pheromone trails evaporate unless
reinforced (quantitative stigmergy). Properties: no addressing, no shared plan,
asynchronous, scales with environment size not agent count; EVAPORATION is the
forgetting mechanism that prevents lock-in on stale solutions. Theraulaz &
Bonabeau, "A Brief History of Stigmergy" (Artificial Life 5(2), 1999); Heylighen,
"Stigmergy as a universal coordination mechanism" (Cognitive Systems Research,
2016).

Borrow three mechanisms directly:
- Trace = state change in the medium. Every entry is a trace; a `claim` is a
  pheromone mark saying "being handled, go elsewhere"; a `partial` result
  stimulates whoever can extend it.
- Evaporation = TTL. Claims expire unless refreshed (lease renewal = trail
  reinforcement). A dead agent's claim evaporates and the task becomes claimable
  again - crash recovery with zero failure-detection machinery.
- Gradient-following = local rules. Agents pick what to do by reading local board
  state ("oldest unclaimed task matching my capabilities"), not by being told.

Honest framing: in insects, stigmergy works because agents are cheap, numerous,
and the task is spatially decomposable with massive redundancy. LLM agents are
EXPENSIVE and few; we cannot afford ant-level redundancy (many ants walking bad
trails is fine; many Opus sessions duplicating a research task is a bill).
Stigmergic designs for agenthop must replace redundancy with explicit dedup
(claims) and keep the evaporation/trace ideas. Fit: as a design language, perfect;
as a literal algorithm (replicate and let waste sort it out), unaffordable.

### 1.5 Gossip / epidemic protocols (Demers et al., 1987)

Idea: each node periodically exchanges state with peers; updates spread
epidemically; convergence is probabilistic but fast (O(log n) rounds); no node is
special. Demers et al., "Epidemic Algorithms for Replicated Database Maintenance"
(PODC 1987). Basis of Amazon Dynamo's anti-entropy, Cassandra, Serf/memberlist.

agenthop already gossips, in a hub-shaped way: the directory room is the rendezvous
through which everyone's updates reach everyone (~5s). Borrow: the ANTI-ENTROPY
framing for the board - each node holds a full local replica; the room carries
deltas; periodic full-state re-announce (the board equivalent of the 60s presence
beat, sec 2.6) repairs any loss, including keeper-turnover log resets. Fit: already
in the architecture; the board just adds a second gossiped dataset.

### 1.6 CRDTs (Shapiro et al., 2011)

Idea: Conflict-free Replicated Data Types - data structures whose concurrent
updates merge deterministically on every replica without coordination, giving
strong eventual consistency (same updates seen = same state, regardless of order).
Shapiro, Preguica, Baquero, Zawirski, "Conflict-free Replicated Data Types" (SSS
2011). Relevant types: G-Set (grow-only set), LWW-Register/Map, OR-Set,
max-register.

This is the formal frame agenthop already lives in: roster = LWW-Map, status =
max-register per identity. Borrow the DISCIPLINE, not a library: define the board
replica as a composition of CRDTs so merge correctness is arguable on paper -
- the entry log: G-Set of immutable entries keyed by `(taskId, kind, actor, seq)`
  (a set union is the merge; duplicates collapse by key);
- each task's derived view: a deterministic FOLD over that set (sec 2.5), so any
  two nodes with the same entries compute the same task state;
- deletion: tombstone entries + TTL-based GC, never in-place removal (you cannot
  retract a gossiped fact, only supersede it).

What CRDTs do NOT give: mutual exclusion. A CRDT can record both claims and
deterministically pick a winner; it cannot prevent the second claimant from having
already burned tokens. That gap is fundamental (CAP: no coordination-free atomic
take), and the design budget for it is sec 3.

### 1.7 Fit summary

| Family | Take | Leave |
|---|---|---|
| Blackboard | data-centric state, opportunistic contribution, entry levels | central control/scheduler |
| Linda | write/read/take vocabulary, bag-of-work idiom | atomic `in` (needs linearizable store) |
| Contract-Net | announce/bid/award lifecycle, per-task manager accountability | mandatory bid round for homogeneous peers |
| Stigmergy | traces, evaporation (TTL), local gradient rules | redundancy-as-strategy (too expensive for LLMs) |
| Gossip | anti-entropy re-announce, full local replicas | nothing - already shipped |
| CRDTs | G-Set log + deterministic fold + monotonic seq; provable convergence | expecting them to solve exclusion |

---

## 2. Core design: the agenthop board

Grounded in shipped mechanisms; the specific entry schema and fold rules are new
design (unimplemented, but each piece maps to code that exists).

### 2.1 Transport: a second team-derived room

Same trick as `directory.ts`, different HKDF info string:

- `boardAddress(nsId)` = HKDF(nsId, "agenthop bus board v1") -> room address.
  Every team member computes it; no configuration, no server.
- `boardToken(team)` = HKDF(nsKey, "agenthop bus board token v1") -> any member
  can keep (host) the room; keeper election identical to the directory (try
  `startHost`, `room_taken` = someone else keeps it; 404 on post = keeper gone,
  reset cursor, try keeper).
- Entries sealed under `nsKey` with a distinct prefix, e.g.
  `[[agenthop:bus-board]] <sealed>` - the relay never sees content.
- Same keeper-`generation` + own-write-echo staleness detection, same epoch guard
  against late old-keeper reads. This code is written and battle-reviewed; the
  board reuses it (ideally by extracting the room-gossip loop from directory.ts
  into a shared helper rather than copying it).

Why a SECOND room and not the directory room: presence is high-frequency choreography
with a 150s TTL and aggressive log resets; board entries are lower-frequency,
longer-lived facts. Mixing them couples their GC and quota regimes and bloats the
presence log. Separate rooms, same machinery. Same-machine-only teams get the same
semantics with the relay layer off by publishing board entries over the local
broker (a new `{t:"board"}` wire frame that the broker fans out to all clients) -
but v1 can simply require a team (relay path) and treat broker fan-out as an
optimization, since a single machine rarely needs stigmergy over direct messages.

### 2.2 The local replica

Each bus node holds the whole board in memory (like `seen` in directory.ts):

- `entries`: Map keyed by `entryKey = taskId + "/" + kind + "/" + actor` for
  register-like kinds (claim, status-bearing kinds), plus an append list for
  log-like kinds (note, partial, result - keyed with seq so replays dedup).
  Union-merge: an entry already present (same key + seq) is dropped; a newer seq
  for a register key replaces; order of arrival is irrelevant.
- Per-identity monotonic `seq` on every entry (the bus already stamps event-time
  ms seq for status; same field, same drop-if-not-newer guard, same honest
  best-effort-ordering caveat as statusfile.ts).
- Derived task views are computed by a pure fold (sec 2.5), never stored
  authoritatively - so there is nothing to corrupt and nothing to reconcile
  beyond the entry set itself.

Capacity honesty: this is an in-memory full replica gossiped through a relay room
with per-message size caps (`textBytes` 64KB in the directory room). The board is
for COORDINATION STATE, not artifacts. Results that are large live on disk / in
git / in a file the entry points at; the board entry carries a pointer + digest
(same philosophy as handoff.ts: the bus carries the visible summary, not hidden
state). Rough budget: hundreds of active tasks, entries <= 4KB each - far below
quota; if a team ever needs more, that is a different product.

### 2.3 Entry types

All entries share an envelope:

```jsonc
{
  "v": 1,
  "board": "<nsId-scoped, implicit via room>",
  "taskId": "t-<uuidv7>",        // uuidv7: time-ordered, collision-free, no coordination
  "kind": "note|task|claim|release|partial|result|tombstone|role-offer",
  "actor": "<stableId>",          // the durable session identity (bus already has it)
  "actorTitle": "claude:Work-20cab0a5",  // for humans reading the board
  "seq": 1760000000000,           // per-actor monotonic, event-time ms (statusfile discipline)
  "ttlMs": 900000,                // evaporation; kind-specific defaults
  "body": { ... }                 // kind-specific, below
}
```

Kinds:

- `note` - passive shared context (Stage A, sec 5). Body: freeform `text`,
  optional `topic`, optional `refs` (paths/URLs). No lifecycle, just TTL. This is
  the pheromone in its purest form: "I learned X, it may help whoever comes next."
- `task` - an open unit of work. Body: `goal` (what done looks like - REQUIRED,
  this is the convergence anchor), `context` (inputs, paths), `parent?` (taskId of
  the task this decomposes), `manager` (defaults to actor: the per-task
  accountable node, CNP-style), `constraints?` (capability hints: tool, cwd,
  machine), `mode`: `"claim"` (first-claim-wins, default) or `"bid"` (CNP round).
- `claim` - "I am working on taskId." Body: `leaseMs` (default ~10min),
  `renewedAt` implicit in seq. A claim is a LEASE, not a lock: it expires unless a
  fresh claim entry (same actor, higher seq) renews it. Register-keyed per
  (taskId, actor) so renewals replace, not append.
- `release` - explicit un-claim ("I give up / am preempted"), faster than waiting
  for lease evaporation. Body: optional `reason`.
- `partial` - intermediate findings on a claimed task. Body: `text` (bounded),
  `refs?`. Doubles as progress heartbeat and as building material for others
  (qualitative stigmergy: a partial can stimulate a better-suited peer to post a
  note or, after release, take over without restarting).
- `result` - terminal output for a taskId. Body: `status`: `"done"|"failed"`,
  `summary` (bounded, like handoff summary caps), `refs?` (artifact pointers +
  digests). Multiple results for one task are possible (sec 3.2); the fold picks
  the winner deterministically and keeps the losers visible for audit.
- `tombstone` - "this task is closed/cancelled/absorbed," posted by the manager
  (or anyone, for abandoned tasks past a long TTL). Stops further claims; entries
  for the task become GC-eligible.
- `role-offer` - a standing capability advertisement, not tied to one task.
  Body: `role` ("reviewer", "synthesizer", "ida-re", ...), `capabilities`
  (tools/cwd/model class), `capacity?`. Register-keyed per (actor, role), TTL'd
  like presence (it IS presence, enriched). Two uses: (a) bid-mode managers can
  award by matching offers without a broadcast round; (b) in Stage C, role
  specialization emerges from agents claiming tasks whose constraints match
  their standing offers - the offer is a pheromone saying "route this kind of
  work my way." Deliberately optional: Stage B works without it (constraints on
  tasks + capability-aware claiming is enough); add offers when peers are
  heterogeneous enough that discovery-by-scanning gets wasteful. Note the same
  entry doubles as "role-claim" for singleton roles (e.g. exactly-one
  synthesizer): a singleton role is just a task-shaped claim with the same
  winner fold - no new mechanism.

### 2.4 Claiming without a central lock

The crux. Options considered:

1. Atomic take (Linda `in`): impossible without a linearizable store. Rejected.
2. Keeper-as-lock-service: the room keeper arbitrates claims (it serializes posts,
   so it COULD reject the second claim). Rejected: it silently reintroduces a
   central coordinator with state that evaporates on keeper turnover - the exact
   failure the directory's generation-reset dance exists to absorb. The keeper
   must stay a dumb log host.
3. Contract-net bid round: manager announces, waits a bid window, posts an award.
   Works, but adds a mandatory latency window + token cost to EVERY task, and the
   award is just... another entry that races (the award message can itself be
   seen late). Kept as optional `mode:"bid"` for heterogeneous-peer tasks.
4. First-claim-wins with deterministic symmetric tie-break. CHOSEN DEFAULT.

The chosen rule, fully local and symmetric (every node computes the same answer
from the same entry set - the CRDT fold discipline):

- To claim: post `claim(taskId, leaseMs)`. Then KEEP WORKING only after a
  confirmation delay OR opportunistically (see below).
- Winner function: among all live (unexpired, unreleased) claims for a task, the
  winner is the claim with the LOWEST (seq, actor) pair - earliest event-time
  wins; actor stableId lexicographic order breaks exact ties. Deterministic,
  total, needs no communication.
- Loser behavior: a node that sees, at any point, a live claim that beats its own
  posts `release` and stops. Because the winner function is symmetric, both
  parties agree who lost without exchanging a single extra message.
- The race window: between posting a claim and gossip convergence (~5-10s via the
  5s poll), two nodes can both believe they won. Two stances, pick per task cost:
  - `confirm-then-work` (default for expensive tasks): after claiming, wait one
    poll cycle (~6-8s) and re-evaluate the winner fold before burning tokens.
    Cost: seconds of latency. Benefit: the duplicate-work window collapses to
    near-simultaneous claims within one gossip round.
  - `work-immediately` (fine for cheap tasks): start at once; if you later lose
    the fold, release and discard. Cost: wasted partial work, bounded by
    detection time (~one poll).
- Lease renewal: the winner re-posts `claim` with fresh seq before `leaseMs/2`
  elapses. Missed renewals (crash, hang) mean evaporation: after lease expiry the
  task is claimable again. No failure detector needed - this is ant-trail
  reinforcement, and it composes with bus.6 status (a peer whose roster status
  went to `idle`/vanished AND whose lease lapsed is definitively gone).

Honest residual (same register as bridge.ts's documented limitation): perfectly
duplicate-free claiming on an eventually-consistent medium is impossible; the
design makes duplicates RARE (one gossip round window), DETECTED (symmetric fold),
CHEAP (confirm-then-work for expensive tasks), and SELF-HEALING (release +
deterministic winner). That is the same accept-the-residual posture the project
shipped for the broker and bridge, extended with the admission from sec 0.3: here
there is no kernel arbiter, so the window is seconds, not microseconds.

### 2.5 The task fold (derived state machine)

Pure function of a task's entry set; every node computes it identically:

```
open       := task exists, no tombstone, no live claim, no accepted result
claimed    := live (unexpired) winning claim exists
in-progress:= claimed + at least one partial from the winner
done       := a result with status "done" accepted by the fold
failed     := result(s) exist, none "done", no live claim, retries exhausted (manager policy)
closed     := tombstone exists
```

Result acceptance when multiple results exist: if the task has a reachable
`manager`, the manager's tombstone-with-verdict decides (CNP report step: manager
verifies and closes - this is where "collectively wrong" gets its one cheap
checkpoint, sec 4.5). If the manager is gone (left the team, TTL'd out of the
roster), fall back to the deterministic rule: first `done` result by (seq, actor)
wins; later results remain as visible alternates. Speculative-but-reasonable;
revisit after Stage B dogfooding.

### 2.6 Persistence, re-seeding, TTL/GC

The relay room is an EPHEMERAL gossip channel (keeper dies -> log restarts), so,
like presence, the durable truth must live in members and be re-announced:

- Each node persists its replica to `~/.agenthop/board/<nsId>.jsonl` (append +
  periodic compaction; crash-safe by the temp+rename idiom used everywhere in
  this codebase). A restarting node reloads its last view instantly.
- Anti-entropy beat: every node periodically (e.g. 60s, jittered) re-announces a
  small random/rotating batch of LIVE entries it holds that matter for liveness -
  at minimum: open tasks it manages, its own live claims, results not yet
  tombstoned. On keeper turnover (generation change) every node schedules a
  prompt full re-announce of its live set, exactly like presence re-announcing
  after a log reset. Net effect: the board survives any keeper death with at most
  a poll-cycle of blur, and a fresh team member converges to the full live board
  within ~1 beat.
- TTL defaults (evaporation policy, tunable): `note` 1-24h by topic; `task` 24h
  unclaimed then auto-tombstone (nobody wanted it - surface to humans rather than
  letting it rot); `claim` lease 10min, renewable; `partial` lives as long as its
  task; `result`/`tombstone` 7d for audit, then GC'd from replicas.
- GC is local and lazy: each node drops expired entries on read/compaction. No
  distributed GC round needed - expiry is computable locally from (seq, ttlMs),
  modulo ordinary clock skew (bounded skew only widens/narrows evaporation a
  little; it never breaks convergence since the fold tolerates an entry being
  briefly live on one node and expired on another - the next beat settles it).

### 2.7 Surface: tools

Minimal MCP tool additions (names provisional, match house style):

- `agenthop_board_post(kind, body, taskId?)` - write an entry (task, note,
  partial, result...).
- `agenthop_board_read(filter?)` - the folded view: open tasks, live claims, my
  tasks, recent notes. THE default read is small and curated (open + mine +
  recent), not a full dump - token discipline.
- `agenthop_board_claim(taskId, mode?)` - post claim, run the confirm fold,
  return won/lost/already-claimed.
- `agenthop_board_watch(filter, timeout)` - long-poll for board changes matching
  a filter (new open task, my task got a result...), built like
  `agenthop_wait_peer`: event-driven on replica updates, no busy polling.

Everything else (who claims what, when to synthesize) is agent policy - prompts
and skills, not bus code.

---

## 3. The hard distributed problems, named

### 3.1 No global state / eventual consistency

Two nodes may briefly disagree about everything: who claimed, whether a result
exists, whether a task is open. The design's answer is the one the project already
trusts: make every datum either immutable (log kinds) or a monotonic register
(claims, status), make merge order-independent (G-Set union + per-key max), and
make every decision a deterministic fold so disagreement is only ever about
NOT-YET-SEEN entries, never about interpretation. Convergence bound in practice:
one poll cycle (~5s) same-relay; a keeper turnover adds one reset+re-announce
round (~60s worst case with the anti-entropy beat, same as presence today).

### 3.2 Split-brain

If the relay is partitioned (or two keepers transiently serve disjoint members -
the generation mechanism makes this short-lived), each side keeps a working board
and may double-claim or double-complete tasks. On heal, union-merge is automatic
and conflict-free at the DATA level; at the WORK level, the symmetric winner fold
retroactively names one claim winner, and duplicate results are adjudicated by
the manager or the deterministic fallback (sec 2.5). The cost is wasted work
during the partition - unavoidable by CAP; the design chooses availability (both
sides keep working) over exclusion, which is right for research/build tasks and
would be WRONG for side-effectful tasks. Hence a hard rule: NON-IDEMPOTENT,
EXTERNALLY-VISIBLE actions (deploy, publish, send email, push to main) must not
be dispatched through claims alone. Such a task's body must carry
`idempotencyKey`/guard instructions, or be executed only by its manager. The
board is for coordination of work whose duplication is wasteful but safe.

### 3.3 Duplicated work

Three independent containment layers: (1) claims + confirm-then-work shrink the
window to near-simultaneity; (2) partials make in-flight work visible, so an
agent about to start something can see a peer's partials even if a claim raced;
(3) the fold names a single winner afterward, so duplication never persists past
one gossip round. Accepted floor: two agents can each burn one confirm-window of
thinking on the same task. With ~6-8s confirm delay this is pennies; without it
(work-immediately mode) it is bounded by task size - which is why mode is chosen
by expected task cost.

### 3.4 Convergence / termination: how does the swarm know it is DONE?

The genuinely hard one, and where pure stigmergy is weakest. Ant colonies never
"finish"; a task force must. The design leans on two anchors:

- Every task has a `goal` (done-criteria) written at post time. No goal, no task
  - this is enforced by the post tool. Vague goals are the root cause of
  non-termination; make the WRITER pay the specification cost, once, up front.
- Every task has a MANAGER (CNP borrow): the poster, by default the node that
  decomposed the problem. The manager is not an orchestrator - it does not
  schedule, select, or supervise anyone - but it IS the terminator: it watches
  results for its tasks (board_watch), verifies against the goal, posts the
  tombstone-with-verdict, and decides retry-vs-fail. For a decomposed problem,
  the root task's manager synthesizes when all child tasks fold to done. If the
  manager dies, its tasks' results sit visible until lease/TTL logic lets another
  node adopt the orphan (post a note claiming managership - itself just a claim
  on a synthesis task).

Honest statement: this is "emergence with a spine." Fully manager-less
termination (quorum voting on doneness, convergence detection via quiescence) is
possible in theory and famously brittle in practice; no production system the
author knows of ships it, and MAST (sec 4) found verification failures to be a
top failure category even WITH orchestrators. Per-task managers are the minimal
concession that keeps termination decidable. Marked: design conviction, not
proven fact.

### 3.5 Liveness: nobody claims / everybody waits

Failure mode: tasks sit open because every agent is busy, shy, or waiting for
someone else (bystander effect, for machines). Mitigations, all cheap:

- Idle-pull rule as a standing skill: bus.6 already detects idle via hooks. The
  stigmergic rule is "on idle, scan the board; claim the oldest open task you
  match." Idle agents become the labor pool with zero dispatch machinery.
- The unclaimed-task TTL (24h -> auto-tombstone + surface to a human) guarantees
  no task waits silently forever.
- The manager's board_watch gives it a natural nag point: a task open past a
  threshold can be re-posted with looser constraints, higher visibility, or
  split smaller - or escalated to explicit dispatch (agenthop_spawn a worker for
  it), which is the graceful degradation path: THE BOARD FALLS BACK TO
  ORCHESTRATION WHEN EMERGENCE STALLS. This one-way door (emergent first,
  explicit fallback) is the pragmatic answer to liveness that pure stigmergy
  lacks.
- Deadlock by circular waiting is structurally limited: claims are leases that
  evaporate; waits (board_watch) have timeouts; and tasks form a parent tree,
  not an arbitrary dependency graph, in v1. Explicit cross-task `dependsOn` is
  deliberately NOT in v1 - dependency graphs on an eventually-consistent board
  invite distributed deadlock reasoning we do not need yet.

---

## 4. Failure modes of EMERGENT multi-agent systems, and what the medium does

Framing source, grounded: Cemri et al., "Why Do Multi-Agent LLM Systems Fail?"
(arXiv:2503.13657, 2025 - verified; MAST taxonomy, 14 failure modes in 3
clusters: system design issues, inter-agent misalignment, task verification).
Their data is mostly from ORCHESTRATED systems; removing the orchestrator removes
some modes (orchestrator bottleneck/bias) and AMPLIFIES others (verification,
misalignment). Mapped to our design:

### 4.1 Thrashing (claim/release churn, agents hopping between tasks)

Cause: agents re-deciding constantly as the board shifts under them. Medium
answers: leases make a claim sticky for `leaseMs` (you cannot flap faster than
your lease); confirm-then-work damps claim races; board_read's curated default
view (not the full feed) keeps agents from reacting to every ripple. Local-rule
answer: "finish or release with a reason" as skill discipline; a release reason
is a trace that stops the next agent from repeating the same abort.

### 4.2 Duplicated / wasted work

Sec 3.3. Additionally: notes are the cheap dedup for NON-task work - "I already
read file X, summary attached" prevents three agents re-reading the same 2000
lines. This is where passive Stage A alone already pays for itself.

### 4.3 Oscillation (A undoes B, B redoes A)

Classic in stigmergic systems with antagonistic rules (build/demolish). Our tasks
are append-only facts, not shared mutable artifacts, so the board itself cannot
oscillate. The real risk is agents EDITING SHARED CODE based on board state -
that is out of scope for the medium (git is the medium there, with its own
conflict machinery) and should stay so: one task = one workspace/worktree owner
at a time, which the claim already provides.

### 4.4 Cost explosion

The quiet killer: N idle agents each polling the board with an LLM turn, bidding
on everything, re-summarizing each other's notes. Mitigations baked in:
board_watch is event-driven (no LLM-turn polling); the idle-pull rule fires on
the HOOK (idle transition), not on a timer; default mode is claim (no bid round);
entry bodies are size-capped; the curated read keeps per-turn token cost flat.
Missing and recommended: a per-team "board activity budget" note - a convention,
not a mechanism - plus the human looking at the board (it is human-readable by
design; `agenthop board` CLI dump). Honesty: no mechanism here PREVENTS an agent
from spiraling; caps + visibility + small vocabulary make spirals slow and
obvious rather than impossible.

### 4.5 Confidently collectively wrong

The scariest one: agent A posts a wrong partial; B builds on it; C synthesizes
confidently garbage. Stigmergy AMPLIFIES this (traces are trusted context). MAST
calls the cluster task verification. Medium answers: results carry refs +
digests so claims are checkable against artifacts, not just prose; the manager
verdict step is a mandatory second pair of eyes (different session, often a
different tool/model - cross-model review is this project's proven habit: the
Codex adversarial-review loop); `mode:"bid"` exists for tasks worth multiple
independent attempts (post the same goal twice with `independent:true` and
compare - redundancy purchased deliberately, where it is worth the tokens).
Honest limit: nothing in ANY coordination medium fixes correlated model error;
verification is a policy layer, and the board only guarantees the verdict
checkpoint exists and is visible.

### 4.6 Non-convergence

Sec 3.4 and 3.5: goals mandatory, managers terminate, TTLs evaporate, explicit
orchestration as fallback. The board never guarantees convergence; it guarantees
non-convergence is VISIBLE (open tasks age in plain sight) and BOUNDED (TTL).

---

## 5. Staged path (ponytail order: simplest valuable thing first)

### Stage A - passive shared blackboard (notes only). BUILD FIRST.

Scope: `note` entries + the second room + the local replica + persistence +
`agenthop_board_post(note)` / `agenthop_board_read`. No tasks, no claims, no
fold, no watch. Effort: small - it is directory.ts with a different prefix, a
JSONL file, and two tools; every hard part is already-reviewed code.

Value, immediate and real: a team-wide shared context. "I fixed the flaky test,
root cause was X." "The API we are all touching rate-limits at 10rps." "Design
decision: we use uuidv7 for ids." Today that knowledge travels by targeted DM
(you must know who needs it) or dies with the session. A note board is
sender-decoupled memory - the first genuine stigmergy (traces that help whoever
comes next), with ZERO coordination risk: no claims means no races, no
duplication, no liveness questions. It also dogfoods the transport (second room,
re-seeding, GC) under harmless load before any task semantics land. Grounded:
every mechanism here is shipped elsewhere in the codebase.

### Stage B - active task-board with claims. THE REAL STEP.

Scope: `task/claim/release/partial/result/tombstone`, the winner fold,
confirm-then-work, leases, manager verdicts, `board_claim` + `board_watch`, the
idle-pull skill rule. This is where self-allocation becomes real: post subtasks,
idle peers claim them, results flow back - still typically with a human-visible
root (whoever posted the tasks), but with NO dispatch calls and NO gather loop.
Risk: moderate and enumerated (secs 3-4); every race has a designed resolution.
Grounded mechanisms, novel composition - expect one adversarial-review cycle of
the claim fold to shake out edge cases (this project's track record says round
counts of 3-12 on concurrency code; budget for it).

Optional B+: `mode:"bid"` contract-net rounds for heterogeneous peers;
deliberate-redundancy tasks (`independent:true`). Add only when a concrete need
shows up.

### Stage C - full stigmergic self-organization. RESEARCH FRONTIER, EXPERIMENT ONLY.

Scope: standing local rules so the collective runs with no per-problem human in
the loop: agents decompose tasks they cannot finish alone into child tasks ON
the board; idle agents pull work continuously; orphaned syntheses get adopted;
role specialization emerges from capability-matched claiming (an agent in the
docs repo claims doc tasks; one with IDA tools claims RE tasks). No new bus
mechanics required beyond B - Stage C is PROMPTS, SKILLS, AND POLICY on the
Stage B substrate, plus guardrails: per-task depth caps (a task's `parent` chain
length limits runaway decomposition), spend visibility, and the explicit-
orchestration fallback always armed. Speculative by definition: whether
LLM-agent collectives produce better-than-orchestrated outcomes this way is an
OPEN research question (MAST says current MAS often underperform single strong
agents even WITH orchestrators). Ship A and B because they are useful regardless;
run C as bounded experiments on decomposable, verifiable, low-side-effect
problems (research, codebase surveys, test triage) and measure against an
orchestrated baseline before believing it.

What NOT to build at any stage (negative scope): a central board server; atomic
take; cross-task dependency graphs (v1); board-mediated editing of shared
mutable artifacts (git owns that); consensus/quorum anything; unbounded entry
bodies (artifacts live in files, the board carries pointers).

---

## 6. Recommendation + worked example

### Recommendation

Build Stage A now (one small PR: board room + replica + note tools), Stage B
next (one focused PR + adversarial review of the fold), and treat Stage C as a
measured experiment. The medium's whole design deliberately reuses the three
mechanisms this project has already shipped and hardened - team-derived room +
sealed entries + keeper election (directory.ts), per-identity monotonic seq with
drop-if-not-newer (core.ts/statusfile.ts), and accept-the-residual optimistic
races with deterministic settlement (broker/bridge) - so the new surface area is
the entry vocabulary and the fold, not new distributed-systems machinery.

### Worked example (Stage B+, no orchestrator)

Problem: "Survey how the 5 CLI tools we care about implement permission hooks,
and produce a comparison doc." Decomposable, verifiable, side-effect-free -
ideal board material. Players: Claude session (laptop), Codex session (laptop),
Claude session (desktop), all on team, all with the idle-pull skill rule.

1. The desktop Claude (prompted by the human once - someone always injects the
   root goal; "no orchestrator" is not "no initiative") posts:
   - `task t-root` goal: "comparison doc at docs/research/hooks-survey.md
     covering claude/codex/opencode/gemini/cursor, with per-tool citations";
     manager: itself.
   - Five child tasks `t-claude ... t-cursor`, parent t-root, each goal: "note +
     result with the hook mechanism, config path, event list for <tool>, citing
     files or docs."
2. Laptop Claude goes idle; its Stop hook fires; the idle-pull rule scans the
   board, claims `t-codex` (first-claim-wins; confirm fold after one poll shows
   it won). Laptop Codex idles seconds later, sees t-codex already claimed,
   claims `t-claude`. Desktop Claude claims `t-opencode`. No one assigned
   anything.
3. Race illustration: both laptops' confirm folds had briefly shown themselves
   winning `t-codex`; one poll later the loser's fold flips (lower (seq,actor)
   pair wins), it posts `release` and claims `t-gemini` instead. Cost: ~8s of
   one agent's time. No messages exchanged about it.
4. Workers post `partial`s as they go ("codex hooks.json schema matches
   Claude's; proof: docs/research/codex-opencode-hooks.md"). Partials renew
   nothing (claims renew via re-claim), but they leave building material: when
   laptop Codex sees Claude's partial noting a shared schema, it skips
   re-deriving it and cites the partial. That is qualitative stigmergy paying
   rent.
5. Each worker posts `result(done, summary, refs: [branch/file + digest])`.
   `t-cursor` sits unclaimed (nobody has Cursor installed); after its threshold
   the manager's board_watch wakes, and it either relaxes the goal ("docs-only
   survey for cursor") or - fallback - agenthop_spawns a worker for it.
   Degradation to explicit dispatch is a feature, not a failure.
6. The manager's watch sees all five children fold to done; it verifies each
   result's refs against the goal (the verdict step - the one place a wrong
   confident result gets caught), tombstones the children, writes the synthesis
   doc, posts `result(done)` on t-root, tombstones it. Board shows a complete,
   auditable trace: who did what, when, on what evidence.

Total orchestration calls: zero. Total new trust assumptions: zero (same team
secret, same sealed entries). Total accepted waste: one 8s claim race.

### Final summary

- Staged path: A (passive note board - directory.ts trick with a new vocabulary;
  small, safe, immediately useful) -> B (claimable task-board: leases +
  symmetric deterministic claim fold + per-task manager verdicts) -> C
  (standing-rule self-organization as a measured experiment, not a promised
  feature).
- Single highest-leverage first step: ship Stage A - the second team-derived
  board room + persisted local replica + `note` post/read tools. It delivers
  real value alone, derisks all transport questions for B, and is almost
  entirely already-reviewed code reused.
- Biggest risk: not claim races (designed, bounded) but SILENT COST AND QUALITY
  DRIFT in the emergent stages - agents burning tokens on the board's ambient
  activity and building confidently on wrong traces. Mitigations are policy plus
  visibility (event-driven watch instead of polling, size caps, mandatory goals,
  manager verdict checkpoints, human-readable board), and the honest posture is
  that Stage C remains an open research bet: run it on verifiable problems
  against an orchestrated baseline before trusting it.

---

## References

- Erman, Hayes-Roth, Lesser, Reddy. "The Hearsay-II Speech-Understanding System:
  Integrating Knowledge to Resolve Uncertainty." ACM Computing Surveys 12(2), 1980.
- Hayes-Roth, B. "A blackboard architecture for control." Artificial Intelligence
  26(3), 1985.
- Gelernter, D. "Generative communication in Linda." ACM TOPLAS 7(1), 1985.
- Smith, R. G. "The Contract Net Protocol: High-Level Communication and Control in
  a Distributed Problem Solver." IEEE Transactions on Computers C-29(12), 1980.
- Grasse, P.-P. "La reconstruction du nid et les coordinations interindividuelles
  chez Bellicositermes natalensis et Cubitermes sp. La theorie de la stigmergie."
  Insectes Sociaux 6, 1959.
- Theraulaz, G., Bonabeau, E. "A Brief History of Stigmergy." Artificial Life
  5(2), 1999.
- Heylighen, F. "Stigmergy as a universal coordination mechanism I: Definition and
  components." Cognitive Systems Research 38, 2016.
- Demers, A. et al. "Epidemic Algorithms for Replicated Database Maintenance."
  PODC 1987.
- Shapiro, M., Preguica, N., Baquero, C., Zawirski, M. "Conflict-free Replicated
  Data Types." SSS 2011.
- Han, B., Zhang, S. "Exploring Advanced LLM Multi-Agent Systems Based on
  Blackboard Architecture." arXiv:2507.01701, 2025. (Verified on arXiv
  2026-10-01.)
- Cemri, M. et al. "Why Do Multi-Agent LLM Systems Fail?" arXiv:2503.13657, 2025.
  (MAST taxonomy: 14 failure modes in 3 clusters - system design, inter-agent
  misalignment, task verification. Verified on arXiv 2026-10-01.)
- FIPA Contract Net Interaction Protocol Specification, SC00029H, 2002.
- This repo: `packages/bus/src/directory.ts` (team room, sealed presence, keeper
  election, generation reset), `packages/bus/src/statusfile.ts` (lock-free
  monotonic max-register), `packages/bus/src/core.ts` (statusByIdentity seq
  guard), `packages/bus/src/broker.ts`/`bridge.ts` (optimistic bind races,
  accepted residuals), `docs/research/herdr-study.md` (monotonic seq rationale).
