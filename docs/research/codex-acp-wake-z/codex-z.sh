#!/usr/bin/env bash
# Scheme Z wrapper: install as `<dir>/bin/codex` with ws-bridge.mjs in `<dir>`, and put `<dir>/bin` first on PATH for one
# `tern acp codex` launch. codex-acp spawns "codex app-server [-c k=v ...]"; this routes that to the SHARED daemon's control
# socket (WebSocket) through ws-bridge.mjs. Any other subcommand runs the real codex. -c args cannot reach a running daemon:
# they are dropped and logged.
dir="$(cd "$(dirname "$0")/.." && pwd)"
log="$dir/wrapper.log"
echo "$(date +%T) pid=$$ argv: $*" >> "$log"
real="${CODEX_REAL:-$HOME/.local/bin/codex}"
if [ "${1:-}" = "app-server" ]; then
  shift
  [ $# -gt 0 ] && echo "$(date +%T) dropped app-server args: $*" >> "$log"
  exec node "$dir/ws-bridge.mjs"
fi
exec "$real" "$@"
