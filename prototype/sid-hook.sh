#!/usr/bin/env bash
# agenthop tern-migration spike ③ — Claude Code SessionStart hook: sid -> Tern pane self-report.
#
# Why: cx.agents:list() identifies an agent by its Tern pane id, but it carries no Claude-Code session id (sid). The swarm wants to
# join "which sid" to "which cx.agents entry". Tern exports the pane id as $TERN_PANE in every pane shell. The spike OBSERVED, for a
# plain shell pane, that $TERN_PANE equals that pane's block id in `tern ls` (shell-env == CLI). The type decl names both
# AgentBlock.pane and the CLI block id a "pane id", so treating them as one namespace is an API INFERENCE, not a measured join. The
# full three-way join (one real agent's $TERN_PANE + its cx.agents:list() entry + its CLI block) and restart stability are NOT yet
# verified (review TERN-4). So this hook records the self-reported sid->pane; the swarm side must still confirm the join.
set -u

dir="$HOME/.agenthop/tern-panes/sid"
mkdir -p "$dir"

# All field handling happens inside ONE python process that reads the raw event on stdin. Nothing is routed through a bash "$(...)"
# capture, which would strip trailing newlines from cwd before encoding and let the round-trip check pass on already-lost data
# (review TERN-2-R2). cwd is taken verbatim from the parsed event; pane is normalized to a NUMBER (matching cx.agents:list()'s
# numeric pane) or null; the record is written to a temp file and atomically renamed. A malformed event, a missing sid, or a failed
# lossless-encoding check writes nothing (the honest signal) and never blocks the session.
python3 -c '
import json, os, sys
d, pane_raw, pwd_fallback, ts = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
try:
    event = json.load(sys.stdin)
    assert isinstance(event, dict)
except Exception:
    sys.exit(0)                                   # malformed SessionStart event: no record
sid = event.get("session_id") or ""
if not sid or "/" in sid or sid.startswith("."):  # no sid, or unsafe as a filename: nothing to map
    sys.exit(0)
pane = int(pane_raw) if pane_raw.isdigit() else None
cwd = event.get("cwd") or pwd_fallback            # verbatim from the event; trailing newlines are preserved, not stripped
obj = {"sid": sid, "pane": pane, "cwd": cwd, "ts": ts}
s = json.dumps(obj)
back = json.loads(s)
if back != obj or back["sid"] != sid or back["cwd"] != cwd:   # lossless-encoding + source-equality guard
    sys.exit(3)
tmp = os.path.join(d, ".%s.%d.tmp" % (sid, os.getpid()))
with open(tmp, "w") as f:
    f.write(s + "\n")
os.rename(tmp, os.path.join(d, sid + ".json"))    # atomic publish (temp + rename) — DWS discipline
' "$dir" "${TERN_PANE:-}" "$PWD" "$(date +%s)" || true # empty $TERN_PANE => pane null (not inside a Tern pane)
exit 0
