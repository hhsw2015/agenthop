#!/usr/bin/env bash
# Fixture for the A3 OSC alert hook (osc-alert-hook.sh). Drives the hook with Claude Code event JSON, capturing the OSC bytes via
# AGENTHOP_OSC_TTY instead of /dev/tty, and asserts the right sequence per event + the no-op-outside-Tern guard. Run: bash test/osc-hook.test.sh

set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/osc-alert-hook.sh"
cap="$(mktemp)"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got: $(printf %q "$3"), want: $(printf %q "$2"))"; fails=$((fails+1)); fi; }

esc=$'\033'; bel=$'\007'
want_pause="${esc}]9;4;4;50${bel}"
want_clear="${esc}]9;4;0${bel}"

run() { # event-json
  : > "$cap"
  printf '%s' "$1" | TERN_PANE=12345 AGENTHOP_OSC_TTY="$cap" bash "$HOOK"
  cat "$cap"
}

ck "Notification -> OSC 9;4;4 (needs human)" "$want_pause" "$(run '{"hook_event_name":"Notification"}')"
ck "Stop -> OSC 9;4;0 (clear)" "$want_clear" "$(run '{"hook_event_name":"Stop"}')"
ck "UserPromptSubmit -> OSC 9;4;0 (clear)" "$want_clear" "$(run '{"hook_event_name":"UserPromptSubmit"}')"
ck "SubagentStop -> OSC 9;4;0 (clear)" "$want_clear" "$(run '{"hook_event_name":"SubagentStop"}')"

# unknown event => emits nothing
ck "unknown event -> no OSC" "" "$(run '{"hook_event_name":"PreToolUse"}')"

# no-op outside a Tern pane (TERN_PANE unset) even on Notification
: > "$cap"
printf '%s' '{"hook_event_name":"Notification"}' | env -u TERN_PANE AGENTHOP_OSC_TTY="$cap" bash "$HOOK"
ck "no TERN_PANE -> no-op" "" "$(cat "$cap")"

rm -f "$cap"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
