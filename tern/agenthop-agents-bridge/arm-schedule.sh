#!/usr/bin/env bash
# agenthop agents-bridge — A2 patrol SCHEDULER, swarm side (#1036 r9). Schedules the promptless patrol sentinel from OUTSIDE Tern's
# plugin hooks: even ONE tern.carly.schedule call exceeded the 50ms budget inside a command hook live (12:21 / 12:24), disabling it until
# reload. `tern ctl carly task add <JSON spec>` reaches Carly's scheduler directly from the CLI [tested 2026-10-15: 0.4s, ok].
#
# Order (after every bridge load/reload, driven by the #1033 sweep): `…arm-scan` (read-only: sentinel.json {ids,count}) → if count>1,
# run `…arm-cancel-next` until count==1 (it keeps the newest; no kv, no arguments) → if count==0, THIS script → it re-runs
# `…arm-scan` and accepts only count==1. Listing/cancelling stay in the plugin (tern 0.8.3's `ctl carly task` has add but no
# list/cancel); only schedule — the call that exceeded 50ms in a hook — runs here.
#
# Two CLI facts this script encodes:
#   - `tern ctl` treats `#` as a comment start and silently truncates the argument there (sentinel.luau contains "#924"), so every
#     `#` in the JSON is written as the JSON escape \u0023. Whitespace and newlines are fine.
#   - ctl's {"ok":true} is NOT proof (ctl returns ok even for unknown subcommands). Success = `…arm-scan` afterwards reports count==1.
#
# Exit: 0 scheduled-and-verified | 2 refused (count>0: a patrol exists or extras await arm-cancel-next) | 1 failed (ctl / scan / verify).
# Env: TERN_BIN, TERN_PANE_SOCKET, AGENTHOP_TERN_PANES, AGENTHOP_SENTINEL_SRC override the defaults.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
TERN="${TERN_BIN:-tern}"
export TERN_PANE_SOCKET="${TERN_PANE_SOCKET:-$HOME/Library/Application Support/Tern/daemon.sock}"
D="${AGENTHOP_TERN_PANES:-$HOME/.agenthop/tern-panes}"
TITLE="agenthop tern patrol"
SRC="${AGENTHOP_SENTINEL_SRC:-$HERE/sentinel.luau}"
STATUS="$D/sentinel.json"

# run …arm-scan and print sentinel.json's count (rc 1 if the scan did not record a fresh "scanned" status)
scan_count() {
  # remove the previous status FIRST so only THIS scan's write can satisfy the read (a stale "scanned" would be a false answer;
  # ctl's ok is not proof the command ran). r12 BTF-ARM-FRESH: a removal that fails (anything but "was not there") is a failure —
  # reading on would let the OLD count answer for this scan and schedule a duplicate.
  rm -f "$STATUS" 2>/dev/null
  if [ -e "$STATUS" ] || [ -L "$STATUS" ]; then echo "cannot clear the previous $STATUS (a stale count must not answer)" >&2; return 1; fi
  "$TERN" ctl plugins run plugin.agenthop-agents-bridge.arm-scan >/dev/null 2>&1
  local i=0
  while [ $i -lt 20 ]; do
    # r12 BTF-ARM-COUNT: count must be a JSON non-negative INTEGER as written (not a bool, not 0.9, not "0"); anything else is
    # UNKNOWN, never coerced to 0
    python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
c=d.get("count")
assert d.get("step")=="scanned" and type(c) is int and c>=0
print(c)' "$STATUS" 2>/dev/null && return 0
    sleep 0.1; i=$((i+1))
  done
  return 1
}

# 1) refuse unless the scan proves there is NO patrol yet (count==0); an unanswered scan is a failure, never "zero"
n="$(scan_count)" || { echo "failed: arm-scan did not report (cannot prove there is no patrol); not scheduling blind"; exit 1; }
if [ "$n" != "0" ]; then echo "refused: $n patrol task(s) already exist (run …arm-cancel-next for extras, or nothing to do)"; exit 2; fi

# 2) schedule via the CLI; every '#' escaped as # (ctl truncates at '#')
spec="$(python3 -I -c 'import json,sys
src=open(sys.argv[2]).read()
s=json.dumps({"title":sys.argv[1],"when":"every 1m","check":src},separators=(",",":"),ensure_ascii=True)
print(s.replace("#","\\u0023"))' "$TITLE" "$SRC")" || { echo "failed: cannot read $SRC"; exit 1; }
out="$("$TERN" ctl carly task add "$spec" 2>&1)"
case "$out" in *'"ok":true'*) ;; *) echo "failed: ctl carly task add: $(printf '%s' "$out" | head -c 300)"; exit 1;; esac

# 3) verify through tasks() via arm-scan — ctl ok alone is not proof
n="$(scan_count)" || { echo "failed: scheduled but arm-scan did not report the verification"; exit 1; }
if [ "$n" != "1" ]; then echo "failed: ctl said ok but arm-scan counts $n patrol task(s) (want 1)"; exit 1; fi
echo "scheduled: verified 1 patrol task"; exit 0
