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
#   requests/.<id>.tmp | .<id>.tmp-<8hex> older than REQUEST_TTL_S ⇒ DELETED (a publish that crashed between write and rename;
#                       exact shapes only — a .gc-* hold is never a temp, r15)
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
# r15: the eval trust boundary (PROTOCOL §2.2) assumes only the owner can WRITE the control dir. Report the mode; group- or
# other-writable ⇒ UNKNOWN (exit 1), nothing done — a dir others can write is not ours to clean or to trust.
MODE="$(stat -f %Lp "$ROOT" 2>/dev/null)" || { echo "gc: control dir mode unreadable: $D (UNKNOWN, nothing done)"; exit 1; }
if [ $(( 8#$MODE & 8#022 )) -ne 0 ]; then echo "gc: unsafe_mode mode=$MODE (group/other-writable control dir: UNKNOWN, nothing done)"; exit 1; fi
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
  # r14 BTF-GC-SOURCE-OWN: TAKE the object first, then decide. A stat of requests/<id>.json followed by a touch/mv of the same PATH
  # can act on a DIFFERENT object: the drain may claim the old file and agenthop_tern re-publish a read-only request under the SAME
  # id (mtime = now) in between. So an old-looking request is first moved (mv -n, verified by looking — macOS mv -n exits 0 even
  # when it refuses) to a private name the drain never reads (.gc-<id>.<pid>.<rand>), and only the object we HOLD is aged. Too
  # young ⇒ put back under its own name; if a newer publish took that name meanwhile, ours is quarantined (kept, never deleted).
  # A crash while holding leaves .gc-* behind; the next run quarantines those once they are older than the TTL.
  quarantine_dir_ok() { { [ -e "$D/requests/quarantine" ] || [ -L "$D/requests/quarantine" ] || mkdir "$D/requests/quarantine"; } && safe_dir "$D/requests/quarantine" quarantine; }
  to_quarantine() { # $1 = held file, $2 = id ⇒ 0 when it is now in quarantine/ (and gone from $1)
    local q="$D/requests/quarantine/$2.$NOW.$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n').json"
    quarantine_dir_ok && touch -t "$(stamp)" "$1" && [ ! -e "$q" ] && mv -n "$1" "$q" && [ ! -e "$1" ] && [ -e "$q" ]
  }
  for f in "$D"/requests/*.json; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    a="$(age "$f")" || continue
    [ "$a" -gt "$REQUEST_TTL_S" ] || continue # young by its path: never taken, nothing to race
    b="$(basename "$f" .json)"
    h="$D/requests/.gc-$b.$$.$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')"
    mv -n "$f" "$h" 2>/dev/null; [ -e "$h" ] || continue # gone (drain claimed it) or not ours: nothing taken
    ah="$(age "$h")" || ah=0
    if [ "$ah" -le "$REQUEST_TTL_S" ]; then
      # the object we took is a FRESH publish (re-sent under the same id): give it back untouched
      mv -n "$h" "$f" 2>/dev/null
      if [ -e "$h" ]; then to_quarantine "$h" "$b" && nq=$((nq+1)) || nh=$((nh+1)); fi
      continue
    fi
    if to_quarantine "$h" "$b"; then
      nq=$((nq+1))
    else
      mv -n "$h" "$f" 2>/dev/null # quarantine impossible: back to its own name, held, retried next run
      nh=$((nh+1))
    fi
  done
  for h in "$D"/requests/.gc-*; do # held by a gc that crashed
    [ -f "$h" ] && [ ! -L "$h" ] || continue
    a="$(age "$h")" || continue
    [ "$a" -gt "$REQUEST_TTL_S" ] || continue
    b="$(basename "$h")"; b="${b#.gc-}"; b="${b%.*.*}"
    to_quarantine "$h" "$b" && nq=$((nq+1)) || nh=$((nh+1))
  done
  # r15 BTF-R14-P2-1: only a PUBLISH temp is ever deleted, by its exact shapes — publish.sh writes requests/.<id>.tmp, agenthop_tern
  # (tern-bridge.ts publishRequest) writes requests/.<id>.tmp-<8 hex>. A gc HOLD (.gc-*) is an obligation and never matches here,
  # even when its <id> contains ".tmp" (an id may: only "/" and a leading "." are forbidden); a hold that cannot be quarantined
  # stays and is counted held above.
  for f in "$D"/requests/.*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    n="$(basename "$f")"
    case "$n" in .gc-*) continue;; esac
    case "$n" in
      *.tmp) ;;
      *.tmp-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) continue;;
    esac
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
echo "gc: results=$nr requests_quarantined=$nq requests_held=$nh tmp=$nt quarantine_expired=$ne mode=$MODE${skipped:+ skipped=${skipped// /,}}"
exit 0
