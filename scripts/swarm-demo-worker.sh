#!/bin/sh
# Box-side DEMO worker for a first live validation of the phase-2 lifecycle (no model cost). It writes output into
# the allowlist dir and signals the supervisor a milestone via the req/ack file — exercising the whole git-channel
# pipeline (supervisor publishes a curated snapshot to the WORK branch; the dispatcher observes it). A real Claude
# task worker replaces this later (same contract: produce artifacts under SWARM_WORK_DIR, write checkpoint.req to
# SWARM_RUNTIME_DIR at meaningful stages, honor [[swarm:checkpoint]]/[[swarm:resume]]).
#
# Cooperative freeze: write the output, THEN (quiesced) publish the req; wait for a CONFIRMED ack before mutating
# output again. If a checkpoint is not confirmed (error/timeout) we STOP producing (hold the freeze) rather than
# race ahead — a demo must not pretend a failed publish succeeded (Codex). Env: SWARM_WORK_DIR, SWARM_RUNTIME_DIR.
set -u
WORK="${SWARM_WORK_DIR:-/root/work}"
RT="${SWARM_RUNTIME_DIR:-/root/.swarm-rt}"
OUT="$WORK/out"
mkdir -p "$OUT"

# Wait for a terminal ack for request $1. Reads the ack file ONCE per poll (consistent snapshot — no status/id
# version mix) and only accepts an ack whose requestId AND status are both in that snapshot. 0=confirmed, 1=error,
# 2=timeout.
await_ack() {
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$RT/checkpoint.ack" ]; then
      ack=$(cat "$RT/checkpoint.ack" 2>/dev/null)
      case "$ack" in
        *"\"requestId\":\"$1\""*)
          case "$ack" in
            *'"status":"confirmed"'*) return 0 ;;
            *'"status":"error"'*) return 1 ;;
          esac ;;
      esac
    fi
    i=$((i + 1)); sleep 0.5
  done
  return 2
}

n=1
while [ "$n" -le 5 ]; do
  # 1. produce artifacts (quiesce after this write before signaling)
  printf 'progress %s at %s\n' "$n" "$(date -u 2>/dev/null)" > "$OUT/progress.txt"
  printf 'line %s\n' "$n" >> "$OUT/log.txt"
  # 2. signal a milestone (atomic temp+rename), then WAIT for a confirmed ack before the next mutation (freeze)
  printf '{"requestId":"m%s","kind":"milestone","next":"demo step %s of 5"}' "$n" "$n" > "$RT/checkpoint.req.tmp"
  mv "$RT/checkpoint.req.tmp" "$RT/checkpoint.req"
  echo "demo: signaled milestone m$n"
  if await_ack "m$n"; then
    echo "demo: m$n confirmed"
  else
    rc=$?
    echo "demo: m$n NOT confirmed (rc=$rc: 1=error 2=timeout) — holding the freeze, stop producing"
    break
  fi
  n=$((n + 1))
  sleep 10
done
echo "demo: finished; idling so the box stays alive for the near-death/handoff path"
sleep 3600
