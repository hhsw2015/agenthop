#!/usr/bin/env bash
# agenthop agents-bridge — A2 r2 ④ W3 CPA probe (SWARM-SIDE, independent of Carly/the sentinel). A down CPA housekeeper cannot post to
# the inbox, so the swarm probes it directly: curl /v1/models (HTTP 200 only, 2s, content not checked). THREE consecutive failures =>
# write a CPA-DOWN L0 alert; a success resets the streak then clears the alert. Model-free.
#
# State discipline (reviews A2-CPA-STATE / A2-CPA-TEMP-OWN — the FC-2 errno lineage). The root lesson: `test -e` / `-L` are EXISTENCE
# BOOLEANS that return false for BOTH "truly absent (ENOENT)" AND "ancestor/file inaccessible (EACCES)" — they launder access failures
# into 0. So read AND delete are classified by REAL ERRNO (python open/os.remove: FileNotFoundError => absent, OSError => unavailable).
# Only ENOENT is "absent"; every other failure is "unavailable/incomplete" and reaches the NA guard. Recovery ORDER: obtain a
# confirmable ZERO count first, then idempotently clear the alert, only then report up+clean. State advances only through an
# EXCLUSIVELY-created temp (mktemp) atomically renamed. Alert JSON uses a real encoder (quoted URL stays parseable).
#
# Usage: cpa-probe.sh [L0-dir]   Env: AGENTHOP_CPA_URL, AGENTHOP_CPA_PROBE (test hook: 0=up/nonzero=down)
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

# errno-classified read: prints ENOENT (only when truly absent) / NA (any access failure, incl. ancestor EACCES, protected symlink,
# unreadable file) / <digits>. No boolean existence test — access failures are NOT laundered to 0.
read_cur() {
  python3 - "$state" <<'PY' 2>/dev/null
import sys
try:
    data = open(sys.argv[1]).read()
except FileNotFoundError:
    print("ENOENT"); sys.exit(0)
except OSError:
    print("NA"); sys.exit(0)
s = data.strip()
print(s if s.isdigit() else "NA")
PY
}

# durable write via an EXCLUSIVELY created temp (mktemp): unpredictable name (no hijack), real file (no symlink follow), own-only delete
write_state() {
  local tmp
  tmp="$(mktemp "$L0/.cpa-probe.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$state" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

# errno-classified delete: 0 if the alert is gone (removed OR truly absent/ENOENT), 1 if an access failure left it (incomplete).
remove_alert() {
  python3 - "$alert_file" <<'PY' 2>/dev/null
import os, sys
try:
    os.remove(sys.argv[1])
except FileNotFoundError:
    sys.exit(0)
except OSError:
    sys.exit(1)
sys.exit(0)
PY
}

raw="$(read_cur)"
case "$raw" in
  ENOENT) cur=0 ;;
  NA | '') cur=NA ;;
  *) cur="$raw" ;;
esac

if [ "$probe" -eq 0 ]; then
  # recovery order: confirm a ZERO count first, then idempotently clear the alert, only then up+clean (never clear on an unconfirmed count)
  if [ "$cur" = "NA" ]; then exit 3; fi          # unreadable carrier (incl. ancestor EACCES) => cannot confirm => incomplete
  if [ "$cur" != "0" ]; then
    write_state 0 || exit 3                        # persist zero failed => do NOT clear the alert; incomplete
  fi
  remove_alert || exit 3                           # count now confirmably zero; a failed clear (e.g. alerts dir EACCES) => incomplete
  exit 0                                           # up + clean
fi

# probe failed
if [ "$cur" = "NA" ]; then exit 2; fi             # unavailable carrier => no advance, no touch
next=$((cur + 1))
if write_state "$next"; then
  if [ "$next" -ge 3 ]; then
    body="$(CPA_URL="$url" CPA_N="$next" python3 -c 'import json,os,time; print(json.dumps({"kind":"cpa_down","url":os.environ["CPA_URL"],"consecutive_fails":int(os.environ["CPA_N"]),"ts":int(time.time())}))' 2>/dev/null)"
    [ -n "$body" ] && printf '%s\n' "$body" >"$alert_file"
  fi
  exit 1
fi
exit 3
