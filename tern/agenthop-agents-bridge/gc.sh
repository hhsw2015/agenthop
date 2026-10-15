#!/usr/bin/env bash
# agenthop agents-bridge — control-plane garbage collection, swarm side (r10, "no leaks"). Called by the #1033 sweep; never by the
# plugin (any fs walk inside a Tern hook costs budget). Safe to run any time; idempotent; never touches a file younger than its limit.
#
#   results/<id>.json  older than RESULT_TTL_S (default 3600)  ⇒ DELETED   (an answer nobody consumed within an hour)
#   requests/<id>.json older than REQUEST_TTL_S (default 300) ⇒ MOVED to requests/quarantine/ (an orphan the drain never claimed —
#                       kept for inspection, NOT deleted: it may be a non-idempotent op whose fate is UNKNOWN, PROTOCOL.md §3.3)
#   requests/.*.tmp    older than REQUEST_TTL_S              ⇒ DELETED   (a publish that crashed between write and rename)
#   requests/quarantine/* older than QUARANTINE_TTL_S (default 86400) ⇒ DELETED
#
# Prints one summary line: gc: results=N requests_quarantined=N tmp=N quarantine_expired=N. Exit 0 always unless the control dir is
# unreadable (exit 1 — an unreadable dir is UNKNOWN, never "nothing to clean"). Env: AGENTHOP_TERN_PANES, RESULT_TTL_S, REQUEST_TTL_S,
# QUARANTINE_TTL_S, GC_NOW (tests: fixed epoch seconds).
set -u

D="${AGENTHOP_TERN_PANES:-$HOME/.agenthop/tern-panes}"
RESULT_TTL_S="${RESULT_TTL_S:-3600}"
REQUEST_TTL_S="${REQUEST_TTL_S:-300}"
QUARANTINE_TTL_S="${QUARANTINE_TTL_S:-86400}"
NOW="${GC_NOW:-$(date +%s)}"

[ -d "$D" ] && [ -r "$D" ] || { echo "gc: control dir unreadable: $D (UNKNOWN, nothing done)"; exit 1; }

age() { local m; m="$(stat -f %m "$1" 2>/dev/null)" || return 1; echo $((NOW - m)); }

nr=0; nq=0; nt=0; ne=0
if [ -d "$D/results" ]; then
  for f in "$D"/results/*.json; do
    [ -f "$f" ] || continue
    a="$(age "$f")" || continue
    [ "$a" -gt "$RESULT_TTL_S" ] && rm -f "$f" && nr=$((nr+1))
  done
fi
if [ -d "$D/requests" ]; then
  for f in "$D"/requests/*.json; do
    [ -f "$f" ] || continue
    a="$(age "$f")" || continue
    if [ "$a" -gt "$REQUEST_TTL_S" ]; then
      mkdir -p "$D/requests/quarantine" && mv -f "$f" "$D/requests/quarantine/$(basename "$f")" && nq=$((nq+1))
    fi
  done
  for f in "$D"/requests/.*.tmp*; do
    [ -f "$f" ] || continue
    a="$(age "$f")" || continue
    [ "$a" -gt "$REQUEST_TTL_S" ] && rm -f "$f" && nt=$((nt+1))
  done
  if [ -d "$D/requests/quarantine" ]; then
    for f in "$D"/requests/quarantine/*; do
      [ -f "$f" ] || continue
      a="$(age "$f")" || continue
      [ "$a" -gt "$QUARANTINE_TTL_S" ] && rm -f "$f" && ne=$((ne+1))
    done
  fi
fi
echo "gc: results=$nr requests_quarantined=$nq tmp=$nt quarantine_expired=$ne"
exit 0
