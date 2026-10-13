#!/usr/bin/env bash
# agenthop tern-migration spike ③ — Claude Code SessionStart hook: sid -> Tern pane self-report.
#
# Why: cx.agents:list() identifies an agent by its Tern pane id, but it carries no Claude-Code session id (sid). The swarm needs to
# join "which sid" to "which cx.agents entry". Tern exports the pane id as $TERN_PANE in every pane shell, and the spike verified
# $TERN_PANE === the pane id cx.agents:list() reports (one id-space). So each session announces its own sid->pane on start; the swarm
# reads sid/<sid>.json and looks that pane up in the bridge's agents.json. Self-reporting beats external probing: terminal-decoupled,
# survives restarts, no scraping.
set -euo pipefail

dir="$HOME/.agenthop/tern-panes/sid"
mkdir -p "$dir"

payload="$(cat)" # Claude Code delivers the SessionStart event as JSON on stdin (session_id, cwd, source, ...)
sid="$(printf '%s' "$payload" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)"
cwd="$(printf '%s' "$payload" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null || true)"

[ -n "$sid" ] || exit 0 # no session id -> nothing to map; never block the session

pane="${TERN_PANE:-}" # empty when this session is not running inside a Tern pane (herdr/other host)
tmp="$dir/.$sid.$$.tmp" # temp + rename (mv) so a reader never sees a torn file — DWS discipline

# Serialize the record with a real JSON encoder and refuse to publish it unless it round-trips (parses back to the same object).
# The earlier printf-spliced JSON corrupted the record when cwd held a quote / backslash / newline, yet still exited 0 (review
# TERN-2). pane is normalized to a NUMBER (matching cx.agents:list()'s numeric pane) when $TERN_PANE is a digit string, else null —
# this also removes the string-vs-number join mismatch the review flagged (TERN-4). A corrupt or non-round-tripping record is never
# written; a missing record is the honest signal.
if python3 -c '
import json, sys
pane_raw = sys.argv[2]
pane = int(pane_raw) if pane_raw.isdigit() else None
obj = {"sid": sys.argv[1], "pane": pane, "cwd": sys.argv[3], "ts": int(sys.argv[4])}
s = json.dumps(obj)
if json.loads(s) != obj:
    sys.exit(3)
open(sys.argv[5], "w").write(s + "\n")
' "$sid" "$pane" "${cwd:-$PWD}" "$(date +%s)" "$tmp"; then
  mv -f "$tmp" "$dir/$sid.json"
else
  rm -f "$tmp" # bad encode / failed round-trip: write nothing rather than a corrupt record
fi
exit 0
