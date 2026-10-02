#!/usr/bin/env bash
# Phase-2 lifecycle launch (box-side wiring). Assumes a box is ALREADY allocated by swarm-launch.sh (which leaves a
# throwaway key at /tmp/ah-rwkey-<launchId>); connects DIRECT (the box is bound to that key — no proxy after alloc)
# and sets up: a single-repo WRITE deploy key, a clone of the WORK repo, the box supervisor (git-channel publisher)
# in its OWN session (setsid, NOT the worker tmux so a scrub can't kill the scrubber), and a task worker. The box
# then publishes curated artifact snapshots to the WORK branch swarm/<launchId>-g<gen>; swarm-dispatch.ts observes.
#
# Usage: scripts/swarm-task.sh <launchId> [--demo | --task "<goal>"]
#   env: SWARM_WORK_REPO (default hhsw2015/swarm-work), SWARM_DEPLOY_KEY (default ~/.agenthop/swarm/swarm-work-deploy),
#        SWARM_BUDGET_SEC (default 3480), SWARM_ALLOWLIST (default "out").
# NOTE: --demo runs a pure-bash worker (no model cost) to validate the pipeline end to end. --task (a Claude worker
#       repointed at CPA) is the real mode; it is NOT wired here yet — it needs the CPA token sourced from a 0600
#       env file (the sup-env pattern below), never inlined into the tmux/claude argv (the Phase-1 swarm-launch.sh
#       CPA-token-in-argv leak Codex flagged is fixed the same way when that worker lands).
set -euo pipefail

LID="${1:?usage: swarm-task.sh <launchId> [--demo | --task \"goal\"]}"
MODE="${2:---demo}"
GOAL="${3:-demo task}"
# Reject an unsupported mode BEFORE any box side-effect (Codex #8: --task is deferred; don't clone/start then bail).
[ "$MODE" = "--demo" ] || { echo "only --demo is supported here (--task/Claude worker is deferred)" >&2; exit 2; }
# Validate the WHOLE launchId (Codex P2-4): the old glob rw-[0-9a-f]* matched "rw-" + one hex + ANY suffix, so
# rw-a'bad / rw-a-not-hex passed and could inject into paths / git refs. Anchor the full string to rw-<hex-only>.
[[ "$LID" =~ ^rw-[0-9a-f]+$ ]] || { echo "bad launchId $LID (expect rw-<hex>, full string)" >&2; exit 2; }
KEYDIR="/tmp/ah-rwkey-$LID"
[ -f "$KEYDIR/id" ] || { echo "no keydir for $LID — allocate a box with swarm-launch.sh first" >&2; exit 1; }
# Require a VALID allocation record within the box's life. ssh to a DEAD key implicitly RE-ALLOCATES (Railway binds
# by key), so never treat ssh as a side-effect-free liveness probe (Codex #4): demand alloc-ts + a remaining window.
[ -f "$KEYDIR/alloc-ts" ] || { echo "no alloc-ts for $LID — not a confirmed allocation; refusing (ssh could re-allocate)" >&2; exit 1; }
WORK_REPO="${SWARM_WORK_REPO:-hhsw2015/swarm-work}"
WORK_URL="git@github.com:$WORK_REPO.git"
DEPLOY_KEY="${SWARM_DEPLOY_KEY:-$HOME/.agenthop/swarm/swarm-work-deploy}"
[ -f "$DEPLOY_KEY" ] || { echo "no deploy key at $DEPLOY_KEY" >&2; exit 1; }
BUDGET="${SWARM_BUDGET_SEC:-3480}"
ALLOWLIST="${SWARM_ALLOWLIST:-out}"
GEN=0
BRANCH="swarm/$LID-g$GEN"
ALLOCTS="$(cat "$KEYDIR/alloc-ts")"
case "$ALLOCTS" in *[!0-9]*|'') echo "corrupt alloc-ts for $LID" >&2; exit 1 ;; esac
AGE=$(( $(date +%s) - ALLOCTS ))
[ "$AGE" -lt "$BUDGET" ] || { echo "box $LID past its window (age ${AGE}s >= ${BUDGET}s) — likely dead; refusing to ssh (would re-allocate)" >&2; exit 1; }
DEADLINE_WALL=$((ALLOCTS + BUDGET))
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# Fresh-only (Codex P2-1): a destructive setup (kill writers + rm checkout/runtime) must never blow away another
# lifecycle's work, and READY must not be satisfied by an OLD in-flight push. TWO guards BEFORE any side-effect:
#  (a) ATOMICALLY acquire this lifecycle — `mkdir` is a single atomic create, so a concurrent same-launchId run loses
#      the race and refuses (no check-then-write gap). A branch-absent remote does NOT prove freshness (an earlier
#      run's push may still be in flight server-side); the lock dir persists (a launchId is one-shot);
#  (b) the remote branch must not already exist (confirmed prior work). To re-run, allocate a FRESH box (new launchId).
# Residual (documented, exactly-once is impossible here): binding READY to THIS run's incarnation needs a manifest
# nonce (shared-schema change) — tracked; the local lock + branch guard close the practical same-LID re-run paths.
LIFECYCLE="/tmp/ah-swarm-task-$LID.lifecycle"
mkdir "$LIFECYCLE" 2>/dev/null || { echo "REFUSING: lifecycle for $LID already held ($LIFECYCLE) — a concurrent/prior same-launchId run owns it; allocate a fresh box (Codex P2-1)." >&2; exit 8; }
# P3: single-quote the deploy-key path INSIDE GSC_RO with POSIX escaping (git runs GSC_RO via `sh -c`). Double quotes
# would let sh EXPAND $()/backticks in a filename; single quotes make it one literal arg regardless of metacharacters.
dkq=${DEPLOY_KEY//\'/\'\\\'\'}
GSC_RO="ssh -i '$dkq' -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
EXIST="$(GIT_SSH_COMMAND="$GSC_RO" git ls-remote "$WORK_URL" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1{print $1}')" || {
  echo "FATAL: cannot query $BRANCH on $WORK_REPO (deploy key / network) — refusing to proceed blind (Codex P2-1)." >&2; exit 7; }
[ -z "$EXIST" ] || { echo "REFUSING: $BRANCH already exists (${EXIST:0:12}) — this lifecycle already ran. Allocate a fresh box (new launchId) or use an explicit resume; not destructively resetting confirmed work (Codex P2-1)." >&2; exit 8; }

# Direct SSH/SCP with the box's throwaway key + its per-VM HASSH profile (no proxy — box is bound to the key).
PROF="$(cat "$KEYDIR/hassh-profile" 2>/dev/null || true)"
ALGO=(); for kv in $PROF; do ALGO+=(-o "$kv"); done
# Plain ssh per step (verified: back-to-back `ssh railway.new` works fine). Do NOT use ControlMaster multiplexing —
# railway.new does not support connection reuse and a reused channel fails with 255.
COMMON=(-i "$KEYDIR/id" -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new
        -o "UserKnownHostsFile=$KEYDIR/known_hosts" -o ConnectTimeout=30 "${ALGO[@]}")
SSH=(ssh "${COMMON[@]}")
SCP=(scp "${COMMON[@]}")
filt() { grep -viE 'human_claim_url|trial_starting|preview_url' || true; }

echo "== phase-2 setup on $LID: branch=$BRANCH deadlineWall=$DEADLINE_WALL repo=$WORK_REPO =="

# Build the supervisor env LOCALLY (values resolved here) and scp it as file bytes — NEVER via a remote heredoc,
# whose unquoted expansion would execute $()/vars embedded in a value (Codex #6). Every value is single-quote-escaped
# (Codex P2-4): a value containing a ' (a legal allowlist path like out/team's, or any configured secret) must not
# break the sourced file or inject shell syntax. sqadd rewrites each ' as '\'' (close quote, escaped quote, reopen).
SUPENV="$(mktemp)"; trap 'rm -f "$SUPENV"' EXIT
: > "$SUPENV"
sqadd() { local v=${2//\'/\'\\\'\'}; printf "export %s='%s'\n" "$1" "$v" >> "$SUPENV"; }
sqadd GIT_SSH_COMMAND 'ssh -i /root/.swarm/deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
sqadd SWARM_LAUNCH_ID "$LID"
sqadd SWARM_GENERATION "$GEN"
sqadd SWARM_BUDGET_SEC "$BUDGET"
sqadd SWARM_DEADLINE_WALL "$DEADLINE_WALL"
sqadd SWARM_WORK_DIR '/root/work'
sqadd SWARM_BRANCH "$BRANCH"
sqadd SWARM_RUNTIME_DIR '/root/.swarm-rt'
sqadd SWARM_ALLOWLIST "$ALLOWLIST"
sqadd SWARM_SCRUB '/root/.swarm/swarm-scrub.sh'
sqadd SWARM_TMUX_SESSION 'swarm'

# 1. ship the deploy key + sup-env + supervisor + scrub + demo worker to a private dir on the box.
"${SSH[@]}" railway.new 'mkdir -p /root/.swarm && chmod 700 /root/.swarm' 2>&1 | filt | tail -1
"${SCP[@]}" "$DEPLOY_KEY" railway.new:/root/.swarm/deploy-key >/dev/null
"${SCP[@]}" "$SUPENV" railway.new:/root/.swarm/sup-env >/dev/null
"${SCP[@]}" "$HERE/scripts/swarm-supervisor.mjs" "$HERE/scripts/swarm-scrub.sh" "$HERE/scripts/swarm-demo-worker.sh" railway.new:/root/.swarm/ >/dev/null

# 2. clone the WORK repo via the deploy key (SSH), configure origin + GIT_SSH_COMMAND, make the runtime dir, and
#    write the supervisor env to a 0600 file (sourced, never argv). The worker's checkout and the supervisor's
#    publish use the SAME deploy key over SSH; the supervisor's private index keeps its commits to the allowlist.
"${SSH[@]}" railway.new "
  set -e
  chmod 600 /root/.swarm/deploy-key
  export GIT_SSH_COMMAND='ssh -i /root/.swarm/deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
  command -v git >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y git >/dev/null 2>&1)
  # tmux is REQUIRED: these boxes kill ssh-session children on logout, so setsid/nohup daemons die on disconnect —
  # only a tmux session persists (proven live). Install it (update first); fail setup if it is still missing.
  command -v tmux >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1; apt-get install -y tmux >/dev/null 2>&1)
  command -v tmux >/dev/null 2>&1 || { echo 'tmux required but unavailable' >&2; exit 3; }
  # Fresh-only (Codex #2): stop any PRIOR writers (supervisor + worker) BEFORE removing the checkout / runtime dir, so
  # we never rm /root/work while an old supervisor is still publishing from it, nor reuse /root/.swarm-rt while a
  # worker is writing checkpoint.req/ack. On a fresh box these are no-ops; on a REUSED box they prevent the race.
  tmux kill-session -t sup 2>/dev/null || true
  tmux kill-session -t swarm 2>/dev/null || true
  rm -rf /root/work
  git clone -q git@github.com:$WORK_REPO.git /root/work
  git -C /root/work config user.email swarm@box; git -C /root/work config user.name swarm-box
  rm -rf /root/.swarm-rt   # fresh runtime dir: a leftover generation's checkpoint.req/ack must not be re-read (Codex #2)
  mkdir -p /root/work/out /root/.swarm-rt && chmod 700 /root/.swarm-rt
  chmod 600 /root/.swarm/sup-env   # scp'd from the dispatcher (built locally; no remote heredoc expansion)
  cat > /root/.swarm/start-sup.sh <<SH
#!/bin/sh
. /root/.swarm/sup-env
exec /root/.local/share/mise/shims/node /root/.swarm/swarm-supervisor.mjs
SH
  chmod +x /root/.swarm/start-sup.sh
  echo setup-ok
" 2>&1 | filt | tail -3

# 3. start the supervisor in its OWN tmux session "sup" (NOT the worker's "swarm" session, so a scrub that kills the
#    worker session cannot kill the scrubber). tmux persists across ssh-close here; setsid/nohup do not. A box-side
#    start script avoids triple-nested quoting (bash -> ssh -> tmux -> sh).
SUP_OUT="$("${SSH[@]}" railway.new "
  tmux kill-session -t sup 2>/dev/null || true
  : > /root/.swarm/sup.log
  tmux new-session -d -s sup 'sh /root/.swarm/start-sup.sh >/root/.swarm/sup.log 2>&1'
  sleep 3
  tmux has-session -t sup 2>/dev/null && echo supervisor-started || echo supervisor-FAILED
  tail -2 /root/.swarm/sup.log 2>/dev/null || true
" 2>&1 | filt | tail -4)" || true
printf '%s\n' "$SUP_OUT"
# Propagate the failure (Codex P2-2): a text-only FAILED must not slide through to a false READY.
echo "$SUP_OUT" | grep -q supervisor-started || { echo "FATAL: supervisor did not start on $LID — aborting, not READY (Codex P2-2)." >&2; exit 4; }

# 4. the worker.
if [ "$MODE" = "--demo" ]; then
  echo "== demo worker (bash; no model cost) in tmux session 'swarm' — writes out/, signals milestones =="
  WK_OUT="$("${SSH[@]}" railway.new "
    tmux kill-session -t swarm 2>/dev/null || true
    chmod +x /root/.swarm/swarm-demo-worker.sh
    tmux new-session -d -s swarm 'env SWARM_WORK_DIR=/root/work SWARM_RUNTIME_DIR=/root/.swarm-rt sh /root/.swarm/swarm-demo-worker.sh >/root/.swarm/worker.log 2>&1'
    sleep 1
    tmux has-session -t swarm 2>/dev/null && echo demo-worker-started || echo demo-worker-FAILED
  " 2>&1 | filt | tail -2)" || true
  printf '%s\n' "$WK_OUT"
  echo "$WK_OUT" | grep -q demo-worker-started || { echo "FATAL: demo worker did not start on $LID — aborting, not READY (Codex P2-2)." >&2; exit 4; }
else
  echo "NOTE: --task (Claude worker) not wired yet; use --demo for the first live validation." >&2
  exit 2
fi

# 5. verify a FIRST CONFIRMED publish on the WORK branch before declaring READY (Codex #7). "tmux session exists" only
#    proves the processes STARTED, not that the supervisor actually pushed a snapshot — a bad deploy key / branch /
#    network would leave it silently producing nothing. Poll the remote branch tip via the SAME deploy key (held
#    locally on the dispatcher), up to ~60s, so a success exit reflects real published work, not just a live process.
echo "== verify first confirmed publish on $BRANCH (up to 60s) =="
# Codex P2-3: distinguish a transient QUERY ERROR (retry, do NOT let errexit kill the script) from a SUCCESSFUL query
# that found the branch still ABSENT (keep waiting) from a CONFIRMED sha. Bound total wait by an absolute deadline and
# each query by ssh ConnectTimeout, so a hung network can't exceed the budget. Because P2-1 verified the branch was
# ABSENT at start, any sha observed here is THIS run's first publish.
# P2-2: ConnectTimeout only bounds the connect/handshake, not the full ls-remote, so bound EACH query by a real total
# timeout via a portable watchdog (no dependency on timeout/gtimeout): run it in the background, hard-kill after `secs`,
# return its stdout. Per-query budget = min(remaining, 25s) and the loop re-checks the absolute deadline AFTER each
# query, so the whole gate stays within ~60s even across retries and an overrun can never be accepted late.
TO_BIN=""; for c in timeout gtimeout; do command -v "$c" >/dev/null 2>&1 && { TO_BIN="$c"; break; }; done
qrun() {  # qrun <secs> <cmd...> : stdout of <cmd>, bounded to <secs>
  local secs=$1; shift
  # Prefer the OS timeout tool: a single-owner supervisor that signals AND reaps its own child correctly.
  if [ -n "$TO_BIN" ]; then local rct=0; "$TO_BIN" "$secs" "$@" 2>/dev/null || rct=$?; return "$rct"; fi
  # Fallback (Codex P1 fix): the PARENT is the SOLE signaller and reaps p ITSELF, so p is never signalled after being
  # reaped — a recycled PID can't be hit (the previous detached watchdog held a bare PID and could TERM an unrelated
  # process after p was reaped). A completion sentinel avoids waiting on a zombie. An orphaned git self-terminates via
  # ssh ConnectTimeout, so a missed child kill is a brief leak, never a wrong-process signal.
  local out done rc=0 w=0; out=$(mktemp); done="$out.done"
  { "$@" >"$out" 2>/dev/null; : > "$done"; } & local p=$!
  while [ ! -e "$done" ] && [ "$w" -lt "$secs" ]; do sleep 1; w=$((w + 1)); done
  if [ ! -e "$done" ]; then
    kill -TERM "$p" 2>/dev/null                                   # p not yet waited -> running/zombie, PID reserved: safe
    local g=0; while [ ! -e "$done" ] && [ "$g" -lt 2 ]; do sleep 1; g=$((g + 1)); done
    [ -e "$done" ] || kill -KILL "$p" 2>/dev/null
  fi
  wait "$p" 2>/dev/null || rc=$?                                  # only now is p reaped / its PID freed
  cat "$out"; rm -f "$out" "$done"
  return "$rc"
}
CONFIRMED=""; QDEADLINE=$(( $(date +%s) + 60 ))
while :; do
  rem=$(( QDEADLINE - $(date +%s) )); [ "$rem" -gt 0 ] || break
  per=$(( rem < 25 ? rem : 25 ))   # min(remaining budget, 25s)
  SHA=""; QRC=0
  SHA="$(qrun "$per" env GIT_SSH_COMMAND="$GSC_RO" git ls-remote "$WORK_URL" "refs/heads/$BRANCH" | awk 'NR==1{print $1}')" || QRC=$?
  [ "$(date +%s)" -lt "$QDEADLINE" ] || break   # a query that overran must NOT be accepted late (P2-2)
  if [ "$QRC" -ne 0 ]; then echo "  (ls-remote query error/timeout; retry within deadline)" >&2; sleep 2; continue; fi
  if [ -n "$SHA" ]; then CONFIRMED="$SHA"; break; fi
  sleep 2
done
if [ -z "$CONFIRMED" ]; then
  echo "WARN: $LID started but produced NO confirmed publish on $BRANCH within 60s — supervisor may be failing to push." >&2
  echo "  check: ssh ... railway.new 'cat /root/.swarm/sup.log'" >&2
  exit 5
fi

echo "READY: $LID confirmed publishing to $WORK_REPO branch $BRANCH (first sha ${CONFIRMED:0:12})."
echo "Observe:  SWARM_WORK_REPO=git@github.com:$WORK_REPO.git npx tsx $HERE/scripts/swarm-dispatch.ts --observe-once git@github.com:$WORK_REPO.git $BRANCH $LID $GEN"
echo "Box logs: ssh ... railway.new 'cat /root/.swarm/sup.log'   (supervisor)   tmux capture-pane -t swarm -p   (worker)"
