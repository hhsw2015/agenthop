import { hkdfSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isRoomAddress, normalizeCode, relayEndpoints, WORDLIST } from "@agenthop/tunnel";
import { DEFAULT_RELAY, readQueue, sendMessage, startHost } from "@agenthop/cli";
import { openEntry, sealEntry, type Team } from "./team.js";
import type { AgentStatus } from "./label.js";

type RunningHost = Awaited<ReturnType<typeof startHost>>;

/**
 * Cross-machine discovery, built entirely on a stock relay — the directory is an ordinary room,
 * so no relay change is needed (the same trick the upstream inbox uses).
 *
 * Everyone on a team announces a small sealed presence blob into one well-known room. One member
 * hosts that room (keeper); the rest POST their announcement and read the log back. Announcements
 * every minute double as the room's keepalive, so it never idles out while anyone is on it. If the
 * keeper goes, the next announce fails and a member reclaims the room with the team-derived token.
 *
 * The relay sees only the namespace id, the message sizes and their timing — never the secret, the
 * roster, or who is who.
 */

/** A presence entry as it travels (sealed under nsKey) and as roster() returns it. */
export type RemotePeer = {
  id: string;
  /** The host's native session id: a durable, restart-stable address (see SelfInfo.stableId). */
  stableId?: string;
  tool: string;
  cwd: string;
  title: string;
  machine: string;
  /** The session's public key, so a DM can be sealed to it. */
  pub: string;
  /** Sender's clock, ms. Used for roster TTL freshness — NOT for ordering a run's announces (clocks skew). */
  ts: number;
  /** Per-INSTANCE epoch: the relay instance's creation stamp (Date.now()), constant for that instance and
   *  strictly higher on each re-instantiation of the same logical run (a restart / socket reconnect makes a
   *  fresh relay node with a NEW pub+mailbox). It orders INSTANCES: a higher epoch wins wholesale (adopt the
   *  new pub + fresh status), so a reconnect is picked up at once instead of the remote clinging to the old,
   *  now-closed mailbox until TTL; an older-epoch replay is rejected. `rev` orders announces WITHIN an epoch.
   *  Absent for peers predating this field (merge falls back to `rev`, then `ts`). */
  epoch?: number;
  /** Per-RUN monotonic presence revision: strictly increases on every announce from this instance, independent
   *  of the wall clock. Within one epoch it — not `ts` — orders a run's announces (including identity
   *  switches), so a clock rollback or a same-ms reorder can neither drop a newer announce nor let an older
   *  one overwrite it. Absent for peers predating this field (merge then falls back to `ts`). */
  rev?: number;
  /**
   * Self-reported work state (see SelfInfo): rides the presence blob so remote peers see it too.
   * `statusSeq` is the per-identity monotonic counter; mergePresence uses it so a replayed or
   * reordered announce can never roll a fresher status back. All optional: absent = never reported.
   */
  status?: AgentStatus;
  statusSeq?: number;
  statusText?: string;
  statusAt?: number;
};

export type Directory = {
  /** Everyone seen in the last TTL, newest entry per session. Excludes ourselves. */
  roster(): RemotePeer[];
  /** Refresh our own announced presence (e.g. once a stable session id is learned late). */
  updateSelf(next: RemotePeer): void;
  close(): Promise<void>;
};

const ANNOUNCE_MS = 60_000;
const TTL_MS = 150_000;
// How long our own just-sent announce may go unseen before we treat the read cursor as stale. Must
// exceed a normal announce->read round trip (a couple of 5s polls); well under the roster TTL.
const STALE_GRACE_MS = 12_000;
const PRESENCE_PREFIX = "[[agenthop:bus-presence]] ";

/** The room presence is gathered in, derived from the public namespace id (never the secret). */
export function directoryAddress(nsId: string): string {
  for (let round = 0; ; round++) {
    const bytes = Buffer.from(hkdfSync("sha256", Buffer.from(nsId), Buffer.alloc(0), `agenthop bus dir v1 ${round}`, 8));
    const digits = String(bytes.readUInt16BE(0) % 10000).padStart(4, "0");
    const words = [2, 4, 6].map((at) => WORDLIST[bytes.readUInt16BE(at) % WORDLIST.length]!);
    const address = `${digits}-${words.join("-")}`;
    if (isRoomAddress(address)) return address;
  }
}

/** The token that holds the directory room, derived from the team key so any member can reclaim it. */
export function directoryToken(team: Team): string {
  return Buffer.from(hkdfSync("sha256", team.nsKey, Buffer.alloc(0), "agenthop bus dir token v1", 32)).toString("base64url");
}

export type DirectoryOptions = {
  team: Team;
  self: RemotePeer;
  relay?: string;
  pass?: string;
};

/** The durable identity a status belongs to: the native session id when known, else the run id. */
const identityOf = (peer: RemotePeer): string => peer.stableId ?? peer.id;

/** Cap the only free-text, caller-controlled presence field so a sealed presence blob can never exceed the
 *  relay's per-message limit (a ~50 KB note sealed to ~67 KB blew past the 64 KiB cap and every heartbeat
 *  then failed). A status note is meant to be short; 2 KiB is generous and keeps the sealed blob tiny. */
const MAX_STATUS_TEXT_BYTES = 2 * 1024;
export function capStatusText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_STATUS_TEXT_BYTES) return text;
  // Truncate on the byte limit; a cut multi-byte char decodes to a trailing U+FFFD, which we strip, then mark.
  return `${buf.subarray(0, MAX_STATUS_TEXT_BYTES).toString("utf8").replace(/�+$/, "")}…`;
}

/**
 * Fold a newer presence entry over the one already on the roster, without letting its status fields
 * roll back. The room log replays old entries (a cursor reset re-reads it from the start) and sender
 * clocks only order entries approximately, so `next` being accepted does not prove its STATUS is the
 * freshest — only `statusSeq` (the per-identity monotonic counter, see core.ts setStatusImpl) does.
 * Rule: `next` wins the presence fields; its status fields win only when STRICTLY newer by seq (the
 * same `seq <= prev` guard core.ts setStatusImpl applies locally), or when they are the first seq seen
 * for this identity. A different identity starts fresh — statuses are per-identity and must never leak
 * across a thread switch. Pure, exported for tests.
 */
export function mergePresence(prev: RemotePeer | undefined, next: RemotePeer): RemotePeer {
  if (!prev) return next;
  // INSTANCE epoch first: a different epoch means a different relay INSTANCE of this run (a restart/reconnect
  // made a fresh node with a NEW pub+mailbox). The higher epoch wins WHOLESALE — adopt its pub and its fresh
  // status/rev at once — so the remote switches to the live mailbox immediately instead of clinging to the old,
  // now-closed one until TTL; an older-epoch replay can never reclaim. (Within one epoch, fall through to rev.)
  if (next.epoch !== undefined && prev.epoch !== undefined && next.epoch !== prev.epoch) {
    return next.epoch > prev.epoch ? next : prev;
  }
  // Same instance (same epoch, or a peer predating epoch): order a run's announces by its MONOTONIC `rev` when
  // both carry one — it, not the wall clock, is the truth. Fall back to `ts` only for peers that predate it.
  const haveRev = next.rev !== undefined && prev.rev !== undefined;
  const nextStrictlyNewer = haveRev ? next.rev! > prev.rev! : next.ts > prev.ts;
  const nextNotOlder = haveRev ? next.rev! >= prev.rev! : next.ts >= prev.ts;
  // A DIFFERENT identity in this run slot (a Codex run multiplexing thread A→B) is adopted ONLY by a STRICTLY
  // newer announce. By `rev` this both rejects a late/replayed OLDER-identity announce (it would otherwise
  // overwrite the current entry and could age the whole peer past its TTL) AND adopts a legitimate same-ms
  // switch (its revision is higher even when the clock tie makes ts useless).
  if (identityOf(prev) !== identityOf(next)) return nextStrictlyNewer ? next : prev;
  // Same identity: two INDEPENDENT axes, merged separately so neither discards the other's advance —
  //  - PRESENCE fields follow the newer announce (by rev, else ts);
  //  - STATUS fields follow the higher per-identity monotonic `statusSeq` (core.ts setStatusImpl),
  // so an older-revision announce carrying a higher statusSeq still advances the status, and vice versa.
  const presenceBase = nextNotOlder ? next : prev;
  const statusFrom = next.statusSeq !== undefined && (prev.statusSeq === undefined || next.statusSeq > prev.statusSeq) ? next : prev;
  return { ...presenceBase, status: statusFrom.status, statusSeq: statusFrom.statusSeq, statusText: statusFrom.statusText, statusAt: statusFrom.statusAt };
}

/**
 * A per-INSTANCE epoch that is MONOTONIC across restarts even when the wall clock regresses. `Date.now()`
 * alone is NOT enough: an NTP step-back, a VM/snapshot restore, or a bad RTC can make a restarted instance's
 * clock lower than the one a remote still remembers, and mergePresence's epoch gate then rejects the new
 * instance FOREVER (a lower epoch loses at the gate; ts/rev catching up never helps, and the remote's `seen`
 * watermark is only TTL-filtered, never deleted) — the peer silently drops at TTL and never comes back until
 * some instance finally lands a higher epoch. Persisting `max(now, last+1)` makes each successive instance
 * strictly greater than every prior one on this machine, so a clock rollback can no longer strand a peer.
 *
 * A single shared counter per home is enough: the epoch only has to order restarts of the SAME identity, and
 * those are sequential (old process exits, new one starts → sequential read-then-write → strictly increasing).
 * Two DIFFERENT identities starting at the same ms may read the same `last` and collide on one value, but that
 * is harmless — equal epochs skip the epoch gate and fall through to the per-identity axes. Exported for tests.
 */
export function nextInstanceEpoch(home: string = process.env.HOME || homedir()): number {
  const file = path.join(home, ".agenthop", "dir-epoch");
  let last = 0;
  try {
    last = Number.parseInt(readFileSync(file, "utf8"), 10) || 0;
  } catch {
    // first run / unreadable — start from the clock
  }
  const epoch = Math.max(Date.now(), last + 1);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(epoch));
  } catch {
    // read-only home: use the in-memory value (degraded — a later rollback could still strand this peer)
  }
  return epoch;
}

export function startDirectory(options: DirectoryOptions): Directory {
  const { team } = options;
  // Mutable: a Codex session learns its native id after startup and refreshes its presence via updateSelf.
  let self = options.self;
  const address = directoryAddress(team.nsId);
  const token = directoryToken(team);
  const base = relayEndpoints(options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY, normalizeCode(address)).publicBase;
  const seen = new Map<string, RemotePeer>();
  let keeper: RunningHost | undefined;
  let closed = false;
  let electing = false;
  let after = 0;
  // The ts of our latest announce that we have not yet read back, and when we sent it. Our own writes
  // always come back from a healthy keeper; if this one does not within STALE_GRACE_MS, our writes are
  // landing on a keeper the reads no longer see (the room was taken over and the log restarted at a low
  // seq that our cursor skips) — the cue to resync from the start of the new (small) log. No relay head
  // query or generation id exists, so watching our own write is the cheapest reliable reset signal.
  let pendingSelfTs: number | undefined;
  let pendingSince = 0;
  // The current keeper's per-instance generation id (from the queue response). When it changes, a new
  // keeper took over and its log restarts at seq 1 — precise detection of the takeover.
  let keeperGeneration: string | undefined;
  // Bumped on every cursor reset. Pulls can overlap (the 5s poll and 60s beat coincide, or a slow
  // read), so a pull tags its read with the current epoch and discards its response if a reset happened
  // meanwhile — otherwise a late response from the OLD keeper could roll the cursor back over a reset.
  let epoch = 0;
  // This relay instance's epoch + a per-announce revision, both stamped on every announce. epoch is constant
  // for the instance and STRICTLY higher on every re-instantiation of this run (restart/reconnect → fresh node,
  // new pub) — persisted-monotonic so even a clock rollback cannot lower it (see nextInstanceEpoch). rev
  // strictly increases within the instance. Remote peers merge by (epoch, rev) — see mergePresence.
  const instanceEpoch = nextInstanceEpoch();
  let announceRev = 0;

  const remember = (peer: RemotePeer): void => {
    // Reading back ANY of our own announces at/after the grace-clock start confirms the keeper sees our
    // writes → disarm. Matching only the LATEST ts was wrong: a healthy keeper whose echo lags behind newer
    // announces never cleared, so the stale-keeper fallback fired spuriously (#P2-7).
    if (peer.id === self.id && pendingSelfTs !== undefined && peer.ts >= pendingSince) {
      pendingSelfTs = undefined;
      pendingSince = 0;
    }
    // No outer ts gate: mergePresence merges the two axes independently (presence by ts, status by
    // statusSeq), so a lower-ts entry carrying a higher statusSeq still advances the status, and a stale
    // one never rolls presence back (it keeps the fresher ts). Gating here on ts dropped such updates.
    seen.set(peer.id, mergePresence(seen.get(peer.id), peer));
  };

  /** Accept any presence blob we can open with the team key; ignore the rest. Keeper-side. */
  const accept = (text: string): boolean => {
    if (!text.startsWith(PRESENCE_PREFIX)) return false;
    try {
      remember(JSON.parse(openEntry(team.nsKey, text.slice(PRESENCE_PREFIX.length))) as RemotePeer);
      return true;
    } catch {
      return false;
    }
  };

  async function tryKeeper(): Promise<void> {
    if (closed || electing || keeper) return;
    electing = true;
    try {
      const host = await startHost({
        code: address,
        token,
        serveQueue: true,
        relay: options.relay,
        pass: options.pass,
        accept,
        recoverMs: Number.POSITIVE_INFINITY,
        // The directory room lives for the whole session and only holds small presence blobs. The
        // default 2,000-message / 8 MiB lifetime quota would silently reject announcements after a
        // while (20 sessions announcing once a minute ~= 100 min), so lift it like upstream inbox.
        limits: { messages: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, textBytes: 64 * 1024 },
      });
      if (closed) {
        await host.close(); // closed while opening: don't leave a keeper running (#7)
        return;
      }
      keeper = host;
      after = 0; // we now serve a fresh room log; re-read it from the start (#5)
    } catch {
      // room_taken: someone else keeps it. We stay a plain member (announce + read).
    } finally {
      electing = false;
    }
  }

  async function announce(): Promise<void> {
    if (closed) return;
    const entry: RemotePeer = { ...self, ts: Date.now(), epoch: instanceEpoch, rev: ++announceRev, statusText: capStatusText(self.statusText) };
    // Register the watch BEFORE sending. The room stores the log entry and only then acks the POST, so
    // an independent GET can read our announce back before sendMessage resolves; setting the marker only
    // after the await would let that read miss it, and the marker would then time out on a healthy log.
    // With it set first, a concurrent read clears it (remember()); we leave it as-is on success and only
    // clear it here if the send itself failed.
    pendingSelfTs = entry.ts;
    // Start the stale-keeper grace clock on the FIRST unechoed announce only, and anchor it to entry.ts so an
    // echoed announce (peer.ts === entry.ts) clears it via `peer.ts >= pendingSince`. A routine re-announce
    // (every status change, ~10s) must NOT push pendingSince forward, or the >STALE_GRACE_MS fallback never
    // fires and a taken-over keeper goes undetected until a live peer has aged past its TTL (#P2-7).
    if (pendingSince === 0) pendingSince = entry.ts;
    try {
      await sendMessage({ code: address, text: PRESENCE_PREFIX + sealEntry(team.nsKey, JSON.stringify(entry)), relay: options.relay, pass: options.pass });
    } catch (error) {
      if (pendingSelfTs === entry.ts) {
        pendingSelfTs = undefined; // send failed: nothing to watch for
        pendingSince = 0;
      }
      // No room there (keeper gone or never was): the log restarts under the next keeper, so reset our
      // read cursor (#5) before taking it over; the next tick announces.
      if (/\b404\b|not found/i.test(error instanceof Error ? error.message : String(error))) {
        after = 0;
        void tryKeeper();
      }
    }
  }

  async function pull(): Promise<void> {
    if (closed) return;
    // Own-announce fallback (for a keeper without the generation field): our recent announce never came
    // back -> taken over -> resync. Rarely fires once the generation check is active (that resets sooner).
    if (pendingSelfTs !== undefined && pendingSince !== 0 && Date.now() - pendingSince > STALE_GRACE_MS) {
      after = 0;
      epoch++;
      pendingSelfTs = undefined; // act once; don't re-trigger every poll while it stays unechoed
      pendingSince = 0;
    }
    const startEpoch = epoch;
    try {
      const resp = await readQueue(base, after, options.pass);
      // A reset happened while we were awaiting (a concurrent pull, or our own above): this response
      // predates it, so drop it — never let a late old-keeper response roll the cursor back over a reset.
      if (epoch !== startEpoch) return;
      const generation = (resp as { generation?: string }).generation;
      if (generation && keeperGeneration !== undefined && generation !== keeperGeneration) {
        // New keeper: its log restarts at a low seq our cursor skips. Reset and let the next poll read
        // it from the start (~5s); do not apply this response's old-cursor events.
        keeperGeneration = generation;
        after = 0;
        epoch++;
        pendingSelfTs = undefined; // a pending announce to the old keeper is moot; don't let it thrash
        pendingSince = 0;
        return;
      }
      if (generation) keeperGeneration = generation;
      // No await past this point, so the cursor/roster commit is atomic against other pulls.
      for (const event of resp.events) {
        after = Math.max(after, event.seq ?? after);
        if (typeof event.text === "string") accept(event.text);
      }
    } catch (error) {
      // Room briefly unhosted between keepers (404): rewind, bump epoch, forget the generation so the
      // next keeper's is adopted cleanly. The next keeper restarts the log at seq 1. (accept() idempotent.)
      if (/\b404\b|not found/i.test(error instanceof Error ? error.message : String(error))) {
        after = 0;
        epoch++;
        keeperGeneration = undefined;
      }
    }
  }

  void tryKeeper().then(() => {
    void announce();
    void pull();
  });
  const beat = setInterval(() => {
    void announce();
    void pull();
  }, ANNOUNCE_MS);
  beat.unref();
  // Read more often than we announce, so a new peer shows up within a few seconds, not a minute.
  const poll = setInterval(() => void pull(), 5_000);
  poll.unref();

  return {
    roster() {
      const cutoff = Date.now() - TTL_MS;
      return [...seen.values()].filter((peer) => peer.ts >= cutoff && peer.id !== self.id);
    },
    updateSelf(next) {
      self = next; // the roster self-filter and every later announce use the refreshed presence
      // Announce right away too (mirrors the local broker's re-hello): a late-learned identity or a
      // work-status change should reach other machines within one poll (~5s), not one beat (60s).
      // setStatusImpl already suppresses no-change calls, so this stays at state-change cadence.
      void announce();
    },
    async close() {
      closed = true;
      clearInterval(beat);
      clearInterval(poll);
      await keeper?.close();
      keeper = undefined;
    },
  };
}
