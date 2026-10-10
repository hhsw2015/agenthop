import { homedir } from "node:os";
import { selfInfo, sessionTitle, type AgentStatus, type SelfInfo } from "./label.js";
import { startLocalBus, type LocalBus } from "./broker.js";
import { startRelay, type Relay } from "./relay.js";
import { pushToHost } from "./push.js";
import { startCodexDaemon, type CodexDaemon } from "./codex.js";
import { dedupLocalPeers, resolvePeer, type UnifiedPeer, type ResolveError } from "./resolve.js";
import { readStatusFile, watchStatusDir } from "./statusfile.js";
import { msgLogEnabled, writeMsgLog } from "./msglog.js";
import { dbg } from "./debug.js";
import { recordSelfObserve, recordLearn, readIdentityLog, buildProjection, legacyInboxKeys, identityLogStamp } from "./bus-identity.js";
import { ackInbox, claimInbox, recoverStaleClaims, releaseInbox, retryStuckPoison, writeInbox, watchInbox, quarantineInbox, poisonDlqEnabled, poisonDlqThreshold, shouldQuarantinePoison, recordPoisonStrike, clearPoisonStrikes, buildPoisonS19, enqueuePoisonNotice, drainPoisonNotices, poisonNoticeSource } from "./inbox.js";
import { resolveInboxTarget, isValidSessionId } from "./send-fallback.js";
import { resolveSession, listSessions, probeSessionAlive } from "./swarm/task-liveness.js";
import { reportCheckIn, deliverToCoordinator } from "./checkin.js";

export { dedupLocalPeers, resolvePeer, type UnifiedPeer } from "./resolve.js";

/**
 * The one thing the tools talk to. It joins two transports behind a single roster and a single
 * mailbox: the local broker (same machine, always on, zero config) and — only when a team secret
 * is set — the relay directory + mailbox (other machines). A caller never has to know which a peer
 * is on; a session on this machine wins if it somehow appears on both.
 */

export type BusMessage = { from: string; fromLabel: string; text: string; via: string }; // via is a free-form provenance label (F38): "local"/"relay" carry semantics, an inbox label like "durable-inbox" passes through

export type BusCore = {
  self: SelfInfo;
  peers(): UnifiedPeer[];
  /** `delivered` reports the channel used (bus-reachability §1 / B2+B3 option b): "durable" = written to the recipient's durable
   *  inbox, the ONLY same-machine delivery guarantee (surfaced near-live by the recipient's fs-watch/flush, and restart-safe);
   *  "relay" = a live best-effort cross-machine send (no shared durable inbox). There is no "local"/"native-direct" live push:
   *  a byte-write/FIN is not a confirmed receipt (B3) and native-direct's cached socket could misroute (B2). "bus" = a live
   *  best-effort broker push to a node that does NOT consume the durable inbox (an OpenCode plugin node, C1) — not a durable
   *  guarantee. Absent on failure. */
  send(to: string, text: string): Promise<{ ok: boolean; label?: string; error?: string; delivered?: "durable" | "relay" | "bus" }>;
  recv(timeoutMs: number): Promise<BusMessage[]>;
  /** Record this Codex thread id (from x-codex-turn-metadata) so inbound can be pushed to it. */
  noteThread(id: string): void;
  /** F45 ① (shell-succession): AUTHORITATIVELY adopt a stable sid as this node's identity — the SAME path a Codex thread
   *  adoption takes (learnStableId authoritative). On adoption the node's inboxKeys() start including `sid` (so its durable
   *  inbox is drained — "扫箱"), the liveness socket re-binds via onIdentityChange, and resolveSession(sid) finds this node.
   *  Used by presence's succession consumption point after successionVerdict returns "adopt"; LIVE BY DEFAULT (kill: SWARM_SUCCESSION=0). */
  adoptStableId(sid: string): void;
  status(): string;
  /** Set this session's own work state (working|idle|blocked|unknown); it rides the roster to peers.
   *  A monotonic `seq` (explicit or auto-incremented) drops a stale/duplicate report. */
  setStatus(state: AgentStatus, opts?: { seq?: number; text?: string }): { ok: boolean; seq?: number; ignored?: boolean };
  /** Wait until `target` reaches one of `until` states (or vanishes / times out). Pins the resolved
   *  session's stable identity so a different session cannot satisfy the wait. */
  waitForStatus(target: string, until: AgentStatus[], timeoutMs: number): Promise<{ status?: AgentStatus; reached: boolean; gone?: boolean; error?: string; label?: string }>;
  close(): Promise<void>;
};

export type BusCoreOptions = {
  home?: string; relay?: string; pass?: string;
  /** B7-1: called AFTER this session's stable identity is (re)assigned (Codex adopts its thread id late, by cwd-match). The
   *  presence daemon uses it to RE-BIND its liveness socket from hash(run-id) to hash(stableId) with no poll window, so a
   *  sender probing the stable id proves THIS instance alive and routes its send to the stable id's durable inbox. */
  onIdentityChange?: (self: SelfInfo) => void;
};

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
  // F40 legacy-claim: besides the current identity's two keys, DRAIN boxes keyed by a PRIOR identity of this same logical
  // session (old per-run id / a drifted Codex thread id), discovered from the durable alias-log so a restart/thread-drift
  // doesn't strand earlier mail in a box the new inboxKey() never looks at. Recomputed at startup + on each identity change;
  // fail-soft (the current-identity keys always work on their own — legacy is a recovery safety net, never a dependency).
  let legacyKeys: string[] = [];
  // F40-2: recompute BEFORE each claim (flush/recv), not only on identity change — an alias-log correction/revoke (or a new
  // same-native link) appended by ANY party must take effect without this session restarting or changing its own identity.
  // Stamp-gated so the fold is skipped when the log is unchanged (the common idle case); `force` bypasses it when self's own
  // identity just changed (the native the keys depend on moved).
  // `legacyStamp` is the stamp of the last SUCCESSFUL fold. "\u0000" (initial) / STAMP_RETRY (after a failed read) are
  // sentinels that never equal a real stamp, so the next refresh always re-reads — even if the file's mtime/size is unchanged
  // (a transient EACCES leaves the bytes identical, F40-2-B). A real stamp is committed ONLY after a successful read.
  const STAMP_RETRY = "\u0000retry";
  let legacyStamp = "\u0000";
  const refreshLegacyKeys = (force = false): void => {
    try {
      const stamp = identityLogStamp(home);
      if (!force && stamp === legacyStamp) return; // unchanged since the last SUCCESSFUL fold ⇒ reuse cached keys (cheap path)
      const lg = readIdentityLog(home);
      if (lg.status === "error") {
        // F40-2-B: a READ failure (e.g. a transient EACCES) is NOT an empty log. Folding it to empty-and-committing the stamp
        // stranded mail once perms were restored (the bytes, hence the stamp, were unchanged → the gate skipped the re-read).
        // CONSERVATIVE authorization while blind: grant NO legacy claim — the log may ALREADY carry a revoke, so the stale set
        // must not keep authorizing claims (a revoked box must not be drained during the outage). The current id/stableId keys
        // still work. Force a re-read next time (RETRY sentinel) so a recovery with an UNCHANGED stamp still re-folds.
        legacyKeys = [];
        legacyStamp = STAMP_RETRY;
        return;
      }
      legacyStamp = stamp; // commit the stamp ONLY on a successful read
      legacyKeys = legacyInboxKeys(buildProjection(lg.events, lg.corruption), self);
    } catch { legacyKeys = []; legacyStamp = STAMP_RETRY; /* same conservative stance on any throw: no legacy claim, retry next time */ }
  };
  const inboxKeys = (): string[] => {
    const out = self.stableId && self.stableId !== self.id ? [self.stableId, self.id] : [self.id];
    for (const k of legacyKeys) if (!out.includes(k)) out.push(k); // legacyInboxKeys already excludes the current keys; dedup defensively
    return out;
  };
  let flushing = false;
  // Per-process retry set for poison files a claim could neither quarantine nor release (both failed on a transient FS
  // fault). The flush timer re-attempts them via retryStuckPoison once the fault clears (review bb6dad5-P2-4-B).
  const stuckPoison = new Set<string>();
  // B7 (review 01b773d): HEALTHY claims whose release failed (transient rename error) after a push miss. recoverStaleClaims only
  // frees DEAD-pid claims, so our own live-pid claim would otherwise stay `.claim-<pid>` forever. flushInbox retries releasing
  // these at the top of each pass; on success the file is back to `.json` and the normal claim path re-delivers it.
  const stuckRelease = new Set<string>();
  // FC-2: per-process poison strike counts, AUTHORITATIVE over the sidecar (PD-P2-3: a persistent sidecar-write fault must not
  // re-read 0 forever and never reach the threshold). Coordinator notices are DURABLE on disk (inbox.ts enqueue/drain, PD-P2-2):
  // a restart or an overflow must not discharge the obligation, so there is no in-memory queue — drainPoisonNotices re-scans the
  // durable dir each flush and clears a notice only after a confirmed send.
  const poisonStrikes = new Map<string, number>();
  const retryPoisonNotices = (): void => {
    if (!poisonDlqEnabled()) return; // PD-R3-P1-1: an OFF (or unrelated) drainer must never consume/reroute others' durable notices
    // Deliver each CONFIRMED notice to its OWN bound target (PD-R3-P1-1 — never substitute our SWARM_COORDINATOR). Legacy records
    // carry no bound target and are moved to needs-migration by the drain itself (never target-guessed).
    drainPoisonNotices(home, (target, m) => deliverToCoordinator(home, self, target, m));
  };
  // C2 (review 01b773d): watch-triggered flushes back off until this time after a no-progress flush, so our OWN claim/release
  // renames (which also fire the inbox fs-watch) cannot self-excite a tight flush loop while the push channel is down. The 5s
  // flush timer stays the retry floor during the backoff; a flush that DELIVERS clears it so near-live resumes.
  let watchCooldownUntil = 0;
  const WATCH_COOLDOWN_MS = 5000; // one flush-timer interval: during a channel outage the watch stays quiet, the timer retries
  // B5 (review 01b773d): a startup check-in that missed (coordinator not resolvable yet, or the write failed) leaves a RETRY
  // obligation. retryCheckIn re-attempts it on the flush timer and on a broker (re)connect until it is sent; a permanent "skip"
  // (not in a swarm / we are the coordinator) clears it. Identity-change re-checks-in directly (learnStableId) and resets this.
  let checkInPending = false;
  const retryCheckIn = (): void => {
    if (!checkInPending) return;
    if (reportCheckIn(home, self, process.env.SWARM_COORDINATOR) !== "retry") checkInPending = false; // sent or permanently-skipped ⇒ obligation discharged
  };
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
      refreshLegacyKeys(); // F40-2: pick up an alias-log revoke/new-link before this claim (stamp-gated — cheap when unchanged)
      // Recover claims a dead/previous run left behind, for the CURRENT identity's keys. Crucial after a LATE identity
      // adoption (Codex learns its native id only after its first turn): a message orphaned as `.json.claim-<oldpid>`
      // under the just-adopted stableId would otherwise never be reclaimed (claimInbox only sees `.json`), staying stuck
      // across the restart/adoption (Codex P2-8). Cheap + safe: only a dead pid's claim is released.
      recoverStaleClaims(home, inboxKeys());
      // Re-attempt any poison stuck from a prior flush (quarantine+release both failed then); clears once the FS heals.
      retryStuckPoison(home, stuckPoison);
      // FC-2: re-attempt any poison quarantine notices the coordinator could not receive yet (PD-P2-2).
      retryPoisonNotices();
      // B7: re-attempt releasing HEALTHY claims whose release failed earlier; on success the file is back to `.json` and the
      // claim below re-delivers it. recoverStaleClaims can't help (this is our own LIVE pid).
      for (const f of [...stuckRelease]) if (releaseInbox(f)) stuckRelease.delete(f);
      const codexThread = codexDeliveryThread(self.tool, ownCodexThread, self.stableId, codexDaemon?.activeThread(self.cwd));
      // claimInbox claims the WHOLE pending batch up front. On the first push failure (channel not ready) we
      // must release this one AND every still-unprocessed claim — otherwise they are orphaned as .claim-<pid>
      // files that no later flush reclaims (claimInbox only sees .json), stranding the message for good.
      const claimed = claimInbox(home, inboxKeys(), String(process.pid), stuckPoison); // validates + quarantines poison (F28) — msgs here are schema-valid
      let delivered = 0;
      for (let i = 0; i < claimed.length; i++) {
        // F28 defense-in-depth: a push that THREW (not just returned false) must never escape flushInbox — this runs as
        // `void flushInbox()`, so an unhandled rejection would crash the whole bus server. Treat a throw as a delivery miss,
        // but REMEMBER it threw (FC-2: a throw is a poison strike; a return-false is channel-not-ready and never strikes).
        let ok = false;
        let threw: string | null = null;
        try { ok = await pushToHost(claimed[i].msg.fromLabel, claimed[i].msg.text, { codexThread, codexHome: codexDaemon?.codexHome(), fromMode: claimed[i].msg.fromMode, to: self.title }); }
        catch (e) { threw = e instanceof Error ? e.message : String(e); dbg(`flushInbox push threw (treating as miss): ${threw}`); ok = false; }
        if (ok) { if (poisonDlqEnabled()) clearPoisonStrikes(claimed[i].file, poisonStrikes); ackInbox(claimed[i].file); delivered++; continue; }
        // FC-2 poison dead-letter: a push that THREW (the host erring on THIS message's content) is a poison strike — a push
        // that returned false is channel-not-ready and does NOT strike (no false-quarantine during an outage). After the
        // threshold the message is quarantined (bytes preserved + the coordinator told) and we CONTINUE the batch so the
        // head-of-line poison stops blocking the rest. Dormant unless SWARM_POISON_DLQ; quarantine is recoverable, never a drop.
        if (threw !== null && poisonDlqEnabled()) {
          const strikes = recordPoisonStrike(claimed[i].file, poisonStrikes); // in-memory authoritative (PD-P2-3)
          if (shouldQuarantinePoison(strikes, poisonDlqThreshold())) {
            const qReason = `poison: delivery threw ${strikes}x: ${threw}`;
            const coord = process.env.SWARM_COORDINATOR;
            if (coord === undefined || coord.trim() === "") {
              // No coordinator to notify ⇒ nothing to persist; quarantine directly (the F26 dead-letter ledger is the audit record).
              if (quarantineInbox(home, claimed[i].file, qReason, JSON.stringify(claimed[i].msg)) !== "failed") {
                clearPoisonStrikes(claimed[i].file, poisonStrikes);
                continue;
              }
            } else {
              // PD-P2-2 + PD-R4-P2-1 + PD-R5-P2-2: persist the durable obligation (bound to this poison EVENT, keyed by source ⇒
              // idempotent) BEFORE the quarantine move, so it survives a notice-write failure and a retry overwrites rather than
              // piling up. We do NOT write a separate "confirmed" flag afterwards — the drain VERIFIES the quarantine on the
              // filesystem (the quarantined bytes are the proof) before delivering, so no premature "已隔离" report and no crash/
              // write-fault window that could strand it. If the obligation can't be persisted, do NOT quarantine (keep source+strike).
              const source = poisonNoticeSource(claimed[i].file);
              const notice = buildPoisonS19(self.stableId ?? self.id, self.title, claimed[i].msg, strikes, threw);
              if (enqueuePoisonNotice(home, source, coord, notice) &&
                  quarantineInbox(home, claimed[i].file, qReason, JSON.stringify(claimed[i].msg)) !== "failed") {
                clearPoisonStrikes(claimed[i].file, poisonStrikes);
                continue; // poison removed + obligation persisted ⇒ the drain verifies + delivers; try the rest of the batch
              }
              // else: fall through to release+bail — source + strike retained, retried next flush (idempotent by source)
            }
          }
        }
        // B7: a failed release for a HEALTHY message must not silently strand it — track it for retry (not stuckPoison; it is not
        // a bad message, and recoverStaleClaims won't free a live-pid claim).
        for (let j = i; j < claimed.length; j++) if (!releaseInbox(claimed[j].file)) stuckRelease.add(claimed[j].file);
        break;
      }
      // C2: if we processed claims but delivered NONE (channel not ready), back off watch-triggered re-flushes so our own
      // claim/release renames don't self-excite a tight loop; the 5s timer keeps retrying. A delivery clears the backoff.
      if (claimed.length > 0) watchCooldownUntil = delivered === 0 ? Date.now() + WATCH_COOLDOWN_MS : 0;
    } finally {
      flushing = false;
    }
  };

  // A message has arrived for us. Try the host's native inbox first (surfaces in the live TUI with no hook and no
  // poll); if the channel is not ready, persist it to the DURABLE inbox so the retry below delivers it later.
  // `carried` = the sender's OWN address (handle) + permission mode, stamped into the local envelope at send (email
  // "From:"). Preferred over a roster lookup, which misses when the sender's per-run `from` id isn't in our roster (its
  // run changed / it has >1 node) — the bug that showed a bare run-id prefix + "default". Relay has no carry yet → it
  // falls back to resolving by the roster (labelFor/modeFor).
  const handleInbound = (from: string, text: string, via: "local" | "relay", carried?: { label?: string; mode?: string }): void => {
    // DELIVERY may use the lenient fallback (deliver into the sole session around); IDENTITY learning must NOT (F47-1/F47-R1:
    // every non-authoritative identity entry requires a UNIQUE cwd match). So: delivery target = codexDeliveryThread (lenient
    // activeThread ok); identity learn = authoritative ownCodexThread, else the STRICT ownThread (a lenient sole-loaded guess
    // never provides an ownership claim — adopting another cwd's thread here let an inbound message steal its identity).
    const codexThread = codexDeliveryThread(self.tool, ownCodexThread, self.stableId, codexDaemon?.activeThread(self.cwd));
    learnStableId(ownCodexThread ?? codexDaemon?.ownThread(self.cwd), ownCodexThread !== undefined);
    const label = carried?.label ?? labelFor(from); // the sender's stamped address, else resolve via roster
    const fromMode = carried?.mode ?? modeFor(from); // the sender's stamped mode, else resolve via roster
    // Bind the delivery identity's inbox key + arrival time NOW, before the async push. If the push fails, the fallback
    // persist must use the SAME identity this message was resolved for — not whatever identity a concurrent noteThread
    // switched us to by the time the callback runs, which would file A's message into B's inbox (Codex P2-7).
    const key = inboxKey();
    const ts = Date.now();
    // Metadata-only comms journal for swarm observability. Gated so Buffer.byteLength + the call are skipped entirely
    // when AGENTHOP_MSGLOG is off (the default); writeMsgLog is also internally a no-op + never throws.
    if (msgLogEnabled()) writeMsgLog(home, { ts, from, to: self.id, via, direction: "in", size: Buffer.byteLength(text), text });
    dbg(`inbound via=${via} from=${from} own=${ownCodexThread} stable=${self.stableId} daemon=${codexDaemon?.activeThread(self.cwd)} -> codexThread=${codexThread}`);
    // `to: self.title` = THIS session's own address, shown email-style so the user can see which of their sessions got it.
    void pushToHost(label, text, { codexThread, codexHome: codexDaemon?.codexHome(), fromMode, to: self.title }).then((ok) => {
      dbg(`pushToHost ok=${ok}`);
      if (ok) void flushInbox(); // channel works -> also deliver any durable backlog (keeps order)
      else writeInbox(home, key, { from, fromLabel: label, fromMode, text, via, ts });
    }).catch((e) => {
      // A push that THREW (not just returned false) must still fall back to the durable inbox, never drop the message —
      // an unhandled rejection would also crash the node (Codex P1-05). Persist under the identity bound above.
      dbg(`pushToHost threw: ${e instanceof Error ? e.message : String(e)}`);
      try { writeInbox(home, key, { from, fromLabel: label, fromMode, text, via, ts }); } catch { /* best effort */ }
    });
  };

  // B9 (review d8dd4b1): persist a durable RECOVERY FACT when the local broker (re)connects after a drop. Pre-fix, the in-memory
  // roster re-registered (elect -> broker/client) but NO durable surface recorded that this connection recovered — recordSelfObserve
  // ran only at startup/identity-change. Re-run it on each RE-registration: a fresh alias-log observe (new eventId + ts = the
  // recovery moment, busPid = this incarnation) that a pre-decision whois can read and date for staleness. The FIRST registration
  // is already covered by the startup observe below, so skip it. Reuses an existing face — no new persistent surface, no broadcast.
  let busRegistered = false;
  const onBusRegistered = (): void => {
    if (!busRegistered) { busRegistered = true; return; } // initial connect — startup recordSelfObserve covers it
    recordSelfObserve(home, self, stableIdAuthoritative, "local");
    retryCheckIn(); // B5: a (re)connect is a good moment to retry a missed startup check-in (coordinator may now be reachable)
  };
  const local: LocalBus = startLocalBus(self, options.home, (m) => handleInbound(m.from, m.payload, "local", { label: m.fromLabel, mode: m.fromMode }), onBusRegistered);

  // Codex has no native session id in its env, so we adopt the thread id as our stableId the first
  // time we learn it (from an MCP call's metadata or the daemon). This also refreshes the readable
  // handle (tool:dir-<shortId>) and re-announces it — on both the local broker and the relay directory
  // — so peers can address this session durably.
  const learnStableId = (id: string | undefined, authoritative: boolean): void => {
    if (!id) return;
    if (self.stableId === id) {
      // A guess for THIS exact id is now confirmed authoritative: record the upgrade (P2-1) so whois gets a HARD claim —
      // bus-identity correctly refuses to promote the earlier `possible` on its own. Flip once; a repeat authoritative
      // call for an already-hard id records nothing (no new identity fact).
      if (authoritative && !stableIdAuthoritative) {
        stableIdAuthoritative = true;
        recordLearn(home, self.id, undefined, id, "correction", true);
        recordSelfObserve(home, self, true, "local");
      } else if (authoritative) {
        stableIdAuthoritative = true;
      }
      return;
    }
    // A daemon guess never overrides an id we already have. Authoritative call metadata (or the env)
    // always wins: it may correct an earlier guess, and it keeps the published identity EQUAL to the
    // real delivery target — a stale stableId while delivery moved to another thread was the bug.
    if (!authoritative && self.stableId) return;
    const hadStableId = self.stableId !== undefined;
    const oldKey = self.stableId ?? self.id;
    const wasAuthoritative = stableIdAuthoritative; // capture BEFORE the reassign below — distinguishes thread-switch vs correction
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
    // Record the identity learn to the durable alias-log (bus-identity): bootstrap (first adoption) / thread-switch (an
    // authoritative id replacing an authoritative one) / correction (authoritative replacing a guess). authoritative flows
    // through as the confidence source; a correction's fold undoes the corrected old value. Append-only, fails soft.
    recordLearn(home, self.id, hadStableId ? oldKey : undefined, id, hadStableId ? (wasAuthoritative ? "thread-switch" : "correction") : "bootstrap", authoritative);
    // P2-2: the native learn alone does not record the now-published HANDLE (self.title). Observe the full current identity
    // (run + handle[derivedFrom native] + native) so whois(handle) resolves — a wait.owner stored as a handle can then get
    // this entity's probeTargets instead of reading not-seen.
    recordSelfObserve(home, self, authoritative, "local");
    // B5 (review d8dd4b1): the startup check-in used the per-run id because a Codex node's stableId was not yet known. Now that
    // the durable identity is learned (bootstrap / thread-switch / correction), re-report to the coordinator with the STABLE sid
    // so the session is durably addressable — the earlier provisional per-run line is superseded (idempotent at the coordinator
    // by sid). Gated on SWARM_COORDINATOR, never to self, fail-soft (reportCheckIn). Retain a retry obligation on a transient miss (B5).
    checkInPending = reportCheckIn(home, self, process.env.SWARM_COORDINATOR) === "retry";
    refreshLegacyKeys(true); // F40: self's native just changed ⇒ force a recompute (the keys depend on self.stableId, not only the log)
    // B7-1: the published identity just (re)assigned — notify the owner (presence) so a LISTENER bound to the old id (run-id)
    // re-binds to the new stable id. Fired only on an actual reassignment (the same-id/guess-only early returns above skip it).
    options.onIdentityChange?.(self);
  };

  const relay: Relay | undefined = startRelay(self, (from, text) => handleInbound(from, text, "relay"), options);
  // Record one self-observe to the alias-log at startup (run/handle/native[hard|possible by authority]/busPid/hostPid) so
  // whois can resolve this session + probe its liveness. Append-only, fails soft; only on identity change thereafter (learn).
  recordSelfObserve(home, self, stableIdAuthoritative, "local");
  refreshLegacyKeys(true); // F40: discover prior-identity inbox boxes of this logical session NOW (before watchInbox/flush below)

  const unified = (): UnifiedPeer[] => {
    // Collapse this machine's duplicate nodes for ONE session (startup presence daemon + lazily-spawned MCP node share
    // a stableId) so resolve isn't ambiguous and the roster shows it once (dedupLocalPeers; delivery stays exactly-once
    // via the atomic inbox + unicast DM). Then merge relay peers that aren't already present locally.
    const out = new Map<string, UnifiedPeer>();
    for (const p of dedupLocalPeers(local.peers().map((p) => ({ id: p.id, stableId: p.stableId, tool: p.tool, mode: p.mode, cwd: p.cwd, title: p.title, via: "local", pid: p.pid, status: p.status, statusSeq: p.statusSeq, statusText: p.statusText, statusAt: p.statusAt })))) {
      out.set(p.id, p);
    }
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

  // The sender's REAL permission mode, used only to stamp from-mode on a delivery (unknown -> "default", the safe/gated
  // side). LOCAL peers ONLY: a same-OS-user peer could change this machine's config anyway, so trusting its self-reported
  // mode grants no new power; but a REMOTE same-team member must NOT be able to self-attest "bypassPermissions" and so
  // skip the receiver's approval gate — team membership proves membership, not a permission mode (Codex P1-04). A relay
  // sender therefore resolves to undefined -> "default" -> gated unless the receiver itself opts in (crossSessionInbound).
  const modeFor = (idOrPub: string): string | undefined => {
    const p = unified().find((x) => x.id === idOrPub || x.stableId === idOrPub || x.pub === idOrPub);
    return p?.via === "local" ? p.mode : undefined;
  };

  const resolve = (to: string): UnifiedPeer | ResolveError => resolvePeer(unified(), self.id, to);

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
  // F47: proactively adopt the Codex thread id from the daemon as our roster stableId. Under Codex 0.162 (rmcp client) an
  // MCP call no longer carries x-codex-turn-metadata, so the node never learns its thread id from a call and — if it also
  // never receives an inbound (handleInbound's adopt) — stays an un-addressable "unknown" in the roster, restart and all.
  // F47-1: adopt ONLY via the STRICT ownThread (a loaded thread whose cwd UNIQUELY equals ours) — NOT the lenient
  // delivery fallback `activeThread`, which would adopt the sole loaded thread even when its cwd clearly belongs to another
  // session (stealing its identity). A NON-authoritative guess (real call metadata still upgrades it); no unique cwd match
  // -> stay unconfirmed. F47-2: skip once `closed` so a torn-down instance never adopts or records identity.
  let closedForAdopt = false;
  const adoptCodexIdentity = (): void => { if (closedForAdopt || !codexDaemon || stableIdAuthoritative) return; learnStableId(codexDaemon.ownThread(self.cwd), false); };
  // Fast initial adoption: the daemon handshake + thread list take ~1-2s, so poll briefly until we hold an id (then stop).
  let codexIdTimer: ReturnType<typeof setInterval> | undefined;
  if (codexDaemon) {
    let tries = 0;
    codexIdTimer = setInterval(() => { adoptCodexIdentity(); if (self.stableId !== undefined || ++tries >= 20) { if (codexIdTimer) clearInterval(codexIdTimer); codexIdTimer = undefined; } }, 1000);
    codexIdTimer.unref?.();
  }
  const flushTimer = setInterval(() => { void flushInbox(); retryCheckIn(); adoptCodexIdentity(); }, 5000); // B5: the timer also retries a missed check-in; the steady backstop for a late daemon / thread drift
  flushTimer.unref?.();

  // Recipient fs-watch (B2/B3 option b): a sender now writes same-machine messages straight to our durable inbox, so watch our
  // inbox dir(s) and flush the MOMENT one lands — near-live surfacing instead of waiting out the 5s timer, which stays the floor.
  // Debounced so a burst of writes coalesces into one flush. Watches the CURRENT inbox keys at startup; a Codex node that adopts
  // its stableId later still surfaces via the timer until then (durable is the guarantee, the watch is only the accelerator).
  // S18 seam ("message is a pointer, file is authoritative"): a pre-seal flush would hook in here, before flushInbox.
  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  const onInboxChange = (): void => {
    if (Date.now() < watchCooldownUntil) return; // C2: backing off after a no-progress flush — ignore self-induced churn; the timer retries
    if (watchDebounce) return; // coalesce a burst of arrivals into a single flush
    watchDebounce = setTimeout(() => { watchDebounce = undefined; void flushInbox(); }, 50);
    watchDebounce.unref?.();
  };
  const stopInboxWatch = watchInbox(home, inboxKeys(), onInboxChange);

  // bus-reachability §4: announce this (re)started node to the coordinator's durable inbox so the coordinator learns of
  // the session without relying on a prompt the LLM must remember to send. Gated on SWARM_COORDINATOR, never to self,
  // fail-soft. A Claude node has its stableId at startup; a Codex node that learns its thread id later gets its durable
  // re-announce through the reconnect/re-register path (Stage C), not here.
  if (reportCheckIn(home, self, process.env.SWARM_COORDINATOR) === "retry") checkInPending = true; // B5: coordinator not reachable yet / write failed ⇒ retry on the timer + reconnect

  return {
    self,
    peers: unified,
    noteThread(id) {
      ownCodexThread = id;
      learnStableId(id, true); // call metadata is authoritative for both identity and delivery
      void flushInbox(); // a Codex session just took a turn -> its rollout now exists -> flush anything pending to it
    },
    adoptStableId(sid) {
      learnStableId(sid, true); // F45 ①: authoritative adoption — same machinery as a Codex thread adopt (inboxKeys + socket rebind + resolve)
      void flushInbox();        // drain anything already pending to the adopted identity's inbox immediately ("扫箱")
    },
    async send(to, text) {
      // bus-reachability §1 / B2+B3 (option b): SAME-MACHINE delivery is DURABLE-ALWAYS. The recipient's durable inbox is the
      // ONLY delivery guarantee — a live broker/native push is never a confirmed receipt (B3), and native-direct is RETIRED (its
      // cached cc-socks path could be rebound to another process ⇒ misroute, B2). A same-machine target (a resolved LOCAL peer,
      // or an offline session that owns the handle via presence/<sid>.pid) ⇒ write its durable inbox; the recipient's fs-watch +
      // flush surfaces it near-live and it survives a restart. CROSS-MACHINE (relay) has no shared durable inbox ⇒ a live
      // best-effort relay send, reported honestly. `delivered` is thus "durable" (guaranteed-queued) or "relay" (live).
      const toDurable = (sid: string): { ok: true; label?: string; delivered: "durable" } => {
        writeInbox(home, sid, { from: self.stableId ?? self.id, fromLabel: self.title, ...(self.mode ? { fromMode: self.mode } : {}), text, via: "local", ts: Date.now() });
        return { ok: true, label: labelFor(sid), delivered: "durable" };
      };
      // F40: ONE write-side addressing entry decides durable / relay / none and computes the durable inbox KEY. The key is
      // always the recipient's STABLE identity (stableId ?? per-run id, or an offline session's presence-owned native sid) —
      // never the routing name, which can drift on restart and strand mail in a box no live node drains (the F40 incident).
      const resolvedPeer = resolve(to);
      const sessionList = listSessions(home);
      // F45-R1 (coordinator ruling B): a relay-resolved peer is cross-BROKER, not necessarily cross-MACHINE. It is same-machine
      // (⇒ route durable to its local inbox) IFF its per-session LIVENESS SOCKET answers: the presence daemon listens on
      // presence/<sid>.sock, and the kernel drops that listener the instant the daemon dies, so a successful connect proves the
      // CURRENT instance is alive — window-free (no last-write/mtime freshness, so no pid-recycle window). A stale sock from a
      // dead daemon ⇒ ECONNREFUSED; a recycled pid never listens on it ⇒ connect fails ⇒ keep relay (no false durable). The
      // sock filename IS the sid, so the probe is naturally bound to the exact identity.
      // F45-R7 (rounds 7-9): is this relay-resolved peer actually SAME-MACHINE? probeSessionAlive hashes the sid to a bounded,
      // collision-free socket-name prefix (a crafted "../bridge" can't traverse; two long sids can't truncate-collide) and
      // connect-probes the peer's per-instance liveness socket(s). A connect proves the current instance is alive — window-free.
      // isValidSessionId still gates the DURABLE INBOX KEY below (the raw sid is the inbox dir name): an unsafe sid never becomes
      // a durable target even though its hashed socket path is always safe.
      let relayLocalSid: string | null = null;
      if (!("error" in resolvedPeer) && resolvedPeer.via === "relay" && resolvedPeer.stableId
          && isValidSessionId(resolvedPeer.stableId)
          && (await probeSessionAlive(home, resolvedPeer.stableId))) {
        relayLocalSid = resolvedPeer.stableId;
      }
      const target = resolveInboxTarget(to, resolvedPeer, resolveSession(to, sessionList), relayLocalSid);
      if (target.kind === "none") return { ok: false, error: target.reason };
      if (target.kind === "durable") {
        // C1 (review 01b773d): an OpenCode node receives over the broker + its own in-memory queue; it does NOT consume the
        // durable inbox, so a durable write to it is never read. For such a node, deliver over the LIVE BUS (the accelerator it
        // does consume) and report the capability limit honestly — delivered:"bus" is best-effort, NOT the durable guarantee. Every
        // other local node (BusCore: claude/codex) consumes the durable inbox and gets durable-always. (Not native-direct — no
        // cached socket, no misroute; just the broker the peer is already on.)
        if (target.peer?.tool === "opencode") {
          const oc = target.peer;
          const ok = local.send(oc.id, text);
          if (ok) { if (msgLogEnabled()) writeMsgLog(home, { ts: Date.now(), from: self.id, to: oc.id, via: "local", direction: "out", size: Buffer.byteLength(text), text }); return { ok: true, label: labelFor(oc.id), delivered: "bus" }; }
          return { ok: false, error: `"${oc.title}" (OpenCode) is not reachable on the live bus right now, and OpenCode nodes do not consume the durable inbox — try again when it is active.` };
        }
        return toDurable(target.sid);
      }
      // CROSS-MACHINE (relay): a live best-effort send; no local durable fallback (no shared filesystem).
      const peer = target.peer;
      if (relay && peer.pub) {
        const ok = await relay.send(peer.pub, text);
        if (ok) {
          if (msgLogEnabled()) writeMsgLog(home, { ts: Date.now(), from: self.id, to: peer.id, via: "relay", direction: "out", size: Buffer.byteLength(text), text });
          return { ok: true, label: labelFor(peer.id), delivered: "relay" };
        }
        return { ok: false, error: `Relay delivery to "${peer.title}" failed; it is on another machine.` };
      }
      return { ok: false, error: "That peer is on another machine but no team relay is configured here (set AGENTHOP_TEAM)." };
    },
    async recv(timeoutMs) {
      // Explicit pull: drain the DURABLE inbox (messages the push channel could not surface). Claim+ack so the retry
      // timer never re-delivers the same message.
      const deadline = Date.now() + timeoutMs;
      // F40-2-A: recompute legacy keys before EVERY claim — at entry AND on each 120ms poll — not just at recv entry. An
      // alias-log revoke/late-link appended DURING the wait must take effect on the very next drain: a revoked box must not be
      // claimed, a newly-linked same-native box must be picked up. Stamp-gated ⇒ cheap when the log is unchanged.
      const drain = (): BusMessage[] => {
        refreshLegacyKeys();
        return claimInbox(home, inboxKeys(), String(process.pid), stuckPoison).map((c) => {
          ackInbox(c.file);
          return { from: c.msg.from, fromLabel: c.msg.fromLabel, text: c.msg.text, via: c.msg.via };
        });
      };
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
      closedForAdopt = true; // F47-2: a closed instance must never adopt or record identity again
      if (codexIdTimer) { clearInterval(codexIdTimer); codexIdTimer = undefined; } // F47-2: clear the fast-adopt timer (flushTimer is cleared below)
      clearInterval(flushTimer);
      stopInboxWatch();
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
