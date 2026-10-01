import { hostname } from "node:os";
import { ephemeralKeys } from "./dm.js";
import { loadTeam, type Team } from "./team.js";
import { startDirectory, type RemotePeer } from "./directory.js";
import { startMailbox } from "./mailbox.js";
import type { SelfInfo } from "./label.js";
import type { UnifiedPeer } from "./resolve.js";

/**
 * The cross-machine half of the bus, factored out of core.ts so both a self-joining session (core.ts,
 * one relay node per process) and the gateway (bridge.ts, one relay node per proxied OpenCode session)
 * build it the same way. It is the team-scoped directory (who is out there) plus this identity's own
 * mailbox (DMs sealed to it). Returns undefined when no team secret is set — then only the local
 * broker runs.
 *
 * Identity vs. delivery are kept apart on purpose: `self` is the announced identity, `onInbound` is
 * where a DM to it is delivered. core.ts delivers to the host's native inbox; the gateway delivers
 * back through the local broker to the OpenCode session it stands in for.
 */

export type Relay = {
  /** Everyone on other machines right now, as unified rows (via:"relay"). Excludes this identity. */
  roster(): UnifiedPeer[];
  /** Seal `text` to a peer's public key and post it to their mailbox. false if it did not go. */
  send(pub: string, text: string): Promise<boolean>;
  /** Re-announce our presence after a late identity change (e.g. a stable session id learned). */
  updateSelf(self: SelfInfo): void;
  close(): Promise<void>;
};

export type RelayOptions = {
  home?: string;
  relay?: string;
  pass?: string;
  /**
   * Use this exact Team rather than reading the config now. The gateway passes the Team it validated a
   * session's handshake against, so the team it CHECKS and the team it PUBLISHES to are always the same
   * even if the on-disk config changes between them.
   */
  team?: Team;
};

export function startRelay(
  self: SelfInfo,
  onInbound: (from: string, text: string) => void,
  options: RelayOptions = {},
): Relay | undefined {
  const team = options.team ?? loadTeam(options.home);
  if (!team) return undefined;
  const keys = ephemeralKeys();
  let relayMe: RemotePeer = {
    id: self.id,
    stableId: self.stableId,
    tool: self.tool,
    cwd: self.cwd,
    title: self.title,
    machine: hostname(),
    pub: keys.publicKey,
    ts: Date.now(),
    status: self.status,
    statusSeq: self.statusSeq,
    statusText: self.statusText,
    statusAt: self.statusAt,
  };
  const directory = startDirectory({ team, self: relayMe, relay: options.relay, pass: options.pass });
  const mailbox = startMailbox({ keys, relay: options.relay, pass: options.pass, onInbound: (m) => onInbound(m.from, m.payload) });

  return {
    roster: () =>
      directory.roster().map((p) => ({
        id: p.id,
        stableId: p.stableId,
        tool: p.tool,
        cwd: p.cwd,
        title: p.title,
        via: "relay" as const,
        machine: p.machine,
        pub: p.pub,
        status: p.status,
        statusSeq: p.statusSeq,
        statusText: p.statusText,
        statusAt: p.statusAt,
      })),
    send: (pub, text) => mailbox.send(pub, text),
    updateSelf(next) {
      // Carry the work-status fields too: core.ts pushes every status change through here, and the
      // directory announce is what a peer on another machine sees (its monotonic statusSeq rides along
      // so a replayed announce can never roll it back — see directory.ts mergePresence).
      relayMe = {
        ...relayMe,
        stableId: next.stableId,
        title: next.title,
        ts: Date.now(),
        status: next.status,
        statusSeq: next.statusSeq,
        statusText: next.statusText,
        statusAt: next.statusAt,
      };
      directory.updateSelf(relayMe);
    },
    async close() {
      await directory.close();
      await mailbox.close();
    },
  };
}
