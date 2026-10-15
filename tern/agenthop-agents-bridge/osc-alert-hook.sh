#!/usr/bin/env bash
# agenthop agents-bridge — A3 emitter. A Claude Code hook that signals "needs a human" to the Tern pane via OSC 9;4, so a BARE (non-ACP)
# Claude Code seat produces the same waiting_input / pane.alert signal an ACP block would. The A2 sentinel reads pane.alert and
# cx.agents reports waiting_input (Carly V6: OSC 9;4;4 -> waiting_input + alert=true; clear with 9;4;0; focus clears it; no OSC leaves
# it unchanged).
#
# SCOPE (review TA-A3-SCOPE): this emitter is delivered for CLAUDE CODE only (events below, config ~/.claude/settings.json). Codex is
# NOT wired yet — it uses a different event (PermissionRequest; see docs/research/codex-opencode-hooks.md) and config path, and the
# current hook emits nothing on it. Codex/opencode emitters are TO-VERIFY, not delivered in this batch.
#
# Register for Claude Code events (see osc-alert-hook.settings.json):
#   Notification                      -> OSC 9;4;4 (paused -> needs human)
#   Stop / SubagentStop / UserPromptSubmit -> OSC 9;4;0 (clear)
#
# The OSC must reach the pane's PTY. A hook's stdout is captured by Claude Code, AND Claude Code runs hooks with NO controlling terminal:
# writing /dev/tty failed 14/14 in spike #1037 (docs/research/tui-osc-hooks-spike.md, raw/ evidence @b01c1f0), so the old /dev/tty
# default never reached Tern — A3's emitter was mute. Writing the TUI's own pty (found by walking the parent-process chain to the
# first ancestor with a tty, /dev/ttysNNN) succeeded 12/12. Default = that ancestor pty; /dev/tty only as a last resort;
# AGENTHOP_OSC_TTY overrides (the test uses it to capture the bytes). Only emits inside a Tern pane; on a herdr / other-terminal seat
# $TERN_PANE is unset and the hook is a no-op. Never blocks the session.
#
# Signal scope (spike #1037 facts): only the ALERT is a trustworthy signal. OSC 2 titles are repainted over by the Claude TUI within ~1s
# (not persistent), and progress OSC is not relied on; this hook emits the 9;4 alert pair only.
set -u

[ -n "${TERN_PANE:-}" ] || exit 0 # not inside a Tern pane => nothing to signal

payload="$(cat 2>/dev/null || true)" # Claude Code delivers the hook event as JSON on stdin
ev="$(printf '%s' "$payload" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("hook_event_name",""))' 2>/dev/null || true)"

esc=$'\033'
bel=$'\007' # BEL terminator (Carly's proven repro form: printf "\033]9;4;4;50\007")
# First ancestor (walking $PPID up) that owns a terminal ⇒ its /dev/ttysNNN; else /dev/tty. Bounded walk (16 hops), never loops.
ancestor_tty() {
  local pid="$PPID" i=0 t
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ $i -lt 16 ]; do
    t="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$t" in ""|"?"|"??") ;; *) [ -e "/dev/$t" ] && { echo "/dev/$t"; return 0; } ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"; i=$((i+1))
  done
  echo /dev/tty
}
tty="${AGENTHOP_OSC_TTY:-$(ancestor_tty)}"
[ -n "${AGENTHOP_OSC_TRACE:-}" ] && printf '%s\n' "$tty" >>"$AGENTHOP_OSC_TRACE" 2>/dev/null # test seam: record the chosen target

case "$ev" in
  Notification)
    printf '%s]9;4;4;50%s' "$esc" "$bel" >"$tty" 2>/dev/null || true # paused progress -> waiting_input + alert
    ;;
  Stop | SubagentStop | UserPromptSubmit)
    printf '%s]9;4;0%s' "$esc" "$bel" >"$tty" 2>/dev/null || true # clear
    ;;
esac
exit 0
