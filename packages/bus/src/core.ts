import { selfInfo, sessionTitle, type SelfInfo } from "./label.js";
import { startLocalBus, type LocalBus } from "./broker.js";
import { startRelay, type Relay } from "./relay.js";
import { pushToHost } from "./push.js";
import { startCodexDaemon, type CodexDaemon } from "./codex.js";
import { resolvePeer, type UnifiedPeer } from "./resolve.js";
import { dbg } from "./debug.js";

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
  const queue: BusMessage[] = [];
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

  // A message has arrived for us. Try the host's native inbox first (surfaces in the live TUI with
  // no hook and no poll); only if there is none do we keep it for agenthop_recv.
  const handleInbound = (from: string, text: string, via: "local" | "relay"): void => {
    // Delivery is locked to this session's learned identity (codexDeliveryThread), so it never diverges
    // from the published stableId. Learn from the SAME value: authoritative when it came from call
    // metadata, a guess when only the daemon bootstrapped it.
    const codexThread = codexDeliveryThread(self.tool, ownCodexThread, self.stableId, codexDaemon?.activeThread());
    learnStableId(codexThread, ownCodexThread !== undefined);
    const label = labelFor(from);
    dbg(`inbound via=${via} from=${from} own=${ownCodexThread} stable=${self.stableId} daemon=${codexDaemon?.activeThread()} -> codexThread=${codexThread}`);
    void pushToHost(label, text, { codexThread }).then((ok) => {
      dbg(`pushToHost ok=${ok}`);
      if (!ok) queue.push({ from, fromLabel: label, text, via });
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
    self.stableId = id;
    self.title = sessionTitle(self.tool, self.cwd, id);
    stableIdAuthoritative = authoritative;
    local.updateSelf(self);
    relay?.updateSelf(self);
  };

  const relay: Relay | undefined = startRelay(self, (from, text) => handleInbound(from, text, "relay"), options);

  const unified = (): UnifiedPeer[] => {
    const out = new Map<string, UnifiedPeer>();
    for (const p of local.peers()) out.set(p.id, { id: p.id, stableId: p.stableId, tool: p.tool, cwd: p.cwd, title: p.title, via: "local", pid: p.pid });
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

  return {
    self,
    peers: unified,
    noteThread(id) {
      ownCodexThread = id;
      learnStableId(id, true); // call metadata is authoritative for both identity and delivery
    },
    async send(to, text) {
      const peer = resolve(to);
      if ("error" in peer) return { ok: false, error: peer.error };
      if (peer.via === "local") return { ok: local.send(peer.id, text), label: labelFor(peer.id) };
      if (relay && peer.pub) return { ok: await relay.send(peer.pub, text), label: labelFor(peer.id) };
      return { ok: false, error: "That peer is on another machine but no team relay is configured here (set AGENTHOP_TEAM)." };
    },
    async recv(timeoutMs) {
      // Only messages with no native host inbox land here; native ones already surfaced in the TUI.
      const deadline = Date.now() + timeoutMs;
      let batch = queue.splice(0, queue.length);
      while (batch.length === 0 && Date.now() < deadline) {
        await delay(120);
        batch = queue.splice(0, queue.length);
      }
      return batch;
    },
    status() {
      const relayUrl = options.relay ?? process.env.AGENTHOP_RELAY ?? "default relay";
      const team_ = relay ? `team on (${relayUrl})` : "team off (same-machine only; set AGENTHOP_TEAM for cross-machine)";
      return `local broker: ${local.role()}; ${team_}; ${unified().filter((p) => p.id !== self.id).length} other session(s)`;
    },
    async close() {
      codexDaemon?.close();
      await local.close();
      await relay?.close();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
