#!/usr/bin/env bash
# Run the Swarm Observatory fixtures. Loads the PRODUCTION .luau modules under a stock Lua 5.5 (or LuaJIT)
# interpreter -- the same files Tern loads via require() -- so there is no mirror copy.
#
#   bash test/run.sh         (from the plugin dir, or anywhere: paths are resolved relative to this script)
#
# Exits non-zero if any fixture fails.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

LUA="${LUA_BIN:-}"
if [ -z "$LUA" ]; then
  for cand in lua lua5.5 lua5.4 luajit; do
    if command -v "$cand" >/dev/null 2>&1; then LUA="$cand"; break; fi
  done
fi
if [ -z "$LUA" ]; then
  echo "no Lua interpreter found (install lua 5.x or luajit, or set LUA_BIN=/path/to/lua)" >&2
  exit 2
fi
echo "using interpreter: $LUA ($($LUA -v 2>&1 | head -1))"

fails=0
for t in budget.test.lua parse.test.lua; do
  echo "=== $t ==="
  if ! "$LUA" "$DIR/$t"; then fails=$((fails + 1)); fi
  echo
done

if [ "$fails" -eq 0 ]; then
  echo "ALL FIXTURES PASS"
  exit 0
else
  echo "$fails FIXTURE FILE(S) FAILED"
  exit 1
fi
