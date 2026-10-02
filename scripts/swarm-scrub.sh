#!/usr/bin/env bash
# Box-side self-scrub, invoked by swarm-supervisor.mjs from its OWN session (NOT the worker's tmux), after work is
# confirmed on the remote / at the deadline. HONEST SCOPE (Codex P2-4): this is BEST-EFFORT local deletion, not a
# "no trace / credentials invalidated" guarantee. The real boundary is short-lived, least-privilege, server-side-
# revocable credentials: the CPA eph token expires <=60min and the GitHub token should be a fine-grained, single-
# repo, short-expiry PAT. `rm` cannot un-copy a token that already leaked, cannot scrub another process's argv
# except by killing it, and same-UID env remains readable while a process lives. We therefore: stop the writers
# first (kill the worker session -> drops its in-memory CPA/GitHub tokens), then delete the on-disk secret-bearing
# paths, then return so the supervisor can exit itself last.
set -u

SESSION="${SWARM_TMUX_SESSION:-swarm}"
WORK_DIR="${SWARM_WORK_DIR:-}"
RUNTIME_DIR="${SWARM_RUNTIME_DIR:-}"   # holds the GIT_ASKPASS token file + req/ack

log() { echo "[scrub] $*" >&2; }

# 1. Stop the writers FIRST. Killing the worker tmux session terminates the Claude TUI and the processes IN that
#    session, dropping the CPA + GitHub tokens that were in their environment/argv. The supervisor lives in a
#    different session, so this does not kill the scrubber. HONEST LIMIT (Codex P2-6): kill-session does NOT prove a
#    detached/nohup/double-forked writer has exited — it is not waited on. The real guarantee is credential
#    expiry/revocation (short-lived CPA token + fine-grained GitHub token), not that every writer is gone.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  log "killing worker session $SESSION (does not guarantee detached writers exit)"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
fi

# 2. Delete on-disk secret/trace-bearing paths. LITERAL paths are quoted so a path with spaces is one argument
#    (Codex P2-6: an unquoted `for match in $p` word-splits '/a/owned dir' into '/a/owned' + 'dir' and deletes the
#    wrong directory). The one intentional glob is expanded separately under nullglob.
literals=(
  "$RUNTIME_DIR"
  "$WORK_DIR"
  "/tmp/ah-mcp.json"
  "$HOME/.config/gh"
  "$HOME/.git-credentials"
)
for p in "${literals[@]}"; do
  [ -n "$p" ] && [ -e "$p" ] || continue
  log "rm -rf -- $p"
  rm -rf -- "$p" 2>/dev/null || true
done
shopt -s nullglob
for p in /tmp/swarm-*; do
  log "rm -rf -- $p"
  rm -rf -- "$p" 2>/dev/null || true
done
shopt -u nullglob

# 3. Best-effort: clear this shell's view of the tokens (does not touch other live processes).
unset GITHUB_TOKEN ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GIT_ASKPASS 2>/dev/null || true

log "scrub complete (best-effort; credential expiry/revocation is the real boundary)"
