import { homedir } from "node:os";
import { selfInfo, sessionTitle, type AgentStatus, type SelfInfo } from "./label.js";
import { startLocalBus, type LocalBus } from "./broker.js";
import { startRelay, type Relay } from "./relay.js";
import { pushToHost } from "./push.js";
import { startCodexDaemon, type CodexDaemon } from "./codex.js";
import { resolvePeer, type UnifiedPeer } from "./resolve.js";
import { readStatusFile, watchStatusDir } from "./statusfile.js";
import { msgLogEnabled, writeMsgLog } from "./msglog.js";
import { dbg } from "./debug.js";
import { ackInbox, claimInbox, recoverStaleClaims, releaseInbox, writeInbox } from "./inbox.js";

export { resolvePeer, type UnifiedPeer } from "./resolve.js";

/**
 * The one thing the tools talk to. It joins two transports behind a single roster and a single
 * mailbox: the local broker (same machine, always on, zero config) and — only when a team secret
 * is set — the relay directory + mailbox (other machines). A caller never has to know which a peer
 * is on; a session on this machine wins if it somehow appears on both.
 */

export type BusMessage = { from: string; fromLabel: string; text: string; via: "local" | "relay" };

export type BusCore = {
  self: SelfInfo;
  peers(): UnifiedPeer[];
  send(to: string, text: string): Promise<{ ok: boolean; label?: string; error?: string }>;
  recv(timeoutMs: number): Promise<BusMessage[]>;
  /** Record this Codex thread id (from x-codex-turn-metadata) so inbound can be pushed to it. */
  noteThread(id: string): void;
  status(): string;
  /** Set this session's own work state (working|idle|blocked|unknown); it rides the roster to peers.
   *  A monotonic `seq` (explicit or auto-incremented) drops a stale/duplicate report. */
  setStatus(state: AgentStatus, opts?: { seq?: number; text?: string }): { ok: boolean; seq?: number; ignored?: boolean };
  /** Wait until `target` reaches one of `until` states (or vanishes / times out). Pins the resolved
   *  session's stable identity so a different session cannot satisfy the wait. */
  waitForStatus(target: string, until: AgentStatus[], timeoutMs: number): Promise<{ status?: AgentStatus; reached: boolean; gone?: boolean; error?: string; label?: string }>;
  close(): Promise<void>;
};

export type BusCoreOptions = { home?: string; relay?: string; pass?: string };

/**
 * Which Codex thread to deliver an inbound message into. Locked to this session's learned identity so
 * the delivery target never diverges from the published stableId: authoritative call metadata wins,
 * else the identity we already learned, else the daemon's current guess — used ONLY to bootstrap the
 * first time. Without this lock, a daemon whose active thread drifts A→B would keep publishing A while
 * delivering to B. A non-Codex host delivers through its own channel (cc-socks) and needs no thread.
 */
export function codexDeliveryThread(
  tool: string,
  ownThread: string | undefined,
  stableId: string | undefined,
  daemonThread: string | undefined,
): string | undefined {
  if (tool !== "codex") return undefined;
  return ownThread ?? stableId ?? daemonThread;
}

export function startBusCore(options: BusCoreOptions = {}): BusCore {
  const self = selfInfo();
  const home = options.home ?? homedir(); // resolved early: used by handleInbound (below) + status watch (later)
  // Durable inbox: a message that cannot be pushed to the host's live UI yet (channel not ready) is persisted to disk
  // and retried, instead of sitting in a volatile array only agenthop_recv drains. Keys: the stable identity (survives
  // an MCP-subprocess restart) plus the per-run id (used before stableId was learned).
  const inboxKey = (): string => self.stableId ?? self.id;
  const inboxKeys = (): string[] => (self.stableId && self.stableId !== self.id ? [self.stableId, self.id] : [self.id]);
  let flushing = false;
  // Work-status is per SESSION IDENTITY, not per MCP-server process: one Codex daemon-backed server can
  // adopt several thread identities over its life (see learnStableId), and each must keep its own status
  // and its own monotonic seq — otherwise thread A's seq would gate thread B's reports.
  type StatusEntry = { status: AgentStatus; seq: number; text?: string; at: number };
  const statusByIdentity = new Map<string, StatusEntry>();
  // The Codex thread currently driving this (daemon-level) MCP server, learned from each call's
  // x-codex-turn-metadata. Most precise; the daemon client is the fallback for receive-first.
  let ownCodexThread: string | undefined;
  // Whether the current stableId came from an authoritative source (call metadata, or the env for
  // Claude) rather than a daemon guess. A guess must never override; authoritative always wins.
  let stableIdAuthoritative = self.stableId != null;
  // Under Codex (no cc-socks), hold a live connection to its app-server daemon to know the active
  // thread even before the agent has touched the bus. Off under Claude Code (it uses cc-socks).
  // Only run the Codex daemon fallback when this session actually looks like Codex; otherwise a
  // non-Codex session on a machine that also runs Codex could push a peer's message into a Codex
  // thread. Claude Code uses cc-socks, never this.
  const codexDaemon: CodexDaemon | undefined =
    !process.env.CLAUDE_CODE_MESSAGING_SOCKET && self.tool === "codex" ? startCodexDaemon() : undefined;

  // Re-attempt delivery of durably-queued messages whenever the native channel may have become ready (e.g. a Codex
  // session that just took its first turn now has a rollout for `codex queue`). Claim/ack/release so the retry timer
  // and an explicit recv never double-deliver; stop at the first failure (channel still not ready) and retry later.
  const flushInbox = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      // Recover claims a dead/previous run left behind, for the CURRENT identity's keys. Crucial after a LATE identity
      // adoption (Codex learns its native id only after its first turn): a message orphaned as `.json.claim-<oldpid>`
      // under the just-adopted stableId would otherwise never be reclaimed (claimInbox only sees `.json`), staying stuck
      // across the restart/adoption (Codex P2-8). Cheap + safe: only a dead pid's claim is released.
      recoverStaleClaims(home, inboxKeys());
      const codexThread = codexDeliveryThread(self.tool, ownCodexThread, self.stableId, codexDaemon?.activeThread(self.cwd));
      // claimInbox claims the WHOLE pending batch up front. On the first push failure (channel not ready) we
      // must release this one AND every still-unprocessed claim — otherwise they are orphaned as .claim-<pid>
      // files that no later flush reclaims (claimInbox only sees .json), stranding the message for good.
      const claimed = claimInbox(home, inboxKeys(), String(process.pid));
      for (let i = 0; i < claimed.length; i++) {
        const ok = await pushToHost(claimed[i].msg.fromLabel, claimed[i].msg.text, { codexThread, codexHome: codexDaemon?.codexHome() });
        if (ok) { ackInbox(claimed[i].file); continue; }
        for (let j = i; j < claimed.length; j++) releaseInbox(claimed[j].file);
        break;
      }
    } finally {
      flushing = false;
    }
  };

  // A message has arrived for us. Try the host's native inbox first (surfaces in the live TUI with no hook and no
  // poll); if the channel is not ready, persist it to the DURABLE inbox so the retry below delivers it later.
  const handleInbound = (from: string, text: string, via: "local" | "relay"): void => {
    // Delivery is locked to this session's learned identity (codexDeliveryThread), so it never diverges from the
    // published stableId. Learn from the SAME value: authoritative from call metadata, a guess from the daemon.
    const codexThread = codexDeliveryThread(self.tool, ownCodexThread, self.stableId, codexDaemon?.activeThread(self.cwd));
    learnStableId(codexThread, ownCodexThread !== undefined);
    const label = labelFor(from);
    // Bind the delivery identity's inbox key + arrival time NOW, before the async push. If the push fails, the fallback
    // persist must use the SAME identity this message was resolved for — not whatever identity a concurrent noteThread
    // switched us to by the time the callback runs, which would file A's message into B's inbox (Codex P2-7).
    const key = inboxKey();
    const ts = Date.now();
    // Metadata-only comms journal for swarm observability. Gated so Buffer.byteLength + the call are skipped entirely
    // when AGENTHOP_MSGLOG is off (the default); writeMsgLog is also internally a no-op + never throws.
    if (msgLogEnabled()) writeMsgLog(home, { ts, from, to: self.id, via, direction: "in", size: Buffer.byteLength(text), text });
    dbg(`inbound via=${via} from=${from} own=${ownCodexThread} stable=${self.stableId} daemon=${codexDaemon?.activeThread(self.cwd)} -> codexThread=${codexThread}`);
    void pushToHost(label, text, { codexThread, codexHome: codexDaemon?.codexHome() }).then((ok) => {
      dbg(`pushToHost ok=${ok}`);
      if (ok) void flushInbox(); // channel works -> also deliver any durable backlog (keeps order)
      else writeInbox(home, key, { from, fromLabel: label, text, via, ts });
    });
  };

  const local: LocalBus = startLocalBus(self, options.home, (m) => handleInbound(m.from, m.payload, "local"));

  // Codex has no native session id in its env, so we adopt the thread id as our stableId the first
  // time we learn it (from an MCP call's metadata or the daemon). This also refreshes the readable
  // handle (tool:dir-<shortId>) and re-announces it — on both the local broker and the relay directory
  // — so peers can address this session durably.
  const learnStableId = (id: string | undefined, authoritative: boolean): void => {
    if (!id) return;
    if (self.stableId === id) {
      if (authoritative) stableIdAuthoritative = true;
      return;
    }
    // A daemon guess never overrides an id we already have. Authoritative call metadata (or the env)
    // always wins: it may correct an earlier guess, and it keeps the published identity EQUAL to the
    // real delivery target — a stale stableId while delivery moved to another thread was the bug.
    if (!authoritative && self.stableId) return;
    const hadStableId = self.stableId !== undefined;
    const oldKey = self.stableId ?? self.id;
    self.stableId = id;
    self.title = sessionTitle(self.tool, self.cwd, id ?? self.id); // never bare tool:dir (would shadow a sibling)
    stableIdAuthoritative = authoritative;
    // Status follows the identity. On the FIRST adoption (bootstrap: no stableId yet) carry a status the
    // same run already reported under its per-run id; on a later thread SWITCH (A→B) do NOT carry — keep
    // identities isolated. Then publish the new identity's own status.
    if (!hadStableId && statusByIdentity.has(oldKey) && !statusByIdentity.has(id)) statusByIdentity.set(id, statusByIdentity.get(oldKey)!);
    const e = statusByIdentity.get(id);
    self.status = e?.status;
    self.statusSeq = e?.seq;
    self.statusText = e?.text;
    self.statusAt = e?.at;
    local.updateSelf(self);
    relay?.updateSelf(self);
  };

  const relay: Relay | undefined = startRelay(self, (from, text) => handleInbound(from, text, "relay"), options);

  const unified = (): UnifiedPeer[] => {
    const out = new Map<string, UnifiedPeer>();
    for (const p of local.peers()) out.set(p.id, { id: p.id, stableId: p.stableId, tool: p.tool, cwd: p.cwd, title: p.title, via: "local", pid: p.pid, status: p.status, statusSeq: p.statusSeq, statusText: p.statusText, statusAt: p.statusAt });
    if (relay) {
      for (const p of relay.roster()) if (!out.has(p.id)) out.set(p.id, p);
    }
    return [...out.values()];
  };

  const labelFor = (idOrPub: string): string => {
    const p = unified().find((x) => x.id === idOrPub || x.stableId === idOrPub || x.pub === idOrPub);
    if (!p) return idOrPub.slice(0, 8);
    return `${p.title}${p.via === "relay" ? `@${p.machine ?? "remote"}` : ""}`;
  };

  const resolve = (to: string): UnifiedPeer | { error: string } => resolvePeer(unified(), self.id, to);

  // Set this session's own status, keyed per identity (see statusByIdentity). Shared by the MCP tool
  // and the file watcher below.
  const setStatusImpl = (state: AgentStatus, opts?: { seq?: number; text?: string }): { ok: boolean; seq?: number; ignored?: boolean } => {
    const key = self.stableId ?? self.id;
    const prev = statusByIdentity.get(key);
    const seq = opts?.seq;
    // Monotonic guard (per identity): never apply a report that is not newer than the last.
    if (seq !== undefined && prev && seq <= prev.seq) return { ok: false, ignored: true, seq: prev.seq };
    // Auto-increment must strictly advance and stay a safe integer.
    if (seq === undefined && prev && prev.seq >= Number.MAX_SAFE_INTEGER) return { ok: false, ignored: true, seq: prev.seq };
    const entry: StatusEntry = { status: state, seq: seq ?? (prev?.seq ?? 0) + 1, text: opts?.text?.trim() || undefined, at: Date.now() };
    const unchanged = entry.status === self.status && entry.text === self.statusText;
    statusByIdentity.set(key, entry);
    self.status = entry.status;
    self.statusSeq = entry.seq;
    self.statusText = entry.text;
    self.statusAt = entry.at;
    // Skip the re-announce when neither state nor text changed (only the seq advanced) — a frequent
    // PostToolUse→working report while already working must not spam the roster.
    if (unchanged) return { ok: true, seq: entry.seq };
    local.updateSelf(self);
    relay?.updateSelf(self);
    return { ok: true, seq: entry.seq };
  };

  // Slice B: pick up status that an EXTERNAL hook wrote for this session (via `agenthop report-status`
  // → ~/.agenthop/status/<key>.json) and apply it through the same monotonic path. Keyed by the current
  // identity, re-read on every change so a Codex thread id learned late still lines up.
  const statusHome = home;
  const applyStatusFromFile = (): void => {
    const f = readStatusFile(statusHome, self.stableId ?? self.id);
    if (f) setStatusImpl(f.state as AgentStatus, { seq: f.seq, text: f.text });
  };
  const stopStatusWatch = watchStatusDir(statusHome, applyStatusFromFile);
  applyStatusFromFile(); // pick up a file that already exists at startup

  // Durable-inbox retry: deliver anything queued while the native channel was not ready, and pick up messages a previous
  // MCP-subprocess run persisted (restart durability). flushInbox itself first recovers stale claims for the current
  // identity's keys (Codex P2-8), so this covers both the initial run-id and any later-adopted stableId. Unref'd — the
  // broker socket keeps the process alive; this timer must not by itself.
  void flushInbox();
  const flushTimer = setInterval(() => void flushInbox(), 5000);
  flushTimer.unref?.();

  return {
    self,
    peers: unified,
    noteThread(id) {
      ownCodexThread = id;
      learnStableId(id, true); // call metadata is authoritative for both identity and delivery
      void flushInbox(); // a Codex session just took a turn -> its rollout now exists -> flush anything pending to it
    },
    async send(to, text) {
      const peer = resolve(to);
      if ("error" in peer) return { ok: false, error: peer.error };
      // Log an "out" entry only on confirmed delivery. Gated so Buffer.byteLength + the call are skipped when
      // AGENTHOP_MSGLOG is off (the default); writeMsgLog is also internally a no-op + never throws.
      const logOut = (via: "local" | "relay"): void => {
        if (msgLogEnabled()) writeMsgLog(home, { ts: Date.now(), from: self.id, to: peer.id, via, direction: "out", size: Buffer.byteLength(text), text });
      };
      if (peer.via === "local") { const ok = local.send(peer.id, text); if (ok) logOut("local"); return { ok, label: labelFor(peer.id) }; }
      if (relay && peer.pub) { const ok = await relay.send(peer.pub, text); if (ok) logOut("relay"); return { ok, label: labelFor(peer.id) }; }
      return { ok: false, error: "That peer is on another machine but no team relay is configured here (set AGENTHOP_TEAM)." };
    },
    async recv(timeoutMs) {
      // Explicit pull: drain the DURABLE inbox (messages the push channel could not surface). Claim+ack so the retry
      // timer never re-delivers the same message.
      const deadline = Date.now() + timeoutMs;
      const drain = (): BusMessage[] =>
        claimInbox(home, inboxKeys(), String(process.pid)).map((c) => {
          ackInbox(c.file);
          return { from: c.msg.from, fromLabel: c.msg.fromLabel, text: c.msg.text, via: c.msg.via };
        });
      let batch = drain();
      while (batch.length === 0 && Date.now() < deadline) {
        await delay(120);
        batch = drain();
      }
      return batch;
    },
    setStatus: setStatusImpl,
    async waitForStatus(target, until, timeoutMs) {
      const peer = resolve(target);
      if ("error" in peer) return { reached: false, error: peer.error };
      // Pin the resolved EXACT run (per-run id) AND the native identity it represented at resolve time.
      // The run id survives a restart-as-new check; the identity guard handles a multiplexing run that
      // switches to another native thread mid-wait — its (different identity's) status must not satisfy us.
      const pin = peer.id;
      let pinIdentity = peer.stableId; // undefined if it had not adopted a durable identity yet
      const label = labelFor(peer.id);
      const wanted = new Set(until);
      const deadline = Date.now() + timeoutMs;
      let last: AgentStatus | undefined;
      for (;;) {
        const now = unified().find((p) => p.id === pin);
        if (!now) return { reached: false, gone: true, label };
        // Lock onto the first concrete identity observed if we resolved before adoption — otherwise a
        // later switch to a DIFFERENT identity would still satisfy (pinIdentity===undefined forever).
        if (pinIdentity === undefined && now.stableId !== undefined) pinIdentity = now.stableId;
        // Read the published status only while the run still represents the pinned identity. A switch
        // A→B is skipped (kept waiting), not matched.
        const sameIdentity = pinIdentity === undefined || now.stableId === undefined || now.stableId === pinIdentity;
        if (sameIdentity) {
          last = now.status ?? "unknown"; // an unreported peer is "unknown", and matchable as such
          if (wanted.has(last)) return { reached: true, status: last, label };
        }
        if (Date.now() >= deadline) return { reached: false, status: last, label };
        await delay(200);
      }
    },
    status() {
      const relayUrl = options.relay ?? process.env.AGENTHOP_RELAY ?? "default relay";
      const team_ = relay ? `team on (${relayUrl})` : "team off (same-machine only; set AGENTHOP_TEAM for cross-machine)";
      return `local broker: ${local.role()}; ${team_}; ${unified().filter((p) => p.id !== self.id).length} other session(s)`;
    },
    async close() {
      clearInterval(flushTimer);
      stopStatusWatch();
      codexDaemon?.close();
      await local.close();
      await relay?.close();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
