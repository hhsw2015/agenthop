#!/usr/bin/env bash
# Atomic request publisher for the agents-bridge control plane (PROTOCOL.md §2.0). Writes the JSON to a temp name the bridge does NOT
# list, then renames it into place ONLY IF the write fully succeeded — so a partial/failed write never becomes a visible request
# (review TA-A1-PUBLISH: an unconditional `mv -f` after a failed write still publishes a half-written body).
#
# Usage:  publish.sh <control-dir> <json>     # prints the request id on success; exit != 0 and NO final .json on any write failure
set -u

dir="${1:?control dir}"
json="${2:?json}"
id="q-$$-$(date +%s%N)"
tmp="$dir/requests/.$id.tmp"   # dot-prefixed, not *.json => the bridge never lists it
final="$dir/requests/$id.json"

# The write is the precondition: only on a fully successful write do we rename. On failure, remove the temp and fail without a final.
if printf '%s' "$json" >"$tmp"; then
  if mv -f "$tmp" "$final"; then
    printf '%s\n' "$id"
  else
    rm -f "$tmp" 2>/dev/null
    exit 1
  fi
else
  rm -f "$tmp" 2>/dev/null
  exit 1
fi
