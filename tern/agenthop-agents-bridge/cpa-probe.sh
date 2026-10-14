#!/usr/bin/env bash
# agenthop agents-bridge — A2 r2 ④ W3 CPA probe (SWARM-SIDE, independent of Carly/the sentinel). A down CPA housekeeper cannot post to
# the inbox, so the swarm probes it directly: curl /v1/models (HTTP 200 only, 2s, content not checked). THREE consecutive failures =>
# write a CPA-DOWN L0 alert; one success clears the streak + removes the alert. Model-free.
#
# State discipline (review A2-CPA-STATE): ENOENT = initial 0; a read failure or a bad carrier = UNAVAILABLE (never laundered to 0, never
# resets the streak). The consecutive-fail count only ADVANCES, and the alert is only CLEARED, when the new state is DURABLY persisted
# via a temp-file + atomic rename — a probe result is not a persist result, and they get distinct exit codes. JSON is built by a real
# encoder (review A2-CPA-JSON) so a URL with quotes stays parseable.
#
# Usage: cpa-probe.sh [L0-dir]      # default ~/.agenthop/carly
# Env:   AGENTHOP_CPA_URL   probe URL (default http://127.0.0.1:8318/v1/models)
#        AGENTHOP_CPA_PROBE a command whose exit code replaces curl (0=up, nonzero=down) — test hook
# Exit:  0 up (persisted/clear)  1 down (streak advanced)  2 down but state unavailable  3 persist failed (not advanced / not cleared)
set -u

L0="${1:-$HOME/.agenthop/carly}"
alerts="$L0/alerts"
state="$L0/cpa-probe.state"
alert_file="$alerts/cpa_down.json"
url="${AGENTHOP_CPA_URL:-http://127.0.0.1:8318/v1/models}"
mkdir -p "$alerts" 2>/dev/null || true

# one probe: 0 = up (HTTP 200), nonzero = down
if [ -n "${AGENTHOP_CPA_PROBE:-}" ]; then
  "$AGENTHOP_CPA_PROBE"; probe=$?
else
  http="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  if [ "$http" = "200" ]; then probe=0; else probe=1; fi
fi

# read_state -> prints the streak, or "NA" when unavailable (ENOENT is 0, not NA)
read_state() {
  if [ ! -e "$state" ]; then echo 0; return; fi
  local raw rc
  raw="$(cat "$state" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ]; then echo NA; return; fi            # read failure => unavailable
  case "$raw" in
    '' | *[!0-9]*) echo NA;;                               # empty / non-decimal => unavailable (never silently 0)
    *) echo "$raw";;
  esac
}

# write_state <value> -> 0 on durable persist (temp + atomic rename), nonzero on failure
write_state() {
  local tmp="$state.$$.tmp"
  if printf '%s' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$state" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

cur="$(read_state)"

if [ "$probe" -eq 0 ]; then
  # recovery. Clearing the alert and resetting the streak are gated on a successful persist (never clear while the count is stuck).
  if [ "$cur" = "0" ]; then exit 0; fi                     # already clear
  if write_state 0; then
    rm -f "$alert_file" 2>/dev/null
    exit 0
  fi
  exit 3                                                   # persist failed => do NOT falsely clear the alert
fi

# probe failed
if [ "$cur" = "NA" ]; then
  exit 2                                                   # state unavailable => cannot safely advance (no launder, no reset, no alert)
fi
next=$((cur + 1))
if write_state "$next"; then                              # advance only once durably persisted
  if [ "$next" -ge 3 ]; then
    body="$(CPA_URL="$url" CPA_N="$next" python3 -c 'import json,os,time; print(json.dumps({"kind":"cpa_down","url":os.environ["CPA_URL"],"consecutive_fails":int(os.environ["CPA_N"]),"ts":int(time.time())}))' 2>/dev/null)"
    [ -n "$body" ] && printf '%s\n' "$body" >"$alert_file"
  fi
  exit 1
fi
exit 3                                                     # persist failed => did not advance; no alert from a non-advanced count
