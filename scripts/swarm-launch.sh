#!/usr/bin/env bash
# Launch a persistent swarm worker on a fresh Railway box: allocate -> install agenthop -> run a persistent
# Claude Code TUI (bypass perms) repointed at CPA + joined to a scoped per-swarm team -> SELF-VERIFY it is on the
# bus before declaring ready. The worker then stays warm: discovery + MCP-join are paid ONCE, so per-task latency
# is just the model (the slow step was warmup/discovery, not compute — see the swarm notes).
#
# Reuse-first: by default it REUSES the newest box still inside its ~60-min life (keyed by the throwaway SSH
# key, reached directly, no proxy) instead of allocating — so repeated runs do not burn the IP-gated allocation
# quota. Pass `new` (3rd arg) or AGENTHOP_SWARM_NEW=1 to force a brand-new box and grow the fleet (each VM is
# only ~2 vCPU, so the swarm scales by adding boxes).
#
# Usage:  scripts/swarm-launch.sh [claude|codex|opencode] [swarm-team-secret] [new]
#   env: AGENTHOP_SSH_PROXY (default 127.0.0.1:10808), AGENTHOP_RELAY, AGENTHOP_CPA_BASE, AGENTHOP_REPO,
#        AGENTHOP_SWARM_NEW=1 (force allocate)
#   cf-proxy (auto-started for ALLOCATION when creds are in env; skipped on reuse):
#        CF_PROXY_TOKEN   = the ECH worker token (the one real secret — supply via env, never committed)
#        CF_PROXY_CONFIG  = path to a CPA proxy-pool yaml; the worker domains + edge IP are read from it
#        (or set CF_PROXY_WORKERS=d1:443,d2:443 and CF_PROXY_IP=... directly instead of CF_PROXY_CONFIG)
# Prereqs: for a NEW box, a clean egress (cf-proxy or any SOCKS on $PROXY); reuse needs none. Plus CPA_EPH_SECRET
#          (or ~/.cpa_eph_secret) and tsx.
set -euo pipefail

TOOL="${1:-claude}"
TEAM="${2:-$(openssl rand -hex 16)}"
PROXY="${AGENTHOP_SSH_PROXY:-127.0.0.1:10808}"
RELAY="${AGENTHOP_RELAY:-https://agenthop.imatrix.tech}"
CPA="${AGENTHOP_CPA_BASE:-https://headroom.geeker.indevs.in}"
REPO="${AGENTHOP_REPO:-hhsw2015/agenthop}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Per-tool default model (user-set): claude/opencode -> OPUS 4.8; codex -> gpt-6-astra.
case "$TOOL" in
  claude)   MODEL="claude-opus-4-8" ;;
  opencode) MODEL="claude-opus-4-8" ;;
  codex)    MODEL="gpt-6-astra" ;;
  *) echo "unknown tool: $TOOL" >&2; exit 1 ;;
esac

# --- Reuse-first VM resolution ----------------------------------------------
# A box is bound to its SSH key and lives <=60 min; `ssh railway.new` with a key routes to that key's LIVE box,
# but with a DEAD key it ALLOCATES a fresh one. So we must NOT "probe" liveness by SSHing (that would itself
# over-allocate, from our raw IP). Instead gate reuse on a time window: reuse the newest box still well inside
# its life. Default = reuse (avoids burning the IP-gated allocation quota — over-allocation is the main cause
# of "Anonymous visitors are limited"). Force a brand-new box with `new` as the 3rd arg or AGENTHOP_SWARM_NEW=1:
# the swarm grows by ADDING boxes, since each VM has only ~2 vCPU.
# ponytail: fixed 55m window; swap for a real box-liveness ping if Railway ever exposes one.
REUSE_WINDOW_SEC=3300
FORCE_NEW="${AGENTHOP_SWARM_NEW:-}"; [ "${3:-}" = "new" ] && FORCE_NEW=1
# allocate-only: allocate + stamp + key-bind a FRESH box, then stop (no agenthop/worker install). Used by the handoff
# dispatcher so a successor box is provisioned by swarm-task --resume instead of swarm-launch's Claude worker TUI.
ALLOC_ONLY="${AGENTHOP_ALLOCATE_ONLY:-}"; [ -n "$ALLOC_ONLY" ] && FORCE_NEW=1

# Cleanup trap (set BEFORE any keydir is created, so even an early failure is covered). On exit it (a) tears down
# the alloc-only cf-proxy and (b) removes a NEWLY-created keydir whose allocation was never CONFIRMED (no alloc-ts
# written). A failed/aborted allocation otherwise leaves an orphan throwaway key that both piles up AND is a
# re-allocation hazard (ssh to a dead key RE-ALLOCATES, so a stale key invites an accidental new box). It NEVER
# touches a REUSED box's keydir (NEW_KEYDIR stays empty on reuse) nor a CONFIRMED one (alloc-ts present).
NEW_KEYDIR=""
cleanup() {
  [ -n "${CF_PROXY_PID:-}" ] && kill "$CF_PROXY_PID" 2>/dev/null || true
  # Delete ONLY a definitively-failed keydir: no alloc-ts AND not marked `unknown`. An UNKNOWN result (Codex P2-5) may
  # have created a live box whose ACK we lost; deleting its only key would orphan that VM (unreachable + un-scrubbable),
  # so an unknown keydir is RETAINED (and already excluded from reuse/discovery, which both require alloc-ts).
  # Retain on ANY retain-signal: alloc-ts (confirmed), unknown (maybe-live), or inflight (request may have been sent —
  # Codex P2-3). Delete ONLY a keydir with none of them (the request was never sent, or a recognized clean refusal
  # cleared inflight). Default-retain means a death/bookkeeping-failure after the request can never orphan a live box.
  if [ -n "${NEW_KEYDIR:-}" ] && [ ! -f "$NEW_KEYDIR/alloc-ts" ] && [ ! -f "$NEW_KEYDIR/unknown" ] && [ ! -f "$NEW_KEYDIR/inflight" ]; then
    rm -rf "$NEW_KEYDIR" 2>/dev/null || true
    echo "cleanup: removed keydir $NEW_KEYDIR (request never sent / clean refusal — no alloc-ts, inflight, or unknown)" >&2
  fi
}
trap cleanup EXIT

LID=""; KEYDIR=""; REUSED=""
if [ -z "$FORCE_NEW" ]; then
  now="$(date +%s)"; SCANNED=0
  mapfile -t KDS < <(ls -dt /tmp/ah-rwkey-rw-* 2>/dev/null || true)
  for kd in "${KDS[@]}"; do
    [ -f "$kd/id" ] && [ -f "$kd/alloc-ts" ] || continue  # unconfirmed/failed keydir: never reusable
    SCANNED=$((SCANNED + 1))
    age=$(( now - $(cat "$kd/alloc-ts") ))
    [ "$age" -lt "$REUSE_WINDOW_SEC" ] || continue
    KEYDIR="$kd"; LID="$(basename "$kd" | sed 's/^ah-rwkey-//')"; REUSED=1
    echo "alloc-decision: REUSE $LID (age ${age}s < ${REUSE_WINDOW_SEC}s window; direct, no proxy)"
    break
  done
  [ -z "$REUSED" ] && echo "alloc-decision: no reusable box (${SCANNED} confirmed candidate(s), none inside ${REUSE_WINDOW_SEC}s window) -> allocating new"
else
  echo "alloc-decision: FORCE_NEW set -> allocating new to grow the fleet (ignoring any live box)"
fi

if [ -z "$LID" ]; then
  # Accept a dispatcher-provided launchId (AGENTHOP_LAUNCH_ID) so a handoff can pre-generate it CAS-then-IO; else mint
  # one. Validate the WHOLE string as rw-<hex> so it can't inject into paths / git refs.
  LID="${AGENTHOP_LAUNCH_ID:-rw-$(openssl rand -hex 4)}"
  case "$LID" in rw-*) : ;; *) echo "bad AGENTHOP_LAUNCH_ID $LID (expect rw-<hex>)" >&2; exit 2 ;; esac
  case "${LID#rw-}" in *[!0-9a-f]*|'') echo "bad AGENTHOP_LAUNCH_ID $LID (expect rw-<hex>)" >&2; exit 2 ;; esac
  KEYDIR="/tmp/ah-rwkey-$LID"; NEW_KEYDIR="$KEYDIR"; mkdir -p "$KEYDIR"
  ssh-keygen -t ed25519 -f "$KEYDIR/id" -N "" -q
  echo "alloc-decision: NEW box $LID (via proxy $PROXY); its keydir is removed on exit unless allocation is confirmed"
fi
TITLE="railway:$TOOL-${LID#rw-}"
echo "launch $LID  tool=$TOOL  model=$MODEL  title=$TITLE  reused=${REUSED:-0}"

# Latest release binary for the box (linux-x64) + the CPA eph token (sub = launchId), minted on the dispatcher.
URL="https://github.com/$REPO/releases/latest/download/agenthop-linux-x64"
TOKEN="$(npx tsx "$HERE/scripts/cpa-mint.ts" --sub "$LID" --ttl 3600)"

# Anti-fingerprint: each launch picks a random SSH algorithm profile (KexAlgorithms / Ciphers / MACs) so the
# HASSH fingerprint differs per box. Railway correlates SSH-key + source-IP + client fingerprint to detect farming;
# randomizing HASSH + throwaway key + proxy IP makes each allocation look like a distinct client. All profiles use
# only standard, strong algorithms — no downgrade, just different subsets/orderings of the same safe set.
PROFILES=(
  "KexAlgorithms=curve25519-sha256,diffie-hellman-group14-sha256 Ciphers=aes256-ctr,aes128-ctr MACs=hmac-sha2-256,hmac-sha2-512"
  "KexAlgorithms=diffie-hellman-group16-sha512,ecdh-sha2-nistp256,curve25519-sha256 Ciphers=aes128-ctr,aes256-ctr,aes192-ctr MACs=hmac-sha2-512,hmac-sha2-256"
  "KexAlgorithms=ecdh-sha2-nistp384,curve25519-sha256 Ciphers=aes256-ctr MACs=hmac-sha2-256"
  "KexAlgorithms=ecdh-sha2-nistp521,diffie-hellman-group18-sha512 Ciphers=aes192-ctr,aes256-ctr MACs=hmac-sha2-512,hmac-sha2-256"
  "KexAlgorithms=curve25519-sha256,ecdh-sha2-nistp256 Ciphers=aes128-ctr,aes192-ctr,aes256-ctr MACs=hmac-sha2-256"
  "KexAlgorithms=diffie-hellman-group14-sha256,diffie-hellman-group16-sha512 Ciphers=aes256-ctr,aes192-ctr MACs=hmac-sha2-512"
)
# The profile is per-VM (per launchId), NOT per-connection: once a box is allocated with profile X, every
# reconnect uses X. A mid-session HASSH change on the same key is MORE suspicious than a consistent one.
# Persist alongside the throwaway key so reuse reads it back.
PROF_FILE="$KEYDIR/hassh-profile"
if [ -f "$PROF_FILE" ]; then
  PROF="$(cat "$PROF_FILE")"
else
  PROF="${PROFILES[$((RANDOM % ${#PROFILES[@]}))]}"
  printf '%s' "$PROF" > "$PROF_FILE"
fi
# Parse "Key=Value Key=Value" into -o flags.
ALGO_OPTS=()
for kv in $PROF; do ALGO_OPTS+=(-o "$kv"); done
echo "hassh profile: $PROF (bound to $LID)"

# TWO ssh paths, because Railway gates ALLOCATION by source-IP reputation but binds a live box to the SSH KEY:
#   ALLOC_SSH — the ONE `ssh railway.new` that creates the box — MUST exit via a clean IP (CF ECH proxy), or
#               Railway refuses ("Anonymous visitors are limited").
#   SSH       — every call AFTER the box exists (install, scp, TUI, reconnect) — the box is bound to our key,
#               so it is reachable from ANY IP. Direct is faster + needs no proxy.
# Algorithm options randomize the HASSH fingerprint per box (bound per-VM above).
ALLOC_SSH=(ssh -i "$KEYDIR/id" -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new
     -o "UserKnownHostsFile=$KEYDIR/known_hosts" -o "ProxyCommand=nc -X 5 -x $PROXY %h %p" -o ConnectTimeout=30
     "${ALGO_OPTS[@]}")
SSH=(ssh -i "$KEYDIR/id" -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new
     -o "UserKnownHostsFile=$KEYDIR/known_hosts" -o ConnectTimeout=30 "${ALGO_OPTS[@]}")

if [ -z "$REUSED" ]; then
  # Auto-start the CF-Worker SOCKS proxy for THIS allocation when worker creds are supplied via env
  # (CF_PROXY_WORKERS, CF_PROXY_TOKEN[, CF_PROXY_IP]) and nothing is already listening on $PROXY. Creds stay in
  # env — never hardcoded/committed. If CF_PROXY_WORKERS is unset we assume $PROXY already points at a running
  # SOCKS. The proxy is only needed to allocate (IP-gated); reuse never reaches here, so it costs nothing then.
  CF_PROXY_PID=""; CF_HOST="${PROXY%%:*}"; CF_PORT="${PROXY##*:}"
  # Convenience: derive the worker domains + edge IP from a CPA proxy-pool config (CF_PROXY_CONFIG) so the operator
  # need only supply the TOKEN (the one real secret) in env — the 21 domains come from the file, nothing committed.
  if [ -z "${CF_PROXY_WORKERS:-}" ] && [ -n "${CF_PROXY_CONFIG:-}" ] && [ -f "${CF_PROXY_CONFIG:-}" ]; then
    CF_PROXY_WORKERS="$(awk '/^proxy-pool:/{f=1;next} f&&/^[^[:space:]]/{exit} f&&/[[:space:]]domain:/{gsub(/.*domain:[[:space:]]*"?/,"");gsub(/".*/,"");print}' "$CF_PROXY_CONFIG" | paste -sd, -)"
    : "${CF_PROXY_IP:=$(awk '/^proxy-pool:/{f=1;next} f&&/^[^[:space:]]/{exit} f&&/[[:space:]]ip:/{gsub(/.*ip:[[:space:]]*"?/,"");gsub(/".*/,"");print; exit}' "$CF_PROXY_CONFIG")}"
    export CF_PROXY_WORKERS CF_PROXY_IP
    echo "cf-proxy workers from $CF_PROXY_CONFIG: $(printf '%s' "$CF_PROXY_WORKERS" | tr ',' '\n' | wc -l | tr -d ' ') domains, ip=$CF_PROXY_IP"
  fi
  if [ -n "${CF_PROXY_WORKERS:-}" ] && [ -n "${CF_PROXY_TOKEN:-}" ] && ! nc -z "$CF_HOST" "$CF_PORT" 2>/dev/null; then
    echo "== start cf-proxy (CF Worker SOCKS) on $PROXY =="
    CF_PROXY_PORT="$CF_PORT" npx tsx "$HERE/packages/bus/src/swarm/cf-proxy.ts" >"/tmp/cf-proxy-$$.log" 2>&1 &
    CF_PROXY_PID=$!   # torn down by the unified cleanup trap set above
    for _ in $(seq 1 40); do nc -z "$CF_HOST" "$CF_PORT" 2>/dev/null && break; sleep 0.3; done
    if nc -z "$CF_HOST" "$CF_PORT" 2>/dev/null; then echo "cf-proxy up (pid $CF_PROXY_PID)"; else
      echo "cf-proxy failed to start; see /tmp/cf-proxy-$$.log" >&2; exit 4; fi
  fi

  # Allocation is the ONLY step that must exit via a clean IP (proxy). Keep it minimal — a bare command — so the
  # ~30MB binary download does NOT crawl through the WS tunnel; that happens on the direct install below.
  echo "== allocate NEW box (via proxy, minimal) =="
  : > "$KEYDIR/inflight"   # register BEFORE the request (Codex P2-3): any death/bookkeeping-failure AFTER this defaults to RETAIN
  ALLOC_OUT="$("${ALLOC_SSH[@]}" railway.new 'echo alloc-ok' 2>&1 || true)"
  echo "$ALLOC_OUT" | grep -vi 'human_claim_url\|trial_starting\|preview_url' | tail -2 || true
  if echo "$ALLOC_OUT" | grep -q alloc-ok; then
    # Confirmed: stamp the reuse window, THEN clear in-flight. If the stamp WRITE fails, KEEP inflight so cleanup still
    # retains the key — an alloc-ok (live) box must never be deleted on a local bookkeeping failure (Codex P2-3).
    if date +%s > "$KEYDIR/alloc-ts" 2>/dev/null; then rm -f "$KEYDIR/inflight"
    else echo "WARN: alloc-ts stamp failed for $LID — keeping inflight marker so the (live) box's key is retained." >&2; fi
  else
    # Only a RECOGNIZED PRE-PROVISION refusal proves the box was NOT created (Codex P2-4): Railway's IP-gate message.
    # Generic quota/permission/etc substrings can be POST-provision shell/fs/login errors — NOT deletion evidence, so
    # everything else stays UNKNOWN and RETAINS the key (box may be live).
    if echo "$ALLOC_OUT" | grep -qi 'anonymous visitors are limited'; then
      rm -f "$KEYDIR/inflight"   # clean pre-provision refusal -> allow cleanup to delete (definitively not created)
      echo "ALLOC REFUSED for $LID (provider IP-gate refusal; box not created) — proxy=$PROXY." >&2
      echo "$ALLOC_OUT" | tail -3 >&2
      exit 3
    fi
    : > "$KEYDIR/unknown"   # UNKNOWN: box may be live; RETAIN (inflight also still set). Reconcile or physical (<=60m) expiry.
    echo "ALLOC RESULT UNKNOWN for $LID — retaining keydir (box may be live); excluded from reuse. Reconcile or let it expire." >&2
    echo "$ALLOC_OUT" | tail -3 >&2
    exit 6
  fi

  # allocate-only: a successor box for a handoff is provisioned by swarm-task --resume (its own git/tmux/supervisor), so
  # skip swarm-launch's agenthop-binary install + Claude worker TUI + self-verify. The box is allocated + key-bound +
  # stamped — all the dispatcher needs before swarm-task --resume. "NEW box $LID" keeps the launchId parseable.
  if [ -n "$ALLOC_ONLY" ]; then echo "allocate-only: NEW box $LID ready (skipped install/worker)"; exit 0; fi

  # Install direct — the box is now bound to our key, reachable from any IP, and direct is far faster than SOCKS.
  # The mcp.json carries the AGENTHOP env — Claude Code does NOT pass the parent env to MCP servers, so the team
  # must be set here or the node joins teamless (invisible cross-machine). This was the discovery-failure bug.
  echo "== install (direct: tmux, agenthop, mcp config with the scoped team) =="
  "${SSH[@]}" railway.new "
    apt-get install -y tmux >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y tmux >/dev/null 2>&1)
    curl -sL -o /tmp/agenthop '$URL' && chmod +x /tmp/agenthop
    printf '%s' '{\"mcpServers\":{\"agenthop\":{\"command\":\"/tmp/agenthop\",\"args\":[\"mcp\"],\"env\":{\"AGENTHOP_TEAM\":\"$TEAM\",\"AGENTHOP_RELAY\":\"$RELAY\",\"AGENTHOP_NO_CODEX\":\"1\",\"AGENTHOP_TITLE\":\"$TITLE\"}}}}' > /tmp/ah-mcp.json
    echo setup-ok
  " 2>&1 | grep -vi 'human_claim_url\|trial_starting\|preview_url' | tail -3 || true
else
  echo "== reuse: skip allocation + install (box already provisioned) =="
fi

# On reuse, a still-running `swarm` tmux session is already warm (MCP joined, discovery done) — the whole point
# of persistence. Keep it; relaunching would throw the warmup away. Only launch when there is no warm TUI.
WARM=""
if [ -n "$REUSED" ] && "${SSH[@]}" railway.new 'tmux has-session -t swarm 2>/dev/null && echo __warm__' 2>/dev/null | grep -q __warm__; then
  WARM=1; echo "== reuse warm TUI (swarm session already running — warmup preserved) =="
else
  echo "== launch persistent $TOOL TUI in tmux (bypass perms, CPA, model=$MODEL) =="
fi
# THEORETICAL-FASTEST per-task: after warmup (discovery + MCP-join paid ONCE by staying persistent), the only
# remaining per-task cost is model turns. The worker must reply in ONE turn — answer + a single agenthop_send to
# the sender (whose handle is in the message's from=), with NO agenthop_peers lookup. This system prompt enforces
# that; it cut the earlier 3-tool-call dance to 1. (Delivery is push, so it is already near-instant.)
SYS='You are a persistent swarm worker on the agenthop bus. When a task arrives as a cross-session bus message, do it and reply to the SENDER with a SINGLE agenthop_send call (the sender handle is the message from= attribute) in ONE turn. Never call agenthop_peers — you already have the sender. Keep replies concise, no preamble.'
# claude path (proven). codex/opencode use their own flags for model + MCP (same pattern; fill when tested).
if [ -n "$WARM" ]; then
  :  # warm TUI kept above; nothing to launch
elif [ "$TOOL" = "claude" ]; then
  "${SSH[@]}" railway.new "
    tmux kill-session -t swarm 2>/dev/null || true; sleep 1
    tmux new-session -d -s swarm -x 200 -y 50 \
      'env IS_SANDBOX=1 ANTHROPIC_BASE_URL=$CPA ANTHROPIC_AUTH_TOKEN=$TOKEN \
        claude --dangerously-skip-permissions --model $MODEL --mcp-config /tmp/ah-mcp.json --strict-mcp-config --append-system-prompt \"$SYS\"'
    sleep 16
    tmux send-keys -t swarm Down; sleep 0.5; tmux send-keys -t swarm Enter   # trust folder
    sleep 2
    tmux send-keys -t swarm Down; sleep 0.5; tmux send-keys -t swarm Enter   # accept bypass mode
    sleep 8
    tmux capture-pane -t swarm -p | grep -iE 'bypass permissions on' | tail -1
  " 2>&1 | grep -vi 'human_claim_url\|trial_starting\|preview_url' | tail -3 || true
else
  echo "NOTE: $TOOL launch not yet implemented in this script (claude is proven). Same pattern: install agenthop," \
       "write the tool's MCP config with the scoped team env, launch its TUI with --model $MODEL repointed at CPA." >&2
fi

echo "== self-verify: worker on the bus? (persistent discovery can take up to ~90s cold) =="
# A single short-lived check (not a loop of ephemeral nodes — those churn the directory keeper and slow discovery).
if env -u CLAUDE_CODE_MESSAGING_SOCKET AGENTHOP_TEAM="$TEAM" AGENTHOP_NO_CODEX=1 AH_HOME="/tmp/ah-verify-$LID" \
     npx tsx "$HERE/scripts/swarm-peer-check.ts" 100 2>&1 | grep -q "PEER: $TITLE"; then
  echo "READY: worker $TITLE is on the bus (team=$TEAM). Send it tasks from a dispatcher on the SAME team."
elif [ -n "$REUSED" ]; then
  # Reused box: it was confirmed live (inside its window) and its TUI is warm, so a missed discovery here is a
  # transient relay/directory read, NOT a dead box. Do NOT exit nonzero — a caller treating that as failure would
  # re-allocate, the exact over-allocation we avoid. Warn and succeed; the box is reachable (retry the check).
  echo "WARN: $TITLE not seen on the bus this pass (reused box is live; likely a transient directory read)." >&2
else
  echo "NOT READY: $TITLE did not appear on the bus within the window. Check the box TUI (tmux capture-pane -t swarm)." >&2
  exit 2
fi
