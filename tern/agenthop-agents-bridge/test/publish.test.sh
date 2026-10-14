#!/usr/bin/env bash
# Fixture for the atomic publisher (publish.sh) — the sender write-fail gate (review TA-A1-PUBLISH). Proves: a normal publish yields
# exactly one final .json and no leftover temp; a write failure yields NO final .json (the rename is gated on write success, so a
# failed/partial write never becomes a bridge-visible request). Run: bash test/publish.test.sh
set -u
PUB="$(cd "$(dirname "$0")/.." && pwd)/publish.sh"
root="$(mktemp -d)"; mkdir -p "$root/requests" "$root/results"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $(printf %q "$3") want $(printf %q "$2"))"; fails=$((fails+1)); fi; }
count_json() { find "$root/requests" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
count_tmp()  { find "$root/requests" -maxdepth 1 -name '.*.tmp' 2>/dev/null | wc -l | tr -d ' '; }

# 1) normal publish -> one final .json, no leftover temp, exit 0, id printed
id="$(bash "$PUB" "$root" '{"op":"list"}')"; rc=$?
ck "normal: exit 0" "0" "$rc"
ck "normal: id printed" "1" "$([ -n "$id" ] && echo 1 || echo 0)"
ck "normal: exactly one final .json" "1" "$(count_json)"
ck "normal: no leftover temp" "0" "$(count_tmp)"
find "$root/requests" -maxdepth 1 -name '*.json' -delete 2>/dev/null

# 2) write failure (unwritable requests dir): rename must NOT run -> no final .json, nonzero exit
chmod 000 "$root/requests"
bash "$PUB" "$root" '{"op":"ask"}' >/dev/null 2>&1; rc=$?
chmod 755 "$root/requests"
ck "write-fail: nonzero exit" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
ck "write-fail: NO final .json published" "0" "$(count_json)"
ck "write-fail: no leftover temp" "0" "$(count_tmp)"

rm -rf "$root"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
