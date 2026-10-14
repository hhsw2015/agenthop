#!/usr/bin/env bash
# agenthop agents-bridge — A2 r2 ④ W3 CPA probe (SWARM-SIDE, independent of Carly/the sentinel). A down CPA housekeeper cannot post to
# the inbox, so the swarm probes it directly: curl /v1/models (HTTP 200 only, 2s, content not checked). THREE consecutive failures =>
# write a CPA-DOWN L0 alert; a success idempotently clears the alert + resets the streak. Model-free.
#
# State discipline (reviews A2-CPA-STATE / A2-CPA-TEMP-OWN — the FC-2 lstat + temp-ownership lineage):
#   * ENOENT alone initializes to 0. A carrier that EXISTS but cannot be read (EACCES, dangling/protected symlink) is UNAVAILABLE — it
#     is never laundered to 0, never reset, never clobbered (`-L || -e` distinguishes "present" from "truly absent"; `test -e` != errno).
#   * The streak only ADVANCES, and state is only RESET, through a durable write: an EXCLUSIVELY-created temp (mktemp, no fixed name, no
#     symlink to follow, only-delete-what-we-made) atomically renamed over the state. A probe result is not a persist result (exit codes).
#   * Recovery cleanup is IDEMPOTENT and NOT gated on the count: a success always tries to remove a standing alert; a failed removal is
#     reported (nonzero), never silently swallowed — zero count != fully recovered.
#   * The alert JSON is built by a real encoder so a quoted URL stays parseable (A2-CPA-JSON).
#
# Usage: cpa-probe.sh [L0-dir]      # default ~/.agenthop/carly
# Env:   AGENTHOP_CPA_URL (default http://127.0.0.1:8318/v1/models), AGENTHOP_CPA_PROBE (test hook: exit 0=up / nonzero=down)
# Exit:  0 up+clean  1 down+advanced  2 down+state-unavailable  3 persist/cleanup incomplete
set -u

L0="${1:-$HOME/.agenthop/carly}"
alerts="$L0/alerts"
state="$L0/cpa-probe.state"
alert_file="$alerts/cpa_down.json"
url="${AGENTHOP_CPA_URL:-http://127.0.0.1:8318/v1/models}"
mkdir -p "$alerts" 2>/dev/null || true

if [ -n "${AGENTHOP_CPA_PROBE:-}" ]; then
  "$AGENTHOP_CPA_PROBE"; probe=$?
else
  http="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  if [ "$http" = "200" ]; then probe=0; else probe=1; fi
fi

# ENOENT (truly absent) => 0; present-but-unreadable or non-decimal => NA (keep the carrier untouched)
read_state() {
  if [ -L "$state" ] || [ -e "$state" ]; then
    local raw rc
    raw="$(cat "$state" 2>/dev/null)"; rc=$?
    if [ "$rc" -ne 0 ]; then echo NA; return; fi
    case "$raw" in
      '' | *[!0-9]*) echo NA;;
      *) echo "$raw";;
    esac
  else
    echo 0
  fi
}

# durable write via an EXCLUSIVELY created temp (mktemp): unpredictable name (no hijack), real file (no symlink follow), own-only delete
write_state() {
  local tmp
  tmp="$(mktemp "$L0/.cpa-probe.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$state" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null # only ever our own mktemp'd file
  return 1
}

# remove_alert -> 0 if no alert remains (removed or absent), 1 if one is still there (removal failed)
remove_alert() {
  if [ -e "$alert_file" ] || [ -L "$alert_file" ]; then
    rm -f "$alert_file" 2>/dev/null
    if [ -e "$alert_file" ] || [ -L "$alert_file" ]; then return 1; fi
  fi
  return 0
}

cur="$(read_state)"

if [ "$probe" -eq 0 ]; then
  # An unreadable state carrier on the recovery path cannot be confirmed reset — reporting "up + clean" (exit 0) while the streak is an
  # unknown stale value is exactly the bug (next failure would re-alert at one strike). Preserve everything, report incomplete. "0 =
  # up+clean" and "NA, not-reset, still exit 0" must not both hold.
  if [ "$cur" = "NA" ]; then
    exit 3
  fi
  ok=0
  remove_alert || ok=1                                   # idempotent cleanup, NOT gated on the count (fix a)
  if [ "$cur" != "0" ]; then                             # reset a readable non-zero streak
    write_state 0 || ok=1
  fi
  [ "$ok" -eq 0 ] && exit 0 || exit 3                     # a failed removal/reset => recovery incomplete, not a silent success
fi

# probe failed
if [ "$cur" = "NA" ]; then exit 2; fi                     # unavailable carrier => no advance, no touch
next=$((cur + 1))
if write_state "$next"; then
  if [ "$next" -ge 3 ]; then
    body="$(CPA_URL="$url" CPA_N="$next" python3 -c 'import json,os,time; print(json.dumps({"kind":"cpa_down","url":os.environ["CPA_URL"],"consecutive_fails":int(os.environ["CPA_N"]),"ts":int(time.time())}))' 2>/dev/null)"
    [ -n "$body" ] && printf '%s\n' "$body" >"$alert_file"
  fi
  exit 1
fi
exit 3
