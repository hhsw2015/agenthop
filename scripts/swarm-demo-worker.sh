#!/bin/sh
# Box-side DEMO worker for a first live validation of the phase-2 lifecycle (no model cost). It writes output into
# the allowlist dir and signals the supervisor a milestone via the req/ack file — exercising the whole git-channel
# pipeline (supervisor publishes a curated snapshot to the WORK branch; the dispatcher observes it). A real Claude
# task worker replaces this later (same contract: produce artifacts under SWARM_WORK_DIR, write checkpoint.req to
# SWARM_RUNTIME_DIR at meaningful stages, honor [[swarm:checkpoint]]/[[swarm:resume]]).
#
# Cooperative freeze: write the output, THEN (quiesced) publish the req; wait for a terminal ack before mutating
# output again. Env: SWARM_WORK_DIR, SWARM_RUNTIME_DIR (defaults match swarm-task.sh).
set -u
WORK="${SWARM_WORK_DIR:-/root/work}"
RT="${SWARM_RUNTIME_DIR:-/root/.swarm-rt}"
OUT="$WORK/out"
mkdir -p "$OUT"

await_ack() { # $1 = requestId; wait up to ~30s for a terminal ack for it
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$RT/checkpoint.ack" ]; then
      st=$(grep -o '"status":"[a-z]*"' "$RT/checkpoint.ack" 2>/dev/null | head -1)
      id=$(grep -o "\"requestId\":\"$1\"" "$RT/checkpoint.ack" 2>/dev/null | head -1)
      case "$st" in *confirmed*|*error*) [ -n "$id" ] && return 0 ;; esac
    fi
    i=$((i + 1)); sleep 0.5
  done
}

n=1
while [ "$n" -le 5 ]; do
  # 1. produce artifacts (quiesce after this write before signaling)
  printf 'progress %s at %s\n' "$n" "$(date -u 2>/dev/null)" > "$OUT/progress.txt"
  printf 'line %s\n' "$n" >> "$OUT/log.txt"
  # 2. signal a milestone (atomic temp+rename), then wait for the terminal ack before the next mutation (freeze)
  printf '{"requestId":"m%s","kind":"milestone","next":"demo step %s of 5"}' "$n" "$n" > "$RT/checkpoint.req.tmp"
  mv "$RT/checkpoint.req.tmp" "$RT/checkpoint.req"
  echo "demo: signaled milestone m$n"
  await_ack "m$n"
  n=$((n + 1))
  sleep 10
done
echo "demo: done 5 milestones; idling so the box stays alive for the near-death/handoff path"
sleep 3600
