#!/usr/bin/env bash
# Gate for tern-install.sh. Runs against a fake `tern` binary + a sandbox TERN_CONFIG_DIR,
# so it never touches the real Tern install or the shared plugins directory.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL="$REPO_ROOT/scripts/tern-install.sh"

t=0; f=0
pass(){ echo "ok   - $1"; t=$((t+1)); }
fail(){ echo "FAIL - $1"; f=$((f+1)); }
assert(){ if [ "$1" = "true" ]; then pass "$2"; else fail "$2"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- fake tern: reads/writes a state file of linked ids under TERN_CONFIG_DIR/plugins ---
FAKE="$TMP/fake-tern"
cat > "$FAKE" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PDIR="$TERN_CONFIG_DIR/plugins"
STATE="$PDIR/linked.list"
mkdir -p "$PDIR"
case "${1:-} ${2:-}" in
  "plugin dir") echo "$PDIR" ;;
  "plugin list")
    python3 - "$STATE" "${FAKE_TERN_PROBLEM:-}" <<'PY'
import json, os, sys
state, prob = sys.argv[1], sys.argv[2]
ids = [l.strip() for l in open(state)] if os.path.exists(state) else []
ids = [i for i in ids if i]
broken = [x for x in prob.split(",") if x]
problems = [{"id": x, "error": "simulated"} for x in broken if x in ids]
print(json.dumps({"plugins": [{"id": i, "name": i} for i in ids],
                  "problems": problems, "jit": False, "canvas": True}))
PY
    ;;
  "plugin link")
    dir="${3:?link needs a dir}"
    id="$(grep -E '^id[[:space:]]*=' "$dir/plugin.toml" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')"
    echo "$dir" > "$PDIR/$id.path"
    touch "$STATE"
    grep -qx "$id" "$STATE" || echo "$id" >> "$STATE"
    ;;
  *) echo "fake-tern: unhandled: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$FAKE"
export TERN_BIN="$FAKE"

fresh_cfg(){ # $1 = settings.json body (optional)
  export TERN_CONFIG_DIR="$TMP/cfg-$RANDOM"
  mkdir -p "$TERN_CONFIG_DIR/plugins"
  [ -n "${1:-}" ] && printf '%s' "$1" > "$TERN_CONFIG_DIR/settings.json"
  STATE="$TERN_CONFIG_DIR/plugins/linked.list"
}
state_lines(){ [ -f "$STATE" ] && grep -c . "$STATE" || echo 0; }

# 1. syntax
if bash -n "$INSTALL"; then pass "bash -n parses the installer"; else fail "bash -n parses the installer"; fi

# 2. --dry: reports, previews, writes nothing
fresh_cfg '{"auto_update": true, "font_size": 14}'
before="$(cksum "$TERN_CONFIG_DIR/settings.json")"
out="$(bash "$INSTALL" --dry 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && echo true)" "--dry exits 0"
assert "$([[ "$out" == *agenthop-agents-bridge* ]] && echo true)" "--dry names the bridge plugin"
assert "$([[ "$out" != *agenthop-board* ]] && echo true)" "--dry does not touch board (not a tern plugin)"
assert "$([[ "$out" == *'WOULD link'* ]] && echo true)" "--dry says WOULD link (no real link)"
assert "$([[ "$out" == *'auto_update'*'true'* ]] && echo true)" "--dry reports auto_update current value (true)"
assert "$([ "$(state_lines)" -eq 0 ] && echo true)" "--dry links nothing (state empty)"
assert "$([ "$before" = "$(cksum "$TERN_CONFIG_DIR/settings.json")" ] && echo true)" "--dry does not modify settings.json"

# 3. first real run: serial link + verify, in fixed order
fresh_cfg '{"auto_update": true}'
before="$(cksum "$TERN_CONFIG_DIR/settings.json")"
out="$(bash "$INSTALL" 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && echo true)" "install exits 0"
assert "$([ "$(state_lines)" -eq 1 ] && echo true)" "install links exactly 1 plugin"
assert "$([ "$(head -1 "$STATE")" = "agenthop-agents-bridge" ] && echo true)" "install links agents-bridge"
assert "$([[ "$out" == *'linked and verified'* ]] && echo true)" "install verifies each step"
assert "$([[ "$out" == *'done'* ]] && echo true)" "install reports done"
assert "$([ "$before" = "$(cksum "$TERN_CONFIG_DIR/settings.json")" ] && echo true)" "install does not modify settings.json (G3 untouched)"

# 4. idempotent: re-run against the same state is a harmless no-op
out="$(bash "$INSTALL" 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && echo true)" "re-run exits 0"
assert "$([ "$(state_lines)" -eq 1 ] && echo true)" "re-run adds no duplicate links (still 1)"
assert "$([[ "$out" == *'skipping (idempotent)'* ]] && echo true)" "re-run skips already-loaded plugins"

# 5. auto_update absent is reported honestly (not fabricated)
fresh_cfg '{"font_size": 14}'
out="$(bash "$INSTALL" --dry 2>&1)"
assert "$([[ "$out" == *'auto_update'*'unset (absent)'* ]] && echo true)" "absent auto_update reported as unset, not a made-up value"

# 6. verify failure mid-sequence => fail-stop, never half-installs silently
fresh_cfg '{"auto_update": false}'
export FAKE_TERN_PROBLEM="agenthop-agents-bridge"   # bridge reports a problem once linked
out="$(bash "$INSTALL" 2>&1)"; rc=$?
unset FAKE_TERN_PROBLEM
assert "$([ $rc -ne 0 ] && echo true)" "verify failure exits non-zero"
assert "$([[ "$out" == *'not loaded cleanly'* && "$out" != *'linked and verified'* ]] && echo true)" "fails loudly on a bad verify (bridge rejected)"
assert "$([[ "$out" != *'All plugins loaded and verified'* ]] && echo true)" "never claims success on a failed verify"

# 7. an existing link from ANOTHER source is never silently skipped or re-pointed
fresh_cfg '{}'
echo "agenthop-agents-bridge" > "$STATE"
echo "/elsewhere/bridge-freeze/tern/agenthop-agents-bridge" > "$TERN_CONFIG_DIR/plugins/agenthop-agents-bridge.path"
out="$(bash "$INSTALL" --dry 2>&1)"
assert "$([[ "$out" == *'LINKED FROM ANOTHER SOURCE'*'bridge-freeze'* ]] && echo true)" "--dry flags a link from another source"
out="$(bash "$INSTALL" 2>&1)"; rc=$?
assert "$([ $rc -ne 0 ] && [[ "$out" == *'Not re-pointing'* ]] && echo true)" "install stops on a link from another source"
assert "$([ "$(cat "$TERN_CONFIG_DIR/plugins/agenthop-agents-bridge.path")" = "/elsewhere/bridge-freeze/tern/agenthop-agents-bridge" ] && echo true)" "the other link is left untouched"

echo ""
echo "tern-install gate: $t passed, $f failed"
[ "$f" -eq 0 ] || exit 1
