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

pane="${TERN_PANE:-}" # empty when this session is not running inside a Tern pane (herdr/other host) — recorded as "" on purpose
tmp="$dir/.$sid.$$.tmp" # atomic write (temp + rename), matching the project's DWS discipline so a reader never sees a torn file
printf '{"sid":"%s","pane":"%s","cwd":"%s","ts":%s}\n' "$sid" "$pane" "${cwd:-$PWD}" "$(date +%s)" >"$tmp"
mv -f "$tmp" "$dir/$sid.json"
exit 0
