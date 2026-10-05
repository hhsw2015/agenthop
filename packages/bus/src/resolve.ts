/**
 * Recipient resolution for the bus, kept in its own lean module (no relay/codex imports) so both the
 * core (core.ts) and the OpenCode plugin can reuse it without dragging in heavy dependencies.
 */

export type UnifiedPeer = {
  id: string;
  /** The host's native session id: a durable, restart-stable address (see SelfInfo.stableId). */
  stableId?: string;
  tool: string;
  /** The host's permission mode (Claude vocab: default|acceptEdits|plan|bypassPermissions); used to stamp from-mode on
   *  a delivered cross-session frame so a bypass receiver doesn't gate a bypass sender. Absent => unknown => "default". */
  mode?: string;
  cwd: string;
  title: string;
  via: "local" | "relay";
  machine?: string;
  /** Present for relay peers: the key a DM is sealed to. */
  pub?: string;
  /** Present for local peers: the OS process id, to tell apart sessions that share a title. */
  pid?: number;
  /** Self-reported work state (working|idle|blocked|unknown) and its monotonic sequence, for
   *  orchestration (agenthop_peers display / agenthop_wait). Absent means unknown. */
  status?: "working" | "idle" | "blocked" | "unknown";
  statusSeq?: number;
  statusText?: string;
  statusAt?: number;
};

/**
 * Collapse the SAME session's multiple LOCAL bus nodes into one roster entry. A session has two nodes while its
 * startup PRESENCE daemon and its lazily-spawned MCP node both run — they share one `stableId`. Without this, a
 * send by that stableId is "ambiguous" (two matches) and the roster shows the session twice. Keeping one is safe:
 * both nodes push to the same host channel, and the atomic durable-inbox claim + unicast DM routing already prevent
 * double delivery. The more recently active node (higher `statusAt`) is kept as the representative. Peers with no
 * stableId (e.g. a Codex node before it has learned its thread id) are left as-is — they cannot be collapsed safely.
 */
export function dedupLocalPeers(peers: UnifiedPeer[]): UnifiedPeer[] {
  const out = new Map<string, UnifiedPeer>();
  const keyByStable = new Map<string, string>();
  for (const peer of peers) {
    if (peer.stableId) {
      const prevKey = keyByStable.get(peer.stableId);
      if (prevKey !== undefined) {
        const prev = out.get(prevKey)!;
        if ((peer.statusAt ?? 0) > (prev.statusAt ?? 0)) {
          out.delete(prevKey);
          out.set(peer.id, peer);
          keyByStable.set(peer.stableId, peer.id);
        }
        continue; // drop the duplicate (older) node of the same session
      }
      keyByStable.set(peer.stableId, peer.id);
    }
    out.set(peer.id, peer);
  }
  return [...out.values()];
}

/**
 * Pick the peer a `to` string addresses, or an error. Pure, so it can be tested directly — this is
 * recipient selection, where a silent wrong pick means a misdelivered message.
 *
 * Precedence: ids that are unique by construction (the native session id, the per-run id) are matched
 * before the derived, possibly-colliding-or-spoofable title, so a title can never shadow a real id.
 * Each tier must resolve to exactly ONE peer; two peers sharing a handle (short-id collision or a
 * duplicate AGENTHOP_TITLE) is reported as ambiguous, never silently resolved to the first. An empty
 * target is rejected (otherwise every prefix check matches it).
 */
/** Why a recipient did not resolve. The caller MUST distinguish these: "none" (no such session) may fall back to a
 *  same-machine durable inbox, but "ambiguous" must NEVER fall back — picking one of several matches would misroute a private
 *  message (review d8dd4b1-B1). "empty" is a malformed request. */
export type ResolveErrorKind = "empty" | "ambiguous" | "none";
export type ResolveError = { error: string; kind: ResolveErrorKind };

export function resolvePeer(peers: UnifiedPeer[], selfId: string, to: string): UnifiedPeer | ResolveError {
  const wanted = to.trim();
  if (!wanted) return { error: "No target given (empty recipient).", kind: "empty" };
  const others = peers.filter((p) => p.id !== selfId);
  // An ambiguous match lists the ALWAYS-unique per-run id (the short roster handle can't disambiguate,
  // and even two runs sharing one stableId would repeat it). The session id is shown too for durable
  // addressing when present. Both are accepted by this resolver.
  const ambiguous = (hits: UnifiedPeer[]): ResolveError => ({
    kind: "ambiguous",
    error: `"${to}" matches ${hits.length} sessions: ${hits
      .map((p) => `${p.title}${p.machine ? `@${p.machine}` : ""} (run ${p.id}${p.stableId ? `, session ${p.stableId}` : ""})`)
      .join("; ")}. Address one by its run id or session id.`,
  });
  const byId = others.filter((p) => p.stableId === wanted || p.id === wanted);
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) return ambiguous(byId);
  const byTitle = others.filter((p) => p.title === wanted);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) return ambiguous(byTitle);
  // Otherwise a prefix of any handle, so "codex:Work" finds "codex:Work-01a0ead5"; a short session id
  // works too. One hit wins; several are ambiguous.
  const byPrefix = others.filter(
    (p) => p.id.startsWith(wanted) || (p.stableId?.startsWith(wanted) ?? false) || p.title.startsWith(wanted),
  );
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) return ambiguous(byPrefix);
  return { error: `No session matches "${to}".`, kind: "none" };
}
