import { hkdfSync } from "node:crypto";
import { isRoomAddress, normalizeCode, relayEndpoints, WORDLIST } from "@agenthop/tunnel";
import { DEFAULT_RELAY, readQueue, sendMessage, startHost } from "@agenthop/cli";
import { openEntry, sealEntry, type Team } from "./team.js";

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
  /** Sender's clock, ms. Used to drop stale entries. */
  ts: number;
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

  const remember = (peer: RemotePeer): void => {
    // Reading our own latest announce back confirms the current keeper sees our writes: cursor is fresh.
    if (peer.id === self.id && peer.ts === pendingSelfTs) pendingSelfTs = undefined;
    const prev = seen.get(peer.id);
    if (!prev || peer.ts >= prev.ts) seen.set(peer.id, peer);
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
    const entry: RemotePeer = { ...self, ts: Date.now() };
    // Register the watch BEFORE sending. The room stores the log entry and only then acks the POST, so
    // an independent GET can read our announce back before sendMessage resolves; setting the marker only
    // after the await would let that read miss it, and the marker would then time out on a healthy log.
    // With it set first, a concurrent read clears it (remember()); we leave it as-is on success and only
    // clear it here if the send itself failed.
    pendingSelfTs = entry.ts;
    pendingSince = Date.now();
    try {
      await sendMessage({ code: address, text: PRESENCE_PREFIX + sealEntry(team.nsKey, JSON.stringify(entry)), relay: options.relay, pass: options.pass });
    } catch (error) {
      if (pendingSelfTs === entry.ts) pendingSelfTs = undefined; // send failed: nothing to watch for
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
    if (pendingSelfTs !== undefined && Date.now() - pendingSince > STALE_GRACE_MS) {
      after = 0;
      epoch++;
      pendingSelfTs = undefined; // act once; don't re-trigger every poll while it stays unechoed
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
      self = next; // next announce (and roster self-filter) uses the refreshed identity
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
