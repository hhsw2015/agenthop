#!/usr/bin/env bash
# agenthop agents-bridge — A2 r2 ④ W3 CPA probe (SWARM-SIDE, independent of Carly/the sentinel). The CPA housekeeper, if it is itself
# down, cannot post to the inbox — so the swarm probes it directly: curl /v1/models (HTTP 200 only, 2s timeout, content not checked).
# THREE consecutive failures => write a CPA-DOWN L0 alert; a single success clears the streak and removes the alert (recovery-clears).
# The consecutive-fail count persists in a state file so "3 in a row" survives across rounds. Model-free (no agent turn).
#
# Usage: cpa-probe.sh [L0-dir]        # default ~/.agenthop/carly
# Env:   AGENTHOP_CPA_URL   override the probe URL (default http://127.0.0.1:8318/v1/models)
#        AGENTHOP_CPA_PROBE a command whose exit code replaces the curl (0=up, nonzero=down) — used by the test to inject up/down
set -u

L0="${1:-$HOME/.agenthop/carly}"
alerts="$L0/alerts"
state="$L0/cpa-probe.state"
alert_file="$alerts/cpa_down.json"
url="${AGENTHOP_CPA_URL:-http://127.0.0.1:8318/v1/models}"
mkdir -p "$alerts"

# one probe: code 0 = CPA up (HTTP 200), nonzero = down
if [ -n "${AGENTHOP_CPA_PROBE:-}" ]; then
  "$AGENTHOP_CPA_PROBE"
  code=$?
else
  http="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  if [ "$http" = "200" ]; then code=0; else code=1; fi
fi

fails=0
[ -f "$state" ] && fails="$(tr -dc '0-9' <"$state" 2>/dev/null)"
[ -z "$fails" ] && fails=0

if [ "$code" -eq 0 ]; then
  printf '0' >"$state"            # recovery: reset streak...
  rm -f "$alert_file" 2>/dev/null # ...and clear any standing CPA-DOWN alert
  exit 0
fi

fails=$((fails + 1))
printf '%s' "$fails" >"$state"
if [ "$fails" -ge 3 ]; then       # only the THIRD consecutive failure raises the alert
  printf '{"kind":"cpa_down","url":"%s","consecutive_fails":%s,"ts":%s}\n' "$url" "$fails" "$(date +%s)" >"$alert_file"
fi
exit 1
