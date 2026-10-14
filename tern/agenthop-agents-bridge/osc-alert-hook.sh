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
# The OSC must reach the pane's PTY. A hook's stdout is captured by Claude Code, so it is written to the controlling terminal
# (/dev/tty), overridable with AGENTHOP_OSC_TTY (the test uses this to capture the bytes). Only emits inside a Tern pane; on a herdr /
# other-terminal seat $TERN_PANE is unset and the hook is a no-op. Never blocks the session.
set -u

[ -n "${TERN_PANE:-}" ] || exit 0 # not inside a Tern pane => nothing to signal

payload="$(cat 2>/dev/null || true)" # Claude Code delivers the hook event as JSON on stdin
ev="$(printf '%s' "$payload" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("hook_event_name",""))' 2>/dev/null || true)"

esc=$'\033'
bel=$'\007' # BEL terminator (Carly's proven repro form: printf "\033]9;4;4;50\007")
tty="${AGENTHOP_OSC_TTY:-/dev/tty}"

case "$ev" in
  Notification)
    printf '%s]9;4;4;50%s' "$esc" "$bel" >"$tty" 2>/dev/null || true # paused progress -> waiting_input + alert
    ;;
  Stop | SubagentStop | UserPromptSubmit)
    printf '%s]9;4;0%s' "$esc" "$bel" >"$tty" 2>/dev/null || true # clear
    ;;
esac
exit 0
