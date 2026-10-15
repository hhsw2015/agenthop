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

# r9 (spike #1037): with NO AGENTHOP_OSC_TTY, the default target is the first ANCESTOR that owns a tty (/dev/ttysNNN), not /dev/tty
# (Claude Code runs hooks without a controlling terminal). Check the resolver picks a real ancestor tty device when one exists.
anc="$(bash -c 'source <(sed -n "/^ancestor_tty()/,/^}/p" "'"$HOOK"'"); ancestor_tty')"
# independent oracle: walk from THIS shell's parent (the subshell's $PPID is us) up to the first process owning a tty
want=/dev/tty; pid=$$; i=0
while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ $i -lt 16 ]; do
  t="$(ps -o tty= -p "$pid" | tr -d ' ')"; case "$t" in ""|"?"|"??") ;; *) [ -e "/dev/$t" ] && { want="/dev/$t"; break; } ;; esac
  pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"; i=$((i+1))
done
ck "ancestor tty: resolves to the first ancestor that owns a tty (here $want), /dev/tty only if none" "$want" "$anc"
# the HOOK itself (no AGENTHOP_OSC_TTY) must choose that ancestor target — not /dev/tty
trace="$(mktemp)"
printf '%s' '{"hook_event_name":"Stop"}' | env -u AGENTHOP_OSC_TTY TERN_PANE=1 AGENTHOP_OSC_TRACE="$trace" bash "$HOOK"
ck "hook default target (no AGENTHOP_OSC_TTY) = the ancestor tty ($want)" "$want" "$(head -1 "$trace")"
rm -f "$trace"
rm -f "$cap"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
