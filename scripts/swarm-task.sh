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
KEYDIR="/tmp/ah-rwkey-$LID"
[ -f "$KEYDIR/id" ] || { echo "no keydir for $LID — allocate a box with swarm-launch.sh first" >&2; exit 1; }
WORK_REPO="${SWARM_WORK_REPO:-hhsw2015/swarm-work}"
DEPLOY_KEY="${SWARM_DEPLOY_KEY:-$HOME/.agenthop/swarm/swarm-work-deploy}"
[ -f "$DEPLOY_KEY" ] || { echo "no deploy key at $DEPLOY_KEY" >&2; exit 1; }
BUDGET="${SWARM_BUDGET_SEC:-3480}"
ALLOWLIST="${SWARM_ALLOWLIST:-out}"
GEN=0
BRANCH="swarm/$LID-g$GEN"
ALLOCTS="$(cat "$KEYDIR/alloc-ts" 2>/dev/null || date +%s)"
DEADLINE_WALL=$((ALLOCTS + BUDGET))
HERE="$(cd "$(dirname "$0")/.." && pwd)"

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

# 1. ship the deploy key + supervisor + scrub + demo worker to a private dir on the box.
"${SSH[@]}" railway.new 'mkdir -p /root/.swarm && chmod 700 /root/.swarm' 2>&1 | filt | tail -1
"${SCP[@]}" "$DEPLOY_KEY" railway.new:/root/.swarm/deploy-key >/dev/null
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
  rm -rf /root/work
  git clone -q git@github.com:$WORK_REPO.git /root/work
  git -C /root/work config user.email swarm@box; git -C /root/work config user.name swarm-box
  mkdir -p /root/work/out /root/.swarm-rt && chmod 700 /root/.swarm-rt
  umask 077
  cat > /root/.swarm/sup-env <<ENV
export GIT_SSH_COMMAND='ssh -i /root/.swarm/deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
export SWARM_LAUNCH_ID='$LID'
export SWARM_GENERATION='$GEN'
export SWARM_BUDGET_SEC='$BUDGET'
export SWARM_DEADLINE_WALL='$DEADLINE_WALL'
export SWARM_WORK_DIR='/root/work'
export SWARM_BRANCH='$BRANCH'
export SWARM_RUNTIME_DIR='/root/.swarm-rt'
export SWARM_ALLOWLIST='$ALLOWLIST'
export SWARM_SCRUB='/root/.swarm/swarm-scrub.sh'
export SWARM_TMUX_SESSION='swarm'
ENV
  chmod 600 /root/.swarm/sup-env
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
"${SSH[@]}" railway.new "
  tmux kill-session -t sup 2>/dev/null || true
  : > /root/.swarm/sup.log
  tmux new-session -d -s sup 'sh /root/.swarm/start-sup.sh >/root/.swarm/sup.log 2>&1'
  sleep 3
  tmux has-session -t sup 2>/dev/null && echo supervisor-started || echo supervisor-FAILED
  tail -2 /root/.swarm/sup.log 2>/dev/null || true
" 2>&1 | filt | tail -4

# 4. the worker.
if [ "$MODE" = "--demo" ]; then
  echo "== demo worker (bash; no model cost) in tmux session 'swarm' — writes out/, signals milestones =="
  "${SSH[@]}" railway.new "
    tmux kill-session -t swarm 2>/dev/null || true
    chmod +x /root/.swarm/swarm-demo-worker.sh
    tmux new-session -d -s swarm 'env SWARM_WORK_DIR=/root/work SWARM_RUNTIME_DIR=/root/.swarm-rt sh /root/.swarm/swarm-demo-worker.sh >/root/.swarm/worker.log 2>&1'
    sleep 1
    tmux has-session -t swarm 2>/dev/null && echo demo-worker-started || echo demo-worker-FAILED
  " 2>&1 | filt | tail -2
else
  echo "NOTE: --task (Claude worker) not wired yet; use --demo for the first live validation." >&2
  exit 2
fi

echo "READY: $LID is publishing to $WORK_REPO branch $BRANCH."
echo "Observe:  SWARM_WORK_REPO=git@github.com:$WORK_REPO.git npx tsx $HERE/scripts/swarm-dispatch.ts --observe-once git@github.com:$WORK_REPO.git $BRANCH $LID $GEN"
echo "Box logs: ssh ... railway.new 'cat /root/.swarm/sup.log'   (supervisor)   tmux capture-pane -t swarm -p   (worker)"
