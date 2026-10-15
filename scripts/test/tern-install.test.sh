#!/usr/bin/env bash
# Gate for tern-install.sh. FAKE tern only: the real daemon is global, and TERN_CONFIG_DIR does not isolate the CLI
# from it (a test reload against the real `tern` reloads the live Tern). Nothing here calls the real binary.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL="$REPO_ROOT/scripts/tern-install.sh"

t=0; f=0
assert(){ if [ "$1" = "true" ]; then echo "ok   - $2"; t=$((t+1)); else echo "FAIL - $2"; f=$((f+1)); fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# fake tern. Modes (env):
#   FAKE_DAEMON=down    `list` still answers from the directory (like real tern); reload/ctl fail
#   FAKE_LOAD=fail      reload succeeds but tern.log gets a "failed to load" line and no new vm is written
#   FAKE_LOAD=silent    reload succeeds, nothing logged, but the plugin never writes agents.json (no proof)
#   FAKE_LOAD=budget    reload succeeds, the plugin writes once, and tern.log gets an "exceeded its budget" line
#   FAKE_MIRROR_LOG=budget|fail  the MIRROR call (the probe) writes the new vm AND appends that error to tern.log
#                                before returning ok (TI-PROBE-LOG: an error inside the probe window)
FAKE="$TMP/fake-tern"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PDIR="$TERN_CONFIG_DIR/plugins"; mkdir -p "$PDIR"
echo "$*" >>"$TERN_CONFIG_DIR/calls"
now(){ python3 -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"))'; }
case "${1:-} ${2:-}" in
  "plugin dir") echo "$PDIR" ;;
  "plugin list")
    python3 - "$PDIR" <<'PY'
import json, os, sys
d = sys.argv[1]
ids = [n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n))]
print(json.dumps({"plugins": [{"id": i, "status": "ready"} for i in ids], "problems": []}))
PY
    ;;
  "plugin install")
    src="${3:?}"; id="$(grep -E '^id' "$src/plugin.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
    rm -rf "$PDIR/$id"; mkdir -p "$PDIR/$id"; cp "$src/plugin.toml" "$PDIR/$id/" ;;
  "plugin link") echo "fake-tern: link must never be called" >&2; exit 98 ;;
  "plugin reload")
    [ "${FAKE_DAEMON:-up}" = down ] && exit 1
    echo "vm-$RANDOM" >"$TERN_CONFIG_DIR/current-vm"
    case "${FAKE_LOAD:-ok}" in
      fail)   echo "$(now) WARN x: plugin window entry failed to load plugin=\"agenthop-agents-bridge\" error=boom" >>"$TERN_LOG"; rm -f "$TERN_CONFIG_DIR/current-vm" ;;
      budget) echo "$(now) WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"timer\"" >>"$TERN_LOG" ;;
      silent) rm -f "$TERN_CONFIG_DIR/current-vm" ;;
    esac ;;
  "ctl plugins")
    [ "${FAKE_DAEMON:-up}" = down ] && exit 1
    [ -f "$TERN_CONFIG_DIR/current-vm" ] && echo "{\"tick\":1,\"vm\":\"$(cat "$TERN_CONFIG_DIR/current-vm")\"}" >"$BRIDGE_CTRL_DIR/agents.json"
    case "${FAKE_MIRROR_LOG:-}" in
      budget) echo "$(now) WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"command mirror\"" >>"$TERN_LOG" ;;
      fail)   echo "$(now) WARN x: plugin window entry failed to load plugin=\"agenthop-agents-bridge\" error=late" >>"$TERN_LOG" ;;
    esac
    echo '{"ok":true}' ;;
  *) echo "fake-tern: unhandled: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$FAKE"
export TERN_BIN="$FAKE" PROOF_WAIT=1

fresh(){ # $1 = settings.json body (optional)
  export TERN_CONFIG_DIR="$TMP/cfg-$RANDOM"; mkdir -p "$TERN_CONFIG_DIR/plugins" "$TERN_CONFIG_DIR/ctrl"
  export BRIDGE_CTRL_DIR="$TERN_CONFIG_DIR/ctrl" TERN_LOG="$TERN_CONFIG_DIR/tern.log"; : >"$TERN_LOG"
  echo '{"tick":40,"vm":"vm-before"}' >"$BRIDGE_CTRL_DIR/agents.json"
  [ -n "${1:-}" ] && printf '%s' "$1" >"$TERN_CONFIG_DIR/settings.json"
  P="$TERN_CONFIG_DIR/plugins"
}
calls(){ cat "$TERN_CONFIG_DIR/calls" 2>/dev/null; }
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

assert "$(bash -n "$INSTALL" && echo true)" "bash -n parses the installer"

# 1. default = dry run: nothing installed, no reload, settings untouched
fresh '{"auto_update": true}'; before="$(cksum "$TERN_CONFIG_DIR/settings.json")"
out="$(bash "$INSTALL" 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && [[ "$out" == *'WOULD install a copy'* && "$out" == *'dry run: nothing installed'* ]] && echo true)" "default run is a dry run and says what --live would do"
assert "$([ ! -d "$P/agenthop-agents-bridge" ] && ! calls | grep -qE 'install|reload|ctl' && echo true)" "dry run: no install, no reload, no plugin command"
assert "$([[ "$out" == *'auto_update'*'true'* && "$before" = "$(cksum "$TERN_CONFIG_DIR/settings.json")" ]] && echo true)" "auto_update reported, settings.json unchanged"
assert "$([[ "$out" != *agenthop-board* ]] && echo true)" "board is not a tern plugin: never planned"

# 2. --live, healthy: install copy, record sha, reload, proof via a new vm
fresh '{}'
out="$(bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && [[ "$out" == *'WILL install'*'RELOAD THE LIVE TERN DAEMON'* ]] && echo true)" "--live announces the live reload before acting"
assert "$([[ "$out" == *'load proven: agents.json written by the reloaded instance (vm vm-before -> vm-'* && "$out" == *'installed and their load proven'* ]] && echo true)" "--live healthy: load proven by a new vm"
assert "$([ -d "$P/agenthop-agents-bridge" ] && [ ! -f "$P/agenthop-agents-bridge.path" ] && echo true)" "installs a COPY, never a link"
assert "$([ "$(cat "$P/agenthop-agents-bridge.installed-sha" 2>/dev/null)" = "$SHA" ] && [ "$(cat "$P/agenthop-agents-bridge.proven-sha" 2>/dev/null)" = "$SHA" ] && echo true)" "records the installed commit (<id>.installed-sha) and the proven commit (<id>.proven-sha)"
assert "$(! calls | grep -q 'plugin link' && echo true)" "never calls tern plugin link"

# 3. idempotent: same commit installed => skip, no reload
: >"$TERN_CONFIG_DIR/calls"; out="$(bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && [[ "$out" == *"installed copy at $SHA, load proven, skipping"* ]] && ! calls | grep -q reload && echo true)" "re-run at the same commit after a proven install: skip, no reload"

# 4. TI-LOAD-PROOF: plugin files present, daemon unreachable. `list` still says ready; install must NOT claim success.
fresh '{}'; mkdir -p "$P/agenthop-agents-bridge"   # an older copy, no recorded sha
out="$(FAKE_DAEMON=down bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -ne 0 ] && [[ "$out" != *'load proven'* && "$out" != *'installed and their load proven'* ]] && echo true)" "daemon down: never reports loaded/installed-ok"
assert "$([[ "$out" == *"'tern plugin reload' reported a failing plugin"* ]] && echo true)" "daemon down: says the reload failed"

# 5. daemon up, load fails (tern.log failed to load, no new vm) => FAIL
fresh '{}'; out="$(FAKE_LOAD=fail bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 1 ] && [[ "$out" == *'did not load cleanly after reload (tern.log, before the probe)'*'failed to load'* ]] && echo true)" "load failure in tern.log => exit 1, quoted"

# 6. daemon up, reload ok, no log line, but the plugin never writes => UNKNOWN exit 2
fresh '{}'; out="$(FAKE_LOAD=silent bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 2 ] && [[ "$out" == *'UNKNOWN'*'load not proven'* ]] && echo true)" "no write from a reloaded instance => UNKNOWN exit 2"

# 7. budget kill right after reload => FAIL, even though a vm was written
fresh '{}'; out="$(FAKE_LOAD=budget bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 1 ] && [[ "$out" == *'exceeded its budget'* ]] && echo true)" "budget kill after reload => exit 1"

# 8. an existing LINK is never replaced, dry or live
fresh '{}'; echo "/elsewhere/bridge-freeze/tern/agenthop-agents-bridge" >"$P/agenthop-agents-bridge.path"
out="$(bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -ne 0 ] && [[ "$out" == *'LINKED from /elsewhere/bridge-freeze'*'installed copy only'* ]] && [ "$(cat "$P/agenthop-agents-bridge.path")" = "/elsewhere/bridge-freeze/tern/agenthop-agents-bridge" ] && echo true)" "existing link: stop, link untouched"

# 9. lock held => stop, lock kept
fresh '{}'; mkdir "$P/.tern-install.lock"
out="$(bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -ne 0 ] && [[ "$out" == *'another tern-install'* ]] && [ -d "$P/.tern-install.lock" ] && echo true)" "lock held: stop, other run's lock kept"

# 10. unknown argument
out="$(bash "$INSTALL" --bogus 2>&1)"; rc=$?
assert "$([ $rc -eq 2 ] && echo true)" "unknown argument => exit 2"

# ---- r3: TI-RETRY-PROOF — a failed run leaves the copy, but a re-run must NOT skip without a proof ----------------
# reload fails, then the daemon comes back: run 1 exit 1, run 2 reloads + proves (not "skipping") and exits 0
fresh '{}'
out1="$(FAKE_DAEMON=down bash "$INSTALL" --live 2>&1)"; rc1=$?
assert "$([ $rc1 -eq 1 ] && [ -f "$P/agenthop-agents-bridge.installed-sha" ] && [ ! -f "$P/agenthop-agents-bridge.proven-sha" ] && echo true)" "retry 1a: reload fails => exit 1, copy recorded, NOT proven"
: >"$TERN_CONFIG_DIR/calls"; out2="$(bash "$INSTALL" --live 2>&1)"; rc2=$?
assert "$([ $rc2 -eq 0 ] && [[ "$out2" == *'installed but its load is NOT proven'*'re-proving its load'*'load proven'* ]] && calls | grep -q 'plugin reload' && ! calls | grep -q 'plugin install' && echo true)" "retry 1b: re-run at the same commit re-proves (reload, no reinstall) and exits 0"
assert "$([ "$(cat "$P/agenthop-agents-bridge.proven-sha" 2>/dev/null)" = "$SHA" ] && echo true)" "retry 1c: proven-sha written only after the proof"
# no proof twice in a row: both runs exit 2, the second does NOT exit 0
fresh '{}'
out1="$(FAKE_LOAD=silent bash "$INSTALL" --live 2>&1)"; rc1=$?
out2="$(FAKE_LOAD=silent bash "$INSTALL" --live 2>&1)"; rc2=$?
assert "$([ $rc1 -eq 2 ] && [ $rc2 -eq 2 ] && [[ "$out2" == *'NOT proven'*'UNKNOWN'* ]] && [ ! -f "$P/agenthop-agents-bridge.proven-sha" ] && echo true)" "retry 2: no proof, re-run at the same commit => still UNKNOWN exit 2, never 0"
# dry run reports the unproven state instead of "skipping"
out="$(bash "$INSTALL" 2>&1)"
assert "$([[ "$out" == *'installed but its load is NOT proven'*'WOULD reload'* && "$out" != *'skipping (idempotent)'* ]] && echo true)" "retry 3: dry run shows the copy as installed but not proven"
# a proven install whose proof is then lost (proven-sha removed) is re-proven, not skipped
fresh '{}'; bash "$INSTALL" --live >/dev/null 2>&1; rm -f "$P/agenthop-agents-bridge.proven-sha"
: >"$TERN_CONFIG_DIR/calls"; out="$(bash "$INSTALL" --live 2>&1)"; rc=$?
assert "$([ $rc -eq 0 ] && calls | grep -q 'plugin reload' && echo true)" "retry 4: proven-sha missing => reload + proof again"

# ---- r3: TI-PROBE-LOG — an error written DURING the probe (inside mirror) fails the run --------------------------
for kind in budget fail; do
  fresh '{}'; out="$(FAKE_MIRROR_LOG=$kind bash "$INSTALL" --live 2>&1)"; rc=$?
  assert "$([ $rc -eq 1 ] && [[ "$out" == *'did not load cleanly after reload (tern.log, during the probe)'* && "$out" != *'load proven'* ]] && [ ! -f "$P/agenthop-agents-bridge.proven-sha" ] && echo true)" "probe-log $kind: error appended inside mirror => exit 1, no 'load proven', no proven-sha"
done

echo ""
echo "tern-install gate: $t passed, $f failed"
[ "$f" -eq 0 ] || exit 1
