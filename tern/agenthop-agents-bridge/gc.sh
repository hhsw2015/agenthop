#!/usr/bin/env bash
# agenthop agents-bridge — control-plane garbage collection, swarm side (r10, "no leaks"). Called by the #1033 sweep; never by the
# plugin (any fs walk inside a Tern hook costs budget). Safe to run any time; idempotent; never touches a file younger than its limit.
#
#   results/<id>.json  older than RESULT_TTL_S (default 3600)  ⇒ DELETED   (an answer nobody consumed within an hour)
#   requests/<id>.json older than REQUEST_TTL_S (default 300) ⇒ MOVED to requests/quarantine/<id>.<epoch>.<rand>.json (an orphan
#                       the drain never claimed — kept for inspection, NOT deleted: it may be a non-idempotent op whose fate is
#                       UNKNOWN, PROTOCOL.md §3.3). r12: its mtime is set to the quarantine moment FIRST, so the 24h inspection window
#                       runs from quarantine, not from the request's birth (BTF-GC-QUARANTINE-AGE); the name is fresh and the move
#                       never overwrites (BTF-GC-QUARANTINE-OWN). If either step fails the request stays in requests/ (counted as
#                       requests_held) — never deleted, never clobbering another file.
#   requests/.*.tmp    older than REQUEST_TTL_S              ⇒ DELETED   (a publish that crashed between write and rename)
#   requests/quarantine/* older than QUARANTINE_TTL_S (default 86400) ⇒ DELETED
#
# Prints one summary line: gc: results=N requests_quarantined=N requests_held=N tmp=N quarantine_expired=N [skipped=<dir>(<why>),…]. Exit 0 always unless the control dir is
# unreadable (exit 1 — an unreadable dir is UNKNOWN, never "nothing to clean"). Env: AGENTHOP_TERN_PANES, RESULT_TTL_S, REQUEST_TTL_S,
# QUARANTINE_TTL_S, GC_NOW (tests: fixed epoch seconds).
set -u

D="${AGENTHOP_TERN_PANES:-$HOME/.agenthop/tern-panes}"
RESULT_TTL_S="${RESULT_TTL_S:-3600}"
REQUEST_TTL_S="${REQUEST_TTL_S:-300}"
QUARANTINE_TTL_S="${QUARANTINE_TTL_S:-86400}"
NOW="${GC_NOW:-$(date +%s)}"

[ -d "$D" ] && [ -r "$D" ] || { echo "gc: control dir unreadable: $D (UNKNOWN, nothing done)"; exit 1; }

# r13 BTF-R10-P2-4: a managed subdir (results / requests / requests/quarantine) that is a symlink, or that resolves outside the control
# dir, is SKIPPED (reported in skipped=), never followed — gc must not delete or move a byte outside $D. Entries are also skipped when
# they are symlinks themselves (a link's mtime is not the file's; acting on it would touch whatever it points at).
ROOT="$(cd "$D" && pwd -P)" || { echo "gc: control dir unreadable: $D (UNKNOWN, nothing done)"; exit 1; }
skipped=""
safe_dir() { # $1 = path, $2 = label; 0 = a real directory inside ROOT
  [ -e "$1" ] || [ -L "$1" ] || return 1
  if [ -L "$1" ]; then skipped="$skipped $2(symlink)"; return 1; fi
  [ -d "$1" ] || { skipped="$skipped $2(not-a-dir)"; return 1; }
  local r; r="$(cd "$1" && pwd -P)" || { skipped="$skipped $2(unreadable)"; return 1; }
  case "$r/" in "$ROOT/"*) return 0;; esac
  skipped="$skipped $2(outside)"; return 1
}

age() { local m; m="$(stat -f %m "$1" 2>/dev/null)" || return 1; echo $((NOW - m)); }

stamp() { date -r "$NOW" +%Y%m%d%H%M.%S; }
nr=0; nq=0; nh=0; nt=0; ne=0
if safe_dir "$D/results" results; then
  for f in "$D"/results/*.json; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    a="$(age "$f")" || continue
    [ "$a" -gt "$RESULT_TTL_S" ] && rm -f "$f" && nr=$((nr+1))
  done
fi
if safe_dir "$D/requests" requests; then
  for f in "$D"/requests/*.json; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    a="$(age "$f")" || continue
    if [ "$a" -gt "$REQUEST_TTL_S" ]; then
      b="$(basename "$f" .json)"
      q="$D/requests/quarantine/$b.$NOW.$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n').json"
      if { [ -e "$D/requests/quarantine" ] || [ -L "$D/requests/quarantine" ] || mkdir "$D/requests/quarantine"; } && safe_dir "$D/requests/quarantine" quarantine && touch -t "$(stamp)" "$f" && [ ! -e "$q" ] && mv -n "$f" "$q" && [ ! -e "$f" ] && [ -e "$q" ]; then
        nq=$((nq+1))
      else
        nh=$((nh+1)) # left in requests/ untouched by deletion; reported, retried next run
      fi
    fi
  done
  for f in "$D"/requests/.*.tmp*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    a="$(age "$f")" || continue
    [ "$a" -gt "$REQUEST_TTL_S" ] && rm -f "$f" && nt=$((nt+1))
  done
  if safe_dir "$D/requests/quarantine" quarantine; then
    for f in "$D"/requests/quarantine/*; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      a="$(age "$f")" || continue
      [ "$a" -gt "$QUARANTINE_TTL_S" ] && rm -f "$f" && ne=$((ne+1))
    done
  fi
fi
skipped="$(printf '%s\n' $skipped | sort -u | tr '\n' ' ' | sed 's/^ *//;s/ *$//')"
echo "gc: results=$nr requests_quarantined=$nq requests_held=$nh tmp=$nt quarantine_expired=$ne${skipped:+ skipped=${skipped// /,}}"
exit 0
